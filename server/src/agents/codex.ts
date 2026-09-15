import { join } from "node:path";
import { MCP_SERVER_NAME, QUESTION_WAIT_MS } from "../api/mcp";
import { execCli } from "./resolve";
import { type AgentAdapter, type AgentEvent, firstVersion, type ModelCatalog, orderEfforts, parseJsonLine, truncate } from "./types";

export const codexAdapter: AgentAdapter = {
  id: "codex",
  label: "Codex",
  binName: "codex",
  installCommand: "npm i -g @openai/codex",
  loginCommand: "codex login",
  modelHints: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
  modelPattern: /^(gpt|o)[a-z0-9][a-z0-9.-]*$/i,
  effortHints: ["low", "medium", "high", "xhigh", "max"],
  usageEstimated: true,
  supportsQuestions: true,
  // Only in prose: "You've hit your usage limit. … try again at Sep 6th, 2026 2:40 AM."
  reportsUsageLimits: true,

  async listModels(cli) {
    // The catalog is refreshed from the account's backend; offline, the binary's bundled copy
    // is still a better list than ours.
    for (const args of [["debug", "models"], ["debug", "models", "--bundled"]]) {
      const result = await execCli(cli, args);
      const models = result.code === 0 ? parseModelCatalog(result.stdout) : null;
      if (models) return models;
    }
    return null;
  },

  buildSpawn(invocation) {
    const resultFile = join(invocation.scratchDir, "last-message.txt");
    const common = ["--json", "--skip-git-repo-check", "-o", resultFile];
    if (invocation.model) common.push("-m", invocation.model);
    if (invocation.effort) common.push("-c", `model_reasoning_effort="${invocation.effort}"`);
    if (invocation.askUserUrl) {
      // `-c` takes a dotted TOML path, which is how an MCP server is added for one invocation.
      common.push("-c", `mcp_servers.${MCP_SERVER_NAME}.url="${invocation.askUserUrl}"`);
      // Codex also times tool calls out after 60s by default, long before a question is answered.
      common.push("-c", `mcp_servers.${MCP_SERVER_NAME}.tool_timeout_sec=${QUESTION_WAIT_MS / 1000}`);
    }
    const autonomous = invocation.autonomy === "autonomous";

    if (invocation.resumeSessionId) {
      // `exec resume` has no --sandbox flag; set the equivalent config key instead.
      const access = autonomous ? ["--dangerously-bypass-approvals-and-sandbox"] : ["-c", 'sandbox_mode="read-only"'];
      return { args: ["exec", "resume", ...common, ...access, invocation.resumeSessionId, "-"], stdin: invocation.prompt, resultFile };
    }
    const access = autonomous ? ["--dangerously-bypass-approvals-and-sandbox"] : ["-s", "read-only"];
    return { args: ["exec", ...common, ...access, "-C", invocation.cwd, "-"], stdin: invocation.prompt, resultFile };
  },

  createParser() {
    let lastMessage = "";
    return {
      push(line) {
        const event = parseJsonLine(line);
        if (!event) return line.trim() ? [{ kind: "raw", text: line }] : [];
        const events: AgentEvent[] = [];
        const item = event.item ?? {};
        switch (event.type) {
          case "thread.started":
            if (typeof event.thread_id === "string") events.push({ kind: "session", sessionId: event.thread_id });
            break;
          case "item.started":
            if (item.type === "command_execution") {
              events.push({
                kind: "tool",
                name: "shell",
                status: "started",
                detail: truncate(String(item.command ?? "")),
                id: itemId(item),
              });
            }
            break;
          case "item.completed":
            if (item.type === "agent_message" && typeof item.text === "string") {
              lastMessage = item.text;
              events.push({ kind: "message", text: item.text });
            } else if (item.type === "command_execution") {
              events.push({
                kind: "tool",
                name: "shell",
                status: item.exit_code === 0 ? "completed" : "failed",
                detail: truncate(String(item.aggregated_output ?? "")) || `exit ${item.exit_code}`,
                id: itemId(item),
              });
            } else if (item.type && item.type !== "reasoning" && item.type !== "user_message") {
              events.push({ kind: "tool", name: String(item.type), status: "completed", id: itemId(item) });
            }
            break;
          case "turn.completed": {
            const usage = event.usage ?? {};
            events.push({
              kind: "usage",
              usage: {
                inputTokens: usage.input_tokens,
                cachedInputTokens: usage.cached_input_tokens,
                outputTokens: usage.output_tokens,
              },
            });
            events.push({ kind: "final", ok: true, text: lastMessage });
            break;
          }
          case "turn.failed":
            events.push({ kind: "final", ok: false, text: lastMessage, error: event.error?.message ?? "Turn failed" });
            break;
          case "error":
            events.push({ kind: "error", message: String(event.message ?? event.error?.message ?? "Unknown error") });
            break;
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
    const result = await execCli(cli, ["login", "status"]);
    const detail = truncate(result.output) || (result.code === 0 ? "Logged in" : "Not logged in");
    return { loggedIn: result.code === 0, detail };
  },
};

const itemId = (item: { id?: unknown }): string | undefined => (typeof item.id === "string" ? item.id : undefined);

interface CatalogEntry {
  slug?: unknown;
  visibility?: unknown;
  priority?: unknown;
  supported_reasoning_levels?: { effort?: unknown }[];
}

/**
 * `codex debug models`: slugs in picker order, leaving out internal models the picker hides,
 * with the reasoning levels each one supports.
 */
export function parseModelCatalog(stdout: string): ModelCatalog | null {
  let catalog: { models?: CatalogEntry[] };
  try {
    catalog = JSON.parse(stdout);
  } catch {
    return null;
  }
  const entries = (Array.isArray(catalog.models) ? catalog.models : [])
    .filter((model) => typeof model.slug === "string" && model.visibility !== "hide")
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0));
  if (entries.length === 0) return null;

  const modelEfforts: Record<string, string[]> = {};
  for (const entry of entries) {
    const levels = Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : [];
    modelEfforts[entry.slug as string] = levels.map((level) => level.effort).filter((effort): effort is string => typeof effort === "string");
  }
  return {
    models: entries.map((entry) => entry.slug as string),
    modelEfforts,
    // With no model chosen Codex uses whatever its config names, so any listed level may apply.
    efforts: orderEfforts(Object.values(modelEfforts).flat()),
  };
}
