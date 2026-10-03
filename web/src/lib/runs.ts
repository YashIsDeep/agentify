import {
  NO_AGENT_DEFAULTS,
  type RunView,
  resolveAgentChoice,
  type StageAgentDefaults,
  type StageDef,
  type TaskDetail,
  type TaskSummary,
  type VisitView,
} from "@wm/shared";
import { agentLabel } from "./agents";

/** Finished, and waiting on your decision — either kind. */
export const isAwaitingApproval = (run: Pick<RunView, "status">) => run.status === "awaiting-approval";

/** What runs, in order, when a task enters the stage. */
export const entryActionLabels = (stage: StageDef): string[] =>
  stage.bindings.filter((binding) => binding.enabled).map((binding) => binding.label);

export const isAgentRun = (run: RunView) => run.actionType === "coding-agent";

/**
 * "Codex · gpt-6-astra · high": what ran, or what will run (retry choice → task override → action →
 * stage default, by the server's own rules). The agent's saved default isn't known here, so a
 * preview leaves it out.
 */
export function describeAgent(
  run: RunView,
  task: Pick<TaskSummary, "agentOverride" | "modelOverride" | "effortOverride">,
  stageDefaults?: StageAgentDefaults,
): string {
  const outputs = run.outputs ?? {};
  const layers =
    typeof outputs.agent === "string"
      ? [outputs]
      : [
          run.overrides ?? {},
          { agent: task.agentOverride, model: task.modelOverride, effort: task.effortOverride },
          run.config,
          stageDefaults ?? {},
        ];
  const { agent, model, effort } = resolveAgentChoice(layers, () => NO_AGENT_DEFAULTS);
  return [agentLabel(agent), model, effort].filter(Boolean).join(" · ");
}

/** Every coding-agent run on the task, newest first — the chats you can go back to. */
export function agentChats(detail: TaskDetail): { run: RunView; visit: VisitView }[] {
  return detail.visits
    .flatMap((visit) => visit.runs.filter(isAgentRun).map((run) => ({ run, visit })))
    .sort((a, b) => b.run.id - a.run.id);
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
