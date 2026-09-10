import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedDefaultWorkflows } from "../src/seed/templates";
import { createHarness, type Harness, inspect, removeDir, waitFor } from "./helpers";

let h: Harness;

beforeEach(() => {
  h = createHarness({ seed: true });
});

afterEach(async () => {
  await h.close();
  removeDir(h.dataDir);
});

describe("default templates", () => {
  it("seeds Feature, Bugfix and Spike with consistent references", () => {
    const workflows = h.engine.listWorkflows();
    expect(workflows.map((w) => w.name)).toEqual(["Feature", "Bugfix", "Spike"]);
    expect(workflows[0]!.stages.map((st) => st.name)).toEqual([
      "Backlog",
      "To Pick",
      "Solidify Reqs",
      "Implement Reqs",
      "Review Imp",
      "Test Imp",
      "Submit MR",
    ]);

    for (const workflow of workflows) {
      const stageIds = new Set(workflow.stages.map((st) => st.id));
      const bindingIds = new Set(workflow.stages.flatMap((st) => st.bindings.map((b) => b.id)));
      for (const stage of workflow.stages) {
        for (const binding of stage.bindings) {
          if (binding.phaseId) expect(stage.phases.map((p) => p.id)).toContain(binding.phaseId);
          if (binding.afterBindingId) expect(bindingIds).toContain(binding.afterBindingId);
          if (binding.actionType === "move-stage") {
            const target = binding.config.target as string;
            expect(target === "next" || stageIds.has(target)).toBe(true);
          }
          expect(h.registry.get(binding.actionType)).toBeDefined();
        }
      }
    }
  });

  it("does not seed twice", () => {
    expect(seedDefaultWorkflows(h.db, h.sqlite)).toBe(false);
    expect(h.engine.listWorkflows()).toHaveLength(3);
  });

  it("drafts requirements.md with the Feature template's coding agent", async () => {
    h.agents.setPathOverride("claude", fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url)));
    const q = inspect(h);
    const feature = h.engine.listWorkflows()[0]!;
    const task = h.engine.createTask({ workflowId: feature.id, title: "Try it" });
    h.engine.moveTask(task.id, h.stageId(feature.id, "Solidify Reqs"));

    await waitFor(() => q.phase(task.id, "Approve requirements").status === "running");
    expect(q.runs(task.id, "solidifyWorktree")[0]?.status).toBe("succeeded");
    const requirements = readFileSync(join(h.paths.artifactDir(task.id), "requirements.md"), "utf8");
    expect(requirements).toContain("claude fresh | model:default | access:read-only");
    expect(requirements).toContain("Task: Try it");
    expect(q.detail(task.id).task.badge).toBe("needs-you");
  });
});
