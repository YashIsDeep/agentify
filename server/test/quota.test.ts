import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONTINUE_AFTER_LIMIT } from "../src/actions/coding-agent";
import { claudeAdapter } from "../src/agents/claude";
import { detectUsageLimit, parseResetTime } from "../src/agents/limits";
import { createHarness, type Harness, inspect, removeDir, waitFor } from "./helpers";
import { resetTestActions } from "./test-actions";

const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

describe("usage limit detection", () => {
  const now = new Date(2026, 8, 11, 10, 0).getTime();

  it("reads Codex's reset time", () => {
    const text =
      "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 6th, 2026 2:40 AM.";
    expect(detectUsageLimit(text, now)).toEqual({ resetAt: new Date(2026, 8, 6, 2, 40).getTime() });
  });

  it("reads Claude Code's reset clock in the zone it names", () => {
    const utcTen = Date.UTC(2026, 8, 11, 10, 0);
    expect(parseResetTime("5-hour limit reached ∙ resets 3pm (UTC)", utcTen)).toBe(Date.UTC(2026, 8, 11, 15, 0));
    // 9am in Kolkata has already gone by (it is 3:30pm there), so it means tomorrow's.
    expect(parseResetTime("You've hit your limit · resets 9am (Asia/Kolkata)", utcTen)).toBe(Date.UTC(2026, 8, 12, 3, 30));
    expect(parseResetTime("Weekly limit reached · resets Sep 14, 2pm (UTC)", utcTen)).toBe(Date.UTC(2026, 8, 14, 14, 0));
  });

  it("reads epoch and relative times, and leaves an unstated one blank", () => {
    expect(detectUsageLimit("Claude AI usage limit reached|1789500000", now)).toEqual({ resetAt: 1_789_500_000_000 });
    expect(parseResetTime("try again in 2h 30m", now)).toBe(now + 9_000_000);
    expect(detectUsageLimit("Claude AI usage limit reached", now)).toEqual({ resetAt: null });
  });

  it("ignores failures that aren't usage limits", () => {
    expect(detectUsageLimit("context limit reached", now)).toBeNull();
    expect(detectUsageLimit("Insufficient balance", now)).toBeNull();
    expect(detectUsageLimit("model exploded", now)).toBeNull();
  });

  it("turns Claude Code's rejected rate_limit_event into a limit", () => {
    const parser = claudeAdapter.createParser();
    const events = [
      { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1789500000 } },
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1789500000, rateLimitType: "five_hour" } },
    ].flatMap((event) => parser.push(JSON.stringify(event)));
    expect(events).toEqual([{ kind: "limit", resetAt: 1_789_500_000_000 }]);
  });
});

describe("waiting for a usage limit", () => {
  let h: Harness;
  let q: ReturnType<typeof inspect>;

  beforeEach(() => {
    h = createHarness();
    q = inspect(h);
  });
  afterEach(async () => {
    await h.close();
    removeDir(h.dataDir);
    resetTestActions();
  });

  const quotaWorkflow = (config: Record<string, unknown>) =>
    h.addWorkflow({
      name: "Quota",
      description: "",
      stages: [
        {
          name: "Work",
          bindings: [
            { key: "build", label: "Build", actionType: "test-quota", config },
            {
              key: "after",
              label: "After",
              actionType: "write-artifact",
              config: { name: "after.md", content: "done" },
            },
          ],
        },
      ],
    });

  it("parks the run, badges the task, and carries the same run on at the reset", async () => {
    const task = h.engine.createTask({ workflowId: quotaWorkflow({ key: "a", limits: 1, waitMs: 400 }), title: "Limited" });
    const parked = await waitFor(() => q.runs(task.id, "build").find((run) => run.status === "quota-wait"));

    const summary = q.detail(task.id).task;
    expect(summary.badge).toBe("quota");
    expect(summary.badgeDetail).toEqual({ label: "Build", agent: "claude", resetAt: parked.resumeAt });
    // Not a failure: the rest of the list waits its turn.
    expect(q.runs(task.id, "after")[0]?.status).toBe("waiting");

    await waitFor(() => q.visitDone(task.id));
    expect(q.runs(task.id, "build")).toEqual([expect.objectContaining({ status: "succeeded", resumeAt: null, outputs: { attempt: 2 } })]);
    expect(q.detail(task.id).timeline.map((event) => event.type)).toEqual(expect.arrayContaining(["run.quota-wait", "run.resumed"]));
  });

  it("tries again on request, and cancels like any active run", async () => {
    const task = h.engine.createTask({ workflowId: quotaWorkflow({ key: "b", limits: 2, waitMs: 3_600_000 }), title: "Limited" });
    const parked = await waitFor(() => q.runs(task.id, "build").find((run) => run.status === "quota-wait"));
    expect(h.engine.nextQuotaResumeAt()).toBe(parked.resumeAt);

    const response = await h.app.request(`/api/runs/${parked.id}/resume`, { method: "POST" });
    expect(response.status).toBe(200);
    await waitFor(() => q.detail(task.id).timeline.filter((event) => event.type === "run.quota-wait").length === 2);
    const again = q.runs(task.id, "build")[0]!;
    expect(again.status).toBe("quota-wait");

    h.engine.cancelRun(again.id);
    expect(q.runs(task.id, "build")[0]?.status).toBe("cancelled");
    expect(q.detail(task.id).task.badge).toBe("failed");
    expect(h.engine.nextQuotaResumeAt()).toBeNull();
  });

  it("says which approval a needs-you badge is waiting on", () => {
    const workflowId = h.addWorkflow({
      name: "Manual",
      description: "",
      stages: [{ name: "Review", bindings: [{ key: "approve", label: "Approve requirements", actionType: "approval", config: {} }] }],
    });
    const task = h.engine.createTask({ workflowId, title: "Approve me" });
    expect(q.detail(task.id).task).toMatchObject({
      badge: "needs-you",
      badgeDetail: { label: "Approve requirements", reason: "approval" },
    });
  });

  it("waits for Codex's reset, holds the agent's other runs, and resumes the run's own session", async () => {
    h.agents.setPathOverride("codex", FAKE_CODEX);
    const workflowId = h.addWorkflow({
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
              config: { agent: "codex", prompt: "{{task.title}}", saveResultAs: "result.md" },
            },
          ],
        },
      ],
    });

    const first = h.engine.createTask({ workflowId, title: "LIMIT me" });
    const parked = await waitFor(() => q.runs(first.id, "agent").find((run) => run.status === "quota-wait"));
    expect(parked).toMatchObject({ resumeAt: new Date(2099, 8, 6, 2, 40).getTime(), sessionId: "codex-thread-1" });
    expect(parked.error).toContain("usage limit");

    // The limit is the account's: another Codex run waits with it, without spending a request.
    const second = h.engine.createTask({ workflowId, title: "Other work" });
    const held = await waitFor(() => q.runs(second.id, "agent").find((run) => run.status === "quota-wait"));
    expect(held).toMatchObject({ resumeAt: parked.resumeAt, sessionId: null });

    // Try now: the same run carries on in its session, nudged rather than handed the prompt again.
    expect((await h.app.request(`/api/runs/${parked.id}/resume`, { method: "POST" })).status).toBe(200);
    await waitFor(() => q.visitDone(first.id));
    const file = join(h.paths.artifactDir(first.id), "result.md");
    const result = existsSync(file) ? readFileSync(file, "utf8") : "";
    expect(result).toContain("codex resumed codex-thread-1");
    expect(result).toContain(`prompt:${CONTINUE_AFTER_LIMIT}`);
    expect(q.runs(first.id, "agent")).toHaveLength(1);
  });
});
