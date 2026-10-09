import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedDefaultWorkflows } from "../src/seed/workflows";
import { createHarness, type Harness, inspect, removeDir, waitFor } from "./helpers";

let h: Harness;

beforeEach(() => {
  h = createHarness({ seed: true });
});

afterEach(async () => {
  await h.close();
  removeDir(h.dataDir);
});

describe("default workflows", () => {
  it("seeds only Feature and Bugfix, with consistent references", () => {
    const workflows = h.engine.listWorkflows();
    expect(workflows.map((w) => w.name)).toEqual(["Feature", "Bugfix"]);
    expect(workflows[0]!.stages.map((st) => st.name)).toEqual(["Backlog", "Plan", "Build", "Ship"]);
    expect(workflows[1]!.stages.map((st) => st.name)).toEqual(["Backlog", "Investigate", "Fix", "Ship"]);

    for (const workflow of workflows) {
      const stageIds = new Set(workflow.stages.map((st) => st.id));
      for (const stage of workflow.stages) {
        for (const binding of stage.bindings) {
          if (binding.actionType === "approval" && binding.config.sendBackTo) {
            expect(stageIds.has(binding.config.sendBackTo as string)).toBe(true);
          }
          if (binding.actionType === "move-stage") {
            const target = binding.config.target as string;
            expect(target === "next" || stageIds.has(target)).toBe(true);
          }
          expect(h.registry.get(binding.actionType)).toBeDefined();
        }
      }
    }
  });

  it("seeds nothing that needs setting up first: every action is switched on and none is boilerplate", () => {
    for (const workflow of h.engine.listWorkflows()) {
      const bindings = workflow.stages.flatMap((stage) => stage.bindings);
      expect(bindings.every((binding) => binding.enabled), `${workflow.name} seeds a switched-off action`).toBe(true);
      // A worktree is made on demand and a finished stage moves on by itself.
      expect(bindings.map((binding) => binding.actionType)).toEqual([
        "coding-agent",
        "coding-agent",
        "open-merge-request",
        "approval",
        "archive-task",
      ]);
      expect(workflow.stages.some((stage) => stage.stayWhenDone)).toBe(false);
    }
  });

  it("does not seed twice", () => {
    expect(seedDefaultWorkflows(h.db, h.sqlite)).toBe(false);
    expect(h.engine.listWorkflows()).toHaveLength(2);
  });

  it("drafts requirements.md, waits for your sign-off, then moves the task on to Build", async () => {
    h.agents.setPathOverride("claude", fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url)));
    const q = inspect(h);
    const feature = h.engine.listWorkflows()[0]!;
    const task = h.engine.createTask({ workflowId: feature.id, title: "Try it" });
    // Backlog has no actions, so the task waits there until it is moved.
    expect(q.stageName(task.id)).toBe("Backlog");
    h.engine.moveTask(task.id, h.stageId(feature.id, "Plan"));

    // The agent signs its own work off, so the draft run is what waits for you.
    const waiting = await waitFor(() =>
      q.latest(task.id, "draftRequirements")?.status === "awaiting-approval" ? q.latest(task.id, "draftRequirements") : undefined,
    );
    expect(waiting.outputs?.instructions).toBe("Read requirements.md under Artifacts. Request changes and the agent redrafts it.");
    const requirements = readFileSync(join(h.paths.artifactDir(task.id), "requirements.md"), "utf8");
    expect(requirements).toContain("claude fresh | model:default | access:read-only");
    expect(requirements).toContain("Task: Try it");
    expect(q.detail(task.id).task.badge).toBe("needs-you");

    h.engine.approveRun(waiting.id);
    expect(q.stageName(task.id)).toBe("Build");
    expect(q.latest(task.id, "implement")).toBeDefined();
  });
});
