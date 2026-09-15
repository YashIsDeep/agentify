import type { BadgeDetail, RunStatus, TaskBadge } from "@wm/shared";
import { Ban, CircleCheck, CircleX, Clock, Hand, Hourglass, LoaderCircle, SkipForward, TriangleAlert } from "lucide-react";
import { clockTime } from "../lib/format";

const BADGE_LABELS: Record<TaskBadge, string> = {
  running: "Running",
  quota: "Quota wait",
  queued: "Queued",
  failed: "Failed",
  "needs-you": "Needs you",
  idle: "Idle",
  archived: "Archived",
};

export function StatusBadge({ badge, detail }: { badge: TaskBadge; detail?: BadgeDetail | null }) {
  // A quota wait is only useful with its time: "Resets 2:40 AM".
  const resetAt = badge === "quota" ? detail?.resetAt : undefined;
  return (
    <span className={`badge badge-${badge}`} title={resetAt ? "Waiting for a usage limit to reset" : undefined}>
      {badge === "running" ? (
        <LoaderCircle size={11} className="spin" />
      ) : badge === "needs-you" ? (
        <Hand size={11} />
      ) : badge === "quota" ? (
        <Hourglass size={11} />
      ) : (
        <span className="badge-dot" />
      )}
      {resetAt ? `Resets ${clockTime(resetAt)}` : badge === "needs-you" && detail?.reason === "approval" ? "Ready for review" : BADGE_LABELS[badge]}
    </span>
  );
}

const RUN_LABELS: Record<RunStatus, string> = {
  waiting: "Waiting",
  queued: "Queued",
  running: "Running",
  "awaiting-approval": "Ready for review",
  "quota-wait": "Waiting for a usage limit to reset",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  skipped: "Skipped",
};

export function RunStatusIcon({ status }: { status: RunStatus }) {
  const props = { size: 14, "aria-label": RUN_LABELS[status], className: `run-icon run-icon-${status}` };
  switch (status) {
    case "running":
      return <LoaderCircle {...props} className={`${props.className} spin`} />;
    case "waiting":
    case "queued":
      return <Clock {...props} />;
    case "awaiting-approval":
      return <Hand {...props} />;
    case "quota-wait":
      return <Hourglass {...props} />;
    case "succeeded":
      return <CircleCheck {...props} />;
    case "failed":
      return <CircleX {...props} />;
    case "cancelled":
      return <Ban {...props} />;
    case "interrupted":
      return <TriangleAlert {...props} />;
    case "skipped":
      return <SkipForward {...props} />;
  }
}

export const runStatusLabel = (status: RunStatus) => RUN_LABELS[status];
