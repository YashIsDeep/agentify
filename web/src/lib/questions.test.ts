import { describe, expect, it } from "vitest";
import { combineAnswer, withRecommended } from "./questions";

describe("combineAnswer", () => {
  it("sends the option, your own words, or the option with a note", () => {
    expect(combineAnswer("F = Fold", undefined)).toBe("F = Fold");
    expect(combineAnswer(undefined, "  use Q for fold  ")).toBe("use Q for fold");
    expect(combineAnswer("F = Fold", "but keep Esc free")).toBe("F = Fold — but keep Esc free");
    expect(combineAnswer(undefined, "   ")).toBe("");
  });
});

describe("withRecommended", () => {
  it("picks each unanswered choice's first option and leaves your own picks and text questions alone", () => {
    const fields = [
      { id: "keys", text: "Fold key?", kind: "choice" as const, options: ["F", "Q"] },
      { id: "theme", text: "Theme?", kind: "choice" as const, options: ["Dark", "Light"] },
      { id: "name", text: "Name?", kind: "text" as const },
      { id: "empty", text: "Nothing to pick", kind: "choice" as const, options: [] },
    ];
    expect(withRecommended(fields, { theme: "Light" })).toEqual({ keys: "F", theme: "Light" });
  });
});
