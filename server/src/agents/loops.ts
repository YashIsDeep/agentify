import type { AgentRunResult } from "./run";
import type { AgentTurns } from "./turns";
import type { Verification } from "../services/artifact-history";
import type { DecisionReport } from "./decisions";

/** Sent in place of the prompt when a run picks its own session back up after a usage limit. */
export const CONTINUE_AFTER_LIMIT = "Your usage limit has reset. Carry on with the task from where you stopped.";

/**
 * Where a loop stopped, kept in the run's outputs (`outputs.loop`) so the same run can pick it back
 * up after a usage limit. `sessionId` is the session of the turn to resume, if one had started.
 */
export type SavedLoop =
  | { kind: "single"; phase: "author"; corrections: 0; sessionId: string | null }
  | {
      kind: "review";
      phase: "draft" | "review" | "revise";
      corrections: number;
      sessionId: string | null;
      /** The author's latest draft, once there is one. */
      draft: { text: string; sessionId: string | null; version?: number } | null;
      feedback: string;
    }
  | {
      kind: "ci";
      phase: "publish" | "check" | "fix";
      corrections: number;
      sessionId: string | null;
      failure: string;
      summary: string;
    };

export interface LoopInput {
  turns: AgentTurns;
  /** The author's opening turn, when there is no saved progress to pick up. */
  opening: { prompt: string; session: string | null };
  /** Changes you asked for at this run's approval. */
  followUp: string | null;
  /** The action's own prompt: what the work is for. */
  instructions: string;
  maxCorrections: number;
  /** Optional checks for this document, in addition to its task instructions. */
  verificationInstructions?: string;
  loopLabel?: string;
  /** Request a cumulative decision record in the final independent review. Read after each build. */
  decisionContext?(): string;
  /** Persist each finished build before reviewing it, and its paired verdict before revising it. */
  history?: {
    build(text: string): number;
    verify(version: number, verification: Verification): void;
  };
  /** What you have answered the author so far in this run, one "question → answer" per entry. */
  answered?(): string[];
  saved?: SavedLoop;
  /** Says in the transcript what the loop is doing next. */
  notice(text: string): void;
}

/** How a loop ended. A run that stops early carries `saved`, so it can go round again from there. */
export interface LoopOutcome extends Omit<AgentRunResult, "usage"> {
  decisions?: DecisionReport;
  buildVersion?: number;
  saved?: SavedLoop;
  /** `sessionId` is the reviewer's own session, when it is not the one the run carries on in. */
  review?: { decision: string; feedback: string; sessionId?: string | null };
  ci?: { corrections: number; passed: true };
}

/** The author's first turn, or that turn picked back up in its own session after a usage limit. */
export function authorTurn(input: LoopInput, resumeSession: string | null): Promise<AgentRunResult> {
  if (resumeSession) return input.turns.turn(CONTINUE_AFTER_LIMIT, { session: resumeSession, role: "author" });
  return input.turns.turn(input.opening.prompt, { session: input.opening.session, role: "author" });
}

export const outcome = ({ usage: _usage, ...result }: AgentRunResult): LoopOutcome => result;

/** One author turn and nothing else. */
export async function runSingle(input: LoopInput): Promise<LoopOutcome> {
  const saved = input.saved?.kind === "single" ? input.saved : undefined;
  const result = await authorTurn(input, saved?.sessionId ?? null);
  if (result.ok) return outcome(result);
  return {
    ...outcome(result),
    saved: { kind: "single", phase: "author", corrections: 0, sessionId: result.sessionId ?? saved?.sessionId ?? null },
  };
}
