import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AGENT_IDS, type AgentChoice, type AgentChoiceLayer, type AgentDefaults, type AgentId, type AgentUsage, resolveAgentChoice } from "@wm/shared";
import { z } from "zod";
import { runAgent } from "../agents/run";
import type { AgentEvent } from "../agents/types";
import type { TaskRow } from "../db/schema";
import { resolveInside } from "../paths";
import { ActionError, type ActionDefinition, type RunLog, UsageLimitError } from "./types";
import { artifactName } from "./validation";

/** How long a run waits when its agent hits a usage limit without saying when it resets. */
export const UNKNOWN_RESET_WAIT_MS = 30 * 60_000;
/** Sent in place of the prompt when a run picks its own session back up after a usage limit. */
export const CONTINUE_AFTER_LIMIT = "Your usage limit has reset. Carry on with the task from where you stopped.";

const configSchema = z.object({
  /** Blank takes the stage's default agent, else Claude Code. */
  agent: z.union([z.literal(""), z.enum(AGENT_IDS)]).default(""),
  model: z.string().default(""),
  effort: z.string().default(""),
  prompt: z.string().min(1),
  autonomy: z.enum(["read-only", "autonomous"]).default("read-only"),
  /** Hold the run open when the agent finishes: nothing below it runs until you approve. */
  requireApproval: z.boolean().default(false),
  approvalInstructions: z.string().default(""),
  /** A stage id in the same workflow; empty offers no Send back at the approval. */
  sendBackTo: z.string().default(""),
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
/** Largest prompt kept in the transcript; past this the point has been made and the log is just heavy. */
const MAX_PROMPT_IN_LOG = 20_000;

/** Retry-dialog choice → task override → action → stage default → the agent's saved default → the CLI's own. */
export function selectAgent(
  config: Pick<Config, "agent" | "model" | "effort">,
  task: Pick<TaskRow, "agentOverride" | "modelOverride" | "effortOverride">,
  runOverrides: Record<string, unknown> | null,
  stage: AgentChoiceLayer,
  defaults: (agent: AgentId) => AgentDefaults,
): AgentChoice {
  const taskLayer = { agent: task.agentOverride, model: task.modelOverride, effort: task.effortOverride };
  return resolveAgentChoice([runOverrides ?? {}, taskLayer, config, stage], defaults);
}

export const codingAgentAction: ActionDefinition<Config> = {
  type: "coding-agent",
  label: "Coding agent",
  description: "Runs Claude Code, Codex, OpenCode or Cursor Agent headlessly in the task's worktree.",
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
      default: "",
      help: "Blank uses the stage's default agent, else Claude Code. A per-task or retry-time choice overrides this.",
    },
    {
      name: "model",
      label: "Model",
      kind: "model",
      default: "",
      help: "Blank uses the stage's default, then the agent's (Agents page), then the CLI's.",
    },
    {
      name: "effort",
      label: "Reasoning effort",
      kind: "effort",
      default: "",
      help: "Blank uses the stage's or agent's default when it comes with the same model, else the model's own.",
    },
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
      name: "requireApproval",
      label: "Wait for my approval when it finishes",
      kind: "boolean",
      // New editor actions start with review enabled; the schema keeps existing configs opt-in.
      default: true,
      help: "Review the result, request revisions as often as you need, then Approve & continue. Each revision returns for review; nothing below runs until you approve.",
    },
    {
      name: "approvalInstructions",
      label: "Approval instructions",
      kind: "textarea",
      default: "",
      templated: true,
      dependsOn: "requireApproval",
      placeholder: "Read requirements.md, then approve.",
      help: "Shown on the task while it waits for you.",
    },
    {
      name: "sendBackTo",
      label: "Send back to",
      kind: "stage",
      default: "",
      dependsOn: "requireApproval",
      noneLabel: "No Send back button",
      help: "An escape hatch next to Approve, for when the work belongs at an earlier stage rather than with the agent.",
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
    const stageDefaults = services.engine.stageAgentDefaultsForRun(run);
    const { agent, model, effort } = selectAgent(config, task, run.overrides, stageDefaults, (id) => services.agents.defaults(id));
    const adapter = services.agents.adapter(agent);
    // Last line of defence: the model may come from a task or retry override saved before this
    // agent was chosen, and an effort from one layer may not suit a model from another, so check
    // here rather than letting the CLI fail mid-run.
    const choiceError = await services.agents.validateChoice(agent, model, effort);
    if (choiceError) throw new Error(choiceError);
    // Another run already hit this agent's limit: wait alongside it rather than spend a request finding out.
    const heldUntil = services.agents.quotaHold(agent);
    if (heldUntil) {
      throw new UsageLimitError(`${adapter.label}'s usage limit is still in effect`, heldUntil, {
        sessionId: run.sessionId,
        outputs: { ...(run.outputs ?? {}), agent, model, effort },
      });
    }
    const cli = services.agents.resolve(agent);
    const cwd = [task.worktreePath, task.repoPath, artifactDir].find((dir): dir is string => !!dir && existsSync(dir))!;
    // `ensure-worktree` treats "no repository" as nothing to do, so without this an autonomous
    // agent would quietly start editing the artifacts folder instead of the codebase.
    if (config.autonomy === "autonomous" && cwd === artifactDir) {
      throw new Error("This task has no repository, so there is nothing for an autonomous agent to work on. Set one in the task's Details.");
    }
    // `ensure-worktree` is an action like any other, so a stage can easily be built without one above
    // this agent, and the run then falls back to the repository's own checkout on whatever branch it
    // happens to have — which is not what a task whose Details say "Use a worktree" asked for. Editing
    // it is a refusal; merely reading it is harmless, but surprising enough to say out loud below.
    const strayFromWorktree = cwd === task.repoPath && task.useWorktree;
    if (config.autonomy === "autonomous" && strayFromWorktree) {
      throw new Error(
        `This task is set to use a worktree but hasn't got one, so an autonomous agent would edit the repository's own checkout at ${cwd}, ` +
          `on whatever branch it is currently on. Add an “Ensure worktree” action to an earlier stage in this workflow, ` +
          `or turn off “Use a worktree” in the task's Details if editing the checkout directly is what you want.`,
      );
    }

    let prompt = config.prompt;
    let resumeSessionId: string | null = null;
    // Changes asked for at this run's own approval: your words are the prompt, and the agent picks
    // the session it just used back up, so one run stays one conversation.
    const followUp = run.followUp?.trim();
    if (followUp) {
      log({ kind: "answer", stream: "info", text: followUp });
      if (run.sessionId && run.outputs?.agent === agent) {
        resumeSessionId = run.sessionId;
        prompt = followUp;
        log(`Carrying on in ${adapter.label} session ${run.sessionId} with your changes`);
      } else {
        const previous = typeof run.outputs?.result === "string" ? run.outputs.result : "";
        prompt = previous ? `Your previous answer was:\n\n${previous}\n\n---\n\n${followUp}` : followUp;
        log(`Starting a fresh ${adapter.label} session with your changes`);
      }
    } else if (run.sessionId && run.outputs?.agent === agent) {
      // A usage limit parked this very run after its session had started, so pick that session back up.
      resumeSessionId = run.sessionId;
      prompt = CONTINUE_AFTER_LIMIT;
      log(`Resuming ${adapter.label} session ${run.sessionId} now the usage limit has reset`);
    } else if (config.continueSession) {
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

    // Recorded after every rewrite above, so what the transcript shows is exactly what the CLI got.
    // When a run goes wrong the prompt is as often the culprit as the agent — a template that
    // rendered an artifact as nothing leaves no other trace — and until now it was the one thing
    // the transcript never kept.
    log({ kind: "prompt", stream: "info", text: promptForLog(prompt) });

    // Only agents that can be pointed at an MCP server per invocation can stop and ask.
    const askUserUrl = adapter.supportsQuestions ? services.questions.endpointFor(run.id) : null;
    if (askUserUrl) {
      services.questions.attachLog(run.id, log);
      log(`${adapter.label} can ask you questions while it works`);
    }

    log(`${adapter.label}${model ? ` · ${model}` : ""}${effort ? ` · ${effort}` : ""} · ${config.autonomy} · ${cwd}`);
    // Autonomous runs never reach here in this state; a read-only one only reads, so this is a note
    // rather than a failure — but the path above is the checkout the whole team works in, and seeing
    // why it is there beats wondering whether the worktree silently went missing.
    if (strayFromWorktree) {
      log("That is the repository's own checkout: this task is set to use a worktree, but no “Ensure worktree” action has run above this one. Read-only, so nothing there is edited.");
    }
    const logEvent = eventLogger(log);
    try {
      const result = await runAgent({
        adapter,
        cli,
        invocation: {
          prompt,
          model,
          effort,
          autonomy: config.autonomy,
          resumeSessionId,
          cwd,
          scratchDir: join(services.paths.runsDir(task.id), `${run.id}-agent`),
          askUserUrl,
        },
        env,
        signal,
        inactivityTimeoutMs: config.inactivityTimeoutSec * 1000,
        timeoutMs: config.timeoutSec ? config.timeoutSec * 1000 : undefined,
        isIdleExpected: () => services.questions.isWaiting(run.id),
        onEvent: logEvent,
        onStderr: (line) => log(line, "stderr"),
      });
      const outputs: Record<string, unknown> = {
        agent,
        model,
        effort,
        sessionId: result.sessionId,
        result: result.text.slice(0, MAX_RESULT_IN_OUTPUTS),
      };
      const details = { outputs, sessionId: result.sessionId, usage: result.usage };
      if (result.aborted) throw new Error("Cancelled");
      if (!result.ok && result.usageLimit) {
        const now = Date.now();
        // A reset time already past (or a moment away) still gets a minute, so a stale one can't spin.
        const resetAt = Math.max(result.usageLimit.resetAt ?? now + UNKNOWN_RESET_WAIT_MS, now + 60_000);
        services.agents.setQuotaHold(agent, resetAt);
        log({ kind: "notice", stream: "info", text: `${adapter.label} hit its usage limit; this run carries on at ${new Date(resetAt).toLocaleString()}` });
        throw new UsageLimitError(result.error ?? "Usage limit reached", resetAt, details);
      }
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
    } finally {
      // Whatever happened, the endpoint dies with the run and nothing is left blocked on it.
      services.questions.cancelForRun(run.id, "The run ended");
      services.questions.releaseToken(run.id);
      services.questions.detachLog(run.id);
    }
  },
};

/** The prompt as the transcript keeps it, saying so itself when it was too long to keep whole. */
function promptForLog(prompt: string): string {
  if (prompt.length <= MAX_PROMPT_IN_LOG) return prompt;
  return `${prompt.slice(0, MAX_PROMPT_IN_LOG)}\n\n[Truncated: the prompt was ${prompt.length} characters and only the first ${MAX_PROMPT_IN_LOG} are kept here.]`;
}

/**
 * Turns the CLI's event stream into transcript entries. Each keeps its shape — a message stays one
 * message however many lines it spans, and a tool result carries the id of the call it answers —
 * so the chat view can render the run as the conversation it was.
 */
function eventLogger(log: RunLog) {
  let loggedSession = false;
  return (event: AgentEvent) => {
    switch (event.kind) {
      case "message":
        log({ kind: "message", stream: "stdout", text: event.text });
        break;
      case "tool":
        if (event.status === "started") {
          log({ kind: "tool", stream: "info", text: event.detail ?? "", tool: event.name, ref: event.id });
        } else {
          log({
            kind: "tool-result",
            stream: event.status === "failed" ? "stderr" : "info",
            text: event.detail ?? "",
            tool: event.name,
            ref: event.id,
            ok: event.status !== "failed",
          });
        }
        break;
      case "error":
        log({ kind: "notice", stream: "stderr", text: event.message });
        break;
      case "session":
        if (!loggedSession) log({ kind: "notice", stream: "info", text: `Session ${event.sessionId}` });
        loggedSession = true;
        break;
      case "raw":
        log({ stream: "stdout", text: event.text });
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
