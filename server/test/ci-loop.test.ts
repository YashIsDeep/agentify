import { describe, expect, it, vi } from "vitest";
import { runCiLoop } from "../src/agents/ci-loop";
import type { AgentRunResult } from "../src/agents/run";

const fixed = (): AgentRunResult => ({ ok: true, aborted: false, text: "Fixed regression", sessionId: "fixer", usage: { inputTokens: 10 }, error: null, usageLimit: null });
const red = { ok: false, output: "Test failed" };
const green = { ok: true, output: "Local and remote checks passed" };

describe("CI loop", () => {
  it("skips the fixer when published work passes checks", async () => {
    const fix = vi.fn();
    const publish = vi.fn(async () => {});
    const result = await runCiLoop({ context: "", maxCorrections: 3, check: async () => green, publish, fix });
    expect(fix).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, ci: { passed: true, corrections: 0 } });
  });

  it("publishes, checks, fixes, republishes and reruns before succeeding", async () => {
    const order: string[] = [];
    let checks = 0;
    const result = await runCiLoop({ context: "Task", maxCorrections: 3,
      check: async () => { order.push("check"); return checks++ ? green : red; },
      publish: async () => { order.push("publish"); },
      fix: async (prompt) => { order.push("fix"); expect(prompt).toContain("Test failed"); return fixed(); },
    });
    expect(order).toEqual(["publish", "check", "fix", "publish", "check"]);
    expect(result).toMatchObject({ ok: true, ci: { corrections: 1 }, text: expect.stringContaining("Fixed regression") });
  });

  it("never treats the fixer's success as passing CI and enforces its limit", async () => {
    const fix = vi.fn(async () => fixed());
    const check = vi.fn(async () => red);
    const result = await runCiLoop({ context: "", maxCorrections: 2, check, publish: async () => {}, fix });
    expect(fix).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("stopped after 2"), usage: { inputTokens: 20 } });
  });

  it("preserves the interrupted fix and counter across quota waits", async () => {
    const pending = await runCiLoop({ context: "", maxCorrections: 3, check: async () => red, publish: async () => {},
      fix: async () => ({ ...fixed(), ok: false, error: "quota", usageLimit: { resetAt: 123 } }),
    });
    const fix = vi.fn(async () => fixed());
    const check = vi.fn(async () => green);
    const final = await runCiLoop({ context: "", maxCorrections: 3, checkpoint: pending.ciCheckpoint, check, publish: async () => {}, fix });
    expect(fix).toHaveBeenCalledWith(expect.stringContaining("Test failed"), "fixer");
    expect(check).toHaveBeenCalledOnce();
    expect(final).toMatchObject({ ok: true, usage: { inputTokens: 10 }, ci: { corrections: 1 } });
  });

  it("stops on publish errors without checking stale remote work", async () => {
    const check = vi.fn();
    await expect(runCiLoop({ context: "", maxCorrections: 3, check, publish: async () => { throw new Error("push failed"); }, fix: async () => fixed() })).rejects.toThrow("push failed");
    expect(check).not.toHaveBeenCalled();
  });

  it("applies user revisions before rerunning previously green CI", async () => {
    const fix = vi.fn(async () => fixed());
    const result = await runCiLoop({ context: "", maxCorrections: 3, followUp: "Handle empty input", check: async () => green, publish: async () => {}, fix });
    expect(fix).toHaveBeenCalledWith(expect.stringContaining("Handle empty input"), null);
    expect(result.ci?.corrections).toBe(1);
  });
});
