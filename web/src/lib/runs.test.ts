import type { StageDef } from "@wm/shared";
import { describe, expect, it } from "vitest";
import { entryActionLabels } from "./runs";

describe("runs", () => {
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
