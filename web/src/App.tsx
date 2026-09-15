import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useApi } from "./api-context";
import { AgentsView } from "./components/AgentsView";
import { ArchiveView } from "./components/ArchiveView";
import { Board } from "./components/Board";
import { ConnectionsView } from "./components/ConnectionsView";
import { NewTaskDialog } from "./components/NewTaskDialog";
import { Sidebar } from "./components/Sidebar";
import { TaskDrawer } from "./components/TaskDrawer";
import { WorkflowsView } from "./components/workflows/WorkflowsView";
import { VIEWS, type View } from "./views";
import { cls } from "./lib/format";
import { useQueryParam } from "./lib/url-state";
import { useWorkspaceNavigation } from "./workspace-context";
import { useLiveUpdates } from "./live";

export function App() {
  const setQueryParams = useWorkspaceNavigation();
  const api = useApi();
  const connected = useLiveUpdates();
  const workflows = useQuery({ queryKey: ["workflows"], queryFn: api.workflows, staleTime: Infinity });
  const workflowId = useQueryParam("workflow");
  const viewParam = useQueryParam("view");
  const view: View = VIEWS.includes(viewParam as View) ? (viewParam as View) : "board";
  const taskId = useQueryParam("task");
  const [creating, setCreating] = useState(false);

  const openTask = useCallback((id: string) => setQueryParams({ task: id }), [setQueryParams]);
  const closeTask = useCallback(() => setQueryParams({ task: null }), [setQueryParams]);

  if (workflows.isLoading) return <div className="splash">Loading…</div>;
  if (workflows.error) {
    return (
      <div className="splash">
        <strong>Could not reach the Workflow Manager server.</strong>
        <span className="muted">{workflows.error.message}</span>
        <button type="button" className="button" onClick={() => void workflows.refetch()}>
          Try again
        </button>
      </div>
    );
  }

  const list = workflows.data ?? [];
  const workflow = list.find((w) => w.id === workflowId) ?? list[0];

  return (
    <div className={cls("app", taskId && "drawer-open")}>
      <Sidebar
        workflows={list}
        currentWorkflowId={workflow?.id}
        view={view}
        connected={connected}
        // An open task belongs to the page it was opened from; left open, it covered the next page.
        onSelectWorkflow={(id) => setQueryParams({ workflow: id, view: null, task: null })}
        onSelectView={(next) => setQueryParams({ view: next === "board" ? null : next, task: null })}
        // The task may sit on another workflow's board, or be opened from a page that isn't a board.
        onOpenTask={(task) => setQueryParams({ workflow: task.workflowId, view: null, task: task.id })}
      />
      <main className="main">
        {view === "archive" ? (
          <ArchiveView workflows={list} selectedTaskId={taskId} onOpenTask={openTask} />
        ) : view === "agents" ? (
          <AgentsView />
        ) : view === "workflows" ? (
          <WorkflowsView workflows={list} workflowId={workflow?.id} />
        ) : view === "connections" ? (
          <ConnectionsView />
        ) : workflow ? (
          <Board
            workflow={workflow}
            selectedTaskId={taskId}
            onOpenTask={openTask}
            onNewTask={() => setCreating(true)}
          />
        ) : (
          <div className="splash">
            <strong>No workflows yet</strong>
            <span className="muted">Create a workflow to start adding tasks in this workspace.</span>
            <button type="button" className="button" onClick={() => setQueryParams({ view: "workflows" })}>Create workflow</button>
          </div>
        )}
      </main>
      {taskId && <TaskDrawer key={taskId} taskId={taskId} workflows={list} onClose={closeTask} />}
      {creating && workflow && (
        <NewTaskDialog
          workflows={list}
          defaultWorkflowId={workflow.id}
          onClose={() => setCreating(false)}
          onCreated={(task) => {
            setCreating(false);
            // Show the new card on its own board, whichever page or workflow the dialog was opened from.
            setQueryParams({ workflow: task.workflowId, view: null, task: task.id });
          }}
        />
      )}
    </div>
  );
}
