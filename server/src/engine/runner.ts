import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import type { RunLogLine } from "@wm/shared";
import { z } from "zod";
import { ensureWorktree, lacksWorktree } from "../actions/ensure-worktree";
import type { ActionRegistry } from "../actions/registry";
import { ActionError, type ActionServices, type RunLog, UsageLimitError } from "../actions/types";
import type { RunRow } from "../db/schema";
import { type Paths, purgeTranscripts } from "../paths";
import type { Engine, RunScope } from "./engine";
import { renderDeep, renderString } from "./template";

export interface RunnerDeps {
  engine: Engine;
  registry: ActionRegistry;
  paths: Paths;
  services: ActionServices;
}

/** Executes queued action runs and reports results back to the engine. */
export class Runner {
  private readonly controllers = new Map<number, AbortController>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly unsubscribe: () => void;
  private scheduled = false;
  private stopped = false;
  private quotaTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: RunnerDeps) {
    this.unsubscribe = deps.engine.on((event) => {
      if (event.type === "runs.queued") this.schedule();
      else if (event.type === "run.cancelled") this.controllers.get(event.runId)?.abort();
    });
  }

  start(): void {
    const interrupted = this.deps.engine.markInterruptedRuns();
    if (interrupted) console.warn(`Marked ${interrupted} run(s) interrupted by the previous shutdown`);
    this.schedule();
  }

  /** Aborts in-flight runs without recording a result; they are marked interrupted on next start. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.quotaTimer);
    this.unsubscribe();
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.inflight]);
  }

  /** Resolves once nothing is scheduled or executing (runs blocked on the concurrency cap don't count). */
  async idle(): Promise<void> {
    for (;;) {
      await new Promise((resolve) => setImmediate(resolve));
      if (this.scheduled) continue;
      if (this.inflight.size === 0) return;
      await Promise.allSettled([...this.inflight]);
    }
  }

  private schedule(): void {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    if (this.stopped) return;
    this.deps.engine.requeueDueQuotaRuns();
    for (const run of this.deps.engine.claimRuns()) {
      const execution: Promise<void> = this.execute(run)
        .catch((err: unknown) => console.error(`Run ${run.id} crashed:`, err))
        .finally(() => {
          this.inflight.delete(execution);
          this.schedule();
        });
      this.inflight.add(execution);
    }
    this.armQuotaTimer();
  }

  /** Wakes the pump when the earliest usage limit resets. */
  private armQuotaTimer(): void {
    clearTimeout(this.quotaTimer);
    const next = this.deps.engine.nextQuotaResumeAt();
    if (next === null) return;
    // setTimeout overflows past ~24.8 days; a longer wait simply re-arms when this fires.
    const delay = Math.min(Math.max(next - Date.now(), 0) + 50, 2_147_483_647);
    this.quotaTimer = setTimeout(() => this.schedule(), delay);
    this.quotaTimer.unref?.();
  }

  private async execute(run: RunRow): Promise<void> {
    const { engine, registry, paths, services } = this.deps;
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    const logger = new RunLogger(paths.runLog(run.taskId, run.id), (line) =>
      engine.publish({ type: "run.log", taskId: run.taskId, runId: run.id, line }),
    );
    // References that rendered empty, gathered across the config and anything the action renders itself.
    const misses = new Set<string>();

    try {
      const definition = registry.get(run.actionType);
      if (!definition) throw new Error(`Action type "${run.actionType}" is not available`);
      // Before the scope is built, so templates and WM_* variables see the worktree.
      if (definition.worksInWorktree?.(run.config) && lacksWorktree(engine.getTask(run.taskId))) {
        await ensureWorktree({ task: engine.getTask(run.taskId), services, signal: controller.signal, log: logger.log });
        if (controller.signal.aborted) return;
      }
      const scope = engine.buildScope(run);
      const onMiss = (expression: string) => misses.add(expression);
      const rawConfig = { ...run.config, ...(run.overrides ?? {}) };
      // Includes old snapshots and retry overrides.
      if (definition.validateBeforeRender) definition.configSchema.parse(rawConfig);
      const parsed = definition.configSchema.safeParse(renderDeep(rawConfig, scope, onMiss));
      if (!parsed.success) throw new Error(`Invalid configuration: ${z.prettifyError(parsed.error)}`);

      const artifactDir = paths.artifactDir(run.taskId);
      mkdirSync(artifactDir, { recursive: true });
      mkdirSync(paths.runsDir(run.taskId), { recursive: true });
      const result = await definition.run({
        config: parsed.data,
        run,
        task: engine.getTask(run.taskId),
        artifactDir,
        env: taskEnv(scope, paths, run),
        log: logger.log,
        signal: controller.signal,
        services,
        render: (template) => renderString(template, scope, onMiss),
      });
      if (controller.signal.aborted) return;
      engine.finishRun(run.id, { ok: true, ...(result ?? {}) });
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      logger.log(message, "stderr");
      engine.finishRun(run.id, {
        ok: false,
        error: message,
        ...(err instanceof ActionError ? err.details : {}),
        ...(err instanceof UsageLimitError ? { resumeAt: err.resetAt } : {}),
      });
    } finally {
      this.controllers.delete(run.id);
      if (misses.size && !controller.signal.aborted) reportMisses(engine, run, misses);
      await logger.close();
      if (engine.findTask(run.taskId)?.status === "archived") await purgeTranscripts(paths, run.taskId);
    }
  }
}

/**
 * One entry per run: the empty string still renders, but a prompt with a blank section shouldn't
 * pass unnoticed.
 */
function reportMisses(engine: Engine, run: RunRow, misses: Set<string>): void {
  const refs = [...misses].map((expression) => `{{${expression}}}`).join(", ");
  const [is, part] = misses.size === 1 ? ["is", "that part"] : ["are", "those parts"];
  engine.timeline(
    run.taskId,
    run.visitId,
    run.id,
    "template.unresolved",
    `${run.label}: ${refs} ${is} missing; ${part} rendered empty`,
    { refs: [...misses] },
  );
}

function taskEnv(scope: RunScope, paths: Paths, run: RunRow): Record<string, string> {
  const { task } = scope;
  return {
    WM_TASK_ID: task.id,
    WM_TASK_TITLE: task.title,
    WM_TASK_DESCRIPTION: task.description,
    WM_REPO: task.repoPath ?? "",
    WM_BASE_BRANCH: task.baseBranch ?? "",
    WM_BRANCH: task.branch ?? "",
    WM_WORKTREE: task.worktreePath ?? "",
    WM_LAST_FEEDBACK: task.lastFeedback ?? "",
    WM_ARTIFACT_DIR: paths.artifactDir(task.id),
    WM_OUTPUT_FILE: paths.runOutputFile(task.id, run.id),
    WM_RUN_ID: String(run.id),
    WM_STAGE: scope.stage.name,
    WM_ATTEMPT: String(scope.visit.attempt),
  };
}

/** Appends a run's transcript as JSON lines and forwards each line to live listeners. */
class RunLogger {
  private stream: WriteStream | undefined;

  constructor(
    private readonly file: string,
    private readonly onLine: (line: RunLogLine) => void,
  ) {}

  readonly log = ((entry: string | Omit<RunLogLine, "at">, stream: RunLogLine["stream"] = "info"): void => {
    const line: RunLogLine = { at: Date.now(), ...(typeof entry === "string" ? { stream, text: entry } : entry) };
    if (!this.stream) {
      mkdirSync(dirname(this.file), { recursive: true });
      this.stream = createWriteStream(this.file, { flags: "a" }).on("error", () => {});
    }
    this.stream.write(`${JSON.stringify(line)}\n`);
    this.onLine(line);
  }) as RunLog;

  close(): Promise<void> {
    return new Promise((resolve) => (this.stream ? this.stream.end(() => resolve()) : resolve()));
  }
}
