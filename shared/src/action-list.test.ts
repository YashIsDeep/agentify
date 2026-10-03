import { describe, expect, it } from "vitest";
import {
  actionList,
  addRoundUsage,
  bankRoundTime,
  canRetry,
  canSkip,
  isBlocking,
  isSettled,
  latestAttempts,
  type ListRun,
  RUN_STATUSES,
  type RunStatus,
  workedMs,
} from "./action-list";

const run = (id: number, batchId: string, batchPosition: number, status: RunStatus, continueOnFailure = false): ListRun => ({
  id,
  batchId,
  batchPosition,
  status,
  continueOnFailure,
});

describe("action list", () => {
  it("keeps only the newest attempt per slot, in creation order", () => {
    const runs = [run(1, "a", 0, "failed"), run(2, "a", 1, "skipped"), run(3, "a", 0, "succeeded"), run(4, "b", 0, "running")];
    expect(latestAttempts(runs).map((r) => r.id)).toEqual([2, 3, 4]);
  });

  it("lists actions in list order, a retry keeping its place", () => {
    expect(actionList([run(1, "a", 0, "failed"), run(2, "a", 1, "waiting"), run(3, "a", 0, "running")]).map((r) => r.id)).toEqual([3, 2]);
  });

  it("settles succeeded and skipped runs, and failures allowed to carry on", () => {
    expect(isSettled(run(1, "a", 0, "succeeded"))).toBe(true);
    expect(isSettled(run(1, "a", 0, "skipped"))).toBe(true);
    expect(isSettled(run(1, "a", 0, "failed", true))).toBe(true);
    expect(isSettled(run(1, "a", 0, "failed"))).toBe(false);
    expect(isSettled(run(1, "a", 0, "awaiting-approval"))).toBe(false);
  });

  it("blocks the list on anything stopped that is not allowed to carry on", () => {
    expect(RUN_STATUSES.filter((status) => isBlocking(run(1, "a", 0, status)))).toEqual(["failed", "cancelled", "interrupted"]);
    expect(isBlocking(run(1, "a", 0, "failed", true))).toBe(false);
  });

  it("offers Skip on what blocks, and Retry on that or a skipped run", () => {
    expect(RUN_STATUSES.filter((status) => canSkip(run(1, "a", 0, status)))).toEqual(["failed", "cancelled", "interrupted"]);
    expect(RUN_STATUSES.filter((status) => canRetry(run(1, "a", 0, status)))).toEqual(["failed", "cancelled", "interrupted", "skipped"]);
  });
});

describe("run usage across rounds", () => {
  it("adds a round's tokens and cost to the earlier rounds', keeping the time they took", () => {
    const first = { inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, costUsd: 0.25, estimated: true, priorMs: 60_000 };
    expect(addRoundUsage(first, { inputTokens: 30, outputTokens: 5, costUsd: 0.03, estimated: true })).toEqual({
      inputTokens: 130, cachedInputTokens: 80, outputTokens: 15, costUsd: 0.28, estimated: true, priorMs: 60_000,
    });
    expect(addRoundUsage(null, { outputTokens: 5 })).toEqual({ outputTokens: 5 });
    expect(addRoundUsage(first, undefined)).toBe(first);
  });

  it("banks each round's time before the next, and counts it in the time worked", () => {
    const round = { startedAt: 1_000, endedAt: 31_000, usage: { outputTokens: 5 } };
    const banked = bankRoundTime(round);
    expect(banked).toEqual({ outputTokens: 5, priorMs: 30_000 });
    expect(bankRoundTime({ startedAt: 50_000, endedAt: 60_000, usage: banked })?.priorMs).toBe(40_000);
    expect(workedMs({ startedAt: 50_000, endedAt: null, usage: banked }, 65_000)).toBe(45_000);
    expect(workedMs({ startedAt: null, endedAt: null, usage: banked })).toBeNull();
  });
});
