import type { BadgeDetail, RunStatus, TaskBadge } from "@wm/shared";
import { Ban, CircleCheck, CircleX, Clock, Hand, Hourglass, LoaderCircle, SkipForward, TriangleAlert } from "lucide-react";
import { clockTime } from "../lib/format";
import { Badge, type Tone } from "../ui";

const BADGE_LABELS: Record<TaskBadge, string> = {
  running: "Running",
  quota: "Quota wait",
  queued: "Queued",
  failed: "Failed",
  "needs-you": "Needs you",
  idle: "Idle",
  archived: "Archived",
};

const BADGE_TONES: Record<TaskBadge, Tone> = {
  running: "accent",
  quota: "info",
  queued: "neutral",
  failed: "danger",
  "needs-you": "warn",
  idle: "neutral",
  archived: "neutral",
};

export function StatusBadge({ badge, detail }: { badge: TaskBadge; detail?: BadgeDetail | null }) {
  // A quota wait is only useful with its time: "Resets 2:40 AM".
  const resetAt = badge === "quota" ? detail?.resetAt : undefined;
  const icon =
    badge === "running" ? <LoaderCircle size={11} className="spin" aria-hidden="true" /> : badge === "needs-you" ? Hand : badge === "quota" ? Hourglass : undefined;
  return (
    <Badge tone={BADGE_TONES[badge]} icon={icon} title={resetAt ? "Waiting for a usage limit to reset" : undefined}>
      {resetAt
        ? `Resets ${clockTime(resetAt)}`
        : badge === "needs-you" && detail?.reason === "approval"
          ? "Ready for review"
          : badge === "failed" && detail?.cancelled
            ? "Cancelled"
            : BADGE_LABELS[badge]}
    </Badge>
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
