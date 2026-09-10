import type { TaskDetail, TimelineEventView, VisitView } from "@wm/shared";
import {
  Archive,
  Ban,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDot,
  CircleX,
  Flag,
  LogIn,
  LogOut,
  type LucideIcon,
  MessageSquare,
  Play,
  Plus,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { cls, relativeTime } from "../lib/format";
import { RunLog } from "./RunLog";

const EVENT_STYLE: Record<string, { icon: LucideIcon; tone: string }> = {
  "task.created": { icon: Plus, tone: "muted" },
  "stage.entered": { icon: LogIn, tone: "accent" },
  "stage.exited": { icon: LogOut, tone: "muted" },
  "stage.completed": { icon: Flag, tone: "success" },
  "phase.started": { icon: CircleDot, tone: "muted" },
  "phase.completed": { icon: CircleCheck, tone: "success" },
  "phase.failed": { icon: CircleX, tone: "danger" },
  "run.started": { icon: Play, tone: "accent" },
  "run.succeeded": { icon: CircleCheck, tone: "success" },
  "run.failed": { icon: CircleX, tone: "danger" },
  "run.cancelled": { icon: Ban, tone: "muted" },
  "run.interrupted": { icon: TriangleAlert, tone: "warn" },
  "run.retried": { icon: RotateCcw, tone: "accent" },
  feedback: { icon: MessageSquare, tone: "warn" },
  "task.archived": { icon: Archive, tone: "muted" },
};

export function Timeline({ detail, now }: { detail: TaskDetail; now: number }) {
  // "Started" is noise once the same run has a later event.
  const finishedRuns = new Set(
    detail.timeline.filter((event) => event.runId !== null && event.type !== "run.started").map((event) => event.runId),
  );
  const events = detail.timeline.filter((event) => !(event.type === "run.started" && finishedRuns.has(event.runId)));
  const archived = detail.task.status === "archived";
  const visits = [...detail.visits].reverse();

  return (
    <div className="timeline">
      {visits.map((visit, index) => (
        <VisitGroup
          key={visit.id}
          visit={visit}
          events={events.filter((event) => event.visitId === visit.id)}
          current={visit.id === detail.task.currentVisitId && !archived}
          defaultOpen={index === 0}
          archived={archived}
          now={now}
        />
      ))}
      <ol className="events events-general">
        {events
          .filter((event) => event.visitId === null)
          .map((event) => (
            <EventItem key={event.id} event={event} now={now} archived={archived} />
          ))}
      </ol>
    </div>
  );
}

function VisitGroup({
  visit,
  events,
  current,
  defaultOpen,
  archived,
  now,
}: {
  visit: VisitView;
  events: TimelineEventView[];
  current: boolean;
  defaultOpen: boolean;
  archived: boolean;
  now: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={cls("visit", current && "visit-current")}>
      <button type="button" className="visit-header" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="visit-name">{visit.stageName}</span>
        {visit.attempt > 1 && <span className="chip">attempt {visit.attempt}</span>}
        {current && <span className="chip chip-accent">current</span>}
        <span className="spacer" />
        <span className="muted small" title={new Date(visit.enteredAt).toLocaleString()}>
          {relativeTime(visit.enteredAt, now)}
        </span>
      </button>
      {open && (
        <ol className="events">
          {events.map((event) => (
            <EventItem key={event.id} event={event} now={now} archived={archived} />
          ))}
        </ol>
      )}
    </section>
  );
}

function EventItem({ event, now, archived }: { event: TimelineEventView; now: number; archived: boolean }) {
  const [showLog, setShowLog] = useState(false);
  const style = EVENT_STYLE[event.type] ?? { icon: CircleDot, tone: "muted" };
  const Icon = style.icon;
  const canShowLog = event.runId !== null && event.type !== "run.retried";

  return (
    <li className={cls("event", `event-${style.tone}`, event.type === "feedback" && "event-feedback")}>
      <Icon size={14} className="event-icon" />
      <div className="event-body">
        <div className="event-row">
          <span className="event-message">{event.type === "feedback" ? "Feedback" : event.message}</span>
          <span className="event-time" title={new Date(event.at).toLocaleString()}>
            {relativeTime(event.at, now)}
          </span>
        </div>
        {event.type === "feedback" && <blockquote className="feedback-quote">{event.message}</blockquote>}
        {canShowLog && (
          <button type="button" className="link-button" onClick={() => setShowLog((value) => !value)}>
            {showLog ? "Hide output" : "Show output"}
          </button>
        )}
        {showLog && event.runId !== null && <RunLog runId={event.runId} live={event.type === "run.started"} archived={archived} />}
      </div>
    </li>
  );
}
