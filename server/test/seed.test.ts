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

  it("never lets an unconfigured test command pass quietly", () => {
    const feature = h.engine.listWorkflows()[0]!;
    const runTests = feature.stages.find((st) => st.name === "Test Imp")!.bindings.find((b) => b.key === "runTests")!;
    expect(runTests.enabled).toBe(false);
    expect(runTests.config.command as string).toMatch(/exit 1$/);

    // No seeded shell command means anything until you have edited it, so none may ship switched
    // on; and one that only echoes has to exit non-zero, or switching it on would sign a task off
    // as tested when nothing ran.
    for (const workflow of h.engine.listWorkflows()) {
      for (const stage of workflow.stages) {
        for (const binding of stage.bindings.filter((b) => b.actionType === "shell")) {
          const command = binding.config.command as string;
          expect(binding.enabled, `${workflow.name}/${binding.key} is on before anyone has edited it`).toBe(false);
          if (/^echo\b/.test(command)) {
            expect(command, `${workflow.name}/${binding.key} echoes a placeholder and then succeeds`).toMatch(/exit 1$/);
          }
        }
      }
    }
  });

  it("puts the install step above the test command, both switched off", () => {
    const testImp = h.engine.listWorkflows()[0]!.stages.find((st) => st.name === "Test Imp")!;
    const keys = testImp.bindings.map((b) => b.key);
    expect(keys.indexOf("installDeps")).toBeLessThan(keys.indexOf("runTests"));
    expect(testImp.bindings.find((b) => b.key === "installDeps")!.enabled).toBe(false);
  });

  it("does not seed twice", () => {
    expect(seedDefaultWorkflows(h.db, h.sqlite)).toBe(false);
    expect(h.engine.listWorkflows()).toHaveLength(2);
  });

  it("drafts requirements.md with the Feature workflow's coding agent", async () => {
    h.agents.setPathOverride("claude", fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url)));
    const q = inspect(h);
    const feature = h.engine.listWorkflows()[0]!;
    const task = h.engine.createTask({ workflowId: feature.id, title: "Try it" });
    h.engine.moveTask(task.id, h.stageId(feature.id, "Solidify Reqs"));

    // The agent signs its own work off, so the draft run is what waits for you.
    await waitFor(() => q.latest(task.id, "draftRequirements")?.status === "awaiting-approval");
    expect(q.latest(task.id, "draftRequirements")?.outputs?.instructions).toContain("requirements.md");
    expect(q.runs(task.id, "solidifyWorktree")[0]?.status).toBe("succeeded");
    const requirements = readFileSync(join(h.paths.artifactDir(task.id), "requirements.md"), "utf8");
    expect(requirements).toContain("claude fresh | model:default | access:read-only");
    expect(requirements).toContain("Task: Try it");
    expect(q.detail(task.id).task.badge).toBe("needs-you");
  });
});
