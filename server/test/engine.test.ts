import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approval } from "../src/seed/workflows";
import { createHarness, type Harness, inspect, removeDir, waitFor } from "./helpers";
import { releaseGate, resetTestActions } from "./test-actions";

let h: Harness;
let q: ReturnType<typeof inspect>;

function useHarness(options?: Parameters<typeof createHarness>[0]) {
  h = createHarness(options);
  q = inspect(h);
}

beforeEach(() => useHarness());
afterEach(async () => {
  await h.close();
  removeDir(h.dataDir);
  resetTestActions();
});

const artifact = (taskId: string, name: string) => {
  const file = join(h.paths.artifactDir(taskId), name);
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
};

// Reads a.md from the artifacts dir and reports it as an output via $WM_OUTPUT_FILE.
const READ_A = `node -e "const fs=require('fs');fs.writeFileSync(process.env.WM_OUTPUT_FILE, JSON.stringify({seen: fs.readFileSync('a.md','utf8')}))"`;

describe("engine", () => {
  it("runs a stage's actions in order, waits at an approval, and moves on", async () => {
    const workflowId = h.addWorkflow({
      name: "Flow",
      description: "",
      stages: [
        { name: "Backlog" },
        {
          name: "Build",
          bindings: [
            { key: "writeA", label: "Write A", actionType: "write-artifact", config: { name: "a.md", content: "hello {{task.title}}" } },
            { key: "readA", label: "Read A", actionType: "shell", config: { command: READ_A, cwd: "artifacts" } },
            approval("check", "Check", { instructions: "Check {{outputs.readA.seen}}" }),
            { key: "next", label: "Next", actionType: "move-stage", config: { target: "next" } },
          ],
        },
        {
          name: "Done",
          bindings: [
            {
              key: "summary",
              label: "Summary",
              actionType: "write-artifact",
              config: { name: "summary.md", content: '{{outputs.readA.seen}} | {{artifacts["a.md"]}} | {{stage.name}}' },
            },
          ],
        },
      ],
    });

    const task = h.engine.createTask({ workflowId, title: "Widget" });
    expect(q.stageName(task.id)).toBe("Backlog");
    expect(q.detail(task.id).task).toMatchObject({ badge: "idle", actionProgress: { done: 0, total: 0 } });

    h.engine.moveTask(task.id, h.stageId(workflowId, "Build"));
    const check = await waitFor(() =>
      q.latest(task.id, "check")?.status === "awaiting-approval" ? q.latest(task.id, "check") : undefined,
    );
    expect(q.latest(task.id, "readA")?.outputs).toEqual({ seen: "hello Widget" });
    expect(q.latest(task.id, "next")?.status).toBe("waiting");
    // Rendered when the approval started waiting, so it describes the task as it stands.
    expect(check.outputs).toEqual({ instructions: "Check hello Widget" });
    // A standalone Approval has no chat to open, and no agent to ask for changes.
    expect(q.detail(task.id).task.badgeDetail).not.toHaveProperty("chatRunId");
    expect(() => h.engine.requestChanges(check.id, "More")).toThrow(/has no agent to send changes to/);
    expect(q.detail(task.id).task).toMatchObject({
      badge: "needs-you",
      badgeDetail: { label: "Check", reason: "approval" },
      actionProgress: { done: 2, total: 4 },
    });

    const build = q.currentVisit(task.id);
    h.engine.approveRun(check.id);
    await waitFor(() => artifact(task.id, "summary.md"));
    expect(q.stageName(task.id)).toBe("Done");
    expect(artifact(task.id, "summary.md")).toBe("hello Widget | hello Widget | Done");
    const finished = q.detail(task.id).visits.find((visit) => visit.id === build.id)!;
    expect(finished.completedAt).not.toBeNull();
    expect(finished.runs.find((run) => run.bindingKey === "check")?.outputs).toMatchObject({ decision: "approved" });
  });

  it("holds the rest of the list after a failure until the action is retried or skipped", async () => {
    const workflowId = h.addWorkflow({
      name: "Flaky",
      description: "",
      stages: [
        { name: "Backlog" },
        {
          name: "Work",
          bindings: [
            { key: "flaky", label: "Flaky", actionType: "test-flaky", config: { key: "{{task.title}}", failures: 1 } },
            {
              key: "after",
              label: "After",
              actionType: "write-artifact",
              config: { name: "after.md", content: "attempt {{outputs.flaky.attempt}}" },
            },
          ],
        },
      ],
    });
    const workId = h.stageId(workflowId, "Work");

    const retried = h.engine.createTask({ workflowId, title: "retry", stageId: workId });
    const failed = await waitFor(() => (q.latest(retried.id, "flaky")?.status === "failed" ? q.latest(retried.id, "flaky") : undefined));
    await h.runner.idle();
    expect(q.latest(retried.id, "after")?.status).toBe("waiting");
    expect(q.detail(retried.id).task).toMatchObject({ badge: "failed", badgeDetail: { label: "Flaky" } });

    h.engine.retryRun(failed.id);
    await waitFor(() => q.visitDone(retried.id));
    expect(artifact(retried.id, "after.md")).toBe("attempt 2");
    expect(q.runs(retried.id, "flaky").map((run) => run.status)).toEqual(["failed", "succeeded"]);
    expect(() => h.engine.retryRun(failed.id)).toThrow(/Cannot retry a succeeded run|newer attempt/);

    const skipped = h.engine.createTask({ workflowId, title: "skip", stageId: workId });
    const failure = await waitFor(() => (q.latest(skipped.id, "flaky")?.status === "failed" ? q.latest(skipped.id, "flaky") : undefined));
    h.engine.skipRun(failure.id);
    await waitFor(() => q.visitDone(skipped.id));
    expect(q.latest(skipped.id, "flaky")).toMatchObject({ status: "skipped", error: "flaky failure 1" });
    // A skipped action has no outputs to offer the ones after it.
    expect(artifact(skipped.id, "after.md")).toBe("attempt ");
    expect(q.detail(skipped.id).task.badge).toBe("idle");
    expect(() => h.engine.skipRun(failure.id)).toThrow(/Only a failed, cancelled or interrupted/);
  });

  it("carries on past a failure when the action allows it", async () => {
    const workflowId = h.addWorkflow({
      name: "Tolerant",
      description: "",
      stages: [
        {
          name: "Work",
          bindings: [
            { key: "tracker", label: "Tracker", actionType: "test-flaky", config: { key: "tracker", failures: 5 }, continueOnFailure: true },
            { key: "after", label: "After", actionType: "write-artifact", config: { name: "after.md", content: "ran" } },
          ],
        },
      ],
    });
    const task = h.engine.createTask({ workflowId, title: "Tolerant" });
    await waitFor(() => q.visitDone(task.id));
    expect(q.latest(task.id, "tracker")?.status).toBe("failed");
    expect(artifact(task.id, "after.md")).toBe("ran");
    expect(q.detail(task.id).task).toMatchObject({ badge: "idle", actionProgress: { done: 2, total: 2 } });
    expect(q.detail(task.id).timeline.some((event) => event.message.startsWith("Tracker failed (continuing)"))).toBe(true);
  });

  it("warns once per run about references that rendered empty", async () => {
    const workflowId = h.addWorkflow({
      name: "Blanks",
      description: "",
      stages: [
        {
          name: "Work",
          bindings: [
            {
              key: "write",
              label: "Write",
              actionType: "write-artifact",
              config: { name: "out.md", content: '[{{artifacts["requirements.md"]}}][{{outputs.openMr.mrUrl}}][{{task.title}}]' },
            },
            // No feedback yet is the normal case, not a missing value.
            { key: "fine", label: "Fine", actionType: "write-artifact", config: { name: "fine.md", content: "{{task.title}}{{task.lastFeedback}}" } },
          ],
        },
      ],
    });
    const task = h.engine.createTask({ workflowId, title: "Widget" });
    await waitFor(() => q.visitDone(task.id));

    // The empty string still renders; the warning is the only new thing.
    expect(artifact(task.id, "out.md")).toBe("[][][Widget]");
    const warnings = q.detail(task.id).timeline.filter((event) => event.type === "template.unresolved");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe(
      'Write: {{artifacts["requirements.md"]}}, {{outputs.openMr.mrUrl}} are missing; those parts rendered empty',
    );
  });

  it("cancels running actions when a task is moved, and can move in without running them until Start", async () => {
    const workflowId = h.addWorkflow({
      name: "Cancel",
      description: "",
      stages: [
        {
          name: "Work",
          bindings: [
            { key: "wait", label: "Wait", actionType: "test-wait", config: { gate: "never" } },
            { key: "off", label: "Off", actionType: "write-artifact", config: { name: "off.md", content: "" }, enabled: false },
          ],
        },
        { name: "Done" },
      ],
    });
    const workId = h.stageId(workflowId, "Work");
    const task = h.engine.createTask({ workflowId, title: "Cancel me" });
    await waitFor(() => q.latest(task.id, "wait")?.status === "running");
    // Disabled actions never join the list.
    expect(q.currentVisit(task.id).runs.map((run) => run.bindingKey)).toEqual(["wait"]);

    h.engine.moveTask(task.id, h.stageId(workflowId, "Done"));
    expect(q.runs(task.id, "wait")[0]?.status).toBe("cancelled");
    expect(q.stageName(task.id)).toBe("Done");

    h.engine.moveTask(task.id, workId, { runActions: false });
    const visit = q.currentVisit(task.id);
    expect(visit.attempt).toBe(2);
    expect(visit.runs).toHaveLength(0);
    expect(q.detail(task.id).task).toMatchObject({
      badge: "needs-you",
      badgeDetail: { label: "Work", reason: "start" },
      actionProgress: { done: 0, total: 1 },
    });

    h.engine.startActions(task.id);
    await waitFor(() => q.latest(task.id, "wait")?.status === "running");
    expect(() => h.engine.startActions(task.id)).toThrow(/already started/);
    h.engine.moveTask(task.id, h.stageId(workflowId, "Done"), { runActions: false });
    expect(() => h.engine.startActions(task.id)).toThrow(/no actions to run/);
  });

  it("sends a task back from an approval with a note", async () => {
    const workflowId = h.addWorkflow({
      name: "Review",
      description: "",
      stages: [
        { name: "Backlog", bindings: [approval("ready", "Ready"), { key: "toReview", label: "Next", actionType: "move-stage", config: { target: "next" } }] },
        {
          name: "Review",
          bindings: [approval("review", "Review", { sendBackTo: "Backlog" }), { key: "ship", label: "Ship", actionType: "write-artifact", config: { name: "ship.md", content: "" } }],
        },
      ],
    });
    const task = h.engine.createTask({ workflowId, title: "Manual" });
    const ready = q.latest(task.id, "ready")!;
    expect(ready.status).toBe("awaiting-approval");
    expect(() => h.engine.sendBack(ready.id)).toThrow(/has no Send back/);
    h.engine.approveRun(ready.id);
    await waitFor(() => q.stageName(task.id) === "Review");

    const review = q.latest(task.id, "review")!;
    h.engine.sendBack(review.id, { note: "needs tests" });
    expect(q.stageName(task.id)).toBe("Backlog");
    expect(q.detail(task.id).task.lastFeedback).toBe("needs tests");
    expect(q.currentVisit(task.id).attempt).toBe(2);
    const reviewRuns = q.runs(task.id, "review");
    expect(reviewRuns[0]).toMatchObject({ status: "succeeded", outputs: { decision: "sent back", stageName: "Backlog" } });
    // Nothing after the approval started, and the old approval can't be decided twice.
    expect(q.runs(task.id, "ship")[0]?.status).toBe("cancelled");
    expect(() => h.engine.approveRun(review.id)).toThrow(/not waiting for approval/);
    await h.runner.idle();
    expect(artifact(task.id, "ship.md")).toBeUndefined();

    // Once the stage it was sent back to is signed off, the note has been dealt with.
    const readyAgain = q.latest(task.id, "ready")!;
    expect(readyAgain.status).toBe("awaiting-approval");
    h.engine.approveRun(readyAgain.id);
    expect(q.detail(task.id).task.lastFeedback).toBeNull();
  });

  it("caps concurrent long-running actions and queues the rest", async () => {
    await h.close();
    removeDir(h.dataDir);
    useHarness({ maxConcurrentLongRuns: 1 });

    const workflowId = h.addWorkflow({
      name: "Agents",
      description: "",
      stages: [
        {
          name: "Agent",
          // Gate name is templated from the task title.
          bindings: [{ key: "agent", label: "Agent", actionType: "test-long-wait", config: { gate: "{{task.title}}" } }],
        },
      ],
    });
    const a = h.engine.createTask({ workflowId, title: "a" });
    const b = h.engine.createTask({ workflowId, title: "b" });
    await waitFor(() => q.latest(a.id, "agent")?.status === "running");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(q.latest(b.id, "agent")?.status).toBe("queued");
    expect(q.detail(b.id).task.badge).toBe("queued");

    releaseGate("a");
    await waitFor(() => q.latest(b.id, "agent")?.status === "running");
    releaseGate("b");
    await waitFor(() => q.visitDone(b.id));
  });

  it("marks runs interrupted when the server stopped while they were running, but keeps approvals waiting", async () => {
    const workflowId = h.addWorkflow({
      name: "Restart",
      description: "",
      stages: [
        { name: "Work", bindings: [{ key: "wait", label: "Wait", actionType: "test-wait", config: { gate: "never" } }] },
        { name: "Gate", bindings: [approval("gate", "Gate")] },
      ],
    });
    const task = h.engine.createTask({ workflowId, title: "Restart" });
    const gated = h.engine.createTask({ workflowId, title: "Gated", stageId: h.stageId(workflowId, "Gate") });
    await waitFor(() => q.latest(task.id, "wait")?.status === "running");

    const { dataDir } = h;
    await h.close();
    useHarness({ dataDir });

    expect(q.latest(task.id, "wait")?.status).toBe("interrupted");
    expect(q.detail(task.id).task.badge).toBe("failed");
    expect(q.detail(task.id).timeline.some((event) => event.type === "run.interrupted")).toBe(true);
    expect(q.latest(gated.id, "gate")?.status).toBe("awaiting-approval");
    expect(q.detail(gated.id).task.badge).toBe("needs-you");
  });
});
