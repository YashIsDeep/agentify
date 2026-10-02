import type { LoopInput } from "../src/agents/loops";
import type { AgentRunResult } from "../src/agents/run";
import { type AgentTurns, createTurns, type TurnOptions } from "../src/agents/turns";

/** The test adapter at the turn seam: answers each turn from a script and records what it was asked. */
export type ScriptedReply = AgentRunResult | ((prompt: string, options: TurnOptions) => AgentRunResult);

export interface ScriptedTurns extends AgentTurns {
  calls: ({ prompt: string } & TurnOptions)[];
}

export function scriptedTurns(...replies: ScriptedReply[]): ScriptedTurns {
  const calls: ScriptedTurns["calls"] = [];
  const turns = createTurns(async (prompt, options) => {
    calls.push({ prompt, ...options });
    const next = replies.shift();
    if (!next) throw new Error(`No scripted reply for turn ${calls.length} (${options.role})`);
    return typeof next === "function" ? next(prompt, options) : next;
  });
  return {
    calls,
    turn: turns.turn,
    get usage() {
      return turns.usage;
    },
  };
}

/** A successful turn that used 10 input tokens. */
export const reply = (text: string, sessionId: string | null = "author", extra: Partial<AgentRunResult> = {}): AgentRunResult => ({
  ok: true, aborted: false, text, sessionId, usage: { inputTokens: 10 }, error: null, usageLimit: null, ...extra,
});

export const limited = (sessionId: string | null): AgentRunResult =>
  reply("", sessionId, { ok: false, error: "Usage limit reached", usageLimit: { resetAt: 123 } });

export const loopInput = (turns: AgentTurns, overrides: Partial<LoopInput> = {}): LoopInput => ({
  turns,
  opening: { prompt: "Build it", session: null },
  followUp: null,
  instructions: "Build it",
  maxCorrections: 3,
  notice: () => {},
  ...overrides,
});
