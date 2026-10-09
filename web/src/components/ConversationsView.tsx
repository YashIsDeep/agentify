import { useQuery } from "@tanstack/react-query";
import { isApprovalOnly, type TaskSummary, type WorkflowDef } from "@wm/shared";
import { Hand, MessageCircleQuestion, MessagesSquare, PanelRightOpen, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useApi } from "../api-context";
import { useNow, useTaskAction } from "../hooks";
import { cls } from "../lib/format";
import { describeAgent } from "../lib/runs";
import { Button, Callout, EmptyState, Page } from "../ui";
import { AgentReview } from "./AgentReview";
import { Transcript } from "./ChatModal";
import { ApprovalDecision } from "./StagePanel";
import { RunStatusIcon } from "./StatusBadge";
import { describe } from "./StatusCounters";

/**
 * Everything waiting on you, one conversation at a time: the queue on the left, the one you're on
 * beside it. Answering takes it off the queue, and the page moves to the next one; with nothing
 * left it stays open, and the next question to come in shows up here by itself.
 */
export function ConversationsView({
  workflows,
  onOpenTask,
}: {
  workflows: WorkflowDef[];
  onOpenTask: (id: string) => void;
}) {
  const api = useApi();
  // The sidebar's counters read the same query, and live updates refresh it.
  const tasks = useQuery({ queryKey: ["tasks", "all", "active"], queryFn: () => api.tasks({ status: "active" }) });
  // Oldest task first, so the queue doesn't reshuffle whenever one of them changes.
  const queue = (tasks.data ?? []).filter((task) => task.badge === "needs-you").sort((a, b) => a.createdAt - b.createdAt);

  const [pickedId, setPickedId] = useState<string | null>(null);
  // Where the one you were on sat in the queue: once it's answered, the next one has moved into that place.
  const lastIndex = useRef(0);
  const picked = queue.findIndex((task) => task.id === pickedId);
  const index = picked >= 0 ? picked : Math.min(lastIndex.current, queue.length - 1);
  const current = index >= 0 ? queue[index] : undefined;
  // Holding on to the one you're on by id: a question arriving elsewhere in the queue mustn't move you.
  useEffect(() => {
    if (!current) return;
    lastIndex.current = index;
    setPickedId(current.id);
  }, [current?.id, index]);

  const where = (task: TaskSummary) => {
    const workflow = workflows.find((w) => w.id === task.workflowId);
    const stage = workflow?.stages.find((st) => st.id === task.currentStageId);
    return [workflows.length > 1 && workflow?.name, stage?.name].filter(Boolean).join(" · ");
  };

  return (
    <Page title="Open conversations" className="conversations-page">
      {tasks.error && (
        <Callout tone="danger">
          Could not load what needs you: {tasks.error.message}{" "}
          <Button variant="link" onClick={() => void tasks.refetch()}>
            Try again
          </Button>
        </Callout>
      )}
      {tasks.isSuccess && !current && (
        <EmptyState icon={MessagesSquare} title="Nothing needs you right now">
          Questions and reviews from your agents appear here as they come in.
        </EmptyState>
      )}
      {current && (
        <div className="convo">
          <nav className="chat-list" aria-label="Waiting on you">
            <ul>
              {queue.map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    className={cls("chat-list-item", task.id === current.id && "chat-list-item-current")}
                    aria-current={task.id === current.id ? "true" : undefined}
                    onClick={() => setPickedId(task.id)}
                  >
                    <span className="chat-list-title">
                      {task.badgeDetail?.reason === "question" ? (
                        <MessageCircleQuestion size={13} className="text-warn" aria-hidden="true" />
                      ) : task.badgeDetail?.reason === "start" ? (
                        <Play size={13} className="text-warn" aria-hidden="true" />
                      ) : (
                        <Hand size={13} className="text-warn" aria-hidden="true" />
                      )}
                      <span className="chat-list-label">{task.title}</span>
                    </span>
                    <span className="chat-list-meta">{describe(task)}</span>
                    {where(task) && <span className="chat-list-meta">{where(task)}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <Conversation
            // A fresh conversation for each item, so a half-typed answer never carries over to the next.
            key={`${current.id}:${current.badgeDetail?.chatRunId ?? current.badgeDetail?.reason}`}
            task={current}
            workflow={workflows.find((w) => w.id === current.workflowId)}
            onOpenTask={onOpenTask}
          />
        </div>
      )}
    </Page>
  );
}

function Conversation({
  task,
  workflow,
  onOpenTask,
}: {
  task: TaskSummary;
  workflow: WorkflowDef | undefined;
  onOpenTask: (id: string) => void;
}) {
  const api = useApi();
  const action = useTaskAction();
  const detail = useQuery({ queryKey: ["task", task.id], queryFn: () => api.task(task.id) });
  const runId = task.badgeDetail?.chatRunId;
  const visits = detail.data?.visits ?? [];
  const visit = visits.find((v) => v.runs.some((run) => run.id === runId));
  const run = visit?.runs.find((entry) => entry.id === runId);
  const now = useNow(run?.status === "running" ? 1000 : 30_000);
  const stageDefaults = workflow?.stages.find((stage) => stage.id === visit?.stageId)?.agentDefaults;
  // A standalone Approval has no chat, but its decision is just two buttons: they belong here too.
  const currentVisit = visits.find((v) => v.id === detail.data?.task.currentVisitId);
  const approval = task.badgeDetail?.reason === "approval" && !run
    ? currentVisit?.runs.find((entry) => entry.status === "awaiting-approval" && isApprovalOnly(entry))
    : undefined;
  const stageName = (stageId: string) => workflow?.stages.find((stage) => stage.id === stageId)?.name ?? "another stage";

  return (
    <section className="chat-main" aria-label={task.title}>
      <header className="chat-header">
        {run && <RunStatusIcon status={run.status} />}
        <div className="chat-header-text">
          <strong>{task.title}</strong>
          <span className="muted small">
            {[run?.label ?? task.badgeDetail?.label, run && detail.data && describeAgent(run, detail.data.task, stageDefaults)]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <span className="spacer" />
        {task.badgeDetail?.reason === "start" && (
          <Button size="sm" variant="primary" icon={Play} loading={action.isPending} onClick={() => action.mutate(() => api.startActions(task.id))}>
            Start
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={PanelRightOpen} onClick={() => onOpenTask(task.id)}>
          Open task
        </Button>
      </header>

      {detail.error ? (
        <p className="chat-body chat-notice chat-notice-error">Could not load the task: {detail.error.message}</p>
      ) : run && detail.data ? (
        <Transcript key={run.id} run={run} now={now} archived={false}>
          <AgentReview key={`review-${run.id}`} run={run} detail={detail.data} stages={workflow?.stages ?? []} />
        </Transcript>
      ) : approval && detail.data ? (
        <div className="chat-body">
          <ApprovalDecision run={approval} task={detail.data.task} stageName={stageName} />
        </div>
      ) : detail.isLoading ? (
        <p className="chat-body muted small">Loading…</p>
      ) : (
        // A stage waiting to be started: the header's Start button is the whole decision.
        <p className="chat-body muted">
          {task.badgeDetail?.reason === "start" ? `${describe(task)}.` : `${describe(task)}. Open the task to decide.`}
        </p>
      )}
    </section>
  );
}
