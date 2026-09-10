import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentStatus, AgentTestResult, RunLogLine } from "@wm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, inspect, removeDir, waitFor } from "./helpers";

const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));

let h: Harness;
let q: ReturnType<typeof inspect>;
let savedApiKey: string | undefined;

beforeEach(() => {
  h = createHarness();
  q = inspect(h);
  h.agents.setPathOverride("codex", FAKE_CODEX);
  h.agents.setPathOverride("claude", FAKE_CLAUDE);
  // Must never reach the agent process.
  savedApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
});

afterEach(async () => {
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedApiKey;
  await h.close();
  removeDir(h.dataDir);
});

const artifact = (taskId: string, name: string) => {
  const file = join(h.paths.artifactDir(taskId), name);
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
};

function agentWorkflow(config: Record<string, unknown>) {
  return h.addWorkflow({
    name: "Agents",
    description: "",
    stages: [
      {
        name: "Work",
        phases: [{ name: "Agent", completion: "auto" }],
        bindings: [
          {
            key: "agent",
            label: "Agent",
            trigger: "phase.started",
            phase: "Agent",
            actionType: "coding-agent",
            config: { agent: "codex", prompt: "Implement {{task.title}}", saveResultAs: "result.md", ...config },
          },
        ],
      },
      { name: "Done" },
    ],
  });
}

async function reenter(taskId: string, workflowId: string, attempt: number) {
  h.engine.moveTask(taskId, h.stageId(workflowId, "Done"));
  h.engine.moveTask(taskId, h.stageId(workflowId, "Work"));
  await waitFor(() => q.currentVisit(taskId).attempt === attempt && q.phase(taskId, "Agent").status === "done");
}

describe("coding-agent action", () => {
  it("runs the agent, saves its final message, and records session and usage", async () => {
    const workflowId = agentWorkflow({ autonomy: "autonomous" });
    // An autonomous agent needs somewhere real to work; without a repo the action refuses to run.
    const task = h.engine.createTask({ workflowId, title: "Widget", repoPath: h.dataDir });
    await waitFor(() => q.phase(task.id, "Agent").status === "done");

    const result = artifact(task.id, "result.md") ?? "";
    expect(result).toContain("codex fresh | model:default | access:autonomous | keys:none");
    expect(result).toContain("prompt:Implement Widget");

    const [run] = q.runs(task.id, "agent");
    expect(run?.sessionId).toBe("codex-thread-1");
    expect(run?.outputs).toMatchObject({ agent: "codex", model: null, sessionId: "codex-thread-1", artifact: "result.md" });
    expect(run?.usage).toMatchObject({ inputTokens: 1200, outputTokens: 80, estimated: true });

    const log = (await (await h.app.request(`/api/runs/${run!.id}/log`)).json()) as RunLogLine[];
    expect(log.map((line) => line.text)).toContain("▸ shell: git status");
  });

  it("continues the previous session, and hands over context when the agent changes", async () => {
    const workflowId = agentWorkflow({ autonomy: "autonomous", continueSession: true });
    const task = h.engine.createTask({ workflowId, title: "Widget", repoPath: h.dataDir });
    await waitFor(() => q.phase(task.id, "Agent").status === "done");

    await reenter(task.id, workflowId, 2);
    expect(artifact(task.id, "result.md")).toContain("codex resumed codex-thread-1");

    h.engine.updateTask(task.id, { agentOverride: "claude", modelOverride: "opus" });
    await reenter(task.id, workflowId, 3);
    const handedOver = artifact(task.id, "result.md") ?? "";
    expect(handedOver).toContain("claude fresh | model:opus | access:autonomous | keys:none");
    expect(handedOver).toContain("A previous attempt at this step (by Codex) ended with:");
  });

  it("keeps the session of a failed run and lets Retry switch agent and model", async () => {
    const workflowId = agentWorkflow({ prompt: "FAIL please" });
    const task = h.engine.createTask({ workflowId, title: "Widget" });
    await waitFor(() => q.phase(task.id, "Agent").status === "failed");

    const [failed] = q.runs(task.id, "agent");
    expect(failed?.error).toContain("model exploded");
    expect(failed?.sessionId).toBe("codex-thread-1");

    h.engine.retryRun(failed!.id, { agent: "claude", model: "sonnet" });
    await waitFor(() => q.phase(task.id, "Agent").status === "done");
    expect(artifact(task.id, "result.md")).toContain("claude fresh | model:sonnet | access:read-only");
    expect(q.runs(task.id, "agent").at(-1)?.usage).toMatchObject({ inputTokens: 1010, costUsd: 0.0123 });
  });

  it("stops an agent that goes quiet", async () => {
    const workflowId = agentWorkflow({ prompt: "HANG", inactivityTimeoutSec: 1 });
    const task = h.engine.createTask({ workflowId, title: "Widget" });
    await waitFor(() => q.runs(task.id, "agent")[0]?.status === "failed", { timeout: 20_000 });
    expect(q.runs(task.id, "agent")[0]?.error).toMatch(/No output for 1s/);
  });

  it("reports status and tests agents over the API", async () => {
    const statuses = (await (await h.app.request("/api/agents")).json()) as AgentStatus[];
    expect(statuses.map((status) => status.id)).toEqual(["claude", "codex", "opencode"]);
    expect(statuses.find((status) => status.id === "codex")).toMatchObject({
      installed: true,
      path: FAKE_CODEX,
      pathOverride: FAKE_CODEX,
      version: "9.9.9",
      loggedIn: true,
    });
    expect(statuses.find((status) => status.id === "claude")).toMatchObject({ version: "9.9.9", loggedIn: true });

    const test = await h.app.request("/api/agents/codex/test", { method: "POST", body: "{}" });
    const result = (await test.json()) as AgentTestResult;
    expect(result.ok).toBe(true);
    expect(result.text).toContain("prompt:Reply with exactly the word pong");

    const put = (path: string | null) =>
      h.app.request("/api/agents/codex", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
    expect((await put("C:/definitely/not/here.exe")).status).toBe(400);
    expect(((await (await put(null)).json()) as AgentStatus).pathOverride).toBeNull();
    expect((await h.app.request("/api/agents/gemini/test", { method: "POST" })).status).toBe(400);
  });
});
