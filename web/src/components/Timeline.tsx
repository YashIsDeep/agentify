import type { RunView, TaskDetail, TimelineEventView, VisitView } from "@wm/shared";
import {
  Archive,
  Ban,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDot,
  CircleX,
  Flag,
  Hand,
  Hourglass,
  LogIn,
  LogOut,
  type LucideIcon,
  MessageSquare,
  Play,
  Plus,
  RotateCcw,
  SkipForward,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import { useState } from "react";
import { cls, relativeTime } from "../lib/format";
import { isAgentRun, isApprovalRun } from "../lib/runs";
import { Button, Tag } from "../ui";
import { RunLog } from "./RunLog";

interface EventContext {
  now: number;
  archived: boolean;
  runs: Map<number, RunView>;
  onOpenChat: (run: RunView) => void;
}

const EVENT_STYLE: Record<string, { icon: LucideIcon; tone: string }> = {
  "task.created": { icon: Plus, tone: "muted" },
  "stage.entered": { icon: LogIn, tone: "accent" },
  "stage.exited": { icon: LogOut, tone: "muted" },
  "stage.completed": { icon: Flag, tone: "success" },
  "actions.started": { icon: Play, tone: "accent" },
  "approval.waiting": { icon: Hand, tone: "warn" },
  "run.approved": { icon: CircleCheck, tone: "success" },
  "run.sent-back": { icon: Undo2, tone: "warn" },
  "run.changes-requested": { icon: MessageSquare, tone: "warn" },
  "run.skipped": { icon: SkipForward, tone: "muted" },
  "run.started": { icon: Play, tone: "accent" },
  "run.succeeded": { icon: CircleCheck, tone: "success" },
  "run.failed": { icon: CircleX, tone: "danger" },
  "run.cancelled": { icon: Ban, tone: "muted" },
  "run.interrupted": { icon: TriangleAlert, tone: "warn" },
  "run.quota-wait": { icon: Hourglass, tone: "info" },
  "run.resumed": { icon: Play, tone: "accent" },
  "run.retried": { icon: RotateCcw, tone: "accent" },
  feedback: { icon: MessageSquare, tone: "warn" },
  "task.archived": { icon: Archive, tone: "muted" },
};

export function Timeline({
  detail,
  now,
  onOpenChat,
}: {
  detail: TaskDetail;
  now: number;
  onOpenChat: (run: RunView) => void;
}) {
  // "Started" is noise once the same run has a later event.
  const finishedRuns = new Set(
    detail.timeline.filter((event) => event.runId !== null && event.type !== "run.started").map((event) => event.runId),
  );
  const events = detail.timeline.filter((event) => !(event.type === "run.started" && finishedRuns.has(event.runId)));
  const archived = detail.task.status === "archived";
  const visits = [...detail.visits].reverse();
  const context: EventContext = {
    now,
    archived,
    runs: new Map(detail.visits.flatMap((visit) => visit.runs).map((run) => [run.id, run])),
    onOpenChat,
  };

  return (
    <div className="timeline">
      {visits.map((visit, index) => (
        <VisitGroup
          key={visit.id}
          visit={visit}
          events={events.filter((event) => event.visitId === visit.id)}
          current={visit.id === detail.task.currentVisitId && !archived}
          // The stage panel above already lays out the current stage, so the history starts folded.
          defaultOpen={index === 0 && (archived || visit.id !== detail.task.currentVisitId)}
          context={context}
        />
      ))}
      <ol className="events events-general">
        {events
          .filter((event) => event.visitId === null)
          .map((event) => (
            <EventItem key={event.id} event={event} context={context} />
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
  context,
}: {
  visit: VisitView;
  events: TimelineEventView[];
  current: boolean;
  defaultOpen: boolean;
  context: EventContext;
}) {
  const { now } = context;
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={cls("visit", current && "visit-current")}>
      <button type="button" className="visit-header" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="visit-name">{visit.stageName}</span>
        {visit.attempt > 1 && <Tag>attempt {visit.attempt}</Tag>}
        {current && <Tag tone="accent">current</Tag>}
        <span className="spacer" />
        <span className="muted small" title={new Date(visit.enteredAt).toLocaleString()}>
          {relativeTime(visit.enteredAt, now)}
        </span>
      </button>
      {open && (
        <ol className="events">
          {events.map((event) => (
            <EventItem key={event.id} event={event} context={context} />
          ))}
        </ol>
      )}
    </section>
  );
}

function EventItem({ event, context }: { event: TimelineEventView; context: EventContext }) {
  const { now, archived } = context;
  const [showLog, setShowLog] = useState(false);
  const style = EVENT_STYLE[event.type] ?? { icon: CircleDot, tone: "muted" };
  const Icon = style.icon;
  // An agent's transcript is a conversation; flattened into a log it read as one run-on block.
  const run = event.runId !== null ? context.runs.get(event.runId) : undefined;
  // An approval has no output; its events already say what was decided.
  const canShowLog = event.runId !== null && event.type !== "run.retried" && !(run && isApprovalRun(run));
  const agentRun = run && isAgentRun(run) ? run : undefined;

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
        {canShowLog && agentRun && (
          <Button variant="link" onClick={() => context.onOpenChat(agentRun)}>
            Open chat
          </Button>
        )}
        {canShowLog && !agentRun && (
          <Button variant="link" onClick={() => setShowLog((value) => !value)}>
            {showLog ? "Hide output" : "Show output"}
          </Button>
        )}
        {showLog && event.runId !== null && <RunLog runId={event.runId} live={event.type === "run.started"} archived={archived} />}
      </div>
    </li>
  );
}
