import { describe, expect, it, vi } from "vitest";
import { runCi } from "../src/agents/ci-loop";
import { limited, loopInput, reply, scriptedTurns } from "./scripted-turns";

const fixed = () => reply("Fixed regression", "fixer");
const red = { ok: false, output: "Test failed" };
const green = { ok: true, output: "Local and remote checks passed" };

describe("CI loop", () => {
  it("skips the fixer when published work passes checks", async () => {
    const turns = scriptedTurns();
    const publish = vi.fn(async () => {});
    const result = await runCi(loopInput(turns), { check: async () => green, publish });
    expect(turns.calls).toEqual([]);
    expect(publish).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, ci: { passed: true, corrections: 0 } });
  });

  it("publishes, checks, fixes, republishes and reruns before succeeding", async () => {
    const order: string[] = [];
    let checks = 0;
    const turns = scriptedTurns((prompt) => {
      order.push("fix");
      expect(prompt).toContain("Test failed");
      return fixed();
    });
    const result = await runCi(loopInput(turns), {
      check: async () => { order.push("check"); return checks++ ? green : red; },
      publish: async () => { order.push("publish"); },
    });
    expect(order).toEqual(["publish", "check", "fix", "publish", "check"]);
    expect(turns.calls[0]).toMatchObject({ role: "fixer", session: null });
    expect(result).toMatchObject({ ok: true, ci: { corrections: 1 }, text: expect.stringContaining("Fixed regression") });
  });

  it("never treats the fixer's success as passing CI and enforces its limit", async () => {
    const turns = scriptedTurns(fixed(), fixed());
    const check = vi.fn(async () => red);
    const result = await runCi(loopInput(turns, { maxCorrections: 2 }), { check, publish: async () => {} });
    expect(turns.calls).toHaveLength(2);
    expect(check).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("stopped after 2") });
    expect(turns.usage).toMatchObject({ inputTokens: 20 });
  });

  it("preserves the interrupted fix and counter across quota waits", async () => {
    const pending = await runCi(loopInput(scriptedTurns(limited("fixer"))), { check: async () => red, publish: async () => {} });
    expect(pending.saved).toMatchObject({ kind: "ci", phase: "fix", sessionId: "fixer" });

    const turns = scriptedTurns(fixed());
    const check = vi.fn(async () => green);
    const final = await runCi(loopInput(turns, { saved: pending.saved }), { check, publish: async () => {} });
    expect(turns.calls[0]).toMatchObject({ session: "fixer", prompt: expect.stringContaining("Test failed") });
    expect(check).toHaveBeenCalledOnce();
    expect(final).toMatchObject({ ok: true, ci: { corrections: 1 } });
    expect(turns.usage).toMatchObject({ inputTokens: 10 });
  });

  it("stops on publish errors without checking stale remote work", async () => {
    const check = vi.fn();
    await expect(runCi(loopInput(scriptedTurns()), { check, publish: async () => { throw new Error("push failed"); } })).rejects.toThrow("push failed");
    expect(check).not.toHaveBeenCalled();
  });

  it("applies your changes before rerunning previously green CI", async () => {
    const turns = scriptedTurns(fixed());
    const result = await runCi(loopInput(turns, { followUp: "Handle empty input" }), { check: async () => green, publish: async () => {} });
    expect(turns.calls[0]).toMatchObject({ session: null, prompt: expect.stringContaining("Handle empty input") });
    expect(result.ci?.corrections).toBe(1);
  });
});
