import { useQuery } from "@tanstack/react-query";
import type { RunView, StageDef, TaskDetail, WorkflowDef } from "@wm/shared";
import { Activity, FileText, FolderGit2, GitBranch, Link2, Settings2, X } from "lucide-react";
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ApiError } from "../api";
import { useApi } from "../api-context";
import { useNow, useTaskAction } from "../hooks";
import { cls, relativeTime } from "../lib/format";
import { linkTypeLabel } from "../lib/links";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { BrandIcon, hasBrandIcon } from "./BrandIcon";
import { ChatModal } from "./ChatModal";
import { DetailsPanel } from "./DetailsPanel";
import { RetryDialog } from "./dialogs";
import { isModalOpen } from "./Modal";
import { MoveDialog } from "./MoveDialog";
import { StagePanel } from "./StagePanel";
import { StatusBadge } from "./StatusBadge";
import { Timeline } from "./Timeline";

type Tab = "activity" | "artifacts" | "details";

const TABS: { id: Tab; label: string; icon: typeof Activity }[] = [
  { id: "activity", label: "Activity", icon: Activity },
  { id: "artifacts", label: "Artifacts", icon: FileText },
  { id: "details", label: "Details", icon: Settings2 },
];

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
      if (event.key === "Escape" && !isModalOpen()) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className="drawer" aria-label="Task details">
      {query.isLoading && <div className="drawer-message">Loading…</div>}
      {query.error && (
        <div className="drawer-message">
          <p>
            {query.error instanceof ApiError && query.error.status === 404
              ? "This task no longer exists."
              : query.error.message}
          </p>
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
        </div>
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
  const [tab, setTab] = useState<Tab>("activity");
  // Details holds a form: keep it mounted once opened so switching tabs doesn't throw away edits.
  const [detailsOpened, setDetailsOpened] = useState(false);
  const [moveTo, setMoveTo] = useState<StageDef | null>(null);
  // The chat lives here, not in the stage panel, so runs from earlier stages open it too.
  const [chatRunId, setChatRunId] = useState<number | null>(null);
  const { task } = detail;
  const visit = detail.visits.find((v) => v.id === task.currentVisitId);
  const stage = workflow?.stages.find((s) => s.id === task.currentStageId);
  const archived = task.status === "archived";
  const repoName = task.repoPath?.split(/[\\/]/).filter(Boolean).pop();

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
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close task">
            <X size={16} />
          </button>
        </div>
        <h2 className="drawer-title">{task.title}</h2>
        {(repoName || task.branch || task.links.length > 0 || task.tags.length > 0) && (
          <div className="card-meta">
            {repoName && (
              <span className="chip" title={task.repoPath ?? ""}>
                <FolderGit2 size={11} />
                {repoName}
              </span>
            )}
            {task.branch && (
              <span className="chip" title={task.worktreePath ?? ""}>
                <GitBranch size={11} />
                {task.branch}
              </span>
            )}
            {task.links.map((link) =>
              /^https?:\/\//.test(link.value) ? (
                <a key={link.value} className="chip chip-link" href={link.value} target="_blank" rel="noreferrer">
                  {hasBrandIcon(link.type) ? <BrandIcon brand={link.type} size={11} /> : <Link2 size={11} />}
                  {linkTypeLabel(link.type)}
                </a>
              ) : (
                <span key={link.value} className="chip" title={link.value}>
                  {hasBrandIcon(link.type) ? <BrandIcon brand={link.type} size={11} /> : <Link2 size={11} />}
                  {linkTypeLabel(link.type)}: {link.value}
                </span>
              ),
            )}
            {task.tags.map((tag) => (
              <span key={tag} className="chip chip-tag">
                {tag}
              </span>
            ))}
          </div>
        )}
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

        <div className="subtabs" role="tablist">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={cls("subtab", tab === id && "subtab-active")}
              onClick={() => {
                setTab(id);
                if (id === "details") setDetailsOpened(true);
              }}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>
        {tab === "activity" && <Timeline detail={detail} now={now} onOpenChat={(run) => setChatRunId(run.id)} />}
        {tab === "artifacts" && <ArtifactsPanel taskId={task.id} />}
        {detailsOpened && (
          <div hidden={tab !== "details"}>
            <DetailsPanel detail={detail} />
          </div>
        )}
      </div>

      {moveTo && (
        <MoveDialog task={task} from={stage} to={moveTo} onClose={() => setMoveTo(null)} />
      )}
      {chatRunId !== null && (
        <AgentChat detail={detail} runId={chatRunId} now={now} onSelect={setChatRunId} onClose={() => setChatRunId(null)} />
      )}
    </>
  );
}

/** The chat modal plus the Retry dialog it can open. */
function AgentChat({
  detail,
  runId,
  now,
  onSelect,
  onClose,
}: {
  detail: TaskDetail;
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
