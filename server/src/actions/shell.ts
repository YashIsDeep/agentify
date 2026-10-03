import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { runProcess, stripAnsi, tail } from "../lib/process";
import type { ActionContext, ActionDefinition } from "./types";
import { extractPatterns } from "./validation";

const configSchema = z.object({
  command: z.string().min(1).refine(
    (command) => !command.includes("{{"),
    "Shell commands cannot contain template expressions. Read task data through WM_* environment variables instead.",
  ),
  shell: z.enum(["default", "cmd", "powershell", "bash", "sh"]).default("default"),
  /** Falls back worktree → repo → artifacts when the preferred directory doesn't exist. */
  cwd: z.enum(["worktree", "repo", "artifacts"]).default("worktree"),
  timeoutSec: z.number().positive().optional(),
  /** Output name → regex run over stdout+stderr; first capture group (or whole match) becomes the value. */
  extract: extractPatterns,
});
type Config = z.output<typeof configSchema>;

export const shellAction: ActionDefinition<Config> = {
  type: "shell",
  label: "Run shell command",
  description:
    "Runs a command. Task data is available as WM_* environment variables; write a JSON object to $WM_OUTPUT_FILE to set outputs.",
  configSchema,
  validateBeforeRender: true,
  fields: [
    { name: "command", label: "Command", kind: "textarea", default: "", placeholder: "npm test", help: "Read task data through WM_* environment variables. Template expressions are not allowed in shell commands." },
    {
      name: "shell",
      label: "Shell",
      kind: "select",
      default: "default",
      advanced: true,
      options: [
        { value: "default", label: "System default" },
        { value: "cmd", label: "cmd.exe" },
        { value: "powershell", label: "PowerShell" },
        { value: "bash", label: "bash (Git Bash on Windows)" },
        { value: "sh", label: "sh" },
      ],
    },
    {
      name: "cwd",
      label: "Run in",
      kind: "select",
      default: "worktree",
      help: "Falls back to the next directory when the preferred one doesn't exist.",
      options: [
        { value: "worktree", label: "Task worktree" },
        { value: "repo", label: "Repository" },
        { value: "artifacts", label: "Artifact directory" },
      ],
    },
    { name: "timeoutSec", label: "Timeout (seconds)", kind: "number", default: undefined, placeholder: "No limit", advanced: true },
    {
      name: "extract",
      label: "Outputs from stdout",
      kind: "key-value",
      default: {},
      advanced: true,
      help: "Output name → regular expression. The first capture group becomes the value.",
      keyLabel: "Output",
      valueLabel: "Regex",
    },
  ],
  async run(ctx) {
    const { config } = ctx;
    const cwd = pickCwd(config.cwd, ctx);
    ctx.log(`$ ${config.command}`);
    const result = await runProcess({
      ...invocation(config.shell, config.command),
      cwd,
      env: { ...process.env, ...ctx.env, GIT_TERMINAL_PROMPT: "0" },
      signal: ctx.signal,
      timeoutMs: config.timeoutSec ? config.timeoutSec * 1000 : undefined,
      onLine: (text, stream) => ctx.log(stripAnsi(text), stream),
    });
    if (result.aborted) throw new Error("Cancelled");
    if (result.timedOut) throw new Error(`Timed out after ${config.timeoutSec}s`);
    // Colour codes would otherwise end up in failure messages and in whatever the regexes capture.
    const output = stripAnsi(result.output);
    if (result.code !== 0) {
      const excerpt = tail(output, 5);
      throw new Error(`Command exited with code ${result.code}${excerpt ? `\n${excerpt}` : ""}`);
    }
    return { outputs: { ...extractOutputs(config.extract, output), ...readOutputFile(ctx.env.WM_OUTPUT_FILE) } };
  },
};

function pickCwd(preference: Config["cwd"], ctx: ActionContext<Config>): string {
  const candidates = {
    worktree: [ctx.task.worktreePath, ctx.task.repoPath, ctx.artifactDir],
    repo: [ctx.task.repoPath, ctx.artifactDir],
    artifacts: [ctx.artifactDir],
  }[preference];
  const cwd = candidates.find((dir): dir is string => !!dir && existsSync(dir)) ?? ctx.artifactDir;
  if (cwd !== candidates[0]) ctx.log(`No ${preference} directory for this task; running in ${cwd}`);
  return cwd;
}

export function invocation(shell: Config["shell"], command: string) {
  switch (shell) {
    case "default":
      return { command, shell: true };
    case "cmd":
      return { command: "cmd.exe", args: ["/d", "/s", "/c", `"${command}"`], windowsVerbatimArguments: true };
    case "powershell":
      return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] };
    case "bash":
      return { command: bashPath(), args: ["-c", command] };
    case "sh":
      return { command: "sh", args: ["-c", command] };
  }
}

/** On Windows, plain `bash` can resolve to WSL; prefer Git Bash when installed. */
function bashPath(): string {
  if (process.platform !== "win32") return "bash";
  const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
  return existsSync(gitBash) ? gitBash : "bash";
}

function extractOutputs(patterns: Record<string, string>, output: string): Record<string, string | null> {
  const outputs: Record<string, string | null> = {};
  for (const [name, pattern] of Object.entries(patterns)) {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "m");
    } catch {
      throw new Error(`Invalid regex for output "${name}": ${pattern}`);
    }
    const match = regex.exec(output);
    outputs[name] = match ? (match[1] ?? match[0]) : null;
  }
  return outputs;
}

function readOutputFile(file: string | undefined): Record<string, unknown> {
  if (!file || !existsSync(file)) return {};
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("$WM_OUTPUT_FILE must contain a JSON object");
  }
  return parsed as Record<string, unknown>;
}
