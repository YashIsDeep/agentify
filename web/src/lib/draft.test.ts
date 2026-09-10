import type { ActionTypeInfo, WorkflowDef } from "@wm/shared";
import { describe, expect, it } from "vitest";
import {
  addBinding,
  isDirty,
  moveItem,
  removeBinding,
  removePhase,
  removeStage,
  toDraft,
  uniqueKey,
  type Draft,
} from "./draft";

const workflow = (): WorkflowDef => ({
  id: "w1",
  name: "Feature",
  description: "",
  updatedAt: 10,
  stages: [
    {
      id: "s1",
      name: "Build",
      position: 0,
      wipLimit: null,
      phases: [
        { id: "p1", name: "Write", position: 0, completion: "auto" },
        { id: "p2", name: "Check", position: 1, completion: "manual" },
      ],
      bindings: [
        {
          id: "b1",
          stageId: "s1",
          phaseId: "p1",
          afterBindingId: null,
          key: "build",
          label: "Build",
          trigger: "phase.started",
          actionType: "shell",
          config: { command: "make" },
          enabled: true,
          askFeedback: false,
          position: 0,
        },
        {
          id: "b2",
          stageId: "s1",
          phaseId: null,
          afterBindingId: "b1",
          key: "notify",
          label: "Notify",
          trigger: "action.failed",
          actionType: "shell",
          config: { command: "echo failed" },
          enabled: true,
          askFeedback: false,
          position: 1,
        },
      ],
    },
    {
      id: "s2",
      name: "Ship",
      position: 1,
      wipLimit: null,
      phases: [],
      bindings: [
        {
          id: "b3",
          stageId: "s2",
          phaseId: null,
          afterBindingId: null,
          key: "sendBack",
          label: "Send back",
          trigger: "manual",
          actionType: "move-stage",
          config: { target: "s1" },
          enabled: true,
          askFeedback: true,
          position: 0,
        },
      ],
    },
  ],
});

const draft = (): Draft => toDraft(workflow());
const stage = (d: Draft, id: string) => d.stages.find((candidate) => candidate.id === id);
const binding = (d: Draft, id: string) => d.stages.flatMap((s) => s.bindings).find((candidate) => candidate.id === id);

const shellAction: ActionTypeInfo = {
  type: "shell",
  label: "Run shell command",
  description: "",
  longRunning: false,
  connectionType: null,
  fields: [
    { name: "command", label: "Command", kind: "textarea", default: "" },
    { name: "cwd", label: "Run in", kind: "select", default: "worktree" },
  ],
};

describe("template draft", () => {
  it("round-trips a workflow without looking dirty", () => {
    expect(isDirty(draft(), workflow())).toBe(false);
    expect(isDirty({ ...draft(), name: "Other" }, workflow())).toBe(true);
  });

  it("moves items and refuses to move past either end", () => {
    expect(moveItem(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveItem(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
  });

  it("re-points a move-stage action and drops chains when a stage is deleted", () => {
    const next = removeStage(draft(), "s1");
    expect(next.stages.map((s) => s.id)).toEqual(["s2"]);
    // "Send back" pointed at the deleted stage; falling back to "next" keeps it valid.
    expect(binding(next, "b3")?.config.target).toBe("next");
  });

  it("keeps a stage's other actions when one they chained off is deleted", () => {
    const next = removeBinding(draft(), "b1");
    expect(stage(next, "s1")?.bindings.map((b) => b.id)).toEqual([]);
  });

  it("moves a phase's actions up to the stage when the phase is deleted", () => {
    const next = removePhase(draft(), "s1", "p1");
    expect(stage(next, "s1")?.phases.map((p) => p.id)).toEqual(["p2"]);
    expect(binding(next, "b1")).toMatchObject({ phaseId: null, trigger: "stage.entered" });
  });

  it("adds an action with the catalogue's defaults and an unused key", () => {
    const { draft: next, bindingId } = addBinding(draft(), "s1", shellAction);
    const added = binding(next, bindingId)!;
    expect(added.config).toEqual({ command: "", cwd: "worktree" });
    expect(added.trigger).toBe("phase.started");
    expect(added.phaseId).toBe("p1");
    expect(added.key).toBe("shell");
  });

  it("derives unique identifier-safe keys", () => {
    const d = draft();
    expect(uniqueKey(d, "coding-agent")).toBe("codingAgent");
    expect(uniqueKey(d, "build")).toBe("build2");
    expect(uniqueKey({ ...d, stages: [] }, "move-stage")).toBe("moveStage");
  });
});
