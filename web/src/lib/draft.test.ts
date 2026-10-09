import type { ActionTypeInfo, WorkflowDef } from "@wm/shared";
import { describe, expect, it } from "vitest";
import { addBinding, isDirty, moveBinding, moveItem, removeBinding, removeStage, toDraft, uniqueKey, type Draft } from "./draft";

const workflow = (): WorkflowDef => ({
  id: "w1",
  name: "Feature",
  description: "",
  icon: "✨",
  updatedAt: 10,
  stages: [
    {
      id: "s1",
      name: "Build",
      position: 0,
      wipLimit: null,
      agentDefaults: { agent: null, model: null, effort: null },
      stayWhenDone: false,
      bindings: [
        {
          id: "b1",
          stageId: "s1",
          key: "build",
          label: "Build",
          actionType: "shell",
          config: { command: "make" },
          enabled: true,
          continueOnFailure: false,
          position: 0,
        },
        {
          id: "b2",
          stageId: "s1",
          key: "check",
          label: "Check",
          actionType: "approval",
          config: { instructions: "", sendBackTo: "s2", askForNote: true },
          enabled: true,
          continueOnFailure: false,
          position: 1,
        },
      ],
    },
    {
      id: "s2",
      name: "Ship",
      position: 1,
      wipLimit: null,
      agentDefaults: { agent: null, model: null, effort: null },
      stayWhenDone: false,
      bindings: [
        {
          id: "b3",
          stageId: "s2",
          key: "back",
          label: "Back to build",
          actionType: "move-stage",
          config: { target: "s1" },
          enabled: true,
          continueOnFailure: false,
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

describe("workflow draft", () => {
  it("round-trips a workflow without looking dirty", () => {
    expect(isDirty(draft(), workflow())).toBe(false);
    expect(isDirty({ ...draft(), name: "Other" }, workflow())).toBe(true);
  });

  it("moves items and refuses to move past either end", () => {
    expect(moveItem(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveItem(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
  });

  it("re-points a move and drops a Send back when their stage is deleted", () => {
    // "Back to build" pointed at the deleted stage; falling back to "next" keeps it valid.
    expect(binding(removeStage(draft(), "s1"), "b3")?.config.target).toBe("next");
    expect(binding(removeStage(draft(), "s2"), "b2")?.config.sendBackTo).toBe("");
  });

  it("removes an action and keeps the rest of the list", () => {
    expect(stage(removeBinding(draft(), "b1"), "s1")?.bindings.map((b) => b.id)).toEqual(["b2"]);
  });

  it("adds an action at the end of the list with the catalogue's defaults and an unused key", () => {
    const { draft: next, bindingId } = addBinding(draft(), "s1", shellAction);
    expect(stage(next, "s1")?.bindings.at(-1)?.id).toBe(bindingId);
    expect(binding(next, bindingId)).toMatchObject({ config: { command: "", cwd: "worktree" }, key: "shell", continueOnFailure: false });
  });

  it("reorders a stage's actions", () => {
    const d = draft();
    expect(stage(moveBinding(d, "s1", 1, -1), "s1")?.bindings.map((b) => b.id)).toEqual(["b2", "b1"]);
    expect(moveBinding(d, "s1", 0, -1)).toBe(d);
  });

  it("derives unique identifier-safe keys", () => {
    const d = draft();
    expect(uniqueKey(d, "coding-agent")).toBe("codingAgent");
    expect(uniqueKey(d, "build")).toBe("build2");
    expect(uniqueKey({ ...d, stages: [] }, "move-stage")).toBe("moveStage");
  });
});
