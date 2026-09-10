import type { RunStatus, TaskBadge } from "@wm/shared";
import { Ban, CircleCheck, CircleX, Clock, Hand, LoaderCircle, SkipForward, TriangleAlert } from "lucide-react";

const BADGE_LABELS: Record<TaskBadge, string> = {
  running: "Running",
  queued: "Queued",
  failed: "Failed",
  "needs-you": "Needs you",
  idle: "Idle",
  archived: "Archived",
};

export function StatusBadge({ badge }: { badge: TaskBadge }) {
  return (
    <span className={`badge badge-${badge}`}>
      {badge === "running" ? (
        <LoaderCircle size={11} className="spin" />
      ) : badge === "needs-you" ? (
        <Hand size={11} />
      ) : (
        <span className="badge-dot" />
      )}
      {BADGE_LABELS[badge]}
    </span>
  );
}

const RUN_LABELS: Record<RunStatus, string> = {
  waiting: "Waiting",
  queued: "Queued",
  running: "Running",
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
