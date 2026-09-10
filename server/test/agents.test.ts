import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { selectAgent, usageSummary } from "../src/actions/coding-agent";
import { claudeAdapter } from "../src/agents/claude";
import { codexAdapter } from "../src/agents/codex";
import { opencodeAdapter } from "../src/agents/opencode";
import { cliFromPath, findOnPath, shimTarget } from "../src/agents/resolve";
import { agentEnv } from "../src/agents/run";
import type { AgentAdapter, AgentEvent, AgentInvocation } from "../src/agents/types";
import { removeDir } from "./helpers";

const scratch = mkdtempSync(join(tmpdir(), "wm-agents-"));
afterAll(() => removeDir(scratch));

function parseAll(adapter: AgentAdapter, events: object[]): AgentEvent[] {
  const parser = adapter.createParser();
  return [...events.flatMap((event) => parser.push(JSON.stringify(event))), ...(parser.finish?.() ?? [])];
}
const ofKind = <K extends AgentEvent["kind"]>(events: AgentEvent[], kind: K) =>
  events.filter((event): event is Extract<AgentEvent, { kind: K }> => event.kind === kind);

const invocation = (overrides: Partial<AgentInvocation> = {}): AgentInvocation => ({
  prompt: "Do the thing",
  model: null,
  autonomy: "read-only",
  resumeSessionId: null,
  cwd: "/work",
  scratchDir: scratch,
  ...overrides,
});

describe("claude adapter", () => {
  it("parses stream-json into session, messages, tools, usage and the final result", () => {
    const events = parseAll(claudeAdapter, [
      { type: "system", subtype: "init", session_id: "s-1" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Looking" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] },
      },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true }] } },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Done",
        session_id: "s-1",
        total_cost_usd: 0.5,
        usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 },
      },
    ]);
    expect(ofKind(events, "session")[0]?.sessionId).toBe("s-1");
    expect(ofKind(events, "message").map((e) => e.text)).toEqual(["Looking"]);
    expect(ofKind(events, "tool")).toEqual([
      { kind: "tool", name: "Bash", status: "started", detail: "npm test" },
      { kind: "tool", name: "Bash", status: "failed" },
    ]);
    expect(ofKind(events, "usage")[0]?.usage).toEqual({ inputTokens: 100, cachedInputTokens: 90, outputTokens: 5, costUsd: 0.5 });
    expect(ofKind(events, "final")[0]).toMatchObject({ ok: true, text: "Done" });
  });

  it("treats an error result (e.g. logged out) as a failure", () => {
    const events = parseAll(claudeAdapter, [
      { type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", usage: {} },
    ]);
    expect(ofKind(events, "final")[0]).toMatchObject({ ok: false, error: "Not logged in · Please run /login" });
  });

  it("builds read-only and autonomous invocations", () => {
    const readOnly = claudeAdapter.buildSpawn(invocation());
    expect(readOnly.stdin).toBe("Do the thing");
    expect(readOnly.args).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--verbose", "--permission-prompts", "none"]));
    expect(readOnly.args[readOnly.args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep,WebFetch,WebSearch");
    expect(readOnly.args).not.toContain("--dangerously-skip-permissions");

    const autonomous = claudeAdapter.buildSpawn(invocation({ autonomy: "autonomous", model: "opus", resumeSessionId: "s-1" }));
    expect(autonomous.args).toEqual(expect.arrayContaining(["--dangerously-skip-permissions", "--model", "opus", "--resume", "s-1"]));
    expect(autonomous.args).not.toContain("--tools");
  });
});

describe("codex adapter", () => {
  it("parses exec --json events (captured from codex-cli 0.154)", () => {
    const events = parseAll(codexAdapter, [
      { type: "thread.started", thread_id: "th-1" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "Running the command now." } },
      { type: "item.started", item: { id: "item_1", type: "command_execution", command: "echo probe-output", exit_code: null } },
      { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "echo probe-output", exit_code: 0 } },
      { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "pong" } },
      { type: "turn.completed", usage: { input_tokens: 29739, cached_input_tokens: 25088, output_tokens: 347 } },
    ]);
    expect(ofKind(events, "session")[0]?.sessionId).toBe("th-1");
    expect(ofKind(events, "tool")).toEqual([
      { kind: "tool", name: "shell", status: "started", detail: "echo probe-output" },
      { kind: "tool", name: "shell", status: "completed", detail: undefined },
    ]);
    expect(ofKind(events, "usage")[0]?.usage).toEqual({ inputTokens: 29739, cachedInputTokens: 25088, outputTokens: 347 });
    expect(ofKind(events, "final")[0]).toMatchObject({ ok: true, text: "pong" });
  });

  it("reports failed turns", () => {
    const events = parseAll(codexAdapter, [{ type: "turn.failed", error: { message: "rate limited" } }]);
    expect(ofKind(events, "final")[0]).toMatchObject({ ok: false, error: "rate limited" });
  });

  it("builds fresh and resumed invocations", () => {
    const fresh = codexAdapter.buildSpawn(invocation());
    expect(fresh.args.slice(0, 5)).toEqual(["exec", "--json", "--skip-git-repo-check", "-o", join(scratch, "last-message.txt")]);
    expect(fresh.args).toEqual(expect.arrayContaining(["-s", "read-only", "-C", "/work"]));
    expect(fresh.args.at(-1)).toBe("-");
    expect(fresh.resultFile).toBe(join(scratch, "last-message.txt"));

    const resumedReadOnly = codexAdapter.buildSpawn(invocation({ resumeSessionId: "th-1" }));
    expect(resumedReadOnly.args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(resumedReadOnly.args).toEqual(expect.arrayContaining(["-c", 'sandbox_mode="read-only"']));
    expect(resumedReadOnly.args.slice(-2)).toEqual(["th-1", "-"]);

    const resumedAutonomous = codexAdapter.buildSpawn(invocation({ resumeSessionId: "th-1", autonomy: "autonomous", model: "gpt-5" }));
    expect(resumedAutonomous.args).toEqual(expect.arrayContaining(["--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-5"]));
    expect(resumedAutonomous.args).not.toContain("-s");
  });
});

describe("opencode adapter", () => {
  it("parses run --format json events (captured from opencode 1.18)", () => {
    const events = parseAll(opencodeAdapter, [
      { type: "step_start", sessionID: "ses_1", part: { type: "step-start" } },
      {
        type: "tool_use",
        sessionID: "ses_1",
        part: { type: "tool", tool: "read", state: { status: "completed", input: { filePath: "C:\\probe\\sample.txt" } } },
      },
      {
        type: "step_finish",
        sessionID: "ses_1",
        part: { reason: "tool-calls", tokens: { input: 6533, output: 151, reasoning: 0, cache: { read: 1792, write: 0 } }, cost: 0 },
      },
      { type: "step_start", sessionID: "ses_1", part: { type: "step-start" } },
      { type: "text", sessionID: "ses_1", part: { type: "text", text: "pong" } },
      {
        type: "step_finish",
        sessionID: "ses_1",
        part: { reason: "stop", tokens: { input: 262, output: 25, reasoning: 0, cache: { read: 8320, write: 0 } }, cost: 0.002 },
      },
    ]);
    expect(ofKind(events, "session")).toEqual([{ kind: "session", sessionId: "ses_1" }]);
    expect(ofKind(events, "tool")).toEqual([{ kind: "tool", name: "read", status: "completed", detail: "C:\\probe\\sample.txt" }]);
    expect(ofKind(events, "usage").at(-1)?.usage).toEqual({ inputTokens: 16907, cachedInputTokens: 10112, outputTokens: 176, costUsd: 0.002 });
    expect(ofKind(events, "final")[0]).toMatchObject({ ok: true, text: "pong" });
  });

  it("turns error events into a failed result", () => {
    const events = parseAll(opencodeAdapter, [
      { type: "error", sessionID: "ses_2", error: { name: "APIError", data: { message: "Insufficient balance.", statusCode: 401 } } },
    ]);
    expect(ofKind(events, "error")[0]?.message).toBe("Insufficient balance.");
    expect(ofKind(events, "final")[0]).toMatchObject({ ok: false, error: "Insufficient balance." });
  });

  it("passes short prompts inline and long ones as an attached file", () => {
    const short = opencodeAdapter.buildSpawn(invocation({ autonomy: "autonomous", resumeSessionId: "ses_1", model: "opencode/big-pickle" }));
    expect(short.args.slice(0, 2)).toEqual(["run", "Do the thing"]);
    expect(short.args).toEqual(expect.arrayContaining(["--format", "json", "--dir", "/work", "--auto", "--session", "ses_1", "-m", "opencode/big-pickle"]));

    const prompt = "x".repeat(9000);
    const long = opencodeAdapter.buildSpawn(invocation({ prompt }));
    expect(long.args[1]).toBe("Follow the instructions in the attached file prompt.md.");
    expect(long.args).toEqual(expect.arrayContaining(["--agent", "plan"]));
    expect(long.args.slice(-2)).toEqual(["-f", join(scratch, "prompt.md")]);
    expect(readFileSync(join(scratch, "prompt.md"), "utf8")).toBe(prompt);
  });
});

describe.skipIf(process.platform !== "win32")("resolving npm shims on Windows", () => {
  it("follows .cmd shims to native executables and node scripts", () => {
    const dir = mkdtempSync(join(tmpdir(), "wm-shims-"));
    writeFileSync(
      join(dir, "claude.cmd"),
      '@ECHO off\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n',
    );
    writeFileSync(
      join(dir, "codex.cmd"),
      '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
    );

    expect(shimTarget(join(dir, "claude.cmd"))).toBe(join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"));
    expect(cliFromPath(join(dir, "claude.cmd"))).toMatchObject({ command: join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"), prefixArgs: [] });
    expect(cliFromPath(join(dir, "codex.cmd"))).toMatchObject({
      command: process.execPath,
      prefixArgs: [join(dir, "node_modules", "@openai", "codex", "bin", "codex.js")],
    });
    expect(findOnPath("codex", { PATH: dir })).toBe(join(dir, "codex.cmd"));
    expect(findOnPath("opencode", { PATH: dir })).toBeNull();
    removeDir(dir);
  });
});

describe("agent selection and environment", () => {
  it("prefers the retry choice, then the task override, then the action default", () => {
    const task = { agentOverride: null, modelOverride: null };
    expect(selectAgent({ agent: "claude", model: "" }, task, null)).toEqual({ agent: "claude", model: null });
    expect(selectAgent({ agent: "claude", model: "sonnet" }, { agentOverride: "codex", modelOverride: "gpt-5" }, null)).toEqual({
      agent: "codex",
      model: "gpt-5",
    });
    // An explicit empty model on retry means "CLI default", even if the task sets one.
    expect(selectAgent({ agent: "claude", model: "sonnet" }, { agentOverride: "codex", modelOverride: "gpt-5" }, { agent: "opencode", model: "" })).toEqual({
      agent: "opencode",
      model: null,
    });
    expect(selectAgent({ agent: "claude", model: "" }, { agentOverride: "gemini", modelOverride: null }, { agent: "nope" })).toEqual({
      agent: "claude",
      model: null,
    });
  });

  it("strips API keys from the agent environment regardless of case", () => {
    const env = agentEnv({ WM_TASK_ID: "t" }, { anthropic_api_key: "a", OPENAI_API_KEY: "b", PATH: "p" });
    expect(env).toEqual({ PATH: "p", WM_TASK_ID: "t", NO_COLOR: "1" });
  });

  it("summarises usage", () => {
    expect(usageSummary({ inputTokens: 12345, outputTokens: 450, costUsd: 0.034, estimated: true })).toBe("12.3k in · 450 out · $0.03 est.");
    expect(usageSummary(null)).toBeUndefined();
  });
});
