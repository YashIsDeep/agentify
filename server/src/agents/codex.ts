import { join } from "node:path";
import { execCli } from "./resolve";
import { type AgentAdapter, type AgentEvent, firstVersion, parseJsonLine, truncate } from "./types";

export const codexAdapter: AgentAdapter = {
  id: "codex",
  label: "Codex",
  binName: "codex",
  installCommand: "npm i -g @openai/codex",
  loginCommand: "codex login",
  modelHints: ["gpt-5-codex", "gpt-5"],
  modelPattern: /^(gpt|o)[a-z0-9][a-z0-9.-]*$/i,
  usageEstimated: true,

  buildSpawn(invocation) {
    const resultFile = join(invocation.scratchDir, "last-message.txt");
    const common = ["--json", "--skip-git-repo-check", "-o", resultFile];
    if (invocation.model) common.push("-m", invocation.model);
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
              events.push({ kind: "tool", name: "shell", status: "started", detail: truncate(String(item.command ?? "")) });
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
                detail: item.exit_code === 0 ? undefined : `exit ${item.exit_code}`,
              });
            } else if (item.type && item.type !== "reasoning" && item.type !== "user_message") {
              events.push({ kind: "tool", name: String(item.type), status: "completed" });
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
