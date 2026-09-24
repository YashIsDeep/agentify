import { describe, expect, it } from "vitest";
import { combineAnswer } from "./questions";

describe("combineAnswer", () => {
  it("sends the option, your own words, or the option with a note", () => {
    expect(combineAnswer("F = Fold", undefined)).toBe("F = Fold");
    expect(combineAnswer(undefined, "  use Q for fold  ")).toBe("use Q for fold");
    expect(combineAnswer("F = Fold", "but keep Esc free")).toBe("F = Fold — but keep Esc free");
    expect(combineAnswer(undefined, "   ")).toBe("");
  });
});
