import { describe, expect, it } from "vitest";
import { LOOP_MODES, loopPolicy } from "./loops";

describe("loop policy", () => {
  it("lets a single run keep the autonomy it is given, with no review", () => {
    expect(loopPolicy({ loopMode: "single", autonomy: "autonomous" })).toMatchObject({ autonomy: "autonomous", review: null, asksQuestions: true });
    expect(loopPolicy({ loopMode: "single" })).toMatchObject({ autonomy: "read-only", review: null });
  });

  it("decides each loop's autonomy and review whatever the config says", () => {
    expect(loopPolicy({ loopMode: "plan", autonomy: "autonomous" })).toMatchObject({ autonomy: "read-only", review: "document", asksQuestions: true });
    expect(loopPolicy({ loopMode: "implementation", autonomy: "read-only" })).toMatchObject({ autonomy: "autonomous", review: "code", asksQuestions: true });
    expect(loopPolicy({ loopMode: "ci", autonomy: "read-only" })).toMatchObject({ autonomy: "autonomous", review: null, asksQuestions: false });
  });

  it("treats a missing or unknown mode as a single run", () => {
    expect(loopPolicy({}).mode).toBe("single");
    expect(loopPolicy({ loopMode: "auto", autonomy: "autonomous" })).toMatchObject({ mode: "single", autonomy: "autonomous", review: null });
  });

  it("labels every mode and gives each loop a ready-to-run preset", () => {
    for (const mode of LOOP_MODES) {
      expect(loopPolicy({ loopMode: mode.id }).label).toBe(mode.label);
      expect(mode.preset.loopMode).toBe(mode.id);
      if (mode.id !== "single") expect(mode.preset).toMatchObject({ requireApproval: true, prompt: expect.stringContaining("{{task.title}}") });
    }
    expect(LOOP_MODES.find((mode) => mode.id === "plan")?.preset.saveResultAs).toBe("plan.md");
  });
});
