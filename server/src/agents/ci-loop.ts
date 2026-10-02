import type { LoopInput, LoopOutcome, SavedLoop } from "./loops";

type CiSaved = Extract<SavedLoop, { kind: "ci" }>;

export interface CiCommands {
  /** Exit 0 only when every check on the current commit passes. */
  check(): Promise<{ ok: boolean; output: string }>;
  /** Commits and pushes what remote CI needs; does nothing for local checks. Throws if it fails. */
  publish(): Promise<void>;
}

/**
 * Publish, check, fix, and round again until the checks pass. Only the configured check command can
 * declare CI green; an agent's summary cannot. Changes you asked for are fixed before anything is rerun.
 */
export async function runCi(input: LoopInput, commands: CiCommands): Promise<LoopOutcome> {
  const { followUp } = input;
  const state: CiSaved = input.saved?.kind === "ci"
    ? { ...input.saved }
    : { kind: "ci", phase: followUp ? "fix" : "publish", corrections: 0, failure: followUp ?? "", sessionId: input.opening.session, summary: "" };
  const base = (): LoopOutcome => ({ ok: true, aborted: false, text: state.summary, sessionId: state.sessionId, error: null, usageLimit: null });
  for (;;) {
    if (state.phase === "publish") {
      await commands.publish();
      state.phase = "check";
    }
    if (state.phase === "check") {
      const check = await commands.check();
      if (check.ok) return {
        ...base(), text: `${state.summary ? `${state.summary}\n\n` : ""}CI checks passed after ${state.corrections} correction attempt(s).\n\n${check.output}`,
        ci: { passed: true, corrections: state.corrections },
      };
      state.failure = check.output;
      if (state.corrections >= input.maxCorrections) return {
        ...base(), ok: false, error: `CI loop stopped after ${input.maxCorrections} correction attempts.\n${state.failure}`,
        saved: state,
      };
      state.phase = "fix";
    }
    input.notice("CI loop: fixing failures before rerunning checks");
    const fixed = await input.turns.turn(`Fix the failing CI checks in this repository. Diagnose the output, make focused corrections, and run relevant local checks.
Do not weaken or disable checks to get a passing result. Do not push or merge; the workflow runs its configured publish and check commands after your fixes.
Finish with a summary of the changes and validation. The check command, not your summary, determines whether this loop passes.

Task instructions:
${input.instructions}${state.corrections === 0 && input.opening.prompt !== input.instructions ? `\n\nPrior work and requested changes:\n${input.opening.prompt}` : ""}

Failing checks or requested changes:
${state.failure}`, { session: state.sessionId, role: "fixer" });
    state.sessionId = fixed.sessionId ?? state.sessionId;
    if (!fixed.ok || fixed.aborted) {
      const { usage: _usage, ...result } = fixed;
      return { ...result, sessionId: state.sessionId, saved: state };
    }
    state.summary = fixed.text;
    state.corrections++;
    state.phase = "publish";
  }
}
