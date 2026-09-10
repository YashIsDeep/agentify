import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { api } from "./api";
import { AgentsView } from "./components/AgentsView";
import { ArchiveView } from "./components/ArchiveView";
import { Board } from "./components/Board";
import { ConnectionsView } from "./components/ConnectionsView";
import { NewTaskDialog } from "./components/NewTaskDialog";
import { TaskDrawer } from "./components/TaskDrawer";
import { TemplatesView } from "./components/templates/TemplatesView";
import { TopBar, VIEWS, type View } from "./components/TopBar";
import { cls } from "./lib/format";
import { setQueryParams, useQueryParam } from "./lib/url-state";
import { useLiveUpdates } from "./live";

export function App() {
  const connected = useLiveUpdates();
  const workflows = useQuery({ queryKey: ["workflows"], queryFn: api.workflows, staleTime: Infinity });
  const workflowId = useQueryParam("workflow");
  const viewParam = useQueryParam("view");
  const view: View = VIEWS.includes(viewParam as View) ? (viewParam as View) : "board";
  const taskId = useQueryParam("task");
  const [creating, setCreating] = useState(false);

  const openTask = useCallback((id: string) => setQueryParams({ task: id }), []);
  const closeTask = useCallback(() => setQueryParams({ task: null }), []);

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
      <TopBar
        workflows={list}
        currentWorkflowId={workflow?.id}
        view={view}
        connected={connected}
        onSelectWorkflow={(id) => setQueryParams({ workflow: id, view: null })}
        onSelectView={(next) => setQueryParams({ view: next === "board" ? null : next })}
        onNewTask={() => setCreating(true)}
      />
      <main className="main">
        {view === "archive" ? (
          <ArchiveView workflows={list} selectedTaskId={taskId} onOpenTask={openTask} />
        ) : view === "agents" ? (
          <AgentsView />
        ) : view === "templates" ? (
          <TemplatesView workflows={list} />
        ) : view === "connections" ? (
          <ConnectionsView />
        ) : workflow ? (
          <Board workflow={workflow} selectedTaskId={taskId} onOpenTask={openTask} />
        ) : (
          <div className="splash">No workflows yet.</div>
        )}
      </main>
      {taskId && <TaskDrawer key={taskId} taskId={taskId} workflows={list} onClose={closeTask} />}
      {creating && workflow && (
        <NewTaskDialog
          workflows={list}
          defaultWorkflowId={workflow.id}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            openTask(id);
          }}
        />
      )}
    </div>
  );
}
