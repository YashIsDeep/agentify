import { describe, expect, it, vi } from "vitest";
import { reviewResult } from "../src/agents/review";
import type { AgentRunResult } from "../src/agents/run";

const result = (text: string, sessionId = "author"): AgentRunResult => ({
  ok: true, aborted: false, text, sessionId, usage: { inputTokens: 10, outputTokens: 5 }, error: null, usageLimit: null,
});
const approved = () => result(JSON.stringify({ decision: "approved", feedback: "" }), "reviewer");
const changes = () => result(JSON.stringify({ decision: "changes_requested", feedback: "Cover edge cases" }), "reviewer");

describe("internal agent review", () => {
  it("keeps the approved document and its author session, not the review", async () => {
    const invoke = vi.fn(async () => approved());
    const final = await reviewResult({ draft: result("# Plan"), document: true, context: "Build it", invoke });
    expect(invoke).toHaveBeenCalledWith(expect.stringContaining("# Plan"), null, "review");
    expect(final).toMatchObject({ ok: true, text: "# Plan", sessionId: "author", usage: { inputTokens: 20 }, review: { decision: "approved" } });
  });

  it("automatically sends rejected documents to the author and returns the corrected document", async () => {
    const invoke = vi.fn().mockResolvedValueOnce(changes()).mockResolvedValueOnce(result("# Corrected plan")).mockResolvedValueOnce(approved());
    const final = await reviewResult({ draft: result("# Draft"), document: true, context: "Build it", invoke });
    expect(invoke).toHaveBeenNthCalledWith(2, expect.stringContaining("Cover edge cases"), "author", "revise");
    expect(invoke).toHaveBeenNthCalledWith(3, expect.stringContaining("# Corrected plan"), null, "review");
    expect(final).toMatchObject({ text: "# Corrected plan", review: { decision: "revised" }, usage: { inputTokens: 40 } });
    expect(final.reviewCheckpoint).toBeUndefined();
  });

  it.each(["Looks fine", '{"decision":"maybe","feedback":""}', '{"decision":"changes_requested","feedback":""}'])
    ("fails closed for an invalid verdict: %s", async (text) => {
      const final = await reviewResult({ draft: result("# Draft"), document: true, context: "", invoke: async () => result(text) });
      expect(final.ok).toBe(false);
      expect(final.text).toBe("# Draft");
    });

  it("lets the code reviewer fix the work and returns its final implementation summary", async () => {
    const invoke = vi.fn(async () => result(JSON.stringify({ decision: "approved", feedback: "", summary: "Fixed and tested" }), "reviewer"));
    const final = await reviewResult({ draft: result("Initial implementation"), document: false, context: "Build it", invoke });
    expect(invoke).toHaveBeenCalledWith(expect.stringContaining("Fix any issues you find directly"), null, "review");
    expect(final).toMatchObject({ text: "Fixed and tested", sessionId: "reviewer", review: { decision: "fixed" } });
  });

  it("does not offer blocked code fixes for approval", async () => {
    const final = await reviewResult({ draft: result("Initial"), document: false, context: "", invoke: async () => changes() });
    expect(final).toMatchObject({ ok: false, error: expect.stringContaining("Implementation loop stopped after 3 correction attempts") });
  });

  it.each(["review", "revise"] as const)("resumes a quota-interrupted %s without losing the draft or repeating completed work", async (phase) => {
    const limited = { ...result("", "paused-session"), ok: false, error: "Quota", usageLimit: { resetAt: 123 } };
    const invoke = vi.fn();
    if (phase === "revise") invoke.mockResolvedValueOnce(changes());
    invoke.mockResolvedValueOnce(limited);
    const pending = await reviewResult({ draft: result("# Draft"), document: true, context: "", invoke });
    expect(pending).toMatchObject({ ok: false, text: "# Draft", sessionId: "author", reviewCheckpoint: { phase, sessionId: "paused-session" } });
    const resume = vi.fn();
    if (phase === "revise") resume.mockResolvedValueOnce(result("# Revised"));
    resume.mockResolvedValueOnce(approved());
    const final = await reviewResult({ draft: pending.reviewCheckpoint!.draft, checkpoint: pending.reviewCheckpoint, document: true, context: "", invoke: resume });
    expect(resume).toHaveBeenNthCalledWith(1, expect.any(String), "paused-session", phase);
    expect(final).toMatchObject({ ok: true, text: phase === "review" ? "# Draft" : "# Revised", usage: { inputTokens: phase === "review" ? 10 : 20 } });
  });

  it("does not return a cancelled or empty revision as completed work", async () => {
    for (const revision of [result(""), { ...result("partial"), ok: false, aborted: true, error: "Cancelled" }]) {
      const invoke = vi.fn().mockResolvedValueOnce(changes()).mockResolvedValueOnce(revision);
      const final = await reviewResult({ draft: result("# Draft"), document: true, context: "", invoke });
      expect(final.ok).toBe(false);
    }
  });

  it("bounds repeated plan rejection and retains the latest draft", async () => {
    const invoke = vi.fn().mockResolvedValueOnce(changes()).mockResolvedValueOnce(result("# Latest draft")).mockResolvedValueOnce(changes());
    const final = await reviewResult({ draft: result("# Draft"), document: true, context: "", maxCorrections: 1, invoke });
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(final).toMatchObject({ ok: false, text: "# Latest draft", error: expect.stringContaining("Plan loop stopped after 1 correction attempts") });
  });

  it("lets the implementation reviewer continue fixing before accepting", async () => {
    const invoke = vi.fn().mockResolvedValueOnce(changes()).mockResolvedValueOnce(result(JSON.stringify({ decision: "approved", feedback: "", summary: "All issues fixed" }), "reviewer"));
    const final = await reviewResult({ draft: result("Initial"), document: false, context: "", invoke });
    expect(invoke).toHaveBeenNthCalledWith(2, expect.stringContaining("Cover edge cases"), "reviewer", "review");
    expect(final).toMatchObject({ ok: true, text: "All issues fixed" });
  });
});
