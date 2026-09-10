import type { RunView, StageDef } from "@wm/shared";
import { describe, expect, it } from "vitest";
import { entryActionLabels, latestAttempts } from "./runs";

const run = (id: number, batchId: string, batchPosition: number, status: RunView["status"]): RunView =>
  ({ id, batchId, batchPosition, status }) as RunView;

describe("runs", () => {
  it("keeps only the newest attempt per batch slot", () => {
    const runs = [run(1, "a", 0, "failed"), run(2, "a", 1, "skipped"), run(3, "a", 0, "succeeded"), run(4, "b", 0, "running")];
    expect(latestAttempts(runs).map((r) => r.id)).toEqual([2, 3, 4]);
  });

  it("lists entry actions for stage.entered and the first phase", () => {
    const stage = {
      phases: [
        { id: "p1", name: "One", position: 0, completion: "auto" },
        { id: "p2", name: "Two", position: 1, completion: "manual" },
      ],
      bindings: [
        { label: "On enter", trigger: "stage.entered", phaseId: null, enabled: true },
        { label: "First phase", trigger: "phase.started", phaseId: "p1", enabled: true },
        { label: "Second phase", trigger: "phase.started", phaseId: "p2", enabled: true },
        { label: "Disabled", trigger: "stage.entered", phaseId: null, enabled: false },
        { label: "Done", trigger: "stage.completed", phaseId: null, enabled: true },
      ],
    } as unknown as StageDef;
    expect(entryActionLabels(stage)).toEqual(["On enter", "First phase"]);
  });
});
