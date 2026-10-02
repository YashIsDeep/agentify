import type { AgentUsage } from "@wm/shared";
import { sumUsage } from "./review";
import type { AgentRunResult } from "./run";

export interface CiCheckpoint {
  phase: "publish" | "check" | "fix";
  corrections: number;
  failure: string;
  sessionId: string | null;
  summary: string;
}

export type CiResult = AgentRunResult & {
  ciCheckpoint?: CiCheckpoint;
  ci?: { corrections: number; passed: true };
};

/** Only the configured check command can declare CI green; an agent's summary cannot. */
export async function runCiLoop(options: {
  context: string;
  maxCorrections: number;
  checkpoint?: CiCheckpoint;
  followUp?: string;
  check(): Promise<{ ok: boolean; output: string }>;
  publish(): Promise<void>;
  fix(prompt: string, sessionId: string | null): Promise<AgentRunResult>;
}): Promise<CiResult> {
  const state: CiCheckpoint = options.checkpoint ? { ...options.checkpoint } : {
    phase: options.followUp ? "fix" : "publish", corrections: 0, failure: options.followUp ?? "", sessionId: null, summary: "",
  };
  let usage: AgentUsage | null = null;
  const base = (): AgentRunResult => ({
    ok: true, aborted: false, text: state.summary, sessionId: state.sessionId, usage, error: null, usageLimit: null,
  });
  for (;;) {
    if (state.phase === "publish") {
      await options.publish();
      state.phase = "check";
    }
    if (state.phase === "check") {
      const check = await options.check();
      if (check.ok) return {
        ...base(), text: `${state.summary ? `${state.summary}\n\n` : ""}CI checks passed after ${state.corrections} correction attempt(s).\n\n${check.output}`,
        ci: { passed: true, corrections: state.corrections },
      };
      state.failure = check.output;
      if (state.corrections >= options.maxCorrections) return {
        ...base(), ok: false, error: `CI loop stopped after ${options.maxCorrections} correction attempts.\n${state.failure}`,
        ciCheckpoint: state,
      };
      state.phase = "fix";
    }
    const fixed = await options.fix(`Fix the failing CI checks in this repository. Diagnose the output, make focused corrections, and run relevant local checks.
Do not weaken or disable checks to get a passing result. Do not push or merge; the workflow runs its configured publish and check commands after your fixes.
Finish with a summary of the changes and validation. The check command, not your summary, determines whether this loop passes.

Task instructions:
${options.context}

Failing checks or requested changes:
${state.failure}`, state.sessionId);
    usage = sumUsage(usage, fixed.usage);
    state.sessionId = fixed.sessionId;
    if (!fixed.ok || fixed.aborted) return { ...fixed, usage, ciCheckpoint: state };
    state.summary = fixed.text;
    state.corrections++;
    state.phase = "publish";
  }
}
