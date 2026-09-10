import type { WorkflowDef } from "@wm/shared";
import { Archive, Bot, Plug, Plus, Workflow } from "lucide-react";
import { cls } from "../lib/format";

export type View = "board" | "archive" | "agents" | "templates" | "connections";
export const VIEWS: readonly View[] = ["board", "archive", "agents", "templates", "connections"];

export function TopBar({
  workflows,
  currentWorkflowId,
  view,
  connected,
  onSelectWorkflow,
  onSelectView,
  onNewTask,
}: {
  workflows: WorkflowDef[];
  currentWorkflowId: string | undefined;
  view: View;
  connected: boolean;
  onSelectWorkflow: (id: string) => void;
  onSelectView: (view: View) => void;
  onNewTask: () => void;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden />
        Workflow Manager
      </div>
      <nav className="tabs" aria-label="Workflows">
        {workflows.map((workflow) => {
          const active = view === "board" && workflow.id === currentWorkflowId;
          return (
            <button
              key={workflow.id}
              type="button"
              className={cls("tab", active && "tab-active")}
              aria-current={active ? "page" : undefined}
              onClick={() => onSelectWorkflow(workflow.id)}
            >
              {workflow.name}
            </button>
          );
        })}
        <span className="tab-divider" aria-hidden />
        <button type="button" className={cls("tab", view === "archive" && "tab-active")} onClick={() => onSelectView(view === "archive" ? "board" : "archive")}>
          <Archive size={14} />
          Archive
        </button>
        <button type="button" className={cls("tab", view === "agents" && "tab-active")} onClick={() => onSelectView(view === "agents" ? "board" : "agents")}>
          <Bot size={14} />
          Agents
        </button>
        <button
          type="button"
          className={cls("tab", view === "templates" && "tab-active")}
          onClick={() => onSelectView(view === "templates" ? "board" : "templates")}
        >
          <Workflow size={14} />
          Templates
        </button>
        <button
          type="button"
          className={cls("tab", view === "connections" && "tab-active")}
          onClick={() => onSelectView(view === "connections" ? "board" : "connections")}
        >
          <Plug size={14} />
          Connections
        </button>
      </nav>
      <div className="topbar-actions">
        <span
          className={cls("live", connected ? "live-on" : "live-off")}
          title={connected ? "Live updates connected" : "Reconnecting to the server…"}
        >
          <span className="live-dot" />
          {connected ? "Live" : "Offline"}
        </span>
        <button type="button" className="button primary" onClick={onNewTask}>
          <Plus size={15} />
          New task
        </button>
      </div>
    </header>
  );
}
