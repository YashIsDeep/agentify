import { join } from "node:path";
import type { AgentUsage, LoopPolicy } from "@wm/shared";
import type { RunLog } from "../actions/types";
import type { QuestionService } from "../services/questions";
import { type AgentRunResult, runAgent } from "./run";
import type { AgentAdapter, AgentEvent, ResolvedCli } from "./types";

/**
 * Who a turn speaks for. The author opens the run and may stop to ask you something; a fixer is the
 * author's later corrections (a revised document, a CI fix), which never ask; the reviewer checks the
 * work independently, read-only for a document, and its verdicts stay out of the chat.
 */
export type TurnRole = "author" | "fixer" | "reviewer";

export interface TurnOptions {
  /** A session to resume, or null for a fresh one. */
  session: string | null;
  role: TurnRole;
}

/** Every call a coding-agent run makes to its agent goes through here. */
export interface AgentTurns {
  turn(prompt: string, options: TurnOptions): Promise<AgentRunResult>;
  /** What every turn so far has used, added up. */
  readonly usage: AgentUsage | null;
}

/** One adapter at the seam: sends a single turn to an agent. */
export type TurnInvoke = (prompt: string, options: TurnOptions) => Promise<AgentRunResult>;

/** Wraps an adapter so the turns' usage is added up in one place, whatever sits behind it. */
export function createTurns(invoke: TurnInvoke): AgentTurns {
  let usage: AgentUsage | null = null;
  return {
    async turn(prompt, options) {
      const result = await invoke(prompt, options);
      usage = sumUsage(usage, result.usage);
      return result;
    },
    get usage() {
      return usage;
    },
  };
}

/** Largest prompt kept in the transcript; past this the point has been made and the log is just heavy. */
const MAX_PROMPT_IN_LOG = 20_000;

export interface CliTurnsOptions {
  adapter: AgentAdapter;
  cli: ResolvedCli;
  model: string | null;
  effort: string | null;
  policy: LoopPolicy;
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
  inactivityTimeoutMs: number;
  timeoutMs?: number;
  /** Each role's scratch directory is this path with a suffix. */
  scratchPrefix: string;
  log: RunLog;
  /** Lines describing the run, logged once just after the first prompt so the prompt opens the transcript. */
  introduction: string[];
  runId: number;
  questions: QuestionService;
}

/**
 * The production adapter: each turn runs the agent's CLI in the run's working directory and writes
 * it to the run's transcript, prompt first, as a conversation. While the run is open the author can
 * ask you questions, when both its CLI and the loop mode allow; `close` ends that.
 */
export function cliTurns(options: CliTurnsOptions): AgentTurns & { close(): void } {
  const { adapter, policy, log, runId, questions } = options;
  // Only agents that can be pointed at an MCP server per invocation can stop and ask.
  const askUserUrl = adapter.supportsQuestions && policy.asksQuestions ? questions.endpointFor(runId) : null;
  if (askUserUrl) questions.attachLog(runId, log);
  const introduction = [...(askUserUrl ? [`${adapter.label} can ask you questions while it works`] : []), ...options.introduction];

  const turns = createTurns((prompt, { session, role }) => {
    // Recorded as sent, so what the transcript shows is exactly what the CLI got. When a run goes
    // wrong the prompt is as often the culprit as the agent: a template that rendered an artifact as
    // nothing leaves no other trace.
    log({ kind: "prompt", stream: "info", text: promptForLog(prompt) });
    for (const line of introduction.splice(0)) log(line);
    const logEvent = eventLogger(log);
    return runAgent({
      adapter,
      cli: options.cli,
      invocation: {
        prompt,
        model: options.model,
        effort: options.effort,
        autonomy: role === "reviewer" && policy.review === "document" ? "read-only" : policy.autonomy,
        resumeSessionId: session,
        cwd: options.cwd,
        scratchDir: `${options.scratchPrefix}-${role === "reviewer" ? "review" : "agent"}`,
        // Internal review and correction must not become a conversation with you.
        askUserUrl: role === "author" ? askUserUrl : null,
      },
      env: options.env,
      signal: options.signal,
      inactivityTimeoutMs: options.inactivityTimeoutMs,
      timeoutMs: options.timeoutMs,
      isIdleExpected: () => questions.isWaiting(runId),
      onEvent: (event) => {
        // A reviewer's verdict stays inspectable in collapsed output, not as the work to approve.
        if (role === "reviewer" && event.kind === "message") log(event.text, "stdout");
        else logEvent(event);
      },
      onStderr: (line) => log(line, "stderr"),
    });
  });

  return {
    turn: turns.turn,
    get usage() {
      return turns.usage;
    },
    close() {
      // Whatever happened, the endpoint dies with the run and nothing is left blocked on it.
      questions.cancelForRun(runId, "The run ended");
      questions.releaseToken(runId);
      questions.detachLog(runId);
    },
  };
}

/** Scratch directories of a run's turns live under the task's runs directory. */
export const scratchPrefix = (runsDir: string, runId: number) => join(runsDir, String(runId));

/** The prompt as the transcript keeps it, saying so itself when it was too long to keep whole. */
function promptForLog(prompt: string): string {
  if (prompt.length <= MAX_PROMPT_IN_LOG) return prompt;
  return `${prompt.slice(0, MAX_PROMPT_IN_LOG)}\n\n[Truncated: the prompt was ${prompt.length} characters and only the first ${MAX_PROMPT_IN_LOG} are kept here.]`;
}

/**
 * Turns the CLI's event stream into transcript entries. Each keeps its shape — a message stays one
 * message however many lines it spans, and a tool result carries the id of the call it answers —
 * so the chat view can render the run as the conversation it was.
 */
function eventLogger(log: RunLog) {
  let loggedSession = false;
  return (event: AgentEvent) => {
    switch (event.kind) {
      case "message":
        log({ kind: "message", stream: "stdout", text: event.text });
        break;
      case "tool":
        if (event.status === "started") {
          log({ kind: "tool", stream: "info", text: event.detail ?? "", tool: event.name, ref: event.id });
        } else {
          log({
            kind: "tool-result",
            stream: event.status === "failed" ? "stderr" : "info",
            text: event.detail ?? "",
            tool: event.name,
            ref: event.id,
            ok: event.status !== "failed",
          });
        }
        break;
      case "error":
        log({ kind: "notice", stream: "stderr", text: event.message });
        break;
      case "session":
        if (!loggedSession) log({ kind: "notice", stream: "info", text: `Session ${event.sessionId}` });
        loggedSession = true;
        break;
      case "raw":
        log({ stream: "stdout", text: event.text });
        break;
    }
  };
}

function sumUsage(a: AgentUsage | null, b: AgentUsage | null): AgentUsage | null {
  if (!a) return b;
  if (!b) return a;
  const total: AgentUsage = { estimated: a.estimated || b.estimated };
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "costUsd"] as const) {
    if (a[key] !== undefined || b[key] !== undefined) total[key] = (a[key] ?? 0) + (b[key] ?? 0);
  }
  return total;
}
