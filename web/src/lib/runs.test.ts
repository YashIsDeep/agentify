import type { RunView, StageDef, VisitView } from "@wm/shared";
import { describe, expect, it } from "vitest";
import { actionList, entryActionLabels, latestAttempts } from "./runs";

const run = (id: number, batchId: string, batchPosition: number, status: RunView["status"]): RunView =>
  ({ id, batchId, batchPosition, status }) as RunView;

describe("runs", () => {
  it("keeps only the newest attempt per batch slot", () => {
    const runs = [run(1, "a", 0, "failed"), run(2, "a", 1, "skipped"), run(3, "a", 0, "succeeded"), run(4, "b", 0, "running")];
    expect(latestAttempts(runs).map((r) => r.id)).toEqual([2, 3, 4]);
  });

  it("lists a visit's actions in list order, a retry keeping its place", () => {
    const visit = { runs: [run(1, "a", 0, "failed"), run(2, "a", 1, "waiting"), run(3, "a", 0, "running")] } as VisitView;
    expect(actionList(visit).map((r) => r.id)).toEqual([3, 2]);
  });

  it("lists what a stage runs on entry, in order, leaving out switched-off actions", () => {
    const stage = {
      bindings: [
        { label: "Worktree", enabled: true },
        { label: "Jira", enabled: false },
        { label: "Agent", enabled: true },
      ],
    } as unknown as StageDef;
    expect(entryActionLabels(stage)).toEqual(["Worktree", "Agent"]);
  });
});
