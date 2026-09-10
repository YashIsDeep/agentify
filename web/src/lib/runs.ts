import type { RunStatus, RunView, StageDef, TaskDetail } from "@wm/shared";

const ACTIVE: RunStatus[] = ["waiting", "queued", "running"];
const RETRYABLE: RunStatus[] = ["failed", "cancelled", "interrupted", "skipped"];

export const isActiveRun = (run: RunView) => ACTIVE.includes(run.status);
export const isRetryable = (run: RunView) => RETRYABLE.includes(run.status);

/** Retries share a batch slot; keep only the newest attempt per slot, in creation order. */
export function latestAttempts(runs: RunView[]): RunView[] {
  const bySlot = new Map<string, RunView>();
  for (const run of runs) {
    const slot = `${run.batchId}:${run.batchPosition}`;
    const existing = bySlot.get(slot);
    if (!existing || run.id > existing.id) bySlot.set(slot, run);
  }
  return [...bySlot.values()].sort((a, b) => a.id - b.id);
}

/** Labels of actions that run when a task enters the stage (stage.entered + first phase's phase.started). */
export function entryActionLabels(stage: StageDef): string[] {
  const firstPhase = stage.phases[0];
  return stage.bindings
    .filter(
      (binding) =>
        binding.enabled &&
        (binding.trigger === "stage.entered" ||
          (binding.trigger === "phase.started" && firstPhase && binding.phaseId === firstPhase.id)),
    )
    .map((binding) => binding.label);
}

export function completionActionLabels(stage: StageDef): string[] {
  return stage.bindings.filter((b) => b.enabled && b.trigger === "stage.completed").map((b) => b.label);
}

/** Most recent successful outputs per action key. */
export function latestOutputs(detail: TaskDetail): { key: string; label: string; outputs: Record<string, unknown> }[] {
  const byKey = new Map<string, RunView>();
  for (const run of detail.visits.flatMap((visit) => visit.runs)) {
    if (run.status !== "succeeded" || !run.outputs || Object.keys(run.outputs).length === 0) continue;
    const existing = byKey.get(run.bindingKey);
    if (!existing || run.id > existing.id) byKey.set(run.bindingKey, run);
  }
  return [...byKey.values()].map((run) => ({ key: run.bindingKey, label: run.label, outputs: run.outputs! }));
}
