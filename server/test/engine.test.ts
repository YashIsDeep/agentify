import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  it("runs a phase's actions in order, auto-completes it, and advances on stage completion", async () => {
    const workflowId = h.addWorkflow({
      name: "Flow",
      description: "",
      stages: [
        { name: "Backlog" },
        {
          name: "Build",
          phases: [
            { name: "Generate", completion: "auto" },
            { name: "Check", completion: "manual" },
          ],
          bindings: [
            {
              key: "writeA",
              label: "Write A",
              trigger: "phase.started",
              phase: "Generate",
              actionType: "write-artifact",
              config: { name: "a.md", content: "hello {{task.title}}" },
            },
            {
              key: "readA",
              label: "Read A",
              trigger: "phase.started",
              phase: "Generate",
              actionType: "shell",
              config: { command: READ_A, cwd: "artifacts" },
            },
            { key: "next", label: "Next", trigger: "stage.completed", actionType: "move-stage", config: { target: "next" } },
          ],
        },
        {
          name: "Done",
          bindings: [
            {
              key: "summary",
              label: "Summary",
              trigger: "stage.entered",
              actionType: "write-artifact",
              config: { name: "summary.md", content: '{{outputs.readA.seen}} | {{artifacts["a.md"]}} | {{stage.name}}' },
            },
          ],
        },
      ],
    });

    const task = h.engine.createTask({ workflowId, title: "Widget" });
    expect(q.stageName(task.id)).toBe("Backlog");
    expect(q.detail(task.id).task.badge).toBe("idle");

    h.engine.moveTask(task.id, h.stageId(workflowId, "Build"));
    await waitFor(() => q.phase(task.id, "Check").status === "running");
    expect(q.phase(task.id, "Generate")).toMatchObject({ status: "done", completedBy: "auto" });
    expect(q.runs(task.id, "readA")[0]?.outputs).toEqual({ seen: "hello Widget" });
    expect(q.detail(task.id).task.badge).toBe("needs-you");

    h.engine.completePhase(task.id, q.phase(task.id, "Check").id);
    await waitFor(() => artifact(task.id, "summary.md"));
    expect(q.stageName(task.id)).toBe("Done");
    expect(artifact(task.id, "summary.md")).toBe("hello Widget | hello Widget | Done");
  });

  it("skips the rest of a batch on failure, fires action.failed, and resumes after a retry", async () => {
    const workflowId = h.addWorkflow({
      name: "Flaky",
      description: "",
      stages: [
        { name: "Backlog" },
        {
          name: "Work",
          phases: [{ name: "Do", completion: "auto" }],
          bindings: [
            { key: "flaky", label: "Flaky", trigger: "phase.started", phase: "Do", actionType: "test-flaky", config: { key: "k" } },
            {
              key: "after",
              label: "After",
              trigger: "phase.started",
              phase: "Do",
              actionType: "write-artifact",
              config: { name: "after.md", content: "attempt {{outputs.flaky.attempt}}" },
            },
            {
              key: "onFail",
              label: "On failure",
              trigger: "action.failed",
              after: "flaky",
              actionType: "write-artifact",
              config: { name: "failed.md", content: "failed" },
            },
          ],
        },
      ],
    });

    const task = h.engine.createTask({ workflowId, title: "Flaky", stageId: h.stageId(workflowId, "Work") });
    await waitFor(() => q.phase(task.id, "Do").status === "failed");
    expect(artifact(task.id, "failed.md")).toBe("failed");
    const [failed] = q.runs(task.id, "flaky");
    expect(failed?.status).toBe("failed");
    expect(q.runs(task.id, "after")[0]?.status).toBe("skipped");
    expect(q.detail(task.id).task.badge).toBe("failed");

    h.engine.retryRun(failed!.id);
    await waitFor(() => q.phase(task.id, "Do").status === "done");
    expect(artifact(task.id, "after.md")).toBe("attempt 2");
    expect(q.runs(task.id, "flaky").map((run) => run.status)).toEqual(["failed", "succeeded"]);
    expect(q.currentVisit(task.id).completedAt).not.toBeNull();
    expect(() => h.engine.retryRun(failed!.id)).toThrow(/Cannot retry a succeeded run|newer attempt/);
  });

  it("cancels running actions when a task is moved, fires stage.exited, and can move without actions", async () => {
    const workflowId = h.addWorkflow({
      name: "Cancel",
      description: "",
      stages: [
        {
          name: "Work",
          phases: [{ name: "Wait", completion: "auto" }],
          bindings: [
            { key: "wait", label: "Wait", trigger: "phase.started", phase: "Wait", actionType: "test-wait", config: { gate: "never" } },
            {
              key: "exited",
              label: "On exit",
              trigger: "stage.exited",
              actionType: "write-artifact",
              config: { name: "exited.md", content: "left {{stage.name}}" },
            },
          ],
        },
        { name: "Done" },
      ],
    });
    const workId = h.stageId(workflowId, "Work");
    const task = h.engine.createTask({ workflowId, title: "Cancel me" });
    await waitFor(() => q.runs(task.id, "wait")[0]?.status === "running");

    h.engine.moveTask(task.id, h.stageId(workflowId, "Done"));
    expect(q.runs(task.id, "wait")[0]?.status).toBe("cancelled");
    await waitFor(() => artifact(task.id, "exited.md"));
    expect(artifact(task.id, "exited.md")).toBe("left Work");
    expect(q.stageName(task.id)).toBe("Done");

    h.engine.moveTask(task.id, workId, { runActions: false });
    const visit = q.currentVisit(task.id);
    expect(visit.attempt).toBe(2);
    expect(visit.runs).toHaveLength(0);
    expect(visit.phases[0]?.status).toBe("running");
    expect(q.detail(task.id).task.badge).toBe("needs-you");
  });

  it("completes phaseless stages and runs manual actions with feedback", async () => {
    const workflowId = h.addWorkflow({
      name: "Manual",
      description: "",
      stages: [
        {
          name: "Backlog",
          bindings: [{ key: "toReview", label: "Next", trigger: "stage.completed", actionType: "move-stage", config: { target: "next" } }],
        },
        {
          name: "Review",
          phases: [{ name: "Review", completion: "manual" }],
          bindings: [
            {
              key: "sendBack",
              label: "Send back",
              trigger: "manual",
              actionType: "move-stage",
              config: { target: "@stage:Backlog" },
              askFeedback: true,
            },
          ],
        },
      ],
    });
    const task = h.engine.createTask({ workflowId, title: "Manual" });
    h.engine.completeStage(task.id);
    await waitFor(() => q.stageName(task.id) === "Review");

    const sendBack = h.engine.getWorkflow(workflowId).stages[1]!.bindings[0]!;
    expect(sendBack.askFeedback).toBe(true);
    h.engine.triggerManual(task.id, sendBack.id, { feedback: "needs tests" });
    await waitFor(() => q.stageName(task.id) === "Backlog");
    expect(q.detail(task.id).task.lastFeedback).toBe("needs tests");
    expect(q.currentVisit(task.id).attempt).toBe(2);
    expect(() => h.engine.triggerManual(task.id, sendBack.id)).toThrow(/different stage/);
    expect(() => h.engine.completePhase(task.id, "nope")).toThrow(/not part of/);
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
          phases: [{ name: "Run", completion: "auto" }],
          bindings: [
            // Gate name is templated from the task title.
            { key: "agent", label: "Agent", trigger: "phase.started", phase: "Run", actionType: "test-long-wait", config: { gate: "{{task.title}}" } },
          ],
        },
      ],
    });
    const a = h.engine.createTask({ workflowId, title: "a" });
    const b = h.engine.createTask({ workflowId, title: "b" });
    await waitFor(() => q.runs(a.id, "agent")[0]?.status === "running");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(q.runs(b.id, "agent")[0]?.status).toBe("queued");
    expect(q.detail(b.id).task.badge).toBe("queued");

    releaseGate("a");
    await waitFor(() => q.runs(b.id, "agent")[0]?.status === "running");
    releaseGate("b");
    await waitFor(() => q.phase(b.id, "Run").status === "done");
  });

  it("marks runs interrupted when the server stopped while they were running", async () => {
    const workflowId = h.addWorkflow({
      name: "Restart",
      description: "",
      stages: [
        {
          name: "Work",
          phases: [{ name: "Wait", completion: "auto" }],
          bindings: [{ key: "wait", label: "Wait", trigger: "phase.started", phase: "Wait", actionType: "test-wait", config: { gate: "never" } }],
        },
      ],
    });
    const task = h.engine.createTask({ workflowId, title: "Restart" });
    await waitFor(() => q.runs(task.id, "wait")[0]?.status === "running");

    const { dataDir } = h;
    await h.close();
    useHarness({ dataDir });

    expect(q.runs(task.id, "wait")[0]?.status).toBe("interrupted");
    expect(q.phase(task.id, "Wait").status).toBe("failed");
    expect(q.detail(task.id).task.badge).toBe("failed");
    expect(q.detail(task.id).timeline.some((event) => event.type === "run.interrupted")).toBe(true);
  });
});
