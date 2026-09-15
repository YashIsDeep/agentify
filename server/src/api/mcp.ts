import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AgentQuestionField } from "@wm/shared";
import type { Hono } from "hono";
import { z } from "zod";
import type { QuestionService } from "../services/questions";

export const ASK_TOOL = "ask_user";
export const MCP_SERVER_NAME = "workflow";
/** How the tool is addressed once the CLI namespaces it. */
export const ASK_TOOL_QUALIFIED = `mcp__${MCP_SERVER_NAME}__${ASK_TOOL}`;

/**
 * How long an agent's CLI should let the ask tool block. Their default is 60s, after which the
 * agent is told the call failed while the person may still be reading. These are hard wall-clock
 * limits — progress notifications don't extend Claude Code's — so this is a ceiling, not a
 * keepalive. It asks for a day, but a live Claude Code run (2026-09-11) still ended the call after
 * ~353s, so another limit applies that this setting doesn't reach. See DESIGN.md §3.1 *Questions*.
 */
export const QUESTION_WAIT_MS = 24 * 60 * 60 * 1000;

const questionShape = {
  preamble: z.string().optional().describe("Optional context to show above the questions."),
  questions: z
    .array(
      z.object({
        id: z.string().optional().describe("Stable id for this question; generated if omitted."),
        text: z.string().describe("The question, phrased for a human."),
        options: z.array(z.string()).optional().describe("Offer these as a fixed set of choices."),
        multiline: z.boolean().optional().describe("Ask for a longer free-text answer."),
      }),
    )
    .min(1)
    .describe("Ask everything you need in one call rather than one question at a time."),
};

const DESCRIPTION = [
  "Ask the person running this workflow a question and wait for their answer.",
  "Use this when a decision is genuinely theirs — an ambiguous requirement, a missing detail, a",
  "choice between approaches you cannot make safely alone. The call blocks until they reply, so",
  "ask everything you need at once, and only when you are actually stuck.",
].join(" ");

/**
 * Each agent run gets its own MCP endpoint at /mcp/<token>, so a tool call is unambiguously
 * attributable to that run. The server and transport are built per request (stateless mode):
 * they are cheap, and it avoids a connection outliving the run it belongs to.
 */
export function mountMcp(app: Hono, questions: QuestionService): void {
  app.all("/mcp/:token", async (c) => {
    const runId = questions.runForToken(c.req.param("token"));
    if (runId === undefined) return c.json({ error: "Unknown or expired MCP token" }, 404);

    const server = new McpServer(
      { name: "workflow-manager", version: "1.0.0" },
      { capabilities: { tools: {} }, instructions: "Tools for talking to the person running this workflow." },
    );

    server.registerTool(ASK_TOOL, { description: DESCRIPTION, inputSchema: questionShape }, async (args) => {
      const fields: AgentQuestionField[] = args.questions.map((question, index) => ({
        id: question.id?.trim() || `q${index + 1}`,
        text: question.text,
        kind: question.options?.length ? "choice" : "text",
        ...(question.options?.length ? { options: question.options } : {}),
        ...(question.multiline ? { multiline: true } : {}),
      }));

      try {
        const result = await questions.ask(runId, { preamble: args.preamble, fields });
        return { content: [{ type: "text" as const, text: formatAnswers(fields, result.answers, result.skip) }] };
      } catch (err) {
        // The run was cancelled, or a newer question superseded this one. Tell the agent rather than hang.
        return {
          isError: true,
          content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
        };
      }
    });

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(c.req.raw);
    // Nothing streams after the response, and the run keeps its own endpoint alive.
    void server.close().catch(() => {});
    return response;
  });
}

function formatAnswers(fields: AgentQuestionField[], answers: Record<string, string>, skipped: boolean): string {
  if (skipped) {
    return "The user skipped these questions. Proceed using your best judgement, and note the assumptions you made.";
  }
  const lines = fields.map((field) => {
    const answer = answers[field.id]?.trim();
    return `Q: ${field.text}\nA: ${answer || "(no answer given — use your judgement)"}`;
  });
  return `The user answered:\n\n${lines.join("\n\n")}`;
}
