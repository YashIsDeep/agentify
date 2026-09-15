import type { AgentQuestion, RunLogLine, TaskDetail, TaskSummary } from "@wm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunLog } from "../src/actions/types";
import { ASK_TOOL, ASK_TOOL_QUALIFIED, MCP_SERVER_NAME } from "../src/api/mcp";
import { claudeAdapter } from "../src/agents/claude";
import { codexAdapter } from "../src/agents/codex";
import { cursorAdapter } from "../src/agents/cursor";
import { opencodeAdapter } from "../src/agents/opencode";
import { createHarness, type Harness, removeDir, waitFor } from "./helpers";
import { releaseGate, resetTestActions } from "./test-actions";

let h: Harness;

beforeEach(() => {
  resetTestActions();
  h = createHarness({ seed: true });
});

afterEach(async () => {
  releaseGate("questions");
  await h.close();
  removeDir(h.dataDir);
});

/** A JSON-RPC call against the run's own MCP endpoint, exactly as an agent CLI would make it. */
async function rpc(endpoint: string, method: string, params?: unknown, id: number | null = 1) {
  const response = await h.app.request(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : null };
}

/** Starts a task parked on a long-running action, so there is a real running run to ask from. */
async function runningRun(): Promise<{ runId: number; taskId: string; endpoint: string }> {
  const workflowId = h.addWorkflow({
    name: "Waiting",
    description: "",
    stages: [
      {
        name: "Work",
        bindings: [
          { key: "wait", label: "Wait", actionType: "test-wait", config: { gate: "questions" } },
        ],
      },
    ],
  });
  const task = h.engine.createTask({ workflowId, title: "Asking" });
  const run = await waitFor(() => h.engine.getTaskDetail(task.id).visits[0]?.runs.find((r) => r.status === "running"));
  return { runId: run.id, taskId: task.id, endpoint: new URL(h.questions.endpointFor(run.id)).pathname };
}

const summary = (taskId: string): TaskSummary => h.engine.listTasks({}).find((t) => t.id === taskId)!;

describe("the MCP endpoint an agent asks through", () => {
  it("speaks MCP and offers exactly the ask tool", async () => {
    const { endpoint } = await runningRun();

    const init = await rpc(endpoint, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.status).toBe(200);
    expect(init.body?.result?.capabilities?.tools).toBeDefined();

    const tools = await rpc(endpoint, "tools/list", {}, 2);
    const names = (tools.body?.result?.tools ?? []).map((tool: { name: string }) => tool.name);
    expect(names).toEqual([ASK_TOOL]);
  });

  it("refuses a token that isn't a live run", async () => {
    const response = await h.app.request("/mcp/not-a-real-token", { method: "POST", body: "{}" });
    expect(response.status).toBe(404);
  });

  it("blocks the agent until the question is answered, and hands the answers back", async () => {
    const { runId, taskId, endpoint } = await runningRun();

    const call = rpc(endpoint, "tools/call", {
      name: ASK_TOOL,
      arguments: {
        preamble: "I need two decisions before I continue.",
        questions: [
          { id: "auth", text: "Which auth provider?", options: ["Auth0", "Clerk"] },
          { text: "Any constraints?", multiline: true },
        ],
      },
    });

    // The question reaches the UI while the call is still outstanding.
    const question = await waitFor(() => h.questions.pending()[0]);
    expect(question.preamble).toBe("I need two decisions before I continue.");
    expect(question.fields).toEqual([
      { id: "auth", text: "Which auth provider?", kind: "choice", options: ["Auth0", "Clerk"] },
      { id: "q2", text: "Any constraints?", kind: "text", multiline: true },
    ]);

    // It is stored on the run, so a page reload still shows it, and the task asks for attention.
    const stored = h.engine.getTaskDetail(taskId).visits[0]?.runs.find((r) => r.id === runId);
    expect((stored?.question as AgentQuestion | null)?.id).toBe(question.id);
    expect(summary(taskId).badge).toBe("needs-you");
    // The agent is silent on purpose, so the inactivity timeout must be suspended.
    expect(h.questions.isWaiting(runId)).toBe(true);

    h.questions.answer(question.id, { answers: { auth: "Clerk", q2: "Must work offline" }, skip: false });

    const result = await call;
    const text = result.body?.result?.content?.[0]?.text as string;
    expect(text).toContain("Which auth provider?");
    expect(text).toContain("Clerk");
    expect(text).toContain("Must work offline");

    expect(h.questions.pending()).toEqual([]);
    expect(h.questions.isWaiting(runId)).toBe(false);
    expect(summary(taskId).badge).toBe("running");
  });

  it("tells the agent to carry on when the question is skipped", async () => {
    const { endpoint } = await runningRun();
    const call = rpc(endpoint, "tools/call", {
      name: ASK_TOOL,
      arguments: { questions: [{ text: "Ship it?" }] },
    });
    const question = await waitFor(() => h.questions.pending()[0]);
    h.questions.answer(question.id, { answers: {}, skip: true });

    const text = (await call).body?.result?.content?.[0]?.text as string;
    expect(text).toContain("skipped");
    expect(text).toContain("best judgement");
  });

  it("unblocks the agent when the run is cancelled instead of leaving it hanging", async () => {
    const { runId, endpoint } = await runningRun();
    const call = rpc(endpoint, "tools/call", { name: ASK_TOOL, arguments: { questions: [{ text: "Still there?" }] } });
    await waitFor(() => h.questions.pending()[0]);

    h.questions.cancelForRun(runId, "The run was cancelled");

    const body = (await call).body;
    expect(body?.result?.isError).toBe(true);
    expect(body?.result?.content?.[0]?.text).toContain("cancelled");
  });

  it("answers the question through the API and reports an answered one as gone", async () => {
    const { taskId, endpoint } = await runningRun();
    const call = rpc(endpoint, "tools/call", { name: ASK_TOOL, arguments: { questions: [{ text: "Which port?" }] } });
    const question = await waitFor(() => h.questions.pending()[0]);

    const answer = await h.app.request(`/api/questions/${question.id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: { q1: "8080" } }),
    });
    expect(answer.status).toBe(200);
    expect((await call).body?.result?.content?.[0]?.text).toContain("8080");

    const again = await h.app.request(`/api/questions/${question.id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: {} }),
    });
    expect(again.status).toBe(409);

    const detail = (await (await h.app.request(`/api/tasks/${taskId}`)).json()) as TaskDetail;
    expect(detail.timeline.map((event) => event.type)).toContain("question.answered");
  });

  it("records the question and the answer in the run's transcript", async () => {
    const { runId, endpoint } = await runningRun();
    // The transcript belongs to the action running the agent, which lends it for the duration.
    const lines: Omit<RunLogLine, "at">[] = [];
    const log: RunLog = (entry: string | Omit<RunLogLine, "at">) => {
      lines.push(typeof entry === "string" ? { stream: "info", text: entry } : entry);
    };
    h.questions.attachLog(runId, log);

    const call = rpc(endpoint, "tools/call", {
      name: ASK_TOOL,
      arguments: { preamble: "One thing first.", questions: [{ id: "db", text: "Which database?", options: ["Postgres", "SQLite"] }] },
    });
    const question = await waitFor(() => h.questions.pending()[0]);
    h.questions.answer(question.id, { answers: { db: "Postgres" }, skip: false });
    await call;

    expect(lines).toMatchObject([
      { kind: "question", text: "One thing first.\nWhich database? (Postgres / SQLite)" },
      { kind: "answer", text: "Which database? → Postgres" },
    ]);
  });

  it("replaces a question the agent abandoned instead of refusing to ask again", async () => {
    const { endpoint } = await runningRun();
    // The CLI gives up on the first call — as Claude Code did after its 60s tool timeout — and asks again.
    const abandoned = rpc(endpoint, "tools/call", { name: ASK_TOOL, arguments: { questions: [{ text: "First try?" }] } });
    const first = await waitFor(() => h.questions.pending()[0]);

    const retry = rpc(endpoint, "tools/call", { name: ASK_TOOL, arguments: { questions: [{ text: "Second try?" }] } }, 2);
    const second = await waitFor(() => h.questions.pending().find((question) => question.id !== first.id));
    expect(h.questions.pending()).toEqual([second]);
    expect((await abandoned).body?.result?.isError).toBe(true);

    h.questions.answer(second.id, { answers: { q1: "yes" }, skip: false });
    expect((await retry).body?.result?.content?.[0]?.text).toContain("yes");
  });
});

describe("which agents can be asked", () => {
  const invocation = {
    prompt: "hello",
    model: null,
    autonomy: "read-only" as const,
    resumeSessionId: null,
    cwd: "/tmp",
    scratchDir: "/tmp/scratch",
    effort: null,
    askUserUrl: "http://127.0.0.1:2712/mcp/tok",
  };

  it("points Claude at the endpoint and allows the tool even when read-only", () => {
    const args = claudeAdapter.buildSpawn(invocation).args.join(" ");
    expect(args).toContain(`"${MCP_SERVER_NAME}"`);
    expect(args).toContain("http://127.0.0.1:2712/mcp/tok");
    expect(args).toContain("--strict-mcp-config");
    // Without this the read-only allowlist would silently exclude the ask tool.
    expect(args).toContain(`--tools ${["Read", "Glob", "Grep", "WebFetch", "WebSearch", ASK_TOOL_QUALIFIED].join(",")}`);
    // And without this the tool prompts for permission, which --permission-prompts none denies.
    expect(args).toContain(`--allowedTools ${ASK_TOOL_QUALIFIED}`);
    // Without this Claude Code abandons the question after its 60s default and the agent moves on.
    const spawn = claudeAdapter.buildSpawn(invocation).args;
    const config = JSON.parse(spawn[spawn.indexOf("--mcp-config") + 1] ?? "{}");
    expect(config.mcpServers[MCP_SERVER_NAME].timeout).toBeGreaterThan(60_000);
  });

  it("points Codex at the endpoint with a config override", () => {
    const args = codexAdapter.buildSpawn(invocation).args;
    expect(args).toContain(`mcp_servers.${MCP_SERVER_NAME}.url="http://127.0.0.1:2712/mcp/tok"`);
    // Codex's own 60s tool timeout would end the question early too.
    const timeout = args.find((arg) => arg.startsWith(`mcp_servers.${MCP_SERVER_NAME}.tool_timeout_sec=`));
    expect(Number(timeout?.split("=")[1])).toBeGreaterThan(60);
  });

  it("leaves OpenCode and Cursor alone, which cannot take a per-run MCP server", () => {
    for (const adapter of [opencodeAdapter, cursorAdapter]) {
      expect(adapter.supportsQuestions).toBe(false);
      expect(adapter.buildSpawn(invocation).args.join(" ")).not.toContain("/mcp/tok");
    }
  });
});
