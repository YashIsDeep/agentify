import type { AgentId } from "@wm/shared";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { selectAgent, usageSummary } from "../src/actions/coding-agent";
import { claudeAdapter } from "../src/agents/claude";
import { codexAdapter, parseModelCatalog } from "../src/agents/codex";
import { cursorAdapter, parseCursorModels } from "../src/agents/cursor";
import { opencodeAdapter, parseVerboseModels } from "../src/agents/opencode";
import { cliFromPath, findOnPath, resolveCli, shimTarget } from "../src/agents/resolve";
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
  effort: null,
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
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "1 test failed" }] },
      },
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
      { kind: "tool", name: "Bash", status: "started", detail: "npm test", id: "t1" },
      // The id pairs the result with its call, and the detail is what the chat view previews.
      { kind: "tool", name: "Bash", status: "failed", detail: "1 test failed", id: "t1" },
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
    expect(readOnly.args).not.toContain("--effort");

    const autonomous = claudeAdapter.buildSpawn(invocation({ autonomy: "autonomous", model: "opus", effort: "max", resumeSessionId: "s-1" }));
    expect(autonomous.args).toEqual(expect.arrayContaining(["--dangerously-skip-permissions", "--model", "opus", "--effort", "max", "--resume", "s-1"]));
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
      { kind: "tool", name: "shell", status: "started", detail: "echo probe-output", id: "item_1" },
      { kind: "tool", name: "shell", status: "completed", detail: "exit 0", id: "item_1" },
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

    // Effort is a config key, which `exec` and `exec resume` both take.
    const effort = codexAdapter.buildSpawn(invocation({ resumeSessionId: "th-1", model: "gpt-6-astra", effort: "ultra" }));
    expect(effort.args).toEqual(expect.arrayContaining(["-m", "gpt-6-astra", "-c", 'model_reasoning_effort="ultra"']));
  });

  it("lists picker models and their effort levels from debug models output (captured from codex-cli 0.154)", () => {
    const levels = (...efforts: string[]) => efforts.map((effort) => ({ effort, description: "" }));
    const catalog = {
      models: [
        { slug: "gpt-5.5", visibility: "list", priority: 12, supported_reasoning_levels: levels("low", "medium", "high", "xhigh") },
        { slug: "codex-auto-review", visibility: "hide", priority: 43, supported_reasoning_levels: levels("low") },
        { slug: "gpt-6-astra", visibility: "list", priority: 1, supported_reasoning_levels: levels("low", "medium", "high", "xhigh", "max", "ultra") },
        { slug: "gpt-reserve", visibility: "hide", priority: 3 },
        { slug: "gpt-5.6-luna", visibility: "list", priority: 8, supported_reasoning_levels: levels("low", "medium", "high", "xhigh", "max") },
      ],
    };
    expect(parseModelCatalog(JSON.stringify(catalog))).toEqual({
      models: ["gpt-6-astra", "gpt-5.6-luna", "gpt-5.5"],
      modelEfforts: {
        "gpt-6-astra": ["low", "medium", "high", "xhigh", "max", "ultra"],
        "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
        "gpt-5.5": ["low", "medium", "high", "xhigh"],
      },
      // With no model chosen, any level a listed model supports.
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    });
    expect(parseModelCatalog("error: not logged in")).toBeNull();
    expect(parseModelCatalog(JSON.stringify({ models: [] }))).toBeNull();
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

  it("reads each model's variants from models --verbose (captured from opencode 1.18) and passes one as --variant", () => {
    const block = (name: string, variants: Record<string, object>) =>
      `${name}\n${JSON.stringify({ id: name.split("/")[1], capabilities: { reasoning: true, input: { text: true } }, variants }, null, 2)}`;
    const stdout = [
      block("opencode/big-pickle", {}),
      block("opencode-go/deepseek-v4-pro", { high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } }),
      "opencode-go/listed-without-details",
    ].join("\n");
    expect(parseVerboseModels(stdout)).toEqual({
      models: ["opencode/big-pickle", "opencode-go/deepseek-v4-pro", "opencode-go/listed-without-details"],
      modelEfforts: { "opencode/big-pickle": [], "opencode-go/deepseek-v4-pro": ["high", "max"], "opencode-go/listed-without-details": [] },
      efforts: [],
    });
    expect(parseVerboseModels("Error: no providers configured")).toBeNull();

    const spawn = opencodeAdapter.buildSpawn(invocation({ model: "opencode-go/deepseek-v4-pro", effort: "max" }));
    expect(spawn.args).toEqual(expect.arrayContaining(["-m", "opencode-go/deepseek-v4-pro", "--variant", "max"]));
  });
});

describe("cursor adapter", () => {
  it("parses stream-json into session, messages, tools and the final result (Cursor's documented schema)", () => {
    const events = parseAll(cursorAdapter, [
      { type: "system", subtype: "init", apiKeySource: "login", cwd: "/work", session_id: "chat-1", model: "auto", permissionMode: "default" },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "Do the thing" }] }, session_id: "chat-1" },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Checking the tests." }] }, session_id: "chat-1" },
      { type: "tool_call", subtype: "started", call_id: "c1", tool_call: { shellToolCall: { args: { command: "npm test" } } }, session_id: "chat-1" },
      {
        type: "tool_call",
        subtype: "completed",
        call_id: "c1",
        tool_call: { shellToolCall: { args: { command: "npm test" }, result: { success: { exitCode: 1, stdout: "", stderr: "1 failing" } } } },
        session_id: "chat-1",
      },
      { type: "tool_call", subtype: "started", call_id: "c2", tool_call: { readToolCall: { args: { path: "README.md" } } }, session_id: "chat-1" },
      {
        type: "tool_call",
        subtype: "completed",
        call_id: "c2",
        tool_call: { readToolCall: { args: { path: "README.md" }, result: { success: { content: "# Hi", totalLines: 1 } } } },
        session_id: "chat-1",
      },
      { type: "result", subtype: "success", duration_ms: 1234, duration_api_ms: 1200, is_error: false, result: "Done", session_id: "chat-1" },
    ]);
    expect(ofKind(events, "session")[0]?.sessionId).toBe("chat-1");
    expect(ofKind(events, "message").map((e) => e.text)).toEqual(["Checking the tests."]);
    expect(ofKind(events, "tool")).toEqual([
      { kind: "tool", name: "shell", status: "started", detail: "npm test", id: "c1" },
      { kind: "tool", name: "shell", status: "failed", detail: "1 failing", id: "c1" },
      { kind: "tool", name: "read", status: "started", detail: "README.md", id: "c2" },
      { kind: "tool", name: "read", status: "completed", detail: "# Hi", id: "c2" },
    ]);
    expect(ofKind(events, "final")[0]).toMatchObject({ ok: true, text: "Done" });
    // Cursor reports no token counts.
    expect(ofKind(events, "usage")).toEqual([]);
  });

  it("treats an error result or a rejected tool as a failure", () => {
    const events = parseAll(cursorAdapter, [
      { type: "tool_call", subtype: "completed", call_id: "c1", tool_call: { editToolCall: { args: { path: "a.ts" }, result: { rejected: { reason: "Read-only mode" } } } } },
      { type: "result", subtype: "error", is_error: true, result: "Authentication required" },
    ]);
    expect(ofKind(events, "tool")[0]).toMatchObject({ name: "edit", status: "failed", detail: "Read-only mode" });
    expect(ofKind(events, "final")[0]).toMatchObject({ ok: false, error: "Authentication required" });
  });

  it("builds read-only, autonomous and resumed invocations, sending long prompts through a file", () => {
    const readOnly = cursorAdapter.buildSpawn(invocation());
    expect(readOnly.args).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--trust", "--workspace", "/work", "--mode", "ask"]));
    expect(readOnly.args).not.toContain("--force");
    expect(readOnly.args.at(-1)).toBe("Do the thing");

    const autonomous = cursorAdapter.buildSpawn(invocation({ autonomy: "autonomous", model: "gpt-5", resumeSessionId: "chat-1" }));
    expect(autonomous.args).toEqual(expect.arrayContaining(["--force", "--model", "gpt-5", "--resume", "chat-1"]));
    expect(autonomous.args).not.toContain("--mode");

    const prompt = "x".repeat(9000);
    const long = cursorAdapter.buildSpawn(invocation({ prompt }));
    expect(long.args.at(-1)).toBe(`Read the file ${join(scratch, "prompt.md")} and follow the instructions in it.`);
    expect(long.args).toEqual(expect.arrayContaining(["--add-dir", scratch]));
    expect(readFileSync(join(scratch, "prompt.md"), "utf8")).toBe(prompt);
  });

  it("lists models from `cursor-agent models` (format from Cursor Agent 2026.09.10)", () => {
    const stdout = [
      "Available models",
      "",
      "auto - Auto (current, default)",
      "gpt-5 - GPT-5",
      "claude-opus-4-8-thinking-high - Opus 4.8 Thinking (High)",
      "sonnet-4",
      "",
      "Tip: use --model <id> (or /model <id> in interactive mode) to switch. Parameterized models also accept quoted overrides, e.g. --model 'claude-opus-4-8[context=1m,effort=high,fast=false]'.",
    ].join("\n");
    expect(parseCursorModels(stdout)).toEqual({
      models: ["auto", "gpt-5", "claude-opus-4-8-thinking-high", "sonnet-4"],
      modelEfforts: {},
      efforts: [],
    });
    expect(parseCursorModels("No models available for this account.")).toBeNull();
  });

  it("finds the CLI at the installer's location when a stale PATH doesn't have it", () => {
    const dir = mkdtempSync(join(tmpdir(), "wm-install-"));
    const installed = join(dir, "cursor-agent");
    writeFileSync(installed, "");
    expect(resolveCli("wm-no-such-cli", null, [join(dir, "missing"), installed])).toEqual({ command: installed, prefixArgs: [], path: installed });
    expect(resolveCli("wm-no-such-cli", null, [join(dir, "missing")])).toBeNull();
    removeDir(dir);
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

  it("follows Cursor's launcher to the newest bundled version", () => {
    const dir = mkdtempSync(join(tmpdir(), "wm-cursor-"));
    // The real launcher hands off to a .ps1, so there is no npm-style target to read.
    writeFileSync(join(dir, "cursor-agent.cmd"), '@echo off\r\npowershell.exe -NoProfile -File "%SCRIPT_DIR%\\cursor-agent.ps1" %*\r\n');
    const version = (name: string, complete = true) => {
      mkdirSync(join(dir, "versions", name), { recursive: true });
      writeFileSync(join(dir, "versions", name, "index.js"), "");
      if (complete) writeFileSync(join(dir, "versions", name, "node.exe"), "");
    };
    version("2026.8.11-e8db854");
    version("2026.09.10-fd3934a");
    version("2026.09.12-aaaaaaa", false); // half-downloaded update: no node.exe yet
    mkdirSync(join(dir, "versions", "not-a-version"));

    const newest = join(dir, "versions", "2026.09.10-fd3934a");
    expect(cliFromPath(join(dir, "cursor-agent.cmd"))).toEqual({
      command: join(newest, "node.exe"),
      prefixArgs: [join(newest, "index.js")],
      path: join(newest, "index.js"),
    });
    removeDir(dir);
  });
});

describe("agent selection and environment", () => {
  const noDefaults = () => ({ model: null, effort: null });
  const noTask = { agentOverride: null, modelOverride: null, effortOverride: null };

  it("prefers the retry choice, then the task override, then the action, then the agent's default", () => {
    const claude = { agent: "claude" as const, model: "", effort: "" };
    expect(selectAgent(claude, noTask, null, {}, noDefaults)).toEqual({ agent: "claude", model: null, effort: null });
    const codexTask = { ...noTask, agentOverride: "codex", modelOverride: "gpt-5.5" };
    expect(selectAgent({ ...claude, model: "sonnet" }, codexTask, null, {}, noDefaults)).toEqual({ agent: "codex", model: "gpt-5.5", effort: null });
    // A blank retry model defers, but the task's Codex model and the action's Claude one mean nothing to OpenCode.
    expect(selectAgent({ ...claude, model: "sonnet" }, codexTask, { agent: "opencode", model: "" }, {}, noDefaults)).toEqual({
      agent: "opencode",
      model: null,
      effort: null,
    });
    expect(selectAgent(claude, { ...noTask, agentOverride: "gemini" }, { agent: "nope" }, {}, noDefaults)).toEqual({
      agent: "claude",
      model: null,
      effort: null,
    });
  });

  it("pairs an effort with the model it was chosen for", () => {
    const defaults = (agent: AgentId) => (agent === "codex" ? { model: "gpt-5.5", effort: "high" } : { model: null, effort: null });
    const codex = { agent: "codex" as const, model: "", effort: "" };
    // The saved default model brings its effort...
    expect(selectAgent(codex, noTask, null, {}, defaults)).toEqual({ agent: "codex", model: "gpt-5.5", effort: "high" });
    // ...an effort chosen above the model still applies to it...
    expect(selectAgent(codex, { ...noTask, effortOverride: "low" }, null, {}, defaults)).toMatchObject({ model: "gpt-5.5", effort: "low" });
    // ...but a model chosen above an effort doesn't take that effort, which was meant for another model.
    expect(selectAgent({ ...codex, model: "gpt-6-astra" }, noTask, null, {}, defaults)).toMatchObject({ model: "gpt-6-astra", effort: null });
    expect(selectAgent({ ...codex, model: "gpt-6-astra", effort: "ultra" }, noTask, { agent: "codex", model: "gpt-5.5" }, {}, defaults)).toMatchObject({
      model: "gpt-5.5",
      effort: null,
    });
    // Another agent's default never applies.
    expect(selectAgent({ ...codex, agent: "claude" }, noTask, null, {}, defaults)).toEqual({ agent: "claude", model: null, effort: null });
  });

  it("slots the stage's defaults between the action and the agent's own", () => {
    const defaults = (agent: AgentId) => (agent === "claude" ? { model: "haiku", effort: "low" } : { model: null, effort: null });
    const stage = { agent: "claude", model: "opus", effort: "max" };
    const blank = { agent: "" as const, model: "", effort: "" };
    expect(selectAgent(blank, noTask, null, stage, defaults)).toEqual({ agent: "claude", model: "opus", effort: "max" });
    // An action naming another agent skips the stage's model and effort...
    expect(selectAgent({ ...blank, agent: "codex" }, noTask, null, stage, defaults)).toEqual({ agent: "codex", model: null, effort: null });
    // ...an action's own model drops the stage's effort...
    expect(selectAgent({ ...blank, model: "sonnet" }, noTask, null, stage, defaults)).toEqual({ agent: "claude", model: "sonnet", effort: null });
    // ...and a stage without a model leaves the agent's default model, with its effort.
    expect(selectAgent(blank, noTask, null, { agent: "claude", model: null, effort: null }, defaults)).toEqual({
      agent: "claude",
      model: "haiku",
      effort: "low",
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
