import { randomBytes, randomUUID } from "node:crypto";
import type { AgentQuestion, AgentQuestionField, RunLogLine } from "@wm/shared";
import { and, asc, eq } from "drizzle-orm";
import type { RunLog } from "../actions/types";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { EngineError, type Engine } from "../engine/engine";

export interface AskInput {
  preamble?: string;
  fields: AgentQuestionField[];
}

export interface AnswerInput {
  answers: Record<string, string>;
  skip: boolean;
}

const SKIPPED = "Skipped; the agent was told to carry on";

interface Waiter {
  question: AgentQuestion;
  resolve: (result: AnswerInput) => void;
  reject: (error: Error) => void;
}

/**
 * Questions an agent asks part-way through a run.
 *
 * The agent calls an MCP tool, which parks here until someone answers in the UI — so the run
 * genuinely blocks rather than finishing with its questions buried in the final message. The
 * pending question is written to the run row as well as held in memory: the promise cannot
 * outlive the process, but the UI must still show what is being asked after a page reload.
 */
export class QuestionService {
  private readonly waiting = new Map<string, Waiter>();
  /** Per-run secret in the MCP URL, so only the agent we launched can ask as that run. */
  private readonly tokens = new Map<string, number>();
  private readonly runTokens = new Map<number, string>();
  /** Transcript writers, lent by the action that owns each run so Q&A lands in its chat. */
  private readonly logs = new Map<number, RunLog>();

  constructor(
    private readonly db: Db,
    private readonly engine: Engine,
    /** Where the agent should reach this server, e.g. http://127.0.0.1:2712. */
    private readonly baseUrl: string,
  ) {}

  // ---------------------------------------------------------------- tokens

  /** The MCP endpoint for a run, minting its token. Called just before the agent is spawned. */
  endpointFor(runId: number): string {
    return `${this.baseUrl}/mcp/${this.issueToken(runId)}`;
  }

  isWaiting(runId: number): boolean {
    return this.pendingForRun(runId) !== undefined;
  }

  private issueToken(runId: number): string {
    this.releaseToken(runId);
    const token = randomBytes(24).toString("base64url");
    this.tokens.set(token, runId);
    this.runTokens.set(runId, token);
    return token;
  }

  releaseToken(runId: number): void {
    const existing = this.runTokens.get(runId);
    if (existing) this.tokens.delete(existing);
    this.runTokens.delete(runId);
  }

  runForToken(token: string): number | undefined {
    return this.tokens.get(token);
  }

  // -------------------------------------------------------------- transcript

  /**
   * Lends this run's transcript writer, so a question and its answer are recorded in the chat
   * where they were asked. Only the action running the agent has one, hence the loan.
   */
  attachLog(runId: number, log: RunLog): void {
    this.logs.set(runId, log);
  }

  detachLog(runId: number): void {
    this.logs.delete(runId);
  }

  private record(runId: number, entry: Omit<RunLogLine, "at">): void {
    this.logs.get(runId)?.(entry);
  }

  // ---------------------------------------------------------------- asking

  /** Resolves when the question is answered or skipped; rejects if the run is cancelled. */
  ask(runId: number, input: AskInput): Promise<AnswerInput> {
    const run = this.engine.getRun(runId);
    // A question still pending here was abandoned: the agent's CLI timed its call out and nothing
    // is listening for that answer any more. Replace it — refusing strands the agent entirely.
    const stale = this.pendingForRun(runId);
    if (stale) {
      this.settle(stale, () => stale.reject(new Error("Superseded by a newer question")));
      this.record(runId, { kind: "notice", stream: "info", text: "The agent stopped waiting for that answer and asked again" });
    }

    const question: AgentQuestion = {
      id: randomUUID(),
      runId,
      taskId: run.taskId,
      preamble: input.preamble?.trim() ?? "",
      fields: input.fields,
      askedAt: Date.now(),
    };

    return new Promise<AnswerInput>((resolve, reject) => {
      this.waiting.set(question.id, { question, resolve, reject });
      this.write(runId, question);
      this.record(runId, { kind: "question", stream: "info", text: transcribe(question) });
      this.engine.timeline(run.taskId, run.visitId, runId, "question.asked", describe(question), {
        questionId: question.id,
      });
      this.engine.publish({ type: "task.changed", taskId: run.taskId });
      this.engine.publish({ type: "run.changed", taskId: run.taskId, runId });
    });
  }

  /** Returns the task the question belonged to, so the caller can refresh it. */
  answer(questionId: string, input: AnswerInput): string {
    const waiter = this.waiting.get(questionId);
    if (!waiter) throw new EngineError("That question is no longer waiting for an answer", 409);
    this.settle(waiter, () => waiter.resolve(input));

    const { question } = waiter;
    const summary = input.skip
      ? SKIPPED
      : question.fields
          .map((field) => `${field.text} → ${input.answers[field.id]?.trim() || "(no answer)"}`)
          .join("\n");
    this.record(question.runId, { kind: "answer", stream: "info", text: summary });
    this.engine.timeline(question.taskId, this.engine.getRun(question.runId).visitId, question.runId, "question.answered", summary);
    return question.taskId;
  }

  /**
   * Everything answered in this run so far, oldest first, one "question → answer" per entry. Read
   * from the timeline, so it survives a restart and covers every round of the run.
   */
  answeredForRun(runId: number): string[] {
    return this.db
      .select({ message: s.timelineEvents.message })
      .from(s.timelineEvents)
      .where(and(eq(s.timelineEvents.runId, runId), eq(s.timelineEvents.type, "question.answered")))
      .orderBy(asc(s.timelineEvents.id))
      .all()
      .filter((event) => event.message !== SKIPPED)
      .flatMap((event) => event.message.split("\n"));
  }

  /** Unblocks a waiting agent when its run is cancelled or the server is shutting down. */
  cancelForRun(runId: number, reason = "The run was cancelled"): void {
    const waiter = this.pendingForRun(runId);
    if (!waiter) return;
    this.settle(waiter, () => waiter.reject(new Error(reason)));
  }

  pending(): AgentQuestion[] {
    return [...this.waiting.values()].map((waiter) => waiter.question);
  }

  private pendingForRun(runId: number): Waiter | undefined {
    return [...this.waiting.values()].find((waiter) => waiter.question.runId === runId);
  }

  private settle(waiter: Waiter, finish: () => void): void {
    this.waiting.delete(waiter.question.id);
    this.write(waiter.question.runId, null);
    finish();
    this.engine.publish({ type: "task.changed", taskId: waiter.question.taskId });
    this.engine.publish({ type: "run.changed", taskId: waiter.question.taskId, runId: waiter.question.runId });
  }

  private write(runId: number, question: AgentQuestion | null): void {
    this.db.update(s.actionRuns).set({ question }).where(eq(s.actionRuns.id, runId)).run();
  }

  /**
   * Clears questions left behind by a previous process. Their agents died with it, so nothing
   * is listening for an answer any more.
   */
  clearStale(): void {
    this.db.update(s.actionRuns).set({ question: null }).run();
  }
}

/** The question as it reads in the transcript, once the interactive card is gone. */
function transcribe(question: AgentQuestion): string {
  const asked = question.fields.map((field) => {
    const options = field.kind === "choice" && field.options?.length ? ` (${field.options.join(" / ")})` : "";
    return `${field.text}${options}`;
  });
  return [question.preamble, ...asked].filter(Boolean).join("\n");
}

const describe = (question: AgentQuestion): string =>
  question.fields.length === 1
    ? (question.fields[0]?.text ?? "The agent asked a question")
    : `The agent asked ${question.fields.length} questions`;
