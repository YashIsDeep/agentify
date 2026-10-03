import { actionList, canRetry, canSkip, isActiveRun, isApprovalOnly, runGate, type RunView, type StageAgentDefaults, type StageDef, type TaskDetail, type TaskSummary, type VisitView } from "@wm/shared";
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
import { useActionTypeLabel, useTaskAction } from "../hooks";
import { clockTime, cls, runDuration, usageCost, usageSummary } from "../lib/format";
import { describeAgent, isAgentRun, isAwaitingApproval } from "../lib/runs";
import { Button, IconButton, Tag } from "../ui";
import { CancelRunDialog, RetryDialog, SendBackDialog } from "./dialogs";
import { ReviewArtifacts } from "./ArtifactsPanel";
import { DiffPanel } from "./DiffPanel";
import { RunLog } from "./RunLog";
import { RunStatusIcon, runStatusLabel } from "./StatusBadge";

interface RunHandlers {
  task: TaskSummary;
  /** Where a coding agent's model comes from when neither the action nor the task names one. */
  stageDefaults: StageAgentDefaults;
  now: number;
  busy: boolean;
  stageName: (stageId: string) => string;
  /** "Shell command" for "shell": what kind of action a row is, in its tooltip. */
  typeLabel: (type: string) => string;
  onRetry: (run: RunView) => void;
  onCancel: (run: RunView) => void;
  /** "Try now" on a run waiting for a usage limit to reset. */
  onResume: (run: RunView) => void;
  onSkip: (run: RunView) => void;
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
  const [retrying, setRetrying] = useState<RunView | null>(null);
  const [cancelling, setCancelling] = useState<RunView | null>(null);
  const typeLabel = useActionTypeLabel();

  const runs = actionList(visit.runs);
  const toStart = stage.bindings.filter((binding) => binding.enabled);
  const switchedOff = stage.bindings.filter((binding) => !binding.enabled);
  // A stage with no actions (a Backlog, a Done) has nothing to show; an empty box would only say so.
  if (runs.length === 0 && stage.bindings.length === 0) return null;
  const stageName = (stageId: string) => stages.find((candidate) => candidate.id === stageId)?.name ?? "another stage";

  const handlers: RunHandlers = {
    task,
    stageDefaults: stage.agentDefaults,
    now,
    busy: action.isPending,
    stageName,
    typeLabel,
    // Coding agents get a dialog so the agent/model can be switched for the retry.
    onRetry: (run) => (isAgentRun(run) ? setRetrying(run) : action.mutate(() => api.retryRun(run.id))),
    onCancel: setCancelling,
    onResume: (run) => action.mutate(() => api.resumeRun(run.id)),
    onSkip: (run) => action.mutate(() => api.skipRun(run.id)),
    onOpenChat,
  };

  return (
    <section className="stage-panel">
      {/* The stepper above already names the stage; a heading only earns its line when it adds something. */}
      {(visit.attempt > 1 || visit.completedAt) && (
        <div className="section-heading">
          <h3>{stage.name}</h3>
          {visit.attempt > 1 && <Tag>attempt {visit.attempt}</Tag>}
          {visit.completedAt && (
            <Tag tone="success" icon={CircleCheck}>
              complete
            </Tag>
          )}
        </div>
      )}

      {runs.length > 0 ? (
        <ol className="actions">
          {runs.map((run, index) => (
            <RunItem key={run.id} run={run} index={index} {...handlers} />
          ))}
        </ol>
      ) : toStart.length > 0 && (
        // What will run; the header's Start button starts it.
        <ol className="actions">
          {toStart.map((binding, index) => (
            <li key={binding.id} className="run run-pending">
              <div className="run-row">
                <span className="run-toggle" title={`${binding.label} · ${typeLabel(binding.actionType)}`}>
                  <span className="chevron-space" />
                  {isApprovalOnly(binding) ? <Hand size={14} /> : <Circle size={14} />}
                  <span className="run-label">
                    <span className="action-index">{index + 1}.</span> {binding.label}
                  </span>
                </span>
                <span className="run-meta">Not started</span>
              </div>
            </li>
          ))}
        </ol>
      )}

      {switchedOff.length > 0 && (
        <p className="muted small actions-off">Switched off: {switchedOff.map((binding) => binding.label).join(", ")}</p>
      )}

      {retrying && <RetryDialog run={retrying} onClose={() => setRetrying(null)} />}
      {cancelling && <CancelRunDialog run={cancelling} onClose={() => setCancelling(null)} />}
    </section>
  );
}

function RunItem({
  run,
  index,
  task,
  stageDefaults,
  now,
  busy,
  stageName,
  typeLabel,
  onRetry,
  onCancel,
  onResume,
  onSkip,
  onOpenChat,
}: RunHandlers & { run: RunView; index: number }) {
  const [open, setOpen] = useState(run.status === "running" || run.status === "failed");
  // An Approval action has nothing to show but its buttons; an agent holding itself open has a chat.
  const approval = isApprovalOnly(run);
  const waitingForYou = isAwaitingApproval(run);
  const hasLog = !approval && (run.startedAt !== null || (run.status !== "waiting" && run.status !== "queued"));
  const chat = isAgentRun(run) && hasLog;
  const usage = usageSummary(run.usage);
  const cost = usageCost(run.usage);
  // The agent and model, or the action type, spelled out beside the label crowded it; it's the tooltip.
  const what = isAgentRun(run) ? describeAgent(run, task, stageDefaults) : typeLabel(run.actionType);
  // An agent's question and its review both happen in the chat the header's button opens; the row only
  // has to stand out.
  const needsYou = waitingForYou || !!run.question;

  return (
    <li className={cls("run", `run-${run.status}`, needsYou && "run-needs-you")}>
      <div className="run-row">
        <button
          type="button"
          className="run-toggle"
          onClick={() => (chat ? onOpenChat(run) : setOpen((value) => !value))}
          aria-expanded={chat ? undefined : open}
          // The label is cut short on narrow screens, so the tooltip leads with all of it.
          title={[run.label, what, chat && "open the chat"].filter(Boolean).join(" · ")}
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
          {run.question ? (
            <MessageCircleQuestion size={14} className="run-icon run-icon-approval" />
          ) : waitingForYou ? (
            <Hand size={14} className="run-icon run-icon-approval" />
          ) : (
            <RunStatusIcon status={run.status} />
          )}
          <span className="run-label">
            <span className="action-index">{index + 1}.</span> {run.label}
          </span>
        </button>
        {/* Cost rides along with the time; the token counts are in the tooltip. A run waiting on you
            says so with its highlight and the header's button, so its time is shown like any other. */}
        <span className="run-meta" title={[runStatusLabel(run.status), usage].filter(Boolean).join(" · ")}>
          {run.resumeAt
              ? `resets ${clockTime(run.resumeAt, now)}`
              : run.startedAt && !approval
                ? [runDuration(run, now), cost].filter(Boolean).join(" · ")
                : runStatusLabel(run.status)}
        </span>
        {run.status === "quota-wait" && (
          <Button size="sm" icon={Play} onClick={() => onResume(run)} disabled={busy} title="Try again before the reset time">
            Try now
          </Button>
        )}
        {isActiveRun(run) && !waitingForYou && run.status !== "waiting" && (
          <IconButton label="Cancel action" icon={Square} size="sm" onClick={() => onCancel(run)} disabled={busy} />
        )}
        {canRetry(run) && (
          <Button size="sm" icon={RotateCcw} onClick={() => onRetry(run)} disabled={busy}>
            Retry
          </Button>
        )}
        {canSkip(run) && (
          <Button size="sm" icon={SkipForward} onClick={() => onSkip(run)} disabled={busy} title="Carry on with the next action">
            Skip
          </Button>
        )}
      </div>
      {/* An agent's instructions, diff and buttons are in its chat; only a standalone Approval decides here. */}
      {waitingForYou && !chat && <ApprovalDecision run={run} task={task} stageName={stageName} />}
      {/* The log already ends with the error, so only show it separately while the log is collapsed. */}
      {run.error && run.status !== "cancelled" && !(open && hasLog && !chat) && <div className="run-error">{run.error}</div>}
      {open && hasLog && !chat && <RunLog runId={run.id} live={run.status === "running"} />}
    </li>
  );
}

/**
 * A standalone Approval's decision: what it asks you to check, what there is to look at, and the
 * buttons. Here and on the Open conversations page, which has no drawer to send you to.
 */
export function ApprovalDecision({
  run,
  task,
  stageName,
}: {
  run: RunView;
  task: TaskSummary;
  /** Names the stage a Send back goes to. */
  stageName: (stageId: string) => string;
}) {
  const api = useApi();
  const action = useTaskAction();
  const [sendingBack, setSendingBack] = useState(false);
  const gate = runGate(run);
  const sendBackTo = gate?.sendBackTo || null;

  return (
    <div className="approval">
      {gate?.instructions && <p className="approval-text">{gate.instructions}</p>}
      <ReviewArtifacts taskId={task.id} />
      <DiffPanel task={task} />
      <div className="approval-buttons">
        <Button size="sm" variant="primary" icon={Check} onClick={() => action.mutate(() => api.approveRun(run.id))} disabled={action.isPending}>
          Approve & continue
        </Button>
        {sendBackTo && (
          <Button
            size="sm"
            icon={Undo2}
            disabled={action.isPending}
            onClick={() => (gate?.askForNote === false ? action.mutate(() => api.sendBackRun(run.id)) : setSendingBack(true))}
          >
            Send back to {stageName(sendBackTo)}
          </Button>
        )}
      </div>
      {sendingBack && sendBackTo && (
        <SendBackDialog run={run} stageName={stageName(sendBackTo)} onClose={() => setSendingBack(false)} />
      )}
    </div>
  );
}
