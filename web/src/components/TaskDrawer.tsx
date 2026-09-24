import { useQuery } from "@tanstack/react-query";
import type { RunView, StageDef, TaskDetail, WorkflowDef } from "@wm/shared";
import { Activity, Archive, FileText, Settings2, X } from "lucide-react";
import { useEffect, useState } from "react";
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
import { ArchiveDialog, RetryDialog } from "./dialogs";
import { MoveDialog } from "./MoveDialog";
import { StagePanel } from "./StagePanel";
import { StatusBadge } from "./StatusBadge";
import { TaskMeta } from "./TaskMeta";
import { Timeline } from "./Timeline";

export function TaskDrawer({
  taskId,
  workflows,
  onClose,
}: {
  taskId: string;
  workflows: WorkflowDef[];
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
  onClose,
}: {
  detail: TaskDetail;
  workflow: WorkflowDef | undefined;
  now: number;
  onClose: () => void;
}) {
  const [moveTo, setMoveTo] = useState<StageDef | null>(null);
  const [archiving, setArchiving] = useState(false);
  // The chat lives here, not in the stage panel, so runs from earlier stages open it too.
  const [chatRunId, setChatRunId] = useState<number | null>(null);
  const { task } = detail;
  const visit = detail.visits.find((v) => v.id === task.currentVisitId);
  const stage = workflow?.stages.find((s) => s.id === task.currentStageId);
  const archived = task.status === "archived";

  return (
    <>
      <header className="drawer-header">
        <div className="drawer-header-top">
          <StatusBadge badge={task.badge} detail={task.badgeDetail} />
          <span className="muted small">
            {workflow?.name}
            {stage && ` · ${stage.name}`}
            {visit && !archived && ` · entered ${relativeTime(visit.enteredAt, now)}`}
          </span>
          <span className="spacer" />
          {!archived && <IconButton label="Archive task" icon={Archive} onClick={() => setArchiving(true)} />}
          <IconButton label="Close task" icon={X} onClick={onClose} />
        </div>
        <h2 className="drawer-title">{task.title}</h2>
        <TaskMeta task={task} />
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
                  title={current ? `Currently in ${s.name}` : `Move to ${s.name}`}
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
        {task.description && (
          <div className="markdown description">
            <Markdown remarkPlugins={[remarkGfm]}>{task.description}</Markdown>
          </div>
        )}
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
        onCancel={(run) => action.mutate(() => api.cancelRun(run.id))}
        onResume={(run) => action.mutate(() => api.resumeRun(run.id))}
        onClose={onClose}
      />
      {retrying && <RetryDialog run={retrying} onClose={() => setRetrying(null)} />}
    </>
  );
}
