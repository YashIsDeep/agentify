import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripAnsi } from "../lib/process";
import { execCli } from "./resolve";
import { type AgentAdapter, type AgentEvent, firstVersion, type ModelCatalog, parseJsonLine, truncate } from "./types";

/** Longer prompts go through an attached file to stay clear of Windows' command-line length limit. */
const INLINE_PROMPT_LIMIT = 8000;
const MODEL_NAME = /^[\w.-]+\/[\w.-]+$/;

/**
 * `opencode models --verbose` prints each model's name on its own line followed by its JSON, whose
 * `variants` keys are the values `--variant` accepts.
 */
export function parseVerboseModels(stdout: string): ModelCatalog | null {
  const lines = stripAnsi(stdout).split(/\r?\n/);
  const models: string[] = [];
  const modelEfforts: Record<string, string[]> = {};
  for (let i = 0; i < lines.length; i++) {
    const name = (lines[i] ?? "").trim();
    if (!MODEL_NAME.test(name)) continue;
    models.push(name);
    modelEfforts[name] = [];
    if (lines[i + 1]?.trim() !== "{") continue;
    // Nested braces are indented, so the first bare "}" closes this model's object.
    const end = lines.findIndex((line, j) => j > i && line.trimEnd() === "}");
    if (end === -1) break;
    try {
      const info = JSON.parse(lines.slice(i + 1, end + 1).join("\n")) as { variants?: unknown };
      if (info.variants && typeof info.variants === "object") modelEfforts[name] = Object.keys(info.variants);
    } catch {
      // Keep the model; only its levels are unknown.
    }
    i = end;
  }
  return models.length > 0 ? { models, modelEfforts, efforts: [] } : null;
}

export const opencodeAdapter: AgentAdapter = {
  id: "opencode",
  label: "OpenCode",
  binName: "opencode",
  installCommand: "npm i -g opencode-ai",
  loginCommand: "opencode auth login",
  modelHints: ["opencode-go/deepseek-v4-pro", "opencode-go/deepseek-v4-flash", "opencode/big-pickle"],
  // Providers are configured by the user, so the real list only exists inside their install.
  modelPattern: MODEL_NAME,
  // Variants are declared per model (`deepseek-v4-pro` has high/max, many have none), so there
  // is nothing to offer until a model is chosen.
  effortHints: [],
  usageEstimated: false,
  // `opencode mcp add` writes to persistent config; there is no per-invocation flag, so pointing
  // it at a per-run endpoint would mean writing a config file into the user's repository.
  supportsQuestions: false,

  async listModels(cli) {
    const verbose = await execCli(cli, ["models", "--verbose"]);
    const catalog = verbose.code === 0 ? parseVerboseModels(verbose.stdout) : null;
    if (catalog) return catalog;
    // Older builds without --verbose still list names, just not their variants.
    const result = await execCli(cli, ["models"]);
    if (result.code !== 0) return null;
    const models = stripAnsi(result.stdout)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => MODEL_NAME.test(line));
    return models.length > 0 ? { models, modelEfforts: {}, efforts: [] } : null;
  },

  buildSpawn(invocation) {
    let message = invocation.prompt;
    const attachments: string[] = [];
    if (message.length > INLINE_PROMPT_LIMIT || message.startsWith("-")) {
      const file = join(invocation.scratchDir, "prompt.md");
      writeFileSync(file, invocation.prompt, "utf8");
      attachments.push("-f", file);
      message = "Follow the instructions in the attached file prompt.md.";
    }
    // The message comes first: `-f` is an array option and would swallow a trailing positional.
    const args = ["run", message, "--format", "json", "--dir", invocation.cwd];
    if (invocation.model) args.push("-m", invocation.model);
    if (invocation.effort) args.push("--variant", invocation.effort);
    args.push(...(invocation.autonomy === "autonomous" ? ["--auto"] : ["--agent", "plan"]));
    if (invocation.resumeSessionId) args.push("--session", invocation.resumeSessionId);
    return { args: [...args, ...attachments] };
  },

  createParser() {
    let sessionId: string | null = null;
    let stepTexts: string[] = [];
    let lastText = "";
    let error: string | null = null;
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 };

    return {
      push(line) {
        const event = parseJsonLine(line);
        if (!event) return line.trim() ? [{ kind: "raw", text: stripAnsi(line) }] : [];
        const events: AgentEvent[] = [];
        if (!sessionId && typeof event.sessionID === "string") {
          sessionId = event.sessionID;
          events.push({ kind: "session", sessionId: event.sessionID });
        }
        const part = event.part ?? {};
        switch (event.type) {
          case "step_start":
            stepTexts = [];
            break;
          case "text":
            if (typeof part.text === "string" && part.text.trim()) {
              stepTexts.push(part.text);
              // The answer is the text of the last step that produced any.
              lastText = stepTexts.join("\n\n");
              events.push({ kind: "message", text: part.text });
            }
            break;
          case "tool_use": {
            const state = part.state ?? {};
            const status = state.status === "error" ? "failed" : state.status === "completed" ? "completed" : "started";
            const input = state.input ?? {};
            const detail = input.command ?? input.filePath ?? input.path ?? input.pattern ?? state.title;
            events.push({
              kind: "tool",
              name: String(part.tool ?? "tool"),
              status,
              detail: typeof detail === "string" ? truncate(detail) : undefined,
              id: typeof part.callID === "string" ? part.callID : typeof part.id === "string" ? part.id : undefined,
            });
            break;
          }
          case "step_finish": {
            const tokens = part.tokens ?? {};
            usage.inputTokens += num(tokens.input) + num(tokens.cache?.read);
            usage.cachedInputTokens += num(tokens.cache?.read);
            usage.outputTokens += num(tokens.output) + num(tokens.reasoning);
            usage.costUsd += num(part.cost);
            events.push({ kind: "usage", usage: { ...usage } });
            break;
          }
          case "error":
            error = String(event.error?.data?.message ?? event.error?.message ?? event.error?.name ?? "Unknown error");
            events.push({ kind: "error", message: error });
            break;
        }
        return events;
      },
      finish() {
        return [{ kind: "final", ok: !error, text: lastText, error: error ?? undefined }];
      },
    };
  },

  async version(cli) {
    const result = await execCli(cli, ["--version"]);
    return result.code === 0 ? firstVersion(result.stdout) : null;
  },

  async auth(cli) {
    const result = await execCli(cli, ["auth", "list"]);
    const text = stripAnsi(result.output);
    const count = Number(text.match(/(\d+)\s+credentials?/)?.[1] ?? Number.NaN);
    const providers = [...text.matchAll(/•\s+(.+)/g)].map((match) => (match[1] ?? "").trim()).filter(Boolean);
    if (Number.isNaN(count)) return { loggedIn: null, detail: truncate(text) || "Unknown" };
    return {
      loggedIn: count > 0,
      detail: count > 0 ? `Credentials: ${providers.join(", ") || count}` : "No credentials configured",
    };
  },
};

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
