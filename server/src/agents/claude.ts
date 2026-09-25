import { ASK_TOOL_QUALIFIED, MCP_SERVER_NAME, QUESTION_WAIT_MS } from "../api/mcp";
import { epochMs } from "./limits";
import { execCli } from "./resolve";
import { type AgentAdapter, type AgentEvent, firstVersion, parseJsonLine, truncate } from "./types";

/** Read-only tools that ask for permission by default, so a read-only run must pre-approve them. */
const WEB_TOOLS = ["WebFetch", "WebSearch"];
/** Tools that can't modify anything; used for read-only runs. */
const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", ...WEB_TOOLS];

export const claudeAdapter: AgentAdapter = {
  id: "claude",
  label: "Claude Code",
  binName: "claude",
  installCommand: "npm i -g @anthropic-ai/claude-code",
  loginCommand: "claude auth login",
  // `claude --help`: an alias for the latest model, or a full name like "claude-fable-5".
  modelHints: ["fable", "opus", "sonnet", "haiku"],
  modelPattern: /^claude-[a-z0-9][a-z0-9.-]*$/i,
  // `claude --help` lists these for --effort; the CLI can't say which models take which.
  effortHints: ["low", "medium", "high", "xhigh", "max"],
  usageEstimated: true,
  supportsQuestions: true,
  reportsUsageLimits: true,

  buildSpawn(invocation) {
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    // Pre-approved tools: an unattended run has nobody to answer a permission prompt, and
    // --permission-prompts none denies anything that would ask. Being in --tools is not enough.
    const allowed: string[] = [];
    if (invocation.askUserUrl) {
      // --strict-mcp-config so the user's own MCP servers don't join an unattended run.
      // `timeout` is Claude Code's per-call limit for this server: its 60s default otherwise ends
      // the question long before anyone has read it, and the agent carries on unanswered.
      const server = { type: "http", url: invocation.askUserUrl, timeout: QUESTION_WAIT_MS };
      const config = { mcpServers: { [MCP_SERVER_NAME]: server } };
      args.push("--mcp-config", JSON.stringify(config), "--strict-mcp-config");
      allowed.push(ASK_TOOL_QUALIFIED);
    }
    if (invocation.autonomy === "autonomous") {
      args.push("--dangerously-skip-permissions");
    } else {
      // Plan mode delivers its answer through ExitPlanMode rather than the result, which breaks
      // "save result as artifact"; a read-only tool set keeps the answer in the final message.
      const tools = [...READ_ONLY_TOOLS, ...(invocation.askUserUrl ? [ASK_TOOL_QUALIFIED] : [])];
      args.push("--tools", tools.join(","), "--permission-prompts", "none");
      allowed.push(...WEB_TOOLS);
    }
    if (allowed.length) args.push("--allowedTools", allowed.join(","));
    if (invocation.model) args.push("--model", invocation.model);
    if (invocation.effort) args.push("--effort", invocation.effort);
    if (invocation.resumeSessionId) args.push("--resume", invocation.resumeSessionId);
    return { args, stdin: invocation.prompt };
  },

  createParser() {
    const toolNames = new Map<string, string>();
    return {
      push(line) {
        const event = parseJsonLine(line);
        if (!event) return line.trim() ? [{ kind: "raw", text: line }] : [];
        const events: AgentEvent[] = [];
        switch (event.type) {
          case "system":
            if (event.subtype === "init" && typeof event.session_id === "string") {
              events.push({ kind: "session", sessionId: event.session_id });
            }
            break;
          case "assistant":
            for (const block of event.message?.content ?? []) {
              if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
                events.push({ kind: "message", text: block.text });
              } else if (block.type === "tool_use") {
                toolNames.set(block.id, block.name);
                events.push({
                  kind: "tool",
                  name: block.name,
                  status: "started",
                  detail: summarizeInput(block.input),
                  id: block.id,
                });
              }
            }
            break;
          case "user":
            for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
              if (block.type === "tool_result") {
                const name = toolNames.get(block.tool_use_id) ?? "tool";
                events.push({
                  kind: "tool",
                  name,
                  status: block.is_error ? "failed" : "completed",
                  detail: summarizeResult(block.content),
                  id: block.tool_use_id,
                });
              }
            }
            break;
          case "rate_limit_event": {
            // "allowed" and "allowed_warning" only report usage; "rejected" means the request was refused.
            const info = event.rate_limit_info ?? {};
            if (info.status === "rejected") {
              events.push({ kind: "limit", resetAt: typeof info.resetsAt === "number" ? epochMs(info.resetsAt) : null });
            }
            break;
          }
          case "result": {
            if (typeof event.session_id === "string") events.push({ kind: "session", sessionId: event.session_id });
            const usage = event.usage ?? {};
            events.push({
              kind: "usage",
              usage: {
                inputTokens: sum(usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens),
                cachedInputTokens: usage.cache_read_input_tokens,
                outputTokens: usage.output_tokens,
                costUsd: event.total_cost_usd,
              },
            });
            const ok = event.subtype === "success" && !event.is_error;
            const text = typeof event.result === "string" ? event.result : "";
            const errors = Array.isArray(event.errors) ? event.errors.join("; ") : "";
            events.push({ kind: "final", ok, text, error: ok ? undefined : text || errors || String(event.subtype) });
            break;
          }
        }
        return events;
      },
    };
  },

  async version(cli) {
    const result = await execCli(cli, ["--version"]);
    return result.code === 0 ? firstVersion(result.stdout) : null;
  },

  async auth(cli) {
    const result = await execCli(cli, ["auth", "status"]);
    const status = parseJsonLine(result.stdout.replace(/\s+/g, " "));
    if (!status) return { loggedIn: null, detail: truncate(result.output) || "Unknown" };
    return {
      loggedIn: status.loggedIn === true,
      detail: status.loggedIn ? `Logged in (${status.authMethod ?? "unknown method"})` : "Not logged in",
    };
  },
};

function summarizeInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const value = record.command ?? record.file_path ?? record.path ?? record.pattern ?? record.url ?? record.query;
  return typeof value === "string" ? truncate(value) : undefined;
}

/** A one-line preview of what a tool returned; the full result stays with the agent. */
function summarizeResult(content: unknown): string | undefined {
  const text = typeof content === "string" ? content : blocksToText(content);
  return text.trim() ? truncate(text) : undefined;
}

function blocksToText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) =>
      block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .join(" ");
}

function sum(...values: unknown[]): number | undefined {
  const numbers = values.filter((value): value is number => typeof value === "number");
  return numbers.length ? numbers.reduce((a, b) => a + b, 0) : undefined;
}
