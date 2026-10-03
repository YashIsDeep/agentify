import type { AgentUsage } from "./index";

/**
 * A stage's action list, as both the engine and the web read it. A visit's runs form a batch; each
 * place in it is a slot, and a retry adds a newer attempt to the same slot. Only the newest attempt
 * in each slot is the action as it stands.
 */

export const RUN_STATUSES = [
  "waiting", // later in the stage's list; runs once everything above it has finished
  "queued",
  "running",
  "awaiting-approval", // finished, and held open for you: approve, ask for changes, or send it back
  "quota-wait", // the agent hit its usage limit; requeued by itself at `resumeAt`
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "skipped", // failed or cancelled, and you chose to carry on past it
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Not finished with: cancelling the run, or the task leaving its stage, stops it. */
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ["waiting", "queued", "running", "awaiting-approval", "quota-wait"];
/** Retry starts a new attempt in the same slot. */
export const RETRYABLE_RUN_STATUSES: readonly RunStatus[] = ["failed", "cancelled", "interrupted", "skipped"];
/** Skip carries on past the run as if it had succeeded. */
export const SKIPPABLE_RUN_STATUSES: readonly RunStatus[] = ["failed", "cancelled", "interrupted"];

/** What the list rules need to know about a run; the engine's rows and the web's views both fit. */
export interface ListRun {
  id: number;
  batchId: string;
  batchPosition: number;
  status: RunStatus;
  continueOnFailure: boolean;
}

export const isActiveRun = (run: Pick<ListRun, "status">) => ACTIVE_RUN_STATUSES.includes(run.status);
export const canRetry = (run: Pick<ListRun, "status">) => RETRYABLE_RUN_STATUSES.includes(run.status);
export const canSkip = (run: Pick<ListRun, "status">) => SKIPPABLE_RUN_STATUSES.includes(run.status);

/** Done with, as far as the list is concerned: the next action may start. */
export const isSettled = (run: Pick<ListRun, "status" | "continueOnFailure">) =>
  run.status === "succeeded" || run.status === "skipped" || (run.status === "failed" && run.continueOnFailure);

/** Holds up the list until you retry or skip it. */
export const isBlocking = (run: Pick<ListRun, "status" | "continueOnFailure">) =>
  (run.status === "failed" && !run.continueOnFailure) || run.status === "interrupted" || run.status === "cancelled";

/** The newest attempt in each slot, in creation order. */
export function latestAttempts<T extends Pick<ListRun, "id" | "batchId" | "batchPosition">>(runs: readonly T[]): T[] {
  const bySlot = new Map<string, T>();
  for (const run of runs) {
    const slot = `${run.batchId}:${run.batchPosition}`;
    const existing = bySlot.get(slot);
    if (!existing || run.id > existing.id) bySlot.set(slot, run);
  }
  return [...bySlot.values()].sort((a, b) => a.id - b.id);
}

/** A visit's actions in list order, newest attempt of each. */
export const actionList = <T extends Pick<ListRun, "id" | "batchId" | "batchPosition">>(runs: readonly T[]): T[] =>
  latestAttempts(runs).sort((a, b) => a.batchPosition - b.batchPosition || a.id - b.id);

/**
 * What a run has used, added up across its rounds. Asking for changes or waiting out a usage limit
 * sends the same run round again; `startedAt` restarts each time, so the time of the rounds before
 * is kept as `priorMs`.
 */
export type RunUsage = AgentUsage & { priorMs?: number };

const USAGE_COUNTS = ["inputTokens", "cachedInputTokens", "outputTokens", "costUsd"] as const;

/** Each round reports only what it used, so the rounds are added up rather than the last one standing in for all. */
export function addRoundUsage(previous: RunUsage | null, round: RunUsage | null | undefined): RunUsage | null {
  if (!round) return previous;
  if (!previous) return round;
  const total: RunUsage = { ...previous, ...round };
  for (const key of USAGE_COUNTS) {
    if (previous[key] !== undefined || round[key] !== undefined) total[key] = (previous[key] ?? 0) + (round[key] ?? 0);
  }
  // Time belongs to the run, not the round: only banking a round adds to it.
  if (previous.priorMs !== undefined) total.priorMs = previous.priorMs;
  return total;
}

type Timed = { startedAt: number | null; endedAt: number | null; usage: RunUsage | null };

/** Before a run goes round again: its time so far is banked as `priorMs`. */
export function bankRoundTime(run: Timed): RunUsage | null {
  if (!run.startedAt || !run.endedAt) return run.usage;
  return { ...(run.usage ?? {}), priorMs: (run.usage?.priorMs ?? 0) + Math.max(0, run.endedAt - run.startedAt) };
}

/** How long the run has worked across every round, or null before it first started. */
export function workedMs(run: Timed, now = Date.now()): number | null {
  if (!run.startedAt) return null;
  return (run.usage?.priorMs ?? 0) + Math.max(0, (run.endedAt ?? now) - run.startedAt);
}
