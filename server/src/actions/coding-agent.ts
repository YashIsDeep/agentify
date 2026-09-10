import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AGENT_IDS, type AgentId, type AgentUsage } from "@wm/shared";
import { z } from "zod";
import { runAgent } from "../agents/run";
import type { AgentEvent } from "../agents/types";
import type { TaskRow } from "../db/schema";
import { resolveInside } from "../paths";
import { ActionError, type ActionDefinition } from "./types";
import { artifactName } from "./validation";

const configSchema = z.object({
  agent: z.enum(AGENT_IDS).default("claude"),
  model: z.string().default(""),
  prompt: z.string().min(1),
  autonomy: z.enum(["read-only", "autonomous"]).default("read-only"),
  /** Resume this action's previous session for the task when the agent is unchanged. */
  continueSession: z.boolean().default(false),
  /** Artifact name to write the agent's final message to. Blank skips the write. */
  saveResultAs: z.union([z.literal(""), artifactName("Save result as")]).default(""),
  inactivityTimeoutSec: z.number().positive().default(300),
  timeoutSec: z.number().positive().optional(),
});
type Config = z.output<typeof configSchema>;

/** Largest final message kept in outputs (the artifact always gets the full text). */
const MAX_RESULT_IN_OUTPUTS = 50_000;

const isAgentId = (value: unknown): value is AgentId => AGENT_IDS.includes(value as AgentId);

/** Retry-dialog choice → task override → action default. */
export function selectAgent(
  config: Pick<Config, "agent" | "model">,
  task: Pick<TaskRow, "agentOverride" | "modelOverride">,
  runOverrides: Record<string, unknown> | null,
): { agent: AgentId; model: string | null } {
  const overrides = runOverrides ?? {};
  const agent = isAgentId(overrides.agent) ? overrides.agent : isAgentId(task.agentOverride) ? task.agentOverride : config.agent;
  const model = "model" in overrides ? String(overrides.model ?? "") : (task.modelOverride ?? config.model);
  return { agent, model: model.trim() || null };
}

export const codingAgentAction: ActionDefinition<Config> = {
  type: "coding-agent",
  label: "Coding agent",
  description: "Runs Claude Code, Codex or OpenCode headlessly in the task's worktree.",
  configSchema,
  longRunning: true,
  fields: [
    {
      name: "prompt",
      label: "Prompt",
      kind: "textarea",
      default: "",
      templated: true,
      placeholder: "What should the agent do?",
    },
    {
      name: "agent",
      label: "Agent",
      kind: "agent",
      default: "claude",
      help: "A per-task or retry-time choice overrides this.",
    },
    { name: "model", label: "Model", kind: "model", default: "", help: "Blank uses the CLI's own default." },
    {
      name: "autonomy",
      label: "Autonomy",
      kind: "select",
      default: "read-only",
      options: [
        { value: "read-only", label: "Read-only (cannot edit files)" },
        { value: "autonomous", label: "Autonomous (edits and commits)" },
      ],
    },
    {
      name: "continueSession",
      label: "Continue the previous session",
      kind: "boolean",
      default: false,
      help: "Resumes this action's last session for the task, if the agent is unchanged.",
    },
    {
      name: "saveResultAs",
      label: "Save result as artifact",
      kind: "text",
      default: "",
      placeholder: "requirements.md",
      help: "Writes the agent's final message to this artifact. Leave blank to skip.",
    },
    {
      name: "inactivityTimeoutSec",
      label: "Inactivity timeout (seconds)",
      kind: "number",
      default: 300,
      help: "Fails the run when the agent produces no output for this long.",
    },
    { name: "timeoutSec", label: "Total timeout (seconds)", kind: "number", default: undefined, placeholder: "No limit" },
  ],

  async run({ config, run, task, artifactDir, env, log, signal, services }) {
    const { agent, model } = selectAgent(config, task, run.overrides);
    const adapter = services.agents.adapter(agent);
    // Last line of defence: the model may come from a task or retry override saved before this
    // agent was chosen, so check it here rather than letting the CLI fail mid-run.
    const modelError = await services.agents.validateModel(agent, model);
    if (modelError) throw new Error(modelError);
    const cli = services.agents.resolve(agent);
    const cwd = [task.worktreePath, task.repoPath, artifactDir].find((dir): dir is string => !!dir && existsSync(dir))!;
    // `ensure-worktree` treats "no repository" as nothing to do, so without this an autonomous
    // agent would quietly start editing the artifacts folder instead of the codebase.
    if (config.autonomy === "autonomous" && cwd === artifactDir) {
      throw new Error("This task has no repository, so there is nothing for an autonomous agent to work on. Set one in the task's Details.");
    }

    let prompt = config.prompt;
    let resumeSessionId: string | null = null;
    if (config.continueSession) {
      const previous = services.engine.previousAgentSession(task.id, run.bindingKey, run.id);
      if (previous && previous.agent === agent) {
        resumeSessionId = previous.sessionId;
        log(`Resuming ${adapter.label} session ${previous.sessionId}`);
      } else if (previous?.result) {
        const by = previous.agent ? services.agents.adapter(previous.agent).label : "another agent";
        prompt = `A previous attempt at this step (by ${by}) ended with:\n\n${previous.result}\n\n---\n\n${prompt}`;
        log(`Agent changed; starting a fresh ${adapter.label} session with the previous result as context`);
      }
    }

    log(`${adapter.label}${model ? ` · ${model}` : ""} · ${config.autonomy} · ${cwd}`);
    const logEvent = eventLogger(log);
    const result = await runAgent({
      adapter,
      cli,
      invocation: {
        prompt,
        model,
        autonomy: config.autonomy,
        resumeSessionId,
        cwd,
        scratchDir: join(services.paths.runsDir(task.id), `${run.id}-agent`),
      },
      env,
      signal,
      inactivityTimeoutMs: config.inactivityTimeoutSec * 1000,
      timeoutMs: config.timeoutSec ? config.timeoutSec * 1000 : undefined,
      onEvent: logEvent,
      onStderr: (line) => log(line, "stderr"),
    });

    const outputs: Record<string, unknown> = {
      agent,
      model,
      sessionId: result.sessionId,
      result: result.text.slice(0, MAX_RESULT_IN_OUTPUTS),
    };
    const details = { outputs, sessionId: result.sessionId, usage: result.usage };
    if (result.aborted) throw new Error("Cancelled");
    if (!result.ok) throw new ActionError(result.error ?? "The agent failed", details);

    if (config.saveResultAs) {
      if (!result.text.trim()) throw new ActionError("The agent finished without a final message to save", details);
      const file = resolveInside(artifactDir, config.saveResultAs);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, result.text, "utf8");
      outputs.artifact = config.saveResultAs;
      log(`Saved the final message to ${config.saveResultAs}`);
    }
    return { ...details, summary: usageSummary(result.usage) };
  },
};

function eventLogger(log: (text: string, stream?: "stdout" | "stderr" | "info") => void) {
  let loggedSession = false;
  return (event: AgentEvent) => {
    switch (event.kind) {
      case "message":
        log(event.text, "stdout");
        break;
      case "tool":
        if (event.status === "started") log(`▸ ${event.name}${event.detail ? `: ${event.detail}` : ""}`, "info");
        else if (event.status === "failed") log(`✗ ${event.name}${event.detail ? ` (${event.detail})` : ""}`, "stderr");
        break;
      case "error":
        log(event.message, "stderr");
        break;
      case "session":
        if (!loggedSession) log(`Session ${event.sessionId}`, "info");
        loggedSession = true;
        break;
      case "raw":
        log(event.text, "stdout");
        break;
    }
  };
}

export function usageSummary(usage: AgentUsage | null): string | undefined {
  if (!usage) return undefined;
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`${compact(usage.inputTokens)} in`);
  if (usage.outputTokens !== undefined) parts.push(`${compact(usage.outputTokens)} out`);
  if (usage.costUsd) parts.push(`$${usage.costUsd.toFixed(usage.costUsd < 0.01 ? 4 : 2)}${usage.estimated ? " est." : ""}`);
  return parts.length ? parts.join(" · ") : undefined;
}

const compact = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value));
