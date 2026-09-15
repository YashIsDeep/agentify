import { useQuery } from "@tanstack/react-query";
import type { TaskBadge, TaskSummary, WorkflowDef } from "@wm/shared";
import { BellRing, LoaderCircle, type LucideIcon, TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { useApi } from "../api-context";
import { agentLabel } from "../lib/agents";
import { clockTime, cls } from "../lib/format";
import { Menu } from "./Menu";

/** A usage limit stops a task just as a failure does, so both are counted in one place. */
const COUNTERS: { key: string; name: string; label: string; icon: LucideIcon; badges: TaskBadge[] }[] = [
  { key: "needs-you", name: "Needs you", label: "Needs you", icon: BellRing, badges: ["needs-you"] },
  { key: "running", name: "Running", label: "Running", icon: LoaderCircle, badges: ["running"] },
  { key: "stopped", name: "Stopped", label: "Failed, or waiting for a usage limit", icon: TriangleAlert, badges: ["failed", "quota"] },
];

const APP_TITLE = "Workflow Manager";

/**
 * Active tasks across every workflow, counted by what they're waiting on, at the foot of the sidebar.
 * Each count opens a list of its tasks; a count of zero isn't shown, and queued tasks aren't counted —
 * they only wait for a slot.
 */
export function StatusCounters({
  workflows,
  onOpenTask,
}: {
  workflows: WorkflowDef[];
  onOpenTask: (task: TaskSummary) => void;
}) {
  const api = useApi();
  const tasks = useQuery({ queryKey: ["tasks", "all", "active"], queryFn: () => api.tasks({ status: "active" }) });
  const byBadge = new Map<TaskBadge, TaskSummary[]>();
  for (const task of tasks.data ?? []) byBadge.set(task.badge, [...(byBadge.get(task.badge) ?? []), task]);
  const needsYou = byBadge.get("needs-you")?.length ?? 0;

  // Noticeable from another tab.
  useEffect(() => {
    document.title = needsYou ? `(${needsYou}) ${APP_TITLE}` : APP_TITLE;
  }, [needsYou]);

  const where = (task: TaskSummary) => {
    const workflow = workflows.find((w) => w.id === task.workflowId);
    const stage = workflow?.stages.find((st) => st.id === task.currentStageId);
    return [workflows.length > 1 && workflow?.name, stage?.name].filter(Boolean).join(" · ");
  };

  const counts = COUNTERS.map((counter) => ({
    ...counter,
    list: inOrder(counter.badges.flatMap((badge) => byBadge.get(badge) ?? [])),
  })).filter((counter) => counter.list.length > 0);
  if (counts.length === 0) return null;

  return (
    <div className="counters" role="group" aria-label="Tasks by status">
      {counts.map(({ key, name, label, icon: Icon, list }) => (
        <Menu
          key={key}
          label={label}
          align="left"
          title={`${label}: ${list.length}`}
          triggerLabel={`${label}: ${list.length}`}
          triggerClassName={cls("counter", `counter-${key}`)}
          trigger={
            <>
              <Icon size={14} className={cls(key === "running" && "spin")} />
              <span className="counter-name">{name}</span>
              <span className="counter-count">{list.length}</span>
            </>
          }
          items={list.map((task) => ({
            key: task.id,
            label: task.title,
            hint: [describe(task), where(task)].filter(Boolean).join(" · "),
            onSelect: () => onOpenTask(task),
          }))}
        />
      ))}
    </div>
  );
}

function describe(task: TaskSummary): string {
  const detail = task.badgeDetail;
  if (!detail) return "";
  switch (task.badge) {
    case "needs-you":
      return detail.reason === "question"
        ? `Question from ${detail.label}`
        : detail.reason === "start"
          ? `Start ${detail.label}'s actions`
          : `Approve: ${detail.label}`;
    case "quota":
      return [agentLabel(detail.agent) || detail.label, detail.resetAt && `resets ${clockTime(detail.resetAt)}`].filter(Boolean).join(" ");
    case "failed":
      return `${detail.label} failed`;
    default:
      return detail.label;
  }
}

/** Failures before usage-limit waits, those by soonest reset; the rest as the server sends them. */
function inOrder(tasks: TaskSummary[]): TaskSummary[] {
  const stopped = (task: TaskSummary) => (task.badge === "quota" ? 1 : 0);
  return [...tasks].sort(
    (a, b) => stopped(a) - stopped(b) || (a.badgeDetail?.resetAt ?? 0) - (b.badgeDetail?.resetAt ?? 0),
  );
}
