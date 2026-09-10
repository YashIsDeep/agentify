import { execCli } from "./resolve";
import { type AgentAdapter, type AgentEvent, firstVersion, parseJsonLine, truncate } from "./types";

/** Tools that can't modify anything; used for read-only runs. */
const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "WebFetch", "WebSearch"];

export const claudeAdapter: AgentAdapter = {
  id: "claude",
  label: "Claude Code",
  binName: "claude",
  installCommand: "npm i -g @anthropic-ai/claude-code",
  loginCommand: "claude auth login",
  // `claude --help`: an alias for the latest model, or a full name like "claude-fable-5".
  modelHints: ["fable", "opus", "sonnet", "haiku"],
  modelPattern: /^claude-[a-z0-9][a-z0-9.-]*$/i,
  usageEstimated: true,

  buildSpawn(invocation) {
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (invocation.autonomy === "autonomous") {
      args.push("--dangerously-skip-permissions");
    } else {
      // Plan mode delivers its answer through ExitPlanMode rather than the result, which breaks
      // "save result as artifact"; a read-only tool set keeps the answer in the final message.
      args.push("--tools", READ_ONLY_TOOLS.join(","), "--permission-prompts", "none");
    }
    if (invocation.model) args.push("--model", invocation.model);
    if (invocation.resumeSessionId) args.push("--resume", invocation.resumeSessionId);
    return { args, stdin: invocation.prompt };
  },

  createParser() {
    const toolNames = new Map<string, string>();
    return {
      push(line) {
        const event = parseJsonLine(line);
        if (!event) return line.trim() ? [{ kind: "raw", text: line }] : [];
        const events: AgentEvent[] = [];
        switch (event.type) {
          case "system":
            if (event.subtype === "init" && typeof event.session_id === "string") {
              events.push({ kind: "session", sessionId: event.session_id });
            }
            break;
          case "assistant":
            for (const block of event.message?.content ?? []) {
              if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
                events.push({ kind: "message", text: block.text });
              } else if (block.type === "tool_use") {
                toolNames.set(block.id, block.name);
                events.push({ kind: "tool", name: block.name, status: "started", detail: summarizeInput(block.input) });
              }
            }
            break;
          case "user":
            for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
              if (block.type === "tool_result") {
                const name = toolNames.get(block.tool_use_id) ?? "tool";
                events.push({ kind: "tool", name, status: block.is_error ? "failed" : "completed" });
              }
            }
            break;
          case "result": {
            if (typeof event.session_id === "string") events.push({ kind: "session", sessionId: event.session_id });
            const usage = event.usage ?? {};
            events.push({
              kind: "usage",
              usage: {
                inputTokens: sum(usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens),
                cachedInputTokens: usage.cache_read_input_tokens,
                outputTokens: usage.output_tokens,
                costUsd: event.total_cost_usd,
              },
            });
            const ok = event.subtype === "success" && !event.is_error;
            const text = typeof event.result === "string" ? event.result : "";
            const errors = Array.isArray(event.errors) ? event.errors.join("; ") : "";
            events.push({ kind: "final", ok, text, error: ok ? undefined : text || errors || String(event.subtype) });
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
    const result = await execCli(cli, ["auth", "status"]);
    const status = parseJsonLine(result.stdout.replace(/\s+/g, " "));
    if (!status) return { loggedIn: null, detail: truncate(result.output) || "Unknown" };
    return {
      loggedIn: status.loggedIn === true,
      detail: status.loggedIn ? `Logged in (${status.authMethod ?? "unknown method"})` : "Not logged in",
    };
  },
};

function summarizeInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const value = record.command ?? record.file_path ?? record.path ?? record.pattern ?? record.url ?? record.query;
  return typeof value === "string" ? truncate(value) : undefined;
}

function sum(...values: unknown[]): number | undefined {
  const numbers = values.filter((value): value is number => typeof value === "number");
  return numbers.length ? numbers.reduce((a, b) => a + b, 0) : undefined;
}
