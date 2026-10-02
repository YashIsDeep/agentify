import { describe, expect, it } from "vitest";
import { openingTurn } from "../src/actions/coding-agent";
import { CONTINUE_AFTER_LIMIT, runSingle } from "../src/agents/loops";
import { limited, loopInput, reply, scriptedTurns } from "./scripted-turns";

describe("single run", () => {
  it("sends the opening turn as the author and saves nothing when it succeeds", async () => {
    const turns = scriptedTurns(reply("Done"));
    const result = await runSingle(loopInput(turns, { opening: { prompt: "Go", session: "earlier" } }));
    expect(turns.calls).toEqual([{ prompt: "Go", session: "earlier", role: "author" }]);
    expect(result).toMatchObject({ ok: true, text: "Done" });
    expect(result.saved).toBeUndefined();
  });

  it("carries on in its own session after a usage limit, and starts over if no session had begun", async () => {
    const pending = await runSingle(loopInput(scriptedTurns(limited("s-1"))));
    expect(pending.saved).toEqual({ kind: "single", phase: "author", corrections: 0, sessionId: "s-1" });
    const resumed = scriptedTurns(reply("Done", "s-1"));
    await runSingle(loopInput(resumed, { saved: pending.saved }));
    expect(resumed.calls).toEqual([{ prompt: CONTINUE_AFTER_LIMIT, session: "s-1", role: "author" }]);

    const early = scriptedTurns(reply("Done"));
    await runSingle(loopInput(early, { saved: { kind: "single", phase: "author", corrections: 0, sessionId: null } }));
    expect(early.calls[0]).toMatchObject({ prompt: "Build it", session: null });
  });
});

describe("opening turn", () => {
  const base = {
    prompt: "Implement it",
    continueSession: false,
    followUp: null,
    run: { sessionId: null, agent: undefined, result: undefined },
    agent: "codex" as const,
    previous: () => undefined,
    label: (agent: string) => (agent === "codex" ? "Codex" : "Claude Code"),
  };

  it("sends the action's prompt in a fresh session by default", () => {
    expect(openingTurn(base)).toEqual({ prompt: "Implement it", session: null, notes: [] });
  });

  it("makes your changes the prompt, in the session this run just used", () => {
    const opening = openingTurn({ ...base, followUp: "Shorter", run: { sessionId: "s-1", agent: "codex", result: "Long" } });
    expect(opening).toMatchObject({ prompt: "Shorter", session: "s-1" });
    expect(opening.notes[0]).toEqual({ kind: "answer", stream: "info", text: "Shorter" });
  });

  it("hands a different agent the previous answer instead of a session it can't resume", () => {
    const opening = openingTurn({ ...base, followUp: "Shorter", run: { sessionId: "s-1", agent: "claude", result: "Long" } });
    expect(opening).toMatchObject({ prompt: "Your previous answer was:\n\nLong\n\n---\n\nShorter", session: null });
  });

  it("continues this action's previous session, or passes its result on when the agent changed", () => {
    const same = openingTurn({ ...base, continueSession: true, previous: () => ({ sessionId: "old", agent: "codex", result: "Earlier" }) });
    expect(same).toMatchObject({ prompt: "Implement it", session: "old" });
    const changed = openingTurn({ ...base, continueSession: true, previous: () => ({ sessionId: "old", agent: "claude", result: "Earlier" }) });
    expect(changed).toMatchObject({ session: null, prompt: expect.stringContaining("(by Claude Code) ended with:\n\nEarlier") });
  });

  it("only asks for the previous session when told to continue it", () => {
    let asked = false;
    openingTurn({ ...base, previous: () => { asked = true; return undefined; } });
    expect(asked).toBe(false);
  });
});
