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
        bindings: [
          {
            key: "agent",
            label: "Agent",
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
  await waitFor(() => q.currentVisit(taskId).attempt === attempt && q.visitDone(taskId));
}

describe("coding-agent action", () => {
  it("runs a CI loop through checks and repair before the final approval", async () => {
    const check = fileURLToPath(new URL("./fixtures/ci-check.mjs", import.meta.url));
    const workflowId = agentWorkflow({ loopMode: "ci", requireApproval: true, saveResultAs: "", prompt: "Fix CI [ci:fix]",
      ciCheckCommand: `node "${check}"`, ciPublishCommand: `node "${check}" publish`,
    });
    const task = h.engine.createTask({ workflowId, title: "Widget", repoPath: h.dataDir, useWorktree: false });
    const waiting = await waitFor(() => q.latest(task.id, "agent")?.status === "awaiting-approval" ? q.latest(task.id, "agent") : undefined);
    expect(waiting.outputs).toMatchObject({ ci: { passed: true, corrections: 1 }, result: expect.stringContaining("Local and remote checks passed") });
    expect(readFileSync(join(h.dataDir, "ci-publishes"), "utf8")).toBe("publish\npublish\n");
    expect(readFileSync(join(h.dataDir, "ci-checks"), "utf8")).toBe("check\ncheck\n");
    expect(q.detail(task.id).timeline.filter((event) => event.type === "approval.waiting")).toHaveLength(1);
  });

  it("stops an exhausted CI loop without approval", async () => {
    const workflowId = agentWorkflow({ loopMode: "ci", requireApproval: true, saveResultAs: "", ciCheckCommand: 'node -e "process.exit(1)"', maxCorrections: 1 });
    const task = h.engine.createTask({ workflowId, title: "Widget", repoPath: h.dataDir, useWorktree: false });
    const failed = await waitFor(() => q.latest(task.id, "agent")?.status === "failed" ? q.latest(task.id, "agent") : undefined);
    expect(failed.error).toContain("CI loop stopped after 1 correction attempts");
    expect(q.detail(task.id).timeline.some((event) => event.type === "approval.waiting")).toBe(false);
  });

  it("rejects template interpolation in CI commands before rendering task input", async () => {
    const workflowId = agentWorkflow({ loopMode: "ci", ciCheckCommand: "echo {{task.title}}" });
    const task = h.engine.createTask({ workflowId, title: "unsafe shell input", repoPath: h.dataDir, useWorktree: false });
    const failed = await waitFor(() => q.latest(task.id, "agent")?.status === "failed" ? q.latest(task.id, "agent") : undefined);
    expect(failed.error).toContain("CI commands cannot contain template expressions");
  });

  it("reviews a plan loop's work even without your approval, and saves only where it is told to", async () => {
    const workflowId = agentWorkflow({ loopMode: "plan", saveResultAs: "", prompt: "Plan [review:changes]" });
    const task = h.engine.createTask({ workflowId, title: "Widget" });
    await waitFor(() => q.visitDone(task.id));
    const run = q.latest(task.id, "agent");
    expect(run?.outputs).toMatchObject({ review: { decision: "revised" }, result: expect.stringContaining("# Revised plan"), autonomy: "read-only" });
    expect(artifact(task.id, "plan.md")).toBeUndefined();
    expect(artifact(task.id, ".history/steps/agent.md/B1.md")).toContain("codex fresh");
    expect(artifact(task.id, ".history/steps/agent.md/V2.md")).toContain("Result: Clean");
  });

  it("automatically corrects a rejected plan before exposing its approval", async () => {
    const workflowId = agentWorkflow({ loopMode: "plan", prompt: "Plan the widget [review:changes]", requireApproval: true });
    const task = h.engine.createTask({ workflowId, title: "Widget" });
    const waiting = await waitFor(() => q.latest(task.id, "agent")?.status === "awaiting-approval" ? q.latest(task.id, "agent") : undefined);
    expect(artifact(task.id, "result.md")).toBe("# Revised plan\n\nAcceptance criteria: all requested behavior is verified.");
    expect(waiting.outputs).toMatchObject({ review: { decision: "revised", feedback: "Add acceptance criteria" }, result: expect.stringContaining("# Revised plan") });
    expect(q.runs(task.id, "agent")).toHaveLength(1);
    expect(q.detail(task.id).timeline.filter((event) => event.type === "approval.waiting")).toHaveLength(1);
    expect(artifact(task.id, ".history/result.md/B1.md")).toContain("codex fresh");
    expect(artifact(task.id, ".history/result.md/V1.md")).toContain("Add acceptance criteria");
    expect(artifact(task.id, ".history/result.md/B2.md")).toBe(artifact(task.id, "result.md"));
    expect(artifact(task.id, ".history/result.md/V2.md")).toContain("Result: Clean");
  });

  it("runs reusable build–verify actions and exposes the history through the artifact API", async () => {
    const workflowId = agentWorkflow({ loopMode: "build-verify", saveResultAs: "requirements.md", prompt: "Requirements [review:changes]", verificationInstructions: "Check acceptance criteria" });
    const task = h.engine.createTask({ workflowId, title: "Widget" });
    await waitFor(() => q.visitDone(task.id));
    expect(q.latest(task.id, "agent")?.status).toBe("succeeded");
    const response = await h.app.request(`/api/tasks/${task.id}/artifacts`);
    const names = ((await response.json()) as { name: string }[]).map((file) => file.name);
    expect(names).toEqual([".history/requirements.md/B1.md", ".history/requirements.md/B2.md", ".history/requirements.md/V1.md", ".history/requirements.md/V2.md", "requirements.md"]);
    const original = await h.app.request(`/api/tasks/${task.id}/artifact?name=${encodeURIComponent(names[0]!)}`);
    expect(await original.text()).toContain("codex fresh");
  });

  it("fails an invalid review without saving it over the document or offering approval", async () => {
    const workflowId = agentWorkflow({ loopMode: "plan", prompt: "Plan [review:invalid]", requireApproval: true });
    const task = h.engine.createTask({ workflowId, title: "Widget" });
    await waitFor(() => q.latest(task.id, "agent")?.status === "failed");
    expect(artifact(task.id, "result.md")).toBeUndefined();
    expect(artifact(task.id, ".history/result.md/B1.md")).toContain("codex fresh");
    expect(artifact(task.id, ".history/result.md/V1.md")).toContain("Result: Invalid review");
    expect(q.detail(task.id).timeline.some((event) => event.type === "approval.waiting")).toBe(false);
  });

  it("offers the code reviewer's final implementation for approval", async () => {
    const workflowId = agentWorkflow({ loopMode: "implementation", requireApproval: true, saveResultAs: "implementation.md" });
    const task = h.engine.createTask({ workflowId, title: "Widget", repoPath: h.dataDir, useWorktree: false });
    const waiting = await waitFor(() => q.latest(task.id, "agent")?.status === "awaiting-approval" ? q.latest(task.id, "agent") : undefined);
    expect(waiting.outputs).toMatchObject({ result: "Final implementation with reviewer fixes and passing checks.", review: { decision: "fixed" }, autonomy: "autonomous" });
    expect(artifact(task.id, "implementation.md")).toBe(waiting.outputs?.result);
    const log = (await (await h.app.request(`/api/runs/${waiting.id}/log`)).json()) as RunLogLine[];
    expect(log.filter((line) => line.kind === "message").at(-1)?.text).toBe(waiting.outputs?.result);
    expect(log.filter((line) => line.kind === "message").some((line) => line.text.startsWith('{"decision"'))).toBe(false);
  });

  it("has no automatic review in a single run", async () => {
    const workflowId = agentWorkflow({ loopMode: "single", requireApproval: true, prompt: "Plan [review:changes]" });
    const task = h.engine.createTask({ workflowId, title: "Widget" });
    await waitFor(() => q.latest(task.id, "agent")?.status === "awaiting-approval");
    expect(artifact(task.id, "result.md")).toContain("codex fresh");
    expect(q.latest(task.id, "agent")?.outputs?.review).toBeUndefined();
  });

  it("runs the agent, saves its final message, and records session and usage", async () => {
    const workflowId = agentWorkflow({ autonomy: "autonomous" });
    // An autonomous agent needs somewhere real to work; without a repo the action refuses to run, and
    // with one it refuses the repository's checkout unless the task says worktrees are off.
    const task = h.engine.createTask({ workflowId, title: "Widget", repoPath: h.dataDir, useWorktree: false });
    await waitFor(() => q.visitDone(task.id));

    const result = artifact(task.id, "result.md") ?? "";
    expect(result).toContain("codex fresh | model:default | access:autonomous | keys:none");
    expect(result).toContain("prompt:Implement Widget");

    const [run] = q.runs(task.id, "agent");
    expect(run?.sessionId).toBe("codex-thread-1");
    expect(run?.outputs).toMatchObject({ agent: "codex", model: null, sessionId: "codex-thread-1", artifact: "result.md" });
    expect(run?.usage).toMatchObject({ inputTokens: 1200, outputTokens: 80, estimated: true });

    // The transcript keeps its shape, so the chat view can pair a call with the result that answers it.
    const log = (await (await h.app.request(`/api/runs/${run!.id}/log`)).json()) as RunLogLine[];
    // The rendered prompt opens the transcript, so a bad template can be told from a bad agent.
    expect(log[0]).toMatchObject({ kind: "prompt", text: "Implement Widget" });
    expect(log).toContainEqual(expect.objectContaining({ kind: "tool", tool: "shell", text: "git status" }));
    expect(log).toContainEqual(expect.objectContaining({ kind: "tool-result", tool: "shell", ok: true }));
    expect(log.filter((line) => line.kind === "message").map((line) => line.text)).not.toEqual([]);
  });

  it("records a huge prompt only as far as it is worth keeping, and says it stopped there", async () => {
    const workflowId = agentWorkflow({ prompt: "x".repeat(25_000) });
    const task = h.engine.createTask({ workflowId, title: "Widget" });
    await waitFor(() => q.visitDone(task.id));

    const [run] = q.runs(task.id, "agent");
    const log = (await (await h.app.request(`/api/runs/${run!.id}/log`)).json()) as RunLogLine[];
    expect(log[0]?.kind).toBe("prompt");
    expect(log[0]?.text).toMatch(/^x{20000}\n\n\[Truncated: the prompt was 25000 characters and only the first 20000 are kept here\.\]$/);
  });

  it("fails before the agent starts when the task's worktree cannot be made", async () => {
    // The data directory is no git repository, so there is nothing to branch from.
    const workflowId = agentWorkflow({ autonomy: "autonomous" });
    const task = h.engine.createTask({ workflowId, title: "Widget", repoPath: h.dataDir });
    await waitFor(() => q.latest(task.id, "agent")?.status === "failed");
    expect(q.latest(task.id, "agent")?.error).toContain("git rev-parse");
    // It never got as far as the agent, so nothing ran and nothing was written.
    expect(artifact(task.id, "result.md")).toBeUndefined();
  });

  it("continues the previous session, and hands over context when the agent changes", async () => {
    const workflowId = agentWorkflow({ autonomy: "autonomous", continueSession: true });
    const task = h.engine.createTask({ workflowId, title: "Widget", repoPath: h.dataDir, useWorktree: false });
    await waitFor(() => q.visitDone(task.id));

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
    await waitFor(() => q.latest(task.id, "agent")?.status === "failed");

    const [failed] = q.runs(task.id, "agent");
    expect(failed?.error).toContain("model exploded");
    expect(failed?.sessionId).toBe("codex-thread-1");

    h.engine.retryRun(failed!.id, { agent: "claude", model: "sonnet" });
    await waitFor(() => q.visitDone(task.id));
    expect(artifact(task.id, "result.md")).toContain("claude fresh | model:sonnet | access:read-only");
    expect(q.runs(task.id, "agent").at(-1)?.usage).toMatchObject({ inputTokens: 1010, costUsd: 0.0123 });
  });

  it("runs with the agent's saved default model and effort, which task choices override", async () => {
    await h.agents.setDefaults("codex", { model: "gpt-5.5", effort: "high" });
    const workflowId = agentWorkflow({});
    const task = h.engine.createTask({ workflowId, title: "Widget" });
    await waitFor(() => q.visitDone(task.id));
    expect(artifact(task.id, "result.md")).toContain("model:gpt-5.5 | access:read-only | keys:none | effort:high");
    expect(q.runs(task.id, "agent")[0]?.outputs).toMatchObject({ model: "gpt-5.5", effort: "high" });

    // An effort chosen above the default model still pairs with it...
    h.engine.updateTask(task.id, { effortOverride: "low" });
    await reenter(task.id, workflowId, 2);
    expect(artifact(task.id, "result.md")).toContain("model:gpt-5.5 | access:read-only | keys:none | effort:low");

    // ...but a model chosen above it doesn't inherit the default's effort, which was meant for another model.
    h.engine.updateTask(task.id, { modelOverride: "gpt-6-astra", effortOverride: null });
    await reenter(task.id, workflowId, 3);
    expect(artifact(task.id, "result.md")).toContain("model:gpt-6-astra | access:read-only | keys:none | effort:default");
  });

  it("fills a blank agent, model and effort from the stage's defaults, which an action naming another agent skips", async () => {
    const coding = (key: string, agent: string) => ({
      key,
      label: key,
      actionType: "coding-agent",
      config: { agent, prompt: "Go", saveResultAs: `${key}.md` },
    });
    const workflowId = h.addWorkflow({
      name: "Staged",
      description: "",
      stages: [
        {
          name: "Work",
          agentDefaults: { agent: "claude", model: "sonnet", effort: "high" },
          bindings: [coding("staged", ""), coding("codex", "codex")],
        },
        { name: "Done" },
      ],
    });
    const task = h.engine.createTask({ workflowId, title: "Widget" });
    await waitFor(() => q.visitDone(task.id));
    expect(artifact(task.id, "staged.md")).toContain("claude fresh | model:sonnet | access:read-only | keys:none | effort:high");
    // The stage's Claude model means nothing to Codex.
    expect(artifact(task.id, "codex.md")).toContain("codex fresh | model:default | access:read-only | keys:none | effort:default");
  });

  it("stops an agent that goes quiet", async () => {
    const workflowId = agentWorkflow({ prompt: "HANG", inactivityTimeoutSec: 1 });
    const task = h.engine.createTask({ workflowId, title: "Widget" });
    await waitFor(() => q.runs(task.id, "agent")[0]?.status === "failed", { timeout: 20_000 });
    expect(q.runs(task.id, "agent")[0]?.error).toMatch(/No output for 1s/);
  });

  it("reports status and tests agents over the API", async () => {
    const statuses = (await (await h.app.request("/api/agents")).json()) as AgentStatus[];
    expect(statuses.map((status) => status.id)).toEqual(["claude", "codex", "opencode", "cursor"]);
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

  it("keeps repeated revisions in one session and blocks later actions until explicit approval", async () => {
    const workflowId = h.addWorkflow({
      name: "Review loop", description: "",
      stages: [{ name: "Work", bindings: [
        { key: "agent", label: "Agent", actionType: "coding-agent", config: {
          agent: "codex", loopMode: "plan", prompt: "Implement {{task.title}}", saveResultAs: "result.md",
          requireApproval: true, approvalInstructions: "Check {{task.title}}",
        } },
        { key: "afterApproval", label: "Continue workflow", actionType: "write-artifact", config: { name: "approved.md", content: "Approved" } },
      ] }],
    });
    const task = h.engine.createTask({ workflowId, title: "Widget" });

    const waiting = await waitFor(() =>
      q.latest(task.id, "agent")?.status === "awaiting-approval" ? q.latest(task.id, "agent") : undefined,
    );
    expect(waiting.outputs?.instructions).toBe("Check Widget");
    expect(artifact(task.id, "result.md")).toContain("codex fresh");
    expect(q.detail(task.id).task).toMatchObject({
      badge: "needs-you",
      // Its review happens in its chat, so the sidebar list opens that.
      badgeDetail: { label: "Agent", reason: "approval", chatRunId: waiting.id },
    });
    // Nothing below it has moved: the stage is still on this action.
    expect(q.visitDone(task.id)).toBe(false);
    expect(q.latest(task.id, "afterApproval")?.status).toBe("waiting");
    const post = (path: string, body?: unknown) => h.app.request(path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await post(`/api/runs/${waiting.id}/request-changes`, { note: "   " })).status).toBe(400);

    // Changes go to the agent, in the session it just used, on the same run.
    expect((await post(`/api/runs/${waiting.id}/request-changes`, { note: "Use fewer words" })).status).toBe(200);
    // Double submission and approval while the revision is in flight are rejected.
    expect((await post(`/api/runs/${waiting.id}/request-changes`, { note: "Duplicate" })).status).toBe(409);
    expect((await post(`/api/runs/${waiting.id}/approve`)).status).toBe(409);
    const revised = await waitFor(() => {
      const text = artifact(task.id, "result.md");
      return text?.includes("resumed") ? text : undefined;
    });
    expect(revised).toContain("codex resumed codex-thread-1");
    expect(revised).toContain("prompt:Use fewer words");
    expect(artifact(task.id, ".history/result.md/B1.md")).toContain("codex fresh");
    expect(artifact(task.id, ".history/result.md/B2.md")).toBe(revised);
    expect(artifact(task.id, ".history/result.md/V2.md")).toContain("Result: Clean");
    // The note went to this agent; later stages must not read it as feedback on their own work.
    expect(q.detail(task.id).task.lastFeedback).toBeNull();
    expect(q.runs(task.id, "agent")).toHaveLength(1);

    const again = await waitFor(() =>
      q.latest(task.id, "agent")?.status === "awaiting-approval" ? q.latest(task.id, "agent") : undefined,
    );
    // Your words read as your turn in the chat, so the revision is one conversation.
    const log = (await (await h.app.request(`/api/runs/${again.id}/log`)).json()) as RunLogLine[];
    expect(log).toContainEqual(expect.objectContaining({ kind: "answer", text: "Use fewer words" }));
    // A revision sends your words and nothing else, and that is what the transcript records.
    const prompts = log.filter((line) => line.kind === "prompt").map((line) => line.text);
    expect(prompts).toEqual([
      "Implement Widget", expect.stringContaining("Review the following document independently"),
      "Use fewer words", expect.stringContaining("Requested changes:\nUse fewer words"),
    ]);

    expect(q.latest(task.id, "afterApproval")?.status).toBe("waiting");
    expect((await post(`/api/runs/${again.id}/request-changes`, { note: "Now add a concrete example" })).status).toBe(200);
    await waitFor(() => q.latest(task.id, "agent")?.status === "awaiting-approval");
    expect(artifact(task.id, "result.md")).toContain("codex resumed codex-thread-1");
    expect(artifact(task.id, "result.md")).toContain("prompt:Now add a concrete example");
    expect(artifact(task.id, ".history/result.md/B3.md")).toBe(artifact(task.id, "result.md"));
    expect(artifact(task.id, ".history/result.md/B1.md")).toContain("codex fresh");
    expect(q.runs(task.id, "agent")).toHaveLength(1);
    expect(q.latest(task.id, "afterApproval")?.status).toBe("waiting");
    expect(artifact(task.id, "approved.md")).toBeUndefined();
    const fullLog = (await (await h.app.request(`/api/runs/${again.id}/log`)).json()) as RunLogLine[];
    expect(fullLog.filter((line) => line.kind === "answer").map((line) => line.text)).toEqual([
      "Use fewer words", "Now add a concrete example",
    ]);
    expect(q.detail(task.id).timeline.filter((event) => event.type === "run.changes-requested")).toHaveLength(2);

    expect((await post(`/api/runs/${again.id}/approve`)).status).toBe(200);
    await waitFor(() => q.visitDone(task.id));
    expect(q.latest(task.id, "agent")?.outputs).toMatchObject({ decision: "approved" });
    expect(artifact(task.id, "approved.md")).toBe("Approved");
    expect((await post(`/api/runs/${again.id}/approve`)).status).toBe(409);
    expect((await post(`/api/runs/${again.id}/request-changes`, { note: "Too late" })).status).toBe(409);
  });

  it("only offers Request changes where there is an agent to send them to", async () => {
    const workflowId = agentWorkflow({});
    const task = h.engine.createTask({ workflowId, title: "Widget" });
    await waitFor(() => q.visitDone(task.id));
    // Succeeded, not held open: the action was never asked to wait.
    expect(() => h.engine.requestChanges(q.latest(task.id, "agent")!.id, "more")).toThrow(/not waiting for approval/);
  });

  it("saves agent defaults over the API, and rejects effort levels the agent doesn't offer", async () => {
    const json = { "content-type": "application/json" };
    const defaults = (body: object) => h.app.request("/api/agents/claude/defaults", { method: "PUT", headers: json, body: JSON.stringify(body) });
    expect((await defaults({ model: "opus", effort: "turbo" })).status).toBe(400);
    expect(await (await defaults({ model: "opus", effort: "max" })).json()).toMatchObject({ defaultModel: "opus", defaultEffort: "max" });

    // A test with nothing chosen uses the saved default.
    const test = await h.app.request("/api/agents/claude/test", { method: "POST", headers: json, body: "{}" });
    expect(((await test.json()) as AgentTestResult).text).toContain("model:opus | access:read-only | keys:none | effort:max");

    const workflowId = agentWorkflow({ agent: "claude" });
    const task = h.engine.createTask({ workflowId, title: "Widget" });
    const patch = (body: object) => h.app.request(`/api/tasks/${task.id}`, { method: "PATCH", headers: json, body: JSON.stringify(body) });
    expect((await patch({ agentOverride: "claude", effortOverride: "turbo" })).status).toBe(400);
    expect((await patch({ agentOverride: "claude", effortOverride: "low" })).status).toBe(200);
    const retry = await h.app.request(`/api/runs/${q.runs(task.id, "agent")[0]!.id}/retry`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ overrides: { agent: "claude", model: "", effort: "turbo" } }),
    });
    expect(retry.status).toBe(400);
  });
});
