import { useQuery } from "@tanstack/react-query";
import type { TaskSummary, WorkflowDef } from "@wm/shared";
import { Archive } from "lucide-react";
import { api } from "../api";
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
  const tasks = useQuery({ queryKey: ["tasks", "all", "archived"], queryFn: () => api.tasks({ status: "archived" }) });
  const rows = [...(tasks.data ?? [])].sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
  const workflowOf = (task: TaskSummary) => workflows.find((w) => w.id === task.workflowId);

  return (
    <div className="archive-view">
      <div className="archive-header">
        <h2>Archive</h2>
        <p className="muted">Finished tasks keep their timeline and artifacts.</p>
      </div>
      {tasks.error && <p className="error">{tasks.error.message}</p>}
      {!tasks.isLoading && rows.length === 0 && (
        <div className="empty-state">
          <Archive size={22} />
          <strong>Nothing archived yet</strong>
          <span>Tasks land here when an archive action runs or you archive them from their Details tab.</span>
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
              {rows.map((task) => {
                const workflow = workflowOf(task);
                return (
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
                    <td>{workflow?.name ?? "—"}</td>
                    <td>{workflow?.stages.find((stage) => stage.id === task.currentStageId)?.name ?? "—"}</td>
                    <td title={task.archivedAt ? new Date(task.archivedAt).toLocaleString() : undefined}>
                      {task.archivedAt ? relativeTime(task.archivedAt) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
