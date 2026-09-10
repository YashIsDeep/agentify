import type { BindingDef, PhaseStateView, RunView, StageDef, TaskDetail, TaskSummary, VisitView } from "@wm/shared";
import { Check, ChevronDown, ChevronRight, Circle, CircleCheck, CircleX, Hand, LoaderCircle, Play, RotateCcw, Square } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { useTaskAction } from "../hooks";
import { agentLabel } from "../lib/agents";
import { cls, duration, usageSummary } from "../lib/format";
import { completionActionLabels, isActiveRun, isRetryable, latestAttempts } from "../lib/runs";
import { FeedbackDialog, RetryDialog } from "./dialogs";
import { RunLog } from "./RunLog";
import { RunStatusIcon, runStatusLabel } from "./StatusBadge";

interface RunHandlers {
  task: TaskSummary;
  now: number;
  busy: boolean;
  onRetry: (run: RunView) => void;
  onCancel: (run: RunView) => void;
}

export function StagePanel({
  detail,
  stage,
  visit,
  now,
}: {
  detail: TaskDetail;
  stage: StageDef;
  visit: VisitView;
  now: number;
}) {
  const { task } = detail;
  const action = useTaskAction();
  const [feedbackFor, setFeedbackFor] = useState<BindingDef | null>(null);
  const [retrying, setRetrying] = useState<RunView | null>(null);

  const runs = latestAttempts(visit.runs);
  const phaseIds = new Set(visit.phases.map((phase) => phase.id));
  const stageRuns = runs.filter((run) => !run.phaseStateId || !phaseIds.has(run.phaseStateId));
  const manualActions = stage.bindings.filter((binding) => binding.trigger === "manual" && binding.enabled);
  const completion = completionActionLabels(stage);
  const canCompleteStage = visit.phases.length === 0 && !visit.completedAt && completion.length > 0;

  const handlers: RunHandlers = {
    task,
    now,
    busy: action.isPending,
    // Coding agents get a dialog so the agent/model can be switched for the retry.
    onRetry: (run) => (run.actionType === "coding-agent" ? setRetrying(run) : action.mutate(() => api.retryRun(run.id))),
    onCancel: (run) => action.mutate(() => api.cancelRun(run.id)),
  };

  return (
    <section className="stage-panel">
      <div className="section-heading">
        <h3>{stage.name}</h3>
        {visit.attempt > 1 && <span className="chip">attempt {visit.attempt}</span>}
        {visit.completedAt && (
          <span className="chip chip-success">
            <CircleCheck size={11} />
            complete
          </span>
        )}
      </div>

      {visit.phases.length > 0 ? (
        <ol className="phases">
          {visit.phases.map((phase, index) => (
            <PhaseRow
              key={phase.id}
              phase={phase}
              index={index}
              runs={runs.filter((run) => run.phaseStateId === phase.id)}
              onComplete={() => action.mutate(() => api.completePhase(task.id, phase.id))}
              {...handlers}
            />
          ))}
        </ol>
      ) : (
        <p className="muted small">This stage has no phases{canCompleteStage ? "; complete it when you're ready." : "."}</p>
      )}

      {stageRuns.length > 0 && (
        <div className="stage-runs">
          <div className="label">Stage actions</div>
          <ul className="runs">
            {stageRuns.map((run) => (
              <RunItem key={run.id} run={run} {...handlers} />
            ))}
          </ul>
        </div>
      )}

      {(manualActions.length > 0 || canCompleteStage) && (
        <div className="action-bar">
          {canCompleteStage && (
            <button
              type="button"
              className="button primary"
              disabled={action.isPending}
              title={`Then runs: ${completion.join(", ")}`}
              onClick={() => action.mutate(() => api.completeStage(task.id))}
            >
              <Check size={14} />
              Complete stage
            </button>
          )}
          {manualActions.map((binding) => (
            <button
              key={binding.id}
              type="button"
              className="button"
              disabled={action.isPending}
              onClick={() =>
                binding.askFeedback ? setFeedbackFor(binding) : action.mutate(() => api.triggerAction(task.id, binding.id))
              }
            >
              <Play size={13} />
              {binding.label}
            </button>
          ))}
        </div>
      )}

      {feedbackFor && <FeedbackDialog taskId={task.id} binding={feedbackFor} onClose={() => setFeedbackFor(null)} />}
      {retrying && <RetryDialog run={retrying} onClose={() => setRetrying(null)} />}
    </section>
  );
}

function PhaseRow({
  phase,
  index,
  runs,
  onComplete,
  ...handlers
}: RunHandlers & {
  phase: PhaseStateView;
  index: number;
  runs: RunView[];
  onComplete: () => void;
}) {
  const active = runs.some(isActiveRun);
  const waitingOnYou = phase.status === "running" && !active;

  let icon = <Circle size={16} className="phase-icon muted" />;
  if (phase.status === "done") icon = <CircleCheck size={16} className="phase-icon success" />;
  else if (phase.status === "failed") icon = <CircleX size={16} className="phase-icon danger" />;
  else if (active) icon = <LoaderCircle size={16} className="phase-icon accent spin" />;
  else if (waitingOnYou) icon = <Hand size={16} className="phase-icon warn" />;

  return (
    <li className={cls("phase", `phase-${phase.status}`, waitingOnYou && "phase-waiting")}>
      <div className="phase-row">
        {icon}
        <span className="phase-name">
          <span className="phase-index">{index + 1}.</span> {phase.name}
        </span>
        <span className="mode" title={phase.completion === "auto" ? "Completes when its actions succeed" : "You mark it done"}>
          {phase.completion}
        </span>
        <span className="spacer" />
        {phase.status === "done" && phase.completedBy === "manual" && <span className="muted small">marked done</span>}
        {waitingOnYou && (
          <button type="button" className="button small primary" onClick={onComplete} disabled={handlers.busy}>
            <Check size={13} />
            Mark done
          </button>
        )}
        {phase.status === "failed" && (
          <button type="button" className="button small" onClick={onComplete} disabled={handlers.busy}>
            Mark done anyway
          </button>
        )}
      </div>
      {runs.length > 0 && (
        <ul className="runs">
          {runs.map((run) => (
            <RunItem key={run.id} run={run} {...handlers} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** "Claude Code · opus": what ran, or what will run (retry choice → task override → action default). */
function describeAgent(run: RunView, task: TaskSummary): string {
  const outputs = run.outputs ?? {};
  const overrides = run.overrides ?? {};
  const agent = outputs.agent ?? overrides.agent ?? task.agentOverride ?? run.config.agent;
  const model = "model" in outputs ? outputs.model : "model" in overrides ? overrides.model : (task.modelOverride ?? run.config.model);
  return [agentLabel(typeof agent === "string" ? agent : null), typeof model === "string" ? model : ""].filter(Boolean).join(" · ");
}

function RunItem({ run, task, now, busy, onRetry, onCancel }: RunHandlers & { run: RunView }) {
  const [open, setOpen] = useState(run.status === "running" || run.status === "failed");
  const hasLog = run.status !== "waiting" && run.status !== "queued" && run.status !== "skipped";

  return (
    <li className={cls("run", `run-${run.status}`)}>
      <div className="run-row">
        <button
          type="button"
          className="run-toggle"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          disabled={!hasLog}
        >
          {hasLog ? open ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : <span className="chevron-space" />}
          <RunStatusIcon status={run.status} />
          <span className="run-label">{run.label}</span>
          {run.actionType === "coding-agent" ? (
            <span className="chip chip-agent">{describeAgent(run, task)}</span>
          ) : (
            <span className="run-type">{run.actionType}</span>
          )}
        </button>
        <span className="run-meta" title={runStatusLabel(run.status)}>
          {run.startedAt ? duration(run.startedAt, run.endedAt, now) : runStatusLabel(run.status)}
        </span>
        {isActiveRun(run) && (
          <button type="button" className="icon-button" title="Cancel" aria-label="Cancel" onClick={() => onCancel(run)} disabled={busy}>
            <Square size={12} />
          </button>
        )}
        {isRetryable(run) && (
          <button type="button" className="button small" onClick={() => onRetry(run)} disabled={busy}>
            <RotateCcw size={12} />
            Retry
          </button>
        )}
      </div>
      {/* The log already ends with the error, so only show it separately while the log is collapsed. */}
      {run.error && run.status !== "cancelled" && !(open && hasLog) && <div className="run-error">{run.error}</div>}
      {run.usage && usageSummary(run.usage) && <div className="run-usage">{usageSummary(run.usage)}</div>}
      {open && hasLog && <RunLog runId={run.id} live={run.status === "running"} />}
    </li>
  );
}
