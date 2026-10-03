import { useQuery } from "@tanstack/react-query";
import type { RunView, StageDef, TaskDetail, WorkflowDef } from "@wm/shared";
import { Activity, Archive, FileText, MessageCircleQuestion, MessagesSquare, Play, Settings2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ApiError } from "../api";
import { useApi } from "../api-context";
import { useNow, useTaskAction } from "../hooks";
import { cls, relativeTime } from "../lib/format";
import { Button, IconButton, isDialogOpen, Splash, Tabs } from "../ui";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { ChatModal } from "./ChatModal";
import { DetailsPanel } from "./DetailsPanel";
import { ArchiveDialog, CancelRunDialog, RetryDialog } from "./dialogs";
import { MoveDialog } from "./MoveDialog";
import { StagePanel } from "./StagePanel";
import { StatusBadge } from "./StatusBadge";
import { TaskMeta } from "./TaskMeta";
import { Timeline } from "./Timeline";

export function TaskDrawer({
  taskId,
  workflows,
  openChatRunId,
  onChatOpened,
  onClose,
}: {
  taskId: string;
  workflows: WorkflowDef[];
  /** A run whose chat to open as soon as the task has loaded. */
  openChatRunId: number | null;
  onChatOpened: () => void;
  onClose: () => void;
}) {
  const api = useApi();
  const query = useQuery({ queryKey: ["task", taskId], queryFn: () => api.task(taskId) });
  const hasRunning = query.data?.visits.some((visit) => visit.runs.some((run) => run.status === "running")) ?? false;
  const now = useNow(hasRunning ? 1000 : 30_000);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A menu, tooltip or dialog on top handles its own Escape (and marks it handled).
      if (event.key === "Escape" && !event.defaultPrevented && !isDialogOpen()) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className="drawer" aria-label="Task details">
      {query.isLoading && <Splash title="Loading…" />}
      {query.error && (
        <Splash
          title={query.error instanceof ApiError && query.error.status === 404 ? "This task no longer exists." : query.error.message}
          action={<Button onClick={onClose}>Close</Button>}
        />
      )}
      {query.data && (
        <DrawerContent
          detail={query.data}
          workflow={workflows.find((workflow) => workflow.id === query.data.task.workflowId)}
          now={now}
          openChatRunId={openChatRunId}
          onChatOpened={onChatOpened}
          onClose={onClose}
        />
      )}
    </aside>
  );
}

function DrawerContent({
  detail,
  workflow,
  now,
  openChatRunId,
  onChatOpened,
  onClose,
}: {
  detail: TaskDetail;
  workflow: WorkflowDef | undefined;
  now: number;
  openChatRunId: number | null;
  onChatOpened: () => void;
  onClose: () => void;
}) {
  const api = useApi();
  const action = useTaskAction();
  const [moveTo, setMoveTo] = useState<StageDef | null>(null);
  const [archiving, setArchiving] = useState(false);
  // The chat lives here, not in the stage panel, so runs from earlier stages open it too.
  const [chatRunId, setChatRunId] = useState<number | null>(null);
  const { task } = detail;
  const visit = detail.visits.find((v) => v.id === task.currentVisitId);
  const stage = workflow?.stages.find((s) => s.id === task.currentStageId);
  const archived = task.status === "archived";

  useEffect(() => {
    if (openChatRunId === null) return;
    // The question may have been answered elsewhere in the meantime; then the drawer alone is right.
    if (detail.visits.some((v) => v.runs.some((run) => run.id === openChatRunId))) setChatRunId(openChatRunId);
    onChatOpened();
  }, [openChatRunId, detail.visits, onChatOpened]);

  // What the task is waiting on you for, one click from the header however far the stage panel scrolled.
  // The stage panel doesn't repeat these; a standalone Approval's buttons are in it, right below.
  const needs = task.badge === "needs-you" ? task.badgeDetail : null;
  const needsButton = !needs ? null : needs.chatRunId ? (
    <Button
      size="sm"
      variant="primary"
      icon={needs.reason === "question" ? MessageCircleQuestion : MessagesSquare}
      onClick={() => setChatRunId(needs.chatRunId ?? null)}
    >
      {needs.reason === "question" ? "Answer" : "Review"}
    </Button>
  ) : needs.reason === "start" ? (
    <Button size="sm" variant="primary" icon={Play} loading={action.isPending} onClick={() => action.mutate(() => api.startActions(task.id))}>
      Start
    </Button>
  ) : null;

  return (
    <>
      {/* The board already names the workflow and the stepper the stage; the header is the task and what it needs. */}
      <header className="drawer-header">
        <div className="drawer-header-top">
          <h2 className="drawer-title">{task.title}</h2>
          {needsButton}
          {!archived && <IconButton label="Archive task" icon={Archive} onClick={() => setArchiving(true)} />}
          <IconButton label="Close task" icon={X} onClick={onClose} />
        </div>
        <div className="drawer-meta">
          {/* Idle says nothing, and "needs you" is the button above. */}
          {task.badge !== "idle" && task.badge !== "needs-you" && <StatusBadge badge={task.badge} detail={task.badgeDetail} />}
          <TaskMeta task={task} />
        </div>
      </header>

      {workflow && (
        <ol className="stepper" aria-label="Stages">
          {workflow.stages.map((s) => {
            const current = s.id === task.currentStageId;
            const visited = detail.visits.some((v) => v.stageId === s.id);
            return (
              <li key={s.id} className={cls("step", current && "step-current", visited && "step-visited")}>
                <button
                  type="button"
                  disabled={archived || current}
                  onClick={() => setMoveTo(s)}
                  title={
                    current
                      ? `In ${s.name}${visit && !archived ? ` since ${relativeTime(visit.enteredAt, now)}` : ""}`
                      : `Move to ${s.name}`
                  }
                >
                  <span className="step-dot" />
                  <span className="step-label">{s.name}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}

      <div className="drawer-scroll">
        {/* The current stage's runs and approvals come first: they are what needs acting on. */}
        {!archived && stage && visit && (
          <StagePanel
            detail={detail}
            stage={stage}
            stages={workflow?.stages ?? []}
            visit={visit}
            now={now}
            onOpenChat={(run) => setChatRunId(run.id)}
          />
        )}
        {task.description && <Description text={task.description} />}

        <Tabs
          label="Task"
          tabs={[
            {
              value: "activity",
              label: "Activity",
              icon: Activity,
              content: <Timeline detail={detail} now={now} onOpenChat={(run) => setChatRunId(run.id)} />,
            },
            { value: "artifacts", label: "Artifacts", icon: FileText, content: <ArtifactsPanel taskId={task.id} /> },
            // Details holds a form: it stays mounted once opened, so looking at another tab keeps the edits.
            { value: "details", label: "Details", icon: Settings2, content: <DetailsPanel detail={detail} />, keepMounted: true },
          ]}
        />
      </div>

      {moveTo && (
        <MoveDialog task={task} from={stage} to={moveTo} onClose={() => setMoveTo(null)} />
      )}
      {archiving && <ArchiveDialog task={task} onClose={() => setArchiving(false)} />}
      {chatRunId !== null && (
        <AgentChat
          detail={detail}
          stages={workflow?.stages ?? []}
          runId={chatRunId}
          now={now}
          onSelect={setChatRunId}
          onClose={() => setChatRunId(null)}
        />
      )}
    </>
  );
}

/**
 * A long brief would push the Activity tabs off screen, so it opens as a few lines with the rest
 * one click away.
 */
function Description({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    // Measured while clamped: anything past the clamp is the "more".
    if (element && !expanded) setLong(element.scrollHeight > element.clientHeight + 4);
  }, [text, expanded]);

  return (
    <div className="description">
      <div ref={ref} className={cls("markdown", !expanded && "description-clamped", long && !expanded && "description-faded")}>
        <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
      </div>
      {long && (
        <Button variant="link" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show less" : "Show more"}
        </Button>
      )}
    </div>
  );
}

/** The chat modal plus the Retry dialog it can open. */
function AgentChat({
  detail,
  stages,
  runId,
  now,
  onSelect,
  onClose,
}: {
  detail: TaskDetail;
  stages: StageDef[];
  runId: number;
  now: number;
  onSelect: (runId: number) => void;
  onClose: () => void;
}) {
  const api = useApi();
  const action = useTaskAction();
  const [retrying, setRetrying] = useState<RunView | null>(null);
  const [cancelling, setCancelling] = useState<RunView | null>(null);

  return (
    <>
      <ChatModal
        detail={detail}
        stages={stages}
        runId={runId}
        now={now}
        busy={action.isPending}
        onSelect={onSelect}
        onRetry={setRetrying}
        onCancel={setCancelling}
        onResume={(run) => action.mutate(() => api.resumeRun(run.id))}
        onClose={onClose}
      />
      {retrying && <RetryDialog run={retrying} onClose={() => setRetrying(null)} />}
      {cancelling && <CancelRunDialog run={cancelling} onClose={() => setCancelling(null)} />}
    </>
  );
}
