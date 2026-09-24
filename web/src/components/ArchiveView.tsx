import { useQuery } from "@tanstack/react-query";
import type { TaskSummary, WorkflowDef } from "@wm/shared";
import { Archive, Search } from "lucide-react";
import { useState } from "react";
import { useApi } from "../api-context";
import { cls, relativeTime } from "../lib/format";
import { Button, Callout, EmptyState, Page, SearchInput, Tag, TagList } from "../ui";

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
    <Page
      title="Archive"
      actions={
        all.length > 0 && <SearchInput value={search} onChange={setSearch} label="Search the archive" placeholder="Search titles, tags, workflows…" />
      }
    >
      {tasks.isLoading && (
        <p className="muted" role="status">
          Loading the archive…
        </p>
      )}
      {tasks.error && (
        <Callout tone="danger">
          Could not load the archive: {tasks.error.message}{" "}
          <Button variant="link" onClick={() => void tasks.refetch()}>
            Try again
          </Button>
        </Callout>
      )}
      {/* Only a successful load is genuinely empty; a failed one must not read as "nothing archived". */}
      {tasks.isSuccess && all.length === 0 && (
        <EmptyState icon={Archive} title="Nothing archived yet">
          Tasks land here when an archive action runs, or when you archive one from its header.
        </EmptyState>
      )}
      {all.length > 0 && rows.length === 0 && (
        <EmptyState icon={Search} title={`No archived task matches “${search.trim()}”`} />
      )}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Task</th>
                <th className="table-secondary">Workflow</th>
                <th className="table-secondary">Last stage</th>
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
                      <TagList>
                        {task.tags.map((tag) => (
                          <Tag key={tag} tone="accent">
                            {tag}
                          </Tag>
                        ))}
                      </TagList>
                    )}
                  </td>
                  <td className="table-secondary">{workflowOf(task)?.name ?? "—"}</td>
                  <td className="table-secondary">{stageOf(task)?.name ?? "—"}</td>
                  <td title={task.archivedAt ? new Date(task.archivedAt).toLocaleString() : undefined}>
                    {task.archivedAt ? relativeTime(task.archivedAt) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
