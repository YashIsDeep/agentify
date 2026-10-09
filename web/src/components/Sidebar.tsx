import type { TaskSummary, WorkflowDef } from "@wm/shared";
import { Menu as MenuIcon, Workflow, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cls } from "../lib/format";
import { PAGES, type View } from "../views";
import { isDialogOpen } from "../ui";
import { RemoteIndicator } from "./RemoteIndicator";
import { StatusCounters } from "./StatusCounters";
import { ThemeToggle } from "./ThemeToggle";
import { WorkflowIcon } from "./WorkflowIcon";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

/** Everything the browser would stop at on Tab: the drawer keeps focus inside itself with it. */
const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function Sidebar({
  workflows,
  currentWorkflowId,
  view,
  connected,
  onSelectWorkflow,
  onSelectView,
  onOpenTask,
}: {
  workflows: WorkflowDef[];
  currentWorkflowId?: string;
  view: View;
  connected: boolean;
  onSelectWorkflow: (id: string) => void;
  onSelectView: (view: View) => void;
  onOpenTask: (task: TaskSummary) => void;
}) {
  // Narrow widths have no room for a standing sidebar, so it slides in over the page instead.
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);

  // Whether there is a drawer at all is the stylesheet's call: only the narrow media query takes the
  // sidebar out of the page grid, so read that back rather than keep a second copy of the breakpoint.
  const isDrawer = () => asideRef.current !== null && getComputedStyle(asideRef.current).position === "fixed";

  // A closed drawer is hidden outright and can't hold focus, so the drawer takes focus on the way in
  // and hands it back to the toggle on the way out, rather than dropping it on the body.
  useEffect(() => {
    const aside = asideRef.current;
    if (open) {
      wasOpen.current = true;
      if (isDrawer()) aside?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const active = document.activeElement;
    if (!active || active === document.body || aside?.contains(active)) toggleRef.current?.focus();
  }, [open]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const aside = asideRef.current;
      const toggle = toggleRef.current;
      // A dialog or menu opened from the drawer sits on top of it, and answers the keyboard itself.
      if (!open || !aside || !toggle || isDialogOpen() || event.defaultPrevented) return;
      if (event.key === "Escape") return setOpen(false);
      if (event.key !== "Tab" || !isDrawer()) return;
      // The page behind the scrim is out of reach, and the toggle is the drawer's close button.
      const stops = [toggle, ...aside.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (!first || !last) return;
      const active = document.activeElement as HTMLElement | null;
      const inside = active !== null && stops.includes(active);
      if (event.shiftKey && (active === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Picking a destination is the end of the errand the drawer was opened for.
  const go = (run: () => void) => () => {
    run();
    setOpen(false);
  };

  return (
    <>
      <button
        ref={toggleRef}
        type="button"
        className="nav-toggle"
        aria-label={open ? "Close navigation" : "Open navigation"}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <X size={18} /> : <MenuIcon size={18} />}
      </button>
      {open && <div className="nav-scrim" onClick={() => setOpen(false)} />}
      <aside ref={asideRef} className={cls("sidebar", open && "sidebar-open")}>
        <button className="sidebar-brand" type="button" onClick={go(() => onSelectView("board"))}>
          <Workflow size={19} aria-hidden="true" />
          <span>Agentify</span>
        </button>
        <WorkspaceSwitcher />
        <nav className="sidebar-nav" aria-label="Workspace navigation">
          {PAGES.map(({ view: page, label, icon: Icon }) => (
            <button key={page} type="button" className={cls("sidebar-link", view === page && "sidebar-link-active")} aria-current={view === page ? "page" : undefined} onClick={go(() => onSelectView(page))}>
              <Icon size={17} />{label}
            </button>
          ))}
          <span className="nav-label nav-label-boards">Boards</span>
          {workflows.map((workflow) => (
            <button key={workflow.id} type="button" className={cls("sidebar-link sidebar-workflow", view === "board" && currentWorkflowId === workflow.id && "sidebar-workflow-active")} aria-current={view === "board" && currentWorkflowId === workflow.id ? "page" : undefined} onClick={go(() => onSelectWorkflow(workflow.id))} title={workflow.name}>
              <WorkflowIcon icon={workflow.icon} /><span className="sidebar-workflow-name">{workflow.name}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <StatusCounters
            workflows={workflows}
            conversationsOpen={view === "conversations"}
            onOpenConversations={go(() => onSelectView("conversations"))}
            onOpenTask={(task) => {
              onOpenTask(task);
              setOpen(false);
            }}
          />
          <div className="sidebar-footer-row">
            <span className="sidebar-footer-status">
              <span
                className={cls("live", connected ? "live-on" : "live-off")}
                title={connected ? "Live updates connected" : "Reconnecting to the server…"}
              >
                <span className="live-dot" />
                {connected ? "Live" : "Offline"}
              </span>
              <RemoteIndicator onOpen={go(() => onSelectView("devices"))} />
            </span>
            <ThemeToggle />
          </div>
        </div>
      </aside>
    </>
  );
}
