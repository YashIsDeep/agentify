import { useQuery } from "@tanstack/react-query";
import { canRetry, isActiveRun, loopPolicy, type RunLogLine, type RunView, type StageDef, type TaskDetail } from "@wm/shared";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  MessageCircleQuestion,
  MessagesSquare,
  Play,
  RotateCcw,
  ScrollText,
  Square,
  Terminal,
  UserRound,
  Wrench,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useApi } from "../api-context";
import { type ChatItem, toChatItems, transcriptText } from "../lib/chat";
import { clockTime, cls, relativeTime, runDuration, usageSummary } from "../lib/format";
import { agentChats, describeAgent, isAwaitingApproval } from "../lib/runs";
import { Button, Dialog, IconButton } from "../ui";
import { QuestionCard } from "./QuestionCard";
import { AgentReview } from "./AgentReview";
import { RunStatusIcon, runStatusLabel } from "./StatusBadge";

/**
 * A coding agent's run, read as the conversation it was.
 *
 * The agent is headless, so most of this is a viewer. It becomes a chat you can type into at the
 * two moments the agent is actually listening: a question it stopped to ask, and the approval it
 * waits on when it has finished — where what you type is picked up in the same session.
 */
export function ChatModal({
  detail,
  stages,
  runId,
  now,
  busy,
  onSelect,
  onRetry,
  onCancel,
  onResume,
  onClose,
}: {
  detail: TaskDetail;
  /** The workflow's stages, to name where a Send back goes. */
  stages: StageDef[];
  runId: number;
  now: number;
  busy: boolean;
  onSelect: (runId: number) => void;
  onRetry: (run: RunView) => void;
  onCancel: (run: RunView) => void;
  /** "Try now" on a run waiting for a usage limit to reset. */
  onResume: (run: RunView) => void;
  onClose: () => void;
}) {
  const chats = agentChats(detail);
  const current = chats.find((chat) => chat.run.id === runId) ?? chats[0];
  if (!current) return null;
  const { run } = current;
  const stageDefaults = (stageId: string) => stages.find((stage) => stage.id === stageId)?.agentDefaults;
  // Archiving purges transcripts and ends the task's runs, so there is nothing to act on.
  const archived = detail.task.status === "archived";

  return (
    <Dialog title={`${run.label} transcript`} onClose={onClose} bare className="chat-window">
        <nav className="chat-list" aria-label="Chats in this task">
          <div className="chat-list-head">
            <MessagesSquare size={13} />
            Chats in this task
          </div>
          <ul>
            {chats.map(({ run: entry, visit }) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className={cls("chat-list-item", entry.id === run.id && "chat-list-item-current")}
                  onClick={() => onSelect(entry.id)}
                >
                  <span className="chat-list-title">
                    <RunStatusIcon status={entry.status} />
                    <span className="chat-list-label">{entry.label}</span>
                    {entry.question && <MessageCircleQuestion size={13} className="text-warn" aria-label="Waiting on you" />}
                  </span>
                  <span className="chat-list-meta">
                    {visit.stageName}
                    {entry.retryOfRunId && " · retry"}
                  </span>
                  <span className="chat-list-meta">
                    {describeAgent(entry, detail.task, stageDefaults(visit.stageId))}
                    {entry.startedAt && ` · ${relativeTime(entry.startedAt, now)}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <section className="chat-main">
          <header className="chat-header">
            {/* A blocked agent is still "running" to the engine, but what it's doing is waiting on you. */}
            {run.question ? (
              <MessageCircleQuestion size={14} className="run-icon text-warn" aria-label="Waiting on you" />
            ) : (
              <RunStatusIcon status={run.status} />
            )}
            <div className="chat-header-text">
              <strong>{run.label}</strong>
              <span className="muted small">
                {describeAgent(run, detail.task, stageDefaults(current.visit.stageId))}
                {` · ${ranWithAutonomy(run)}`} · {run.question ? "Waiting on you" : runStatusLabel(run.status)}
                {run.resumeAt && ` · resets ${clockTime(run.resumeAt, now)}`}
                {run.startedAt && ` · ${runDuration(run, now)}`}
                {usageSummary(run.usage) && ` · ${usageSummary(run.usage)}`}
              </span>
            </div>
            <span className="spacer" />
            {/* Phones have no room for the chat list beside the transcript, so it becomes a picker. */}
            {chats.length > 1 && (
              <select
                className="chat-switcher"
                aria-label="Chats in this task"
                value={run.id}
                onChange={(event) => onSelect(Number(event.target.value))}
              >
                {chats.map(({ run: entry, visit }) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label} · {visit.stageName}
                    {entry.question ? " · waiting on you" : ""}
                  </option>
                ))}
              </select>
            )}
            {!archived && run.status === "quota-wait" && (
              <Button size="sm" icon={Play} onClick={() => onResume(run)} disabled={busy} title="Try again before the reset time">
                Try now
              </Button>
            )}
            {!archived && isActiveRun(run) && !isAwaitingApproval(run) && (
              <Button size="sm" icon={Square} onClick={() => onCancel(run)} disabled={busy}>
                Cancel
              </Button>
            )}
            {!archived && canRetry(run) && (
              <Button size="sm" icon={RotateCcw} onClick={() => onRetry(run)} disabled={busy}>
                Retry
              </Button>
            )}
            <IconButton label="Close chat" icon={X} onClick={onClose} />
          </header>

          <Transcript key={run.id} run={run} now={now} archived={archived}>
            {!archived && <AgentReview run={run} detail={detail} stages={stages} onOpenRun={onSelect} />}
          </Transcript>
        </section>
    </Dialog>
  );
}

export function Transcript({ run, now, archived, children }: { run: RunView; now: number; archived: boolean; children?: ReactNode }) {
  const api = useApi();
  const log = useQuery({ queryKey: ["runLog", run.id], queryFn: () => api.runLog(run.id), staleTime: 0 });
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followTail = useRef(true);
  const lines = log.data ?? [];

  // Follow the last message, not the end of a potentially very long review below it.
  const tailPosition = () => {
    const element = bodyRef.current;
    const transcript = transcriptRef.current;
    if (!element || !transcript) return 0;
    return Math.max(0, transcript.getBoundingClientRect().bottom - element.getBoundingClientRect().top + element.scrollTop - element.clientHeight);
  };
  const pin = () => {
    const element = bodyRef.current;
    if (element && followTail.current) element.scrollTop = tailPosition();
  };
  // A new chat starts at the bottom; an open one only follows if you haven't scrolled away.
  useEffect(() => {
    followTail.current = true;
  }, [run.id]);
  useEffect(pin, [lines.length, raw]);
  // A round starting (your revision, your answer) or ending is worth seeing wherever you had scrolled
  // to: otherwise the previous draft stays in view beside "Ready for review".
  useEffect(() => {
    followTail.current = true;
    pin();
  }, [run.status, run.question?.id]);
  // Keep the latest message visible when the viewport changes size.
  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => pin());
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const copy = () => {
    void navigator.clipboard.writeText(transcriptText(lines)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const items = toChatItems(lines);
  // The pending question is answered in the live card, so don't also show it as history.
  const lastQuestion = run.question ? items.findLast((item) => item.kind === "question") : undefined;

  return (
    <div
      className="chat-scroll"
      ref={bodyRef}
      tabIndex={0}
      role="region"
      aria-label="Conversation and review"
      onScroll={(event) => {
        const element = event.currentTarget;
        // Reading the review is deliberate too: new output must not pull you back up.
        followTail.current = Math.abs(tailPosition() - element.scrollTop) < 32;
      }}
    >
      <div className="chat-body" ref={transcriptRef}>
        {log.isLoading && <p className="muted small">Loading the transcript…</p>}
        {log.error && <p className="chat-notice chat-notice-error">Could not load the transcript: {log.error.message}</p>}
        {!log.isLoading && !log.error && lines.length === 0 && (
          <p className="muted small">
            {run.status === "running"
              ? "Waiting for the agent to say something…"
              : archived
                ? "Transcripts are removed when a task is archived."
                : "Nothing was recorded."}
          </p>
        )}

        {raw ? (
          <pre className="log">
            {lines.map((line, index) => (
              <div key={index} className={cls("log-line", `log-${line.stream}`)}>
                {rawLine(line)}
              </div>
            ))}
          </pre>
        ) : (
          items.filter((item) => item !== lastQuestion).map((item) => <ChatBubble key={item.key} item={item} />)
        )}

        {run.question && <QuestionCard question={run.question} />}
        {run.error && run.status !== "cancelled" && <p className="chat-notice chat-notice-error">{run.error}</p>}
        {run.status === "running" && !run.question && (
          <p className="chat-working">
            <span className="chat-dots" aria-hidden="true" />
            Working… {run.startedAt && runDuration({ ...run, endedAt: null }, now)}
          </p>
        )}
      </div>

      <footer className="chat-footer">
        <Button variant="ghost" size="sm" icon={Terminal} onClick={() => setRaw((value) => !value)}>
          {raw ? "Conversation" : "Raw log"}
        </Button>
        <span className="spacer" />
        <span className="muted small">{lines.length} lines</span>
        <Button variant="ghost" size="sm" icon={copied ? Check : Copy} onClick={copy} disabled={lines.length === 0}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </footer>
      {children}
    </div>
  );
}

function ChatBubble({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "prompt":
      return <PromptRow text={item.text} />;
    case "message":
      return (
        <div className="chat-turn chat-turn-agent">
          <div className="markdown chat-bubble">
            <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
          </div>
        </div>
      );
    case "question":
      return (
        <div className="chat-turn chat-turn-agent">
          <div className="chat-bubble chat-bubble-question">
            <MessageCircleQuestion size={14} />
            <span className="chat-prewrap">{item.text}</span>
          </div>
        </div>
      );
    case "answer":
      return (
        <div className="chat-turn chat-turn-you">
          <div className="chat-bubble chat-bubble-you">
            <UserRound size={14} />
            <span className="chat-prewrap">{item.text}</span>
          </div>
        </div>
      );
    case "notice":
      return <p className={cls("chat-notice", item.error && "chat-notice-error")}>{item.text}</p>;
    case "output":
      return (
        <pre className="log chat-output">
          {item.lines.map((line, index) => (
            <div key={index} className={cls("log-line", `log-${line.stream}`)}>
              {line.text || " "}
            </div>
          ))}
        </pre>
      );
    case "tool":
      return <ToolRow item={item} />;
  }
}

/**
 * What the agent was handed to start with. It is where you look when the run went wrong for reasons
 * the conversation doesn't explain, and noise the rest of the time, so it stays folded away until
 * you ask for it.
 */
function PromptRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="chat-tool">
      <button type="button" className="chat-tool-row" onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <ScrollText size={12} />
        <span className="chat-tool-name">Prompt</span>
        <span className="chat-tool-detail">{text.replace(/\s+/g, " ").trim()}</span>
      </button>
      {open && (
        <div className="chat-tool-body">
          <pre className="chat-prewrap">{text}</pre>
        </div>
      )}
    </div>
  );
}

function ToolRow({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const failed = item.result?.ok === false;
  const expandable = Boolean(item.detail || item.result?.detail);

  return (
    <div className={cls("chat-tool", failed && "chat-tool-failed")}>
      <button type="button" className="chat-tool-row" onClick={() => setOpen((value) => !value)} disabled={!expandable}>
        {expandable ? open ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : <span className="chevron-space" />}
        <Wrench size={12} />
        <span className="chat-tool-name">{item.tool}</span>
        <span className="chat-tool-detail">{item.detail}</span>
        <span className="spacer" />
        {!item.result ? (
          <span className="chat-tool-status muted">running</span>
        ) : failed ? (
          <span className="chat-tool-status text-danger">failed</span>
        ) : (
          <Check size={12} className="text-success" />
        )}
      </button>
      {open && (
        <div className="chat-tool-body">
          {item.detail && <pre className="chat-prewrap">{item.detail}</pre>}
          {item.result?.detail && (
            <pre className={cls("chat-prewrap", "chat-tool-result", failed && "chat-notice-error")}>{item.result.detail}</pre>
          )}
        </div>
      )}
    </div>
  );
}

const rawLine = (line: RunLogLine): string => {
  if (line.kind === "tool") return `▸ ${line.tool}${line.text ? `: ${line.text}` : ""}`;
  if (line.kind === "tool-result") return `  ↳ ${line.tool}${line.ok === false ? " failed" : ""}${line.text ? `: ${line.text}` : ""}`;
  return line.text || " ";
};

/** What the run used, as it recorded; one that hasn't run yet shows what its loop mode will use. */
function ranWithAutonomy(run: RunView): string {
  if (typeof run.outputs?.autonomy === "string") return run.outputs.autonomy;
  return loopPolicy({ ...run.config, ...(run.overrides ?? {}) }).autonomy;
}
