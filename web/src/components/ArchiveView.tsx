import { useQuery } from "@tanstack/react-query";
import type { TaskSummary, WorkflowDef } from "@wm/shared";
import { Archive, Search } from "lucide-react";
import { useState } from "react";
import { useApi } from "../api-context";
import { cls, relativeTime } from "../lib/format";

export function ArchiveView({
  workflows,
  selectedTaskId,
  onOpenTask,
}: {
  workflows: WorkflowDef[];
  selectedTaskId: string | null;
  onOpenTask: (id: string) => void;
}) {
  const api = useApi();
  const tasks = useQuery({ queryKey: ["tasks", "all", "archived"], queryFn: () => api.tasks({ status: "archived" }) });
  const [search, setSearch] = useState("");
  const workflowOf = (task: TaskSummary) => workflows.find((w) => w.id === task.workflowId);
  const stageOf = (task: TaskSummary) => workflowOf(task)?.stages.find((stage) => stage.id === task.currentStageId);

  const all = [...(tasks.data ?? [])].sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
  const needle = search.trim().toLowerCase();
  const rows = needle
    ? all.filter((task) =>
        [task.title, task.description, workflowOf(task)?.name, stageOf(task)?.name, task.branch, ...task.tags].some((text) =>
          text?.toLowerCase().includes(needle),
        ),
      )
    : all;

  return (
    <div className="archive-view">
      <div className="archive-header">
        <div>
          <h2>Archive</h2>
          <p className="muted">Finished tasks keep their timeline and artifacts.</p>
        </div>
        {all.length > 0 && (
          <label className="search">
            <Search size={14} aria-hidden />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search titles, tags, workflows…"
              aria-label="Search the archive"
            />
          </label>
        )}
      </div>
      {tasks.isLoading && <p className="muted" role="status">Loading the archive…</p>}
      {tasks.error && (
        <p className="error" role="alert">
          Could not load the archive: {tasks.error.message}{" "}
          <button type="button" className="link-button" onClick={() => void tasks.refetch()}>
            Try again
          </button>
        </p>
      )}
      {/* Only a successful load is genuinely empty; a failed one must not read as "nothing archived". */}
      {tasks.isSuccess && all.length === 0 && (
        <div className="empty-state">
          <Archive size={22} />
          <strong>Nothing archived yet</strong>
          <span>Tasks land here when an archive action runs or you archive them from their Details tab.</span>
        </div>
      )}
      {all.length > 0 && rows.length === 0 && (
        <div className="empty-state">
          <Search size={22} />
          <strong>No archived task matches “{search.trim()}”</strong>
        </div>
      )}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Workflow</th>
                <th>Last stage</th>
                <th>Archived</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((task) => (
                <tr
                  key={task.id}
                  className={cls(task.id === selectedTaskId && "row-selected")}
                  tabIndex={0}
                  onClick={() => onOpenTask(task.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") onOpenTask(task.id);
                  }}
                >
                  <td>
                    <div className="table-title">{task.title}</div>
                    {task.tags.length > 0 && (
                      <div className="card-meta">
                        {task.tags.map((tag) => (
                          <span key={tag} className="chip chip-tag">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td>{workflowOf(task)?.name ?? "—"}</td>
                  <td>{stageOf(task)?.name ?? "—"}</td>
                  <td title={task.archivedAt ? new Date(task.archivedAt).toLocaleString() : undefined}>
                    {task.archivedAt ? relativeTime(task.archivedAt) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
