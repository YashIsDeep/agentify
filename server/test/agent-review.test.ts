import { describe, expect, it } from "vitest";
import { CONTINUE_AFTER_LIMIT } from "../src/agents/loops";
import { runReview } from "../src/agents/review";
import { limited, loopInput, reply, scriptedTurns } from "./scripted-turns";

const approved = () => reply(JSON.stringify({ decision: "approved", feedback: "" }), "reviewer");
const changes = () => reply(JSON.stringify({ decision: "changes_requested", feedback: "Cover edge cases" }), "reviewer");
const fixed = (summary: string) => reply(JSON.stringify({ decision: "approved", feedback: "", summary }), "reviewer");

describe("review loop", () => {
  it("drafts, has the document reviewed, and keeps the approved document with its author session", async () => {
    const turns = scriptedTurns(reply("# Plan"), approved());
    const final = await runReview(loopInput(turns), true);
    expect(turns.calls.map(({ role, session }) => ({ role, session }))).toEqual([
      { role: "author", session: null },
      { role: "reviewer", session: null },
    ]);
    expect(turns.calls[1]!.prompt).toContain("# Plan");
    expect(final).toMatchObject({ ok: true, text: "# Plan", sessionId: "author", review: { decision: "approved" } });
    expect(turns.usage).toMatchObject({ inputTokens: 20 });
  });

  it("sends a rejected document back to its author and returns the corrected one", async () => {
    const turns = scriptedTurns(reply("# Draft"), changes(), reply("# Corrected plan"), approved());
    const final = await runReview(loopInput(turns), true);
    expect(turns.calls[2]).toMatchObject({ role: "fixer", session: "author", prompt: expect.stringContaining("Cover edge cases") });
    expect(turns.calls[3]).toMatchObject({ role: "reviewer", session: null, prompt: expect.stringContaining("# Corrected plan") });
    expect(final).toMatchObject({ text: "# Corrected plan", review: { decision: "revised" } });
    expect(final.saved).toBeUndefined();
    expect(turns.usage).toMatchObject({ inputTokens: 40 });
  });

  it.each(["Looks fine", '{"decision":"maybe","feedback":""}', '{"decision":"changes_requested","feedback":""}'])
    ("fails closed for an invalid verdict: %s", async (text) => {
      const final = await runReview(loopInput(scriptedTurns(reply("# Draft"), reply(text))), true);
      expect(final.ok).toBe(false);
      expect(final.text).toBe("# Draft");
    });

  it("lets the code reviewer fix the work and returns its final implementation summary", async () => {
    const turns = scriptedTurns(reply("Initial implementation"), fixed("Fixed and tested"));
    const final = await runReview(loopInput(turns), false);
    expect(turns.calls[1]).toMatchObject({ role: "reviewer", prompt: expect.stringContaining("Fix any issues you find directly") });
    expect(final).toMatchObject({ text: "Fixed and tested", sessionId: "reviewer", review: { decision: "fixed" } });
  });

  it("does not offer blocked code fixes for approval", async () => {
    const final = await runReview(loopInput(scriptedTurns(reply("Initial"), changes(), changes(), changes(), changes())), false);
    expect(final).toMatchObject({ ok: false, error: expect.stringContaining("Implementation loop stopped after 3 correction attempts") });
  });

  it("lets the implementation reviewer carry on fixing before accepting", async () => {
    const turns = scriptedTurns(reply("Initial"), changes(), fixed("All issues fixed"));
    const final = await runReview(loopInput(turns), false);
    expect(turns.calls[2]).toMatchObject({ role: "reviewer", session: "reviewer", prompt: expect.stringContaining("Cover edge cases") });
    expect(final).toMatchObject({ ok: true, text: "All issues fixed" });
  });

  it("does not return a cancelled or empty revision as completed work", async () => {
    for (const revision of [reply(""), reply("partial", "author", { ok: false, aborted: true, error: "Cancelled" })]) {
      const final = await runReview(loopInput(scriptedTurns(reply("# Draft"), changes(), revision)), true);
      expect(final.ok).toBe(false);
    }
  });

  it("bounds repeated plan rejection and keeps the latest draft", async () => {
    const turns = scriptedTurns(reply("# Draft"), changes(), reply("# Latest draft"), changes());
    const final = await runReview(loopInput(turns, { maxCorrections: 1 }), true);
    expect(turns.calls).toHaveLength(4);
    expect(final).toMatchObject({ ok: false, text: "# Latest draft", error: expect.stringContaining("Plan loop stopped after 1 correction attempts") });
  });

  it("reviews against the changes you asked for", async () => {
    const turns = scriptedTurns(reply("# Plan"), approved());
    await runReview(loopInput(turns, { followUp: "Mention rollback" }), true);
    expect(turns.calls[1]!.prompt).toContain("Requested changes:\nMention rollback");
  });

  it("picks an interrupted draft back up in the author's own session", async () => {
    const first = scriptedTurns(limited("draft-session"));
    const pending = await runReview(loopInput(first), true);
    expect(pending).toMatchObject({ ok: false, saved: { kind: "review", phase: "draft", sessionId: "draft-session" } });

    const turns = scriptedTurns(reply("# Plan", "draft-session"), approved());
    const final = await runReview(loopInput(turns, { saved: pending.saved }), true);
    expect(turns.calls[0]).toEqual({ prompt: CONTINUE_AFTER_LIMIT, session: "draft-session", role: "author" });
    expect(final).toMatchObject({ ok: true, text: "# Plan" });
  });

  it.each(["review", "revise"] as const)("resumes a quota-interrupted %s without losing the draft or repeating finished work", async (phase) => {
    const first = scriptedTurns(reply("# Draft"), ...(phase === "revise" ? [changes()] : []), limited("paused-session"));
    const pending = await runReview(loopInput(first), true);
    expect(pending).toMatchObject({ ok: false, text: "# Draft", sessionId: "author", saved: { phase, sessionId: "paused-session" } });

    const turns = scriptedTurns(...(phase === "revise" ? [reply("# Revised")] : []), approved());
    const final = await runReview(loopInput(turns, { saved: pending.saved }), true);
    expect(turns.calls[0]).toMatchObject({ session: "paused-session", role: phase === "review" ? "reviewer" : "fixer" });
    expect(final).toMatchObject({ ok: true, text: phase === "review" ? "# Draft" : "# Revised" });
    // A resumed round counts only the turns it made.
    expect(turns.usage).toMatchObject({ inputTokens: phase === "review" ? 10 : 20 });
  });
});
