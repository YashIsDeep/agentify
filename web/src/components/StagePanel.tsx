import { APPROVAL_ACTION, type RunView, type StageDef, type TaskDetail, type TaskSummary, type VisitView } from "@wm/shared";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  Hand,
  MessageCircleQuestion,
  MessagesSquare,
  Play,
  RotateCcw,
  SkipForward,
  Square,
  Undo2,
} from "lucide-react";
import { useState } from "react";
import { useApi } from "../api-context";
import { useTaskAction } from "../hooks";
import { clockTime, cls, duration, usageSummary } from "../lib/format";
import { actionList, describeAgent, isActiveRun, isAgentRun, isApprovalRun, isAwaitingApproval, isRetryable, isSkippable } from "../lib/runs";
import { RetryDialog, SendBackDialog } from "./dialogs";
import { DiffPanel } from "./DiffPanel";
import { RunLog } from "./RunLog";
import { RunStatusIcon, runStatusLabel } from "./StatusBadge";

interface RunHandlers {
  task: TaskSummary;
  now: number;
  busy: boolean;
  stageName: (stageId: string) => string;
  onRetry: (run: RunView) => void;
  onCancel: (run: RunView) => void;
  /** "Try now" on a run waiting for a usage limit to reset. */
  onResume: (run: RunView) => void;
  onSkip: (run: RunView) => void;
  onApprove: (run: RunView) => void;
  onSendBack: (run: RunView, stageId: string) => void;
  /** Coding agents open their transcript as a chat instead of expanding a log inline. */
  onOpenChat: (run: RunView) => void;
}

/** The current stage's actions, top to bottom, with whatever each one needs from you. */
export function StagePanel({
  detail,
  stage,
  stages,
  visit,
  now,
  onOpenChat,
}: {
  detail: TaskDetail;
  stage: StageDef;
  /** The workflow's stages, to name where a Send back goes. */
  stages: StageDef[];
  visit: VisitView;
  now: number;
  onOpenChat: (run: RunView) => void;
}) {
  const api = useApi();
  const { task } = detail;
  const action = useTaskAction();
  const [sendingBack, setSendingBack] = useState<{ run: RunView; stageName: string } | null>(null);
  const [retrying, setRetrying] = useState<RunView | null>(null);

  const runs = actionList(visit);
  const toStart = stage.bindings.filter((binding) => binding.enabled);
  const switchedOff = stage.bindings.filter((binding) => !binding.enabled);
  const stageName = (stageId: string) => stages.find((candidate) => candidate.id === stageId)?.name ?? "another stage";

  const handlers: RunHandlers = {
    task,
    now,
    busy: action.isPending,
    stageName,
    // Coding agents get a dialog so the agent/model can be switched for the retry.
    onRetry: (run) => (isAgentRun(run) ? setRetrying(run) : action.mutate(() => api.retryRun(run.id))),
    onCancel: (run) => action.mutate(() => api.cancelRun(run.id)),
    onResume: (run) => action.mutate(() => api.resumeRun(run.id)),
    onSkip: (run) => action.mutate(() => api.skipRun(run.id)),
    onApprove: (run) => action.mutate(() => api.approveRun(run.id)),
    onSendBack: (run, stageId) =>
      run.config.askForNote === false
        ? action.mutate(() => api.sendBackRun(run.id))
        : setSendingBack({ run, stageName: stageName(stageId) }),
    onOpenChat,
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

      {runs.length > 0 ? (
        <ol className="actions">
          {runs.map((run, index) => (
            <RunItem key={run.id} run={run} index={index} {...handlers} />
          ))}
        </ol>
      ) : toStart.length > 0 ? (
        <>
          <ol className="actions">
            {toStart.map((binding, index) => (
              <li key={binding.id} className="run run-pending">
                <div className="run-row">
                  <span className="run-toggle">
                    <span className="chevron-space" />
                    {binding.actionType === APPROVAL_ACTION ? <Hand size={14} /> : <Circle size={14} />}
                    <span className="run-label">
                      <span className="action-index">{index + 1}.</span> {binding.label}
                    </span>
                    <span className="run-type">{binding.actionType}</span>
                  </span>
                  <span className="run-meta">Not started</span>
                </div>
              </li>
            ))}
          </ol>
          <div className="action-bar">
            <button
              type="button"
              className="button primary"
              disabled={action.isPending}
              onClick={() => action.mutate(() => api.startActions(task.id))}
            >
              <Play size={13} />
              Start
            </button>
            <span className="muted small">Nothing has run in {stage.name} yet.</span>
          </div>
        </>
      ) : (
        <p className="muted small">{stage.name} has no actions; move the task on when you're ready.</p>
      )}

      {switchedOff.length > 0 && (
        <p className="muted small actions-off">Switched off: {switchedOff.map((binding) => binding.label).join(", ")}</p>
      )}

      {sendingBack && (
        <SendBackDialog run={sendingBack.run} stageName={sendingBack.stageName} onClose={() => setSendingBack(null)} />
      )}
      {retrying && <RetryDialog run={retrying} onClose={() => setRetrying(null)} />}
    </section>
  );
}

function RunItem({
  run,
  index,
  task,
  now,
  busy,
  stageName,
  onRetry,
  onCancel,
  onResume,
  onSkip,
  onApprove,
  onSendBack,
  onOpenChat,
}: RunHandlers & { run: RunView; index: number }) {
  const [open, setOpen] = useState(run.status === "running" || run.status === "failed");
  // An Approval action has nothing to show but its buttons; an agent holding itself open has a chat.
  const approval = isApprovalRun(run);
  const waitingForYou = isAwaitingApproval(run);
  const hasLog = !approval && (run.startedAt !== null || (run.status !== "waiting" && run.status !== "queued"));
  const chat = isAgentRun(run) && hasLog;
  const sendBackTo = typeof run.config.sendBackTo === "string" && run.config.sendBackTo ? run.config.sendBackTo : null;
  const instructions = typeof run.outputs?.instructions === "string" ? run.outputs.instructions : "";

  return (
    <li className={cls("run", `run-${run.status}`, waitingForYou && "run-approval")}>
      <div className="run-row">
        <button
          type="button"
          className="run-toggle"
          onClick={() => (chat ? onOpenChat(run) : setOpen((value) => !value))}
          aria-expanded={chat ? undefined : open}
          title={chat ? "Open the agent's chat" : undefined}
          disabled={!hasLog}
        >
          {chat ? (
            <MessagesSquare size={14} />
          ) : hasLog ? (
            open ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )
          ) : (
            <span className="chevron-space" />
          )}
          {waitingForYou ? <Hand size={14} className="run-icon run-icon-approval" /> : <RunStatusIcon status={run.status} />}
          <span className="run-label">
            <span className="action-index">{index + 1}.</span> {run.label}
          </span>
          {isAgentRun(run) ? (
            <span className="chip chip-agent">{describeAgent(run, task)}</span>
          ) : (
            <span className="run-type">{run.actionType}</span>
          )}
        </button>
        <span className="run-meta" title={runStatusLabel(run.status)}>
          {waitingForYou
            ? "Ready for review"
            : run.resumeAt
              ? `resets ${clockTime(run.resumeAt, now)}`
              : run.startedAt && !approval
                ? duration(run.startedAt, run.endedAt, now)
                : runStatusLabel(run.status)}
        </span>
        {run.status === "quota-wait" && (
          <button type="button" className="button small" onClick={() => onResume(run)} disabled={busy} title="Try again before the reset time">
            <Play size={12} />
            Try now
          </button>
        )}
        {isActiveRun(run) && !waitingForYou && run.status !== "waiting" && (
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
        {isSkippable(run) && (
          <button type="button" className="button small" onClick={() => onSkip(run)} disabled={busy} title="Carry on with the next action">
            <SkipForward size={12} />
            Skip
          </button>
        )}
      </div>
      {waitingForYou && (
        <div className="approval">
          {instructions && <p className="approval-text">{instructions}</p>}
          {chat && <p className="approval-text muted">Review the result and ask for revisions as often as you need. The workflow waits for your final approval.</p>}
          <DiffPanel task={task} />
          <div className="approval-buttons">
            {chat ? (
              <button type="button" className="button small primary" onClick={() => onOpenChat(run)} disabled={busy}>
                <MessagesSquare size={13} />
                Review & revise
              </button>
            ) : (
              <button type="button" className="button small primary" onClick={() => onApprove(run)} disabled={busy}>
                <Check size={13} />
                Approve & continue
              </button>
            )}
            {sendBackTo && (
              <button type="button" className="button small" onClick={() => onSendBack(run, sendBackTo)} disabled={busy}>
                <Undo2 size={13} />
                Send back to {stageName(sendBackTo)}
              </button>
            )}
          </div>
        </div>
      )}
      {/* The question is answered in the chat; here it only has to be impossible to miss. */}
      {run.question && (
        <button type="button" className="run-question" onClick={() => onOpenChat(run)}>
          <MessageCircleQuestion size={14} />
          The agent is waiting on you
          <span className="spacer" />
          <span className="button small primary">Answer</span>
        </button>
      )}
      {/* The log already ends with the error, so only show it separately while the log is collapsed. */}
      {run.error && run.status !== "cancelled" && !(open && hasLog && !chat) && <div className="run-error">{run.error}</div>}
      {run.usage && usageSummary(run.usage) && <div className="run-usage">{usageSummary(run.usage)}</div>}
      {open && hasLog && !chat && <RunLog runId={run.id} live={run.status === "running"} />}
    </li>
  );
}
