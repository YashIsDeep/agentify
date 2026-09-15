import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripAnsi } from "../lib/process";
import { execCli } from "./resolve";
import { type AgentAdapter, type AgentEvent, firstVersion, type JsonEvent, type ModelCatalog, parseJsonLine, truncate } from "./types";

/** Longer prompts go through a file to stay clear of Windows' command-line length limit. */
const INLINE_PROMPT_LIMIT = 8000;

export const cursorAdapter: AgentAdapter = {
  id: "cursor",
  label: "Cursor Agent",
  // The installer adds both `agent` and `cursor-agent`; the longer name can't collide with some other "agent".
  binName: "cursor-agent",
  installLocations:
    process.platform === "win32"
      ? [join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "cursor-agent", "cursor-agent.cmd")]
      : [join(homedir(), ".local", "bin", "cursor-agent")],
  installCommand:
    process.platform === "win32" ? "irm 'https://cursor.com/install?win32=true' | iex" : "curl https://cursor.com/install -fsS | bash",
  loginCommand: "cursor-agent login",
  // Only used when `cursor-agent models` can't answer (e.g. logged out). No pattern: Cursor's slugs
  // follow no family naming, and the live list is always the account's current one.
  modelHints: ["auto"],
  // No effort setting: thinking levels are separate model ids (`…-thinking-high`). The help text's
  // `model[effort=high]` overrides are, per Cursor staff, not actually supported by --model.
  effortHints: [],
  usageEstimated: true,
  // MCP servers only come from mcp.json files; there is no per-invocation flag.
  supportsQuestions: false,

  async listModels(cli) {
    const result = await execCli(cli, ["models"], 30_000);
    return result.code === 0 ? parseCursorModels(result.stdout) : null;
  },

  buildSpawn(invocation) {
    let message = invocation.prompt;
    const extra: string[] = [];
    if (message.length > INLINE_PROMPT_LIMIT || message.startsWith("-")) {
      const file = join(invocation.scratchDir, "prompt.md");
      writeFileSync(file, invocation.prompt, "utf8");
      // Outside the workspace, so name its folder as a root the agent may read, even in ask mode.
      extra.push("--add-dir", invocation.scratchDir);
      message = `Read the file ${file} and follow the instructions in it.`;
    }
    // --trust: headless runs can't answer the workspace trust prompt.
    const args = ["-p", "--output-format", "stream-json", "--trust", "--workspace", invocation.cwd, ...extra];
    if (invocation.model) args.push("--model", invocation.model);
    // Ask mode is Cursor's read-only mode; without --force, print mode would still run shell commands.
    args.push(...(invocation.autonomy === "autonomous" ? ["--force"] : ["--mode", "ask"]));
    if (invocation.resumeSessionId) args.push("--resume", invocation.resumeSessionId);
    return { args: [...args, message] };
  },

  createParser() {
    return {
      push(line) {
        const event = parseJsonLine(line);
        if (!event) return line.trim() ? [{ kind: "raw", text: stripAnsi(line) }] : [];
        const events: AgentEvent[] = [];
        switch (event.type) {
          case "system":
            if (event.subtype === "init" && typeof event.session_id === "string") {
              events.push({ kind: "session", sessionId: event.session_id });
            }
            break;
          case "assistant": {
            const text = textBlocks(event.message?.content);
            if (text.trim()) events.push({ kind: "message", text });
            break;
          }
          case "tool_call": {
            const call = toolCall(event);
            if (!call) break;
            const id = typeof event.call_id === "string" ? event.call_id : undefined;
            if (event.subtype === "started") {
              events.push({ kind: "tool", name: call.name, status: "started", detail: argsDetail(call.body.args), id });
            } else if (event.subtype === "completed") {
              const outcome = toolOutcome(call.body.result);
              events.push({ kind: "tool", name: call.name, status: outcome.failed ? "failed" : "completed", detail: outcome.detail, id });
            }
            break;
          }
          case "result": {
            if (typeof event.session_id === "string") events.push({ kind: "session", sessionId: event.session_id });
            const ok = event.subtype === "success" && !event.is_error;
            const text = typeof event.result === "string" ? event.result : "";
            const error = ok ? undefined : text || stringOf(event.error) || String(event.subtype ?? "The agent reported a failure");
            events.push({ kind: "final", ok, text, error });
            break;
          }
        }
        return events;
      },
    };
  },

  async version(cli) {
    const result = await execCli(cli, ["--version"]);
    return result.code === 0 ? firstVersion(result.stdout) : null;
  },

  async auth(cli) {
    const result = await execCli(cli, ["status", "--format", "json"]);
    const status = parseJsonLine(stripAnsi(result.stdout).replace(/\s+/g, " "));
    if (!status) return { loggedIn: null, detail: truncate(stripAnsi(result.output)) || "Unknown" };
    const loggedIn = status.isAuthenticated === true;
    return { loggedIn, detail: loggedIn ? "Logged in" : typeof status.message === "string" ? status.message : "Not logged in" };
  },
};

/**
 * `cursor-agent models` prints "Available models", then `<id> - <name> (current, default)` per model,
 * then a tip. Returns null when nothing is listed (e.g. "No models available for this account.").
 */
export function parseCursorModels(stdout: string): ModelCatalog | null {
  const line = /^([A-Za-z0-9][\w.-]*)(?: - .*?)?(?: \((?:current|default)(?:, (?:current|default))?\))?$/;
  const models = stripAnsi(stdout)
    .split(/\r?\n/)
    .map((text) => line.exec(text.trim())?.[1])
    .filter((id): id is string => id !== undefined);
  return models.length > 0 ? { models: [...new Set(models)], modelEfforts: {}, efforts: [] } : null;
}

/** `{ "shellToolCall": { args, result } }` → `{ name: "shell", body }`. */
function toolCall(event: JsonEvent): { name: string; body: JsonEvent } | null {
  const wrapper = event.tool_call;
  if (!wrapper || typeof wrapper !== "object") return null;
  const [key, body] = Object.entries(wrapper as Record<string, unknown>)[0] ?? [];
  if (!key || !body || typeof body !== "object") return null;
  return { name: key.replace(/ToolCall$/, ""), body: body as JsonEvent };
}

function argsDetail(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  const value = record.command ?? record.path ?? record.pattern ?? record.globPattern ?? record.url ?? record.query ?? record.targetDirectory;
  return typeof value === "string" ? truncate(value) : undefined;
}

/** Results are `{ success: {...} }` or another single key (`error`, `rejected`, …) describing the failure. */
function toolOutcome(result: unknown): { failed: boolean; detail?: string } {
  if (!result || typeof result !== "object") return { failed: false };
  const record = result as Record<string, unknown>;
  const success = record.success as Record<string, unknown> | undefined;
  if (success && typeof success === "object") {
    const exitCode = typeof success.exitCode === "number" ? success.exitCode : undefined;
    const failed = exitCode !== undefined && exitCode !== 0;
    const text = [failed ? success.stderr : undefined, success.stdout, success.content, success.output, success.message].find(
      (value): value is string => typeof value === "string" && value.trim() !== "",
    );
    return { failed, detail: text ? truncate(text) : exitCode !== undefined ? `exit ${exitCode}` : undefined };
  }
  const [key, value] = Object.entries(record)[0] ?? [];
  return { failed: true, detail: truncate(stringOf(value) || key || "failed") };
}

function textBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : "",
    )
    .join("");
}

/** A readable message out of whatever shape an error arrives in. */
function stringOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of ["message", "error", "reason", "stderr"]) {
    const nested = stringOf(record[key]);
    if (nested) return nested;
  }
  return "";
}
