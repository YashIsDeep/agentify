import { existsSync } from "node:fs";
import { AGENT_IDS, type AgentChoice, type AgentChoiceLayer, type AgentDefaults, type AgentId, type AgentUsage, LOOP_MODE_IDS, LOOP_MODES, loopPolicy, resolveAgentChoice, type RunLogLine } from "@wm/shared";
import { z } from "zod";
import { type CiCommands, runCi } from "../agents/ci-loop";
import { type LoopInput, runSingle, type SavedLoop } from "../agents/loops";
import { runReview } from "../agents/review";
import { cliTurns, scratchPrefix } from "../agents/turns";
import type { TaskRow } from "../db/schema";
import { artifactHistory, currentDocumentContext } from "../services/artifact-history";
import { renderDecisions } from "../agents/decisions";
import { ActionError, type ActionDefinition, type RunLog, UsageLimitError } from "./types";
import { artifactName } from "./validation";
import { invocation } from "./shell";
import { runProcess, stripAnsi } from "../lib/process";

/** How long a run waits when its agent hits a usage limit without saying when it resets. */
export const UNKNOWN_RESET_WAIT_MS = 30 * 60_000;

const configSchema = z.object({
  /** Blank takes the stage's default agent, else Claude Code. */
  agent: z.union([z.literal(""), z.enum(AGENT_IDS)]).default(""),
  model: z.string().default(""),
  effort: z.string().default(""),
  prompt: z.string().min(1),
  loopMode: z.enum(LOOP_MODE_IDS).default("single"),
  maxCorrections: z.number().int().min(1).max(10).default(3),
  verificationInstructions: z.string().default(""),
  ciCheckCommand: z.string().refine((value) => !value.includes("{{"), "CI commands cannot contain template expressions; use WM_* environment variables").default(""),
  ciPublishCommand: z.string().refine((value) => !value.includes("{{"), "CI commands cannot contain template expressions; use WM_* environment variables").default(""),
  ciShell: z.enum(["default", "cmd", "powershell", "bash", "sh"]).default("default"),
  ciTimeoutSec: z.number().positive().default(1800),
  autonomy: z.enum(["read-only", "autonomous"]).default("read-only"),
  /** Hold the run open when the agent finishes: nothing below it runs until you approve. */
  requireApproval: z.boolean().default(false),
  /** No longer offered in the editor: blank shows the standard line for the loop mode. */
  approvalInstructions: z.string().default(""),
  /** A stage id in the same workflow; empty offers no Send back at the approval. */
  sendBackTo: z.string().default(""),
  /**
   * Resume this action's previous session for the task when the agent is unchanged. No longer offered
   * in the editor: only workflows saved with it off start fresh.
   */
  continueSession: z.boolean().default(true),
  /** Artifact name to write the agent's final message to. Blank skips the write. */
  saveResultAs: z.union([z.literal(""), artifactName("Save result as")]).default(""),
  inactivityTimeoutSec: z.number().positive().default(300),
  timeoutSec: z.number().positive().optional(),
}).refine((config) => config.loopMode !== "ci" || !!config.ciCheckCommand.trim(), "CI loop requires a check command")
  .refine((config) => !["plan", "build-verify", "implementation"].includes(config.loopMode)
    || config.saveResultAs.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".").join("/").toLowerCase() !== "decisions.md",
  "decisions.md is reserved for the final decision record; choose a different result artifact name");
type Config = z.output<typeof configSchema>;

/** Largest final message kept in outputs (the artifact always gets the full text). */
const MAX_RESULT_IN_OUTPUTS = 50_000;

const LOOPS = { field: "loopMode", in: ["plan", "build-verify", "implementation", "ci"] } as const;
const DOCUMENT_LOOPS = { field: "loopMode", in: ["plan", "build-verify"] } as const;
const CI = { field: "loopMode", in: ["ci"] } as const;
const AWAITING_APPROVAL = { field: "requireApproval", in: [true] } as const;

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
  validateBeforeRender: true,
  worksInWorktree: () => true,
  fields: [
    {
      name: "loopMode", label: "Loop", kind: "select", default: "single",
      options: LOOP_MODES.map((mode) => ({ value: mode.id, label: mode.label })),
      help: LOOP_MODES.map((mode) => `${mode.label}: ${mode.hint}`).join(" "),
    },
    { name: "maxCorrections", label: "Maximum correction attempts", kind: "number", default: 3, shownWhen: LOOPS, advanced: true, help: "Stops with a failure and the remaining feedback when the limit is reached (1–10)." },
    { name: "verificationInstructions", label: "Verification criteria", kind: "textarea", default: "", templated: true, shownWhen: DOCUMENT_LOOPS, advanced: true,
      placeholder: "What must be true for this document to pass review?", help: "The independent reviewer checks these criteria as well as the task instructions. Each build and review is kept in Artifacts." },
    { name: "ciCheckCommand", label: "CI check command", kind: "textarea", default: "", shownWhen: CI, placeholder: "npm test", help: "Run local checks, remote checks, or a script combining both. It must wait for checks on the current commit and exit 0 only when all pass. Use WM_* environment variables, not templates." },
    { name: "ciPublishCommand", label: "CI publish command", kind: "textarea", default: "", shownWhen: CI, advanced: true, help: "Optional: runs before each check, including the first, to commit and push changes needed by remote CI. Leave blank for local checks or an already-published branch. Must be safe to repeat." },
    { name: "ciShell", label: "CI command shell", kind: "select", default: "default", shownWhen: CI, advanced: true, options: [
      { value: "default", label: "System default" }, { value: "powershell", label: "PowerShell" },
      { value: "cmd", label: "cmd.exe" }, { value: "bash", label: "Bash" }, { value: "sh", label: "sh" },
    ] },
    { name: "ciTimeoutSec", label: "CI command timeout (seconds)", kind: "number", default: 1800, shownWhen: CI, advanced: true },
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
    },
    {
      name: "model",
      label: "Model",
      kind: "model",
      default: "",
      advanced: true,
    },
    {
      name: "effort",
      label: "Reasoning effort",
      kind: "effort",
      default: "",
      advanced: true,
    },
    {
      name: "autonomy",
      label: "Autonomy",
      kind: "select",
      default: "read-only",
      // Every loop decides its own autonomy.
      shownWhen: { field: "loopMode", in: ["single"] },
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
      help: "Approve the final result and ask for revisions. Nothing after it runs until then.",
    },
    {
      name: "sendBackTo",
      label: "Send back to",
      kind: "stage",
      default: "",
      shownWhen: AWAITING_APPROVAL,
      advanced: true,
      noneLabel: "No Send back button",
      help: "Adds a Send back button next to Approve, for work that belongs at an earlier stage.",
    },
    {
      name: "saveResultAs",
      label: "Save result as artifact",
      kind: "text",
      default: "",
      advanced: true,
      placeholder: "requirements.md",
      help: "Writes the accepted result here, preserving previous versions. Reviewed loops also save decisions.md. Plan and Build–verify keep every build and review even when this is blank.",
    },
    {
      name: "inactivityTimeoutSec",
      label: "Inactivity timeout (seconds)",
      kind: "number",
      default: 300,
      advanced: true,
      help: "Fails the run when the agent produces no output for this long.",
    },
    { name: "timeoutSec", label: "Total timeout (seconds)", kind: "number", default: undefined, placeholder: "No limit", advanced: true },
  ],

  async run({ config, run, task, artifactDir, env, log, signal, services }) {
    const policy = loopPolicy(config);
    const { autonomy } = policy;
    const { saveResultAs } = config;
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
      const sameAgent = run.outputs?.agent === agent;
      const { loop: _loop, sessionId: _sessionId, ...previousOutputs } = run.outputs ?? {};
      // A task override may have switched agents while this run was parked. Keep the previous
      // answer as context, but never relabel its session or saved loop as the new agent's work.
      throw new UsageLimitError(`${adapter.label}'s usage limit is still in effect`, heldUntil, {
        sessionId: sameAgent ? run.sessionId : null,
        outputs: { ...(sameAgent ? run.outputs : previousOutputs), agent, model, effort },
      });
    }
    const cli = services.agents.resolve(agent);
    const cwd = [task.worktreePath, task.repoPath, artifactDir].find((dir): dir is string => !!dir && existsSync(dir))!;
    // Creating the worktree treats "no repository" as nothing to do, so without this an autonomous
    // agent would quietly start editing the artifacts folder instead of the codebase.
    if (autonomy === "autonomous" && cwd === artifactDir) {
      throw new Error("This task has no repository, so there is nothing for an autonomous agent to work on. Set one in the task's Details.");
    }
    // The runner creates the worktree before this runs, so this only happens when the worktree was
    // removed underneath the run. The fallback is the repository's own checkout on whatever branch it
    // happens to have — which is not what a task whose Details say "Use a worktree" asked for. Editing
    // it is a refusal; merely reading it is harmless, but surprising enough to say out loud below.
    const strayFromWorktree = cwd === task.repoPath && task.useWorktree;
    if (autonomy === "autonomous" && strayFromWorktree) {
      throw new Error(
        `This task is set to use a worktree but hasn't got one, so an autonomous agent would edit the repository's own checkout at ${cwd}, ` +
          `on whatever branch it is currently on. Retry to create the worktree again, ` +
          `or turn off “Use a worktree” in the task's Details if editing the checkout directly is what you want.`,
      );
    }

    // Saved progress is this run's own, picked up after a usage limit; it belongs to the agent that made it.
    const saved = run.outputs?.agent === agent ? (run.outputs?.loop as SavedLoop | undefined) : undefined;
    const followUp = run.followUp?.trim() || null;
    const opening = openingTurn({
      prompt: config.prompt,
      continueSession: config.continueSession,
      followUp,
      run: { sessionId: run.sessionId, agent: run.outputs?.agent, result: run.outputs?.result },
      agent,
      previous: () => services.engine.previousAgentSession(task.id, run.bindingKey, run.id),
      label: (id) => services.agents.adapter(id).label,
    });
    if (saved) log(`Picking this run back up where it stopped, in ${adapter.label}`);
    else for (const note of opening.notes) logNote(log, note);

    const turns = cliTurns({
      adapter,
      cli,
      model,
      effort,
      policy,
      cwd,
      env,
      signal,
      inactivityTimeoutMs: config.inactivityTimeoutSec * 1000,
      timeoutMs: config.timeoutSec ? config.timeoutSec * 1000 : undefined,
      scratchPrefix: scratchPrefix(services.paths.runsDir(task.id), run.id),
      log,
      introduction: [
        `${adapter.label}${model ? ` · ${model}` : ""}${effort ? ` · ${effort}` : ""} · ${autonomy} · ${cwd}`,
        // Autonomous runs never reach here in this state; a read-only one only reads, so this is a
        // note rather than a failure — but the path above is the checkout the whole team works in,
        // and seeing why it is there beats wondering whether the worktree silently went missing.
        ...(strayFromWorktree
          ? ["That is the repository's own checkout: this task is set to use a worktree, but it is missing. Read-only, so nothing there is edited."]
          : []),
      ],
      runId: run.id,
      questions: services.questions,
    });
    try {
      const historyName = saveResultAs || `steps/${encodeURIComponent(run.bindingKey)}.md`;
      const history = artifactHistory(artifactDir, historyName);
      const input: LoopInput = {
        turns,
        opening,
        followUp,
        instructions: config.prompt,
        maxCorrections: config.maxCorrections,
        verificationInstructions: config.verificationInstructions,
        loopLabel: policy.label,
        ...(policy.review ? { decisionContext: () => [
          `Build and review history for ${historyName}:\n${history.context()}`,
          currentDocumentContext(artifactDir, historyName),
          "User decisions and revision requests across this task:\n" + services.engine.getTaskDetail(task.id).timeline
            .filter((event) => ["question.answered", "run.changes-requested", "feedback"].includes(event.type))
            .map((event) => event.message).join("\n"),
        ].join("\n\n") } : {}),
        ...(policy.review === "document" ? { history: {
          build: (text: string) => {
            const version = history.build(withoutPreamble(text));
            log({ kind: "notice", stream: "info", text: `Saved build B${version} in Artifacts` });
            services.engine.publish({ type: "task.changed", taskId: task.id });
            return version;
          },
          verify: (version, verification) => {
            history.verify(version, verification);
            log({ kind: "notice", stream: "info", text: `Saved review V${version}: ${verification.decision}` });
            services.engine.publish({ type: "task.changed", taskId: task.id });
          },
        } } : {}),
        answered: () => services.questions.answeredForRun(run.id),
        saved,
        notice: (text) => log({ kind: "notice", stream: "info", text }),
      };
      const result = policy.mode === "ci"
        ? await runCi(input, ciCommands(config, { cwd, env, signal, log }))
        : policy.review
          ? await runReview(input, policy.review === "document")
          : await runSingle(input);
      const outputs: Record<string, unknown> = {
        agent,
        model,
        effort,
        autonomy,
        sessionId: result.sessionId,
        result: result.text.slice(0, MAX_RESULT_IN_OUTPUTS),
        ...(result.saved ? { loop: result.saved } : {}),
        ...(result.review ? { review: result.review } : {}),
        ...(result.ci ? { ci: result.ci } : {}),
        loopMode: config.loopMode,
      };
      const details = { outputs, sessionId: result.sessionId, usage: turns.usage };
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
      if (policy.review && !result.decisions) throw new ActionError("The final review did not include a decision record", details);

      if (result.review || result.ci) {
        log({ kind: "notice", stream: "info", text: config.requireApproval ? "Final work ready for your approval" : "Loop completed" });
        log({ kind: "message", stream: "stdout", text: result.text });
      }

      let buildVersion = result.buildVersion;
      if (saveResultAs) {
        if (!result.text.trim()) throw new ActionError("The agent finished without a final message to save", details);
        const text = withoutPreamble(result.text);
        if (policy.review !== "document") buildVersion = history.build(text);
        history.publish(text);
        outputs.artifact = saveResultAs;
        log(`Saved the final message to ${saveResultAs}`);
      }
      if (result.decisions) {
        const source = [`Task: ${task.title}`, `Final step: ${run.label} (run ${run.id})`,
          ...(buildVersion ? [`Final build: ${history.reference("B", buildVersion)}`,
            ...(policy.review === "document" ? [`Final review: ${history.reference("V", buildVersion)}`] : [])]
            : ["Final build: the implementation and accepted summary in this run"]),
        ].join("\n\n");
        const decisions = renderDecisions(result.decisions, source);
        const decisionHistory = artifactHistory(artifactDir, "decisions.md");
        outputs.decisionsVersion = decisionHistory.build(decisions);
        decisionHistory.publish(decisions);
        outputs.decisionsArtifact = "decisions.md";
        log({ kind: "notice", stream: "info", text: "Saved decisions.md with the final choices and alternatives for your review" });
      }
      return { ...details, summary: usageSummary(turns.usage) };
    } finally {
      turns.close();
    }
  },
};

type Note = string | Omit<RunLogLine, "at">;

const logNote = (log: RunLog, note: Note) => (typeof note === "string" ? log(note) : log(note));

/**
 * How the author's first turn starts, when the run has no saved progress. Changes you asked for at
 * this run's own approval are the prompt, in the session it just used, so one run stays one
 * conversation; otherwise the run resumes this action's last session on the task.
 * Either way, a different agent can't resume another's session, so it gets the earlier result as context.
 */
export function openingTurn(options: {
  prompt: string;
  continueSession: boolean;
  followUp: string | null;
  /** What this run recorded when it last ran. */
  run: { sessionId: string | null; agent: unknown; result: unknown };
  agent: AgentId;
  previous(): { sessionId: string; agent: AgentId | null; result: string | null } | undefined;
  label(agent: AgentId): string;
}): { prompt: string; session: string | null; notes: Note[] } {
  const { followUp, run, agent, label } = options;
  if (followUp) {
    const answer: Note = { kind: "answer", stream: "info", text: followUp };
    if (run.sessionId && run.agent === agent) {
      return { prompt: followUp, session: run.sessionId, notes: [answer, `Carrying on in ${label(agent)} session ${run.sessionId} with your changes`] };
    }
    const previous = typeof run.result === "string" ? run.result : "";
    return {
      prompt: previous ? `Your previous answer was:\n\n${previous}\n\n---\n\n${followUp}` : followUp,
      session: null,
      notes: [answer, `Starting a fresh ${label(agent)} session with your changes`],
    };
  }
  if (options.continueSession) {
    const previous = options.previous();
    if (previous && previous.agent === agent) {
      return { prompt: options.prompt, session: previous.sessionId, notes: [`Resuming ${label(agent)} session ${previous.sessionId}`] };
    }
    if (previous?.result) {
      const by = previous.agent ? label(previous.agent) : "another agent";
      return {
        prompt: `A previous attempt at this step (by ${by}) ended with:\n\n${previous.result}\n\n---\n\n${options.prompt}`,
        session: null,
        notes: [`Agent changed; starting a fresh ${label(agent)} session with the previous result as context`],
      };
    }
  }
  return { prompt: options.prompt, session: null, notes: [] };
}

/** The CI loop's commands, run in the agent's working directory with the task's WM_* variables. */
function ciCommands(
  config: Config,
  context: { cwd: string; env: Record<string, string>; signal: AbortSignal; log: RunLog },
): CiCommands {
  const { cwd, signal, log } = context;
  const run = async (command: string) => {
    log(`$ ${command}`);
    const result = await runProcess({
      ...invocation(config.ciShell, command), cwd, signal,
      env: { ...process.env, ...context.env, GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: config.ciTimeoutSec * 1000,
      onLine: (text, stream) => log(stripAnsi(text), stream),
    });
    if (result.aborted) throw new Error("Cancelled");
    if (result.timedOut) throw new Error(`CI command timed out after ${config.ciTimeoutSec}s`);
    if (result.code === null) throw new Error("CI command ended without an exit code");
    return { ok: result.code === 0, output: `Exit code: ${result.code}\n${stripAnsi(result.output).slice(-30_000)}` };
  };
  return {
    check: () => run(config.ciCheckCommand),
    publish: async () => {
      if (!config.ciPublishCommand.trim()) return;
      const published = await run(config.ciPublishCommand);
      if (!published.ok) throw new Error(`CI publish command failed:\n${published.output}`);
    },
  };
}

/**
 * Agents asked for "only a Markdown document" still tend to open with a line of chat ("Here's the
 * plan."), which would then head the artifact. When the document starts with a heading a line or two
 * in, that lead-in is dropped; anything longer is kept, since it may be content.
 */
export function withoutPreamble(text: string): string {
  const heading = /^#{1,6}\s/m.exec(text);
  if (!heading || heading.index === 0) return text;
  const lead = text.slice(0, heading.index).trim();
  const lines = lead.split("\n").filter((line) => line.trim());
  // Lists, quotes, tables and code are content, not chat.
  if (lines.length > 2 || lead.length > 300 || /^\s*([-*+>|]|\d+\.|```)/m.test(lead)) return text;
  return text.slice(heading.index);
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
