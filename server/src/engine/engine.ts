import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import {
  ACTIVE_RUN_STATUSES,
  AGENT_IDS,
  type AgentId,
  CHAIN_TRIGGERS,
  type CreateTaskInput,
  createTaskSchema,
  PHASE_TRIGGERS,
  type PhaseStatus,
  RETRYABLE_RUN_STATUSES,
  type RunStatus,
  type ServerEvent,
  type TaskBadge,
  type TaskDetail,
  type TaskStatus,
  type TaskSummary,
  type Trigger,
  type UpdateTaskInput,
  updateTaskSchema,
  type WorkflowDef,
  type WorkflowUsage,
} from "@wm/shared";
import { and, asc, count, desc, eq, gt, inArray, isNotNull, lt, ne, type SQL, sql } from "drizzle-orm";
import type { Db, Sqlite } from "../db/client";
import * as s from "../db/schema";
import type { BindingRow, PhaseStateRow, RunRow, TaskRow, VisitRow } from "../db/schema";
import { type Paths, resolveInside } from "../paths";
import type { Scope } from "./template";

export class EngineError extends Error {
  override name = "EngineError";
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

export type InternalEvent =
  | ServerEvent
  | { type: "runs.queued" }
  | { type: "run.cancelled"; taskId: string; runId: number };

export interface EngineOptions {
  paths: Paths;
  isLongRunning: (actionType: string) => boolean;
  maxConcurrentLongRuns: number;
}

export type RunResult =
  | {
      ok: true;
      outputs?: Record<string, unknown>;
      summary?: string;
      sessionId?: string | null;
      usage?: Record<string, unknown> | null;
    }
  | {
      ok: false;
      error: string;
      outputs?: Record<string, unknown>;
      sessionId?: string | null;
      usage?: Record<string, unknown> | null;
    };

export interface RunScope extends Scope {
  task: Omit<TaskRow, "links"> & { links: Record<string, string> };
  stage: { id: string; name: string };
  phase: { id: string | null; name: string } | null;
  visit: { id: string; attempt: number };
  run: { id: number; key: string; label: string };
  artifacts: Record<string, string | undefined>;
  artifactPath: Record<string, string>;
  outputs: Record<string, Record<string, unknown> | undefined>;
}

interface TriggerMatch {
  stageId?: string;
  phaseId?: string | null;
  afterBindingId?: string | null;
}

/**
 * Owns all workflow state transitions. Every public mutation runs in a single SQLite
 * transaction; events are emitted only after commit. Action execution lives in Runner.
 */
export class Engine {
  private readonly emitter = new EventEmitter();
  private pending: InternalEvent[] = [];
  private inTx = false;

  constructor(
    private readonly db: Db,
    private readonly sqlite: Sqlite,
    private readonly options: EngineOptions,
  ) {
    this.emitter.setMaxListeners(0);
  }

  on(listener: (event: InternalEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  publish(event: InternalEvent): void {
    if (this.inTx) this.pending.push(event);
    else this.emitter.emit("event", event);
  }

  private tx<T>(fn: () => T): T {
    if (this.inTx) return fn();
    this.inTx = true;
    let result: T;
    try {
      result = this.sqlite.transaction(fn)();
    } catch (err) {
      this.pending = [];
      this.inTx = false;
      throw err;
    }
    this.inTx = false;
    const events = dedupe(this.pending);
    this.pending = [];
    for (const event of events) this.emitter.emit("event", event);
    return result;
  }

  // ---------------------------------------------------------------- workflows

  listWorkflows(): WorkflowDef[] {
    return this.db
      .select({ id: s.workflows.id })
      .from(s.workflows)
      .orderBy(asc(s.workflows.createdAt))
      .all()
      .map((workflow) => this.getWorkflow(workflow.id));
  }

  getWorkflow(id: string): WorkflowDef {
    const workflow = this.db.select().from(s.workflows).where(eq(s.workflows.id, id)).get();
    if (!workflow) throw new EngineError(`Workflow ${id} not found`, 404);
    const stageRows = this.db
      .select()
      .from(s.stages)
      .where(eq(s.stages.workflowId, id))
      .orderBy(asc(s.stages.position))
      .all();
    const phaseRows = stageRows.length
      ? this.db
          .select()
          .from(s.phases)
          .where(
            inArray(
              s.phases.stageId,
              stageRows.map((stage) => stage.id),
            ),
          )
          .orderBy(asc(s.phases.position))
          .all()
      : [];
    const bindingRows = this.db
      .select()
      .from(s.actionBindings)
      .where(eq(s.actionBindings.workflowId, id))
      .orderBy(asc(s.actionBindings.position))
      .all();

    return {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      updatedAt: workflow.updatedAt,
      stages: stageRows.map((stage) => ({
        id: stage.id,
        name: stage.name,
        position: stage.position,
        wipLimit: stage.wipLimit,
        phases: phaseRows
          .filter((phase) => phase.stageId === stage.id)
          .map(({ id: phaseId, name, position, completion }) => ({ id: phaseId, name, position, completion })),
        bindings: bindingRows
          .filter((binding) => binding.stageId === stage.id)
          .map(({ workflowId: _workflowId, ...binding }) => binding),
      })),
    };
  }

  /** What still depends on a template: blocks deleting it, and deleting the stages tasks sit in. */
  workflowUsage(workflowId: string): WorkflowUsage {
    const rows = this.db
      .select({ status: s.tasks.status, stageId: s.tasks.currentStageId, n: count() })
      .from(s.tasks)
      .where(eq(s.tasks.workflowId, workflowId))
      .groupBy(s.tasks.status, s.tasks.currentStageId)
      .all();

    const usage: WorkflowUsage = { activeTasks: 0, archivedTasks: 0, activeByStage: {} };
    for (const row of rows) {
      if (row.status === "active") {
        usage.activeTasks += row.n;
        if (row.stageId) usage.activeByStage[row.stageId] = (usage.activeByStage[row.stageId] ?? 0) + row.n;
      } else {
        usage.archivedTasks += row.n;
      }
    }
    return usage;
  }

  // ---------------------------------------------------------------- task queries

  findTask(id: string): TaskRow | undefined {
    return this.db.select().from(s.tasks).where(eq(s.tasks.id, id)).get();
  }

  getTask(id: string): TaskRow {
    const task = this.findTask(id);
    if (!task) throw new EngineError(`Task ${id} not found`, 404);
    return task;
  }

  private getActiveTask(id: string): TaskRow {
    const task = this.getTask(id);
    if (task.status !== "active") throw new EngineError("Task is archived", 409);
    return task;
  }

  listTasks(filter: { workflowId?: string; status?: TaskStatus } = {}): TaskSummary[] {
    const conditions: SQL[] = [];
    if (filter.workflowId) conditions.push(eq(s.tasks.workflowId, filter.workflowId));
    if (filter.status) conditions.push(eq(s.tasks.status, filter.status));
    return this.db
      .select()
      .from(s.tasks)
      .where(and(...conditions))
      .orderBy(desc(s.tasks.updatedAt))
      .all()
      .map((task) => this.summarize(task));
  }

  getTaskDetail(id: string): TaskDetail {
    const task = this.getTask(id);
    const visits = this.db
      .select()
      .from(s.stageVisits)
      .where(eq(s.stageVisits.taskId, id))
      .orderBy(asc(s.stageVisits.enteredAt), sql`rowid`)
      .all();
    const phaseStates = visits.length
      ? this.db
          .select()
          .from(s.phaseStates)
          .where(
            inArray(
              s.phaseStates.visitId,
              visits.map((visit) => visit.id),
            ),
          )
          .orderBy(asc(s.phaseStates.position))
          .all()
      : [];
    const runs = this.db.select().from(s.actionRuns).where(eq(s.actionRuns.taskId, id)).orderBy(asc(s.actionRuns.id)).all();
    const timeline = this.db
      .select()
      .from(s.timelineEvents)
      .where(eq(s.timelineEvents.taskId, id))
      .orderBy(asc(s.timelineEvents.id))
      .all();

    return {
      task: this.summarize(task),
      visits: visits.map((visit) => ({
        ...visit,
        phases: phaseStates.filter((phase) => phase.visitId === visit.id),
        runs: runs.filter((run) => run.visitId === visit.id),
      })),
      timeline,
    };
  }

  getRun(id: number): RunRow {
    const run = this.db.select().from(s.actionRuns).where(eq(s.actionRuns.id, id)).get();
    if (!run) throw new EngineError(`Run ${id} not found`, 404);
    return run;
  }

  latestOutputs(taskId: string, bindingKey: string): Record<string, unknown> | undefined {
    const row = this.db
      .select({ outputs: s.actionRuns.outputs })
      .from(s.actionRuns)
      .where(
        and(
          eq(s.actionRuns.taskId, taskId),
          eq(s.actionRuns.bindingKey, bindingKey),
          eq(s.actionRuns.status, "succeeded"),
        ),
      )
      .orderBy(desc(s.actionRuns.id))
      .limit(1)
      .get();
    return row?.outputs ?? undefined;
  }

  /** The most recent earlier run of this action on the task that recorded an agent session. */
  previousAgentSession(
    taskId: string,
    bindingKey: string,
    beforeRunId: number,
  ): { sessionId: string; agent: AgentId | null; result: string | null } | undefined {
    const row = this.db
      .select({ sessionId: s.actionRuns.sessionId, outputs: s.actionRuns.outputs })
      .from(s.actionRuns)
      .where(
        and(
          eq(s.actionRuns.taskId, taskId),
          eq(s.actionRuns.bindingKey, bindingKey),
          lt(s.actionRuns.id, beforeRunId),
          isNotNull(s.actionRuns.sessionId),
        ),
      )
      .orderBy(desc(s.actionRuns.id))
      .limit(1)
      .get();
    if (!row?.sessionId) return undefined;
    const agent = row.outputs?.agent;
    const result = row.outputs?.result;
    return {
      sessionId: row.sessionId,
      agent: AGENT_IDS.includes(agent as AgentId) ? (agent as AgentId) : null,
      result: typeof result === "string" && result ? result : null,
    };
  }

  nextStageId(taskId: string, fromStageId?: string): string | null {
    const task = this.getTask(taskId);
    const current = fromStageId ?? task.currentStageId;
    const stageRows = this.db
      .select({ id: s.stages.id })
      .from(s.stages)
      .where(eq(s.stages.workflowId, task.workflowId))
      .orderBy(asc(s.stages.position))
      .all();
    const index = stageRows.findIndex((stage) => stage.id === current);
    return index >= 0 ? (stageRows[index + 1]?.id ?? null) : null;
  }

  /** Template scope for rendering a run's config. Artifacts and outputs resolve lazily. */
  buildScope(run: RunRow): RunScope {
    const task = this.getTask(run.taskId);
    const visit = this.getVisit(run.visitId);
    const phase = run.phaseStateId ? this.findPhaseState(run.phaseStateId) : undefined;
    const artifactDir = this.options.paths.artifactDir(task.id);
    const links: Record<string, string> = {};
    for (const link of task.links) links[link.type] ??= link.value;

    return {
      task: { ...task, links },
      stage: { id: visit.stageId, name: visit.stageName },
      phase: phase ? { id: phase.phaseId, name: phase.name } : null,
      visit: { id: visit.id, attempt: visit.attempt },
      run: { id: run.id, key: run.bindingKey, label: run.label },
      artifacts: lazyRecord((name) => {
        const file = resolveInside(artifactDir, name);
        return existsSync(file) ? readFileSync(file, "utf8") : undefined;
      }),
      artifactPath: lazyRecord((name) => resolveInside(artifactDir, name)),
      outputs: lazyRecord((key) => this.latestOutputs(task.id, key)),
    };
  }

  // ---------------------------------------------------------------- task mutations

  createTask(raw: CreateTaskInput): TaskRow {
    const input = createTaskSchema.parse(raw);
    return this.tx(() => {
      const workflow = this.getWorkflow(input.workflowId);
      const stage = input.stageId ? workflow.stages.find((st) => st.id === input.stageId) : workflow.stages[0];
      if (!stage) {
        throw new EngineError(input.stageId ? "Stage does not belong to this workflow" : "Workflow has no stages");
      }
      const now = Date.now();
      const task = this.db
        .insert(s.tasks)
        .values({
          id: randomUUID(),
          workflowId: workflow.id,
          title: input.title,
          description: input.description,
          repoPath: input.repoPath ?? null,
          baseBranch: input.baseBranch ?? null,
          links: input.links,
          tags: input.tags,
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      this.timeline(task.id, null, null, "task.created", `Created in ${workflow.name}`);
      this.enterStage(task.id, stage.id, { runActions: true });
      return this.getTask(task.id);
    });
  }

  updateTask(id: string, raw: UpdateTaskInput): TaskRow {
    const patch = updateTaskSchema.parse(raw);
    return this.tx(() => {
      this.getActiveTask(id);
      this.db
        .update(s.tasks)
        .set({ ...patch, updatedAt: Date.now() })
        .where(eq(s.tasks.id, id))
        .run();
      this.publish({ type: "task.changed", taskId: id });
      return this.getTask(id);
    });
  }

  /** Used by ensure-worktree to record where the task's code lives. */
  setTaskGitInfo(id: string, info: { branch: string; baseBranch: string; worktreePath: string }): void {
    this.tx(() => {
      this.getActiveTask(id);
      this.db
        .update(s.tasks)
        .set({ ...info, updatedAt: Date.now() })
        .where(eq(s.tasks.id, id))
        .run();
      this.publish({ type: "task.changed", taskId: id });
    });
  }

  moveTask(
    taskId: string,
    stageId: string,
    options: { runActions?: boolean; initiatedByRunId?: number } = {},
  ): { stageId: string; stageName: string } {
    return this.tx(() => {
      const task = this.getActiveTask(taskId);
      const stage = this.db.select().from(s.stages).where(eq(s.stages.id, stageId)).get();
      if (!stage || stage.workflowId !== task.workflowId) {
        throw new EngineError("Stage does not belong to this task's workflow");
      }
      const runActions = options.runActions ?? true;
      this.exitCurrentVisit(task, { runActions, exceptRunId: options.initiatedByRunId });
      this.enterStage(task.id, stage.id, { runActions });
      return { stageId: stage.id, stageName: stage.name };
    });
  }

  /** Manual completion ("tick" or "Mark done anyway"). Cancels anything still running in the phase. */
  completePhase(taskId: string, phaseStateId: string): void {
    this.tx(() => {
      const task = this.getActiveTask(taskId);
      const phase = this.findPhaseState(phaseStateId);
      if (!phase || phase.visitId !== task.currentVisitId) {
        throw new EngineError("Phase is not part of the task's current stage", 404);
      }
      if (phase.status !== "running" && phase.status !== "failed") {
        throw new EngineError(`Phase is ${phase.status}, not in progress`, 409);
      }
      this.completePhaseInternal(phase, "manual");
    });
  }

  /** Completes a stage whose phases are all done, or that has no phases (e.g. Backlog). */
  completeStage(taskId: string): void {
    this.tx(() => {
      const task = this.getActiveTask(taskId);
      if (!task.currentVisitId) throw new EngineError("Task is not in a stage", 409);
      const visit = this.getVisit(task.currentVisitId);
      if (visit.completedAt) throw new EngineError("Stage is already complete", 409);
      if (this.phaseStatesOf(visit.id).some((phase) => phase.status !== "done")) {
        throw new EngineError("Complete all phases first", 409);
      }
      this.completeStageInternal(visit);
    });
  }

  triggerManual(taskId: string, bindingId: string, options: { feedback?: string } = {}): RunRow {
    return this.tx(() => {
      const task = this.getActiveTask(taskId);
      const binding = this.db.select().from(s.actionBindings).where(eq(s.actionBindings.id, bindingId)).get();
      if (!binding) throw new EngineError(`Action ${bindingId} not found`, 404);
      if (binding.trigger !== "manual") throw new EngineError("Action is not manually triggered");
      if (binding.stageId !== task.currentStageId || !task.currentVisitId) {
        throw new EngineError("Action belongs to a different stage", 409);
      }
      if (!binding.enabled) throw new EngineError("Action is disabled", 409);

      if (options.feedback !== undefined) {
        this.db
          .update(s.tasks)
          .set({ lastFeedback: options.feedback, updatedAt: Date.now() })
          .where(eq(s.tasks.id, task.id))
          .run();
        this.timeline(task.id, task.currentVisitId, null, "feedback", options.feedback);
      }

      let phaseStateId: string | null = null;
      if (binding.phaseId) {
        const phase = this.db
          .select()
          .from(s.phaseStates)
          .where(
            and(
              eq(s.phaseStates.visitId, task.currentVisitId),
              eq(s.phaseStates.phaseId, binding.phaseId),
              inArray(s.phaseStates.status, ["running", "failed"]),
            ),
          )
          .get();
        phaseStateId = phase?.id ?? null;
      }

      const [run] = this.createBatch(task.id, task.currentVisitId, [binding], "manual", phaseStateId, null);
      if (phaseStateId) this.evaluatePhase(phaseStateId);
      this.publish({ type: "task.changed", taskId: task.id });
      return run!;
    });
  }

  retryRun(runId: number, overrides?: Record<string, unknown>): RunRow {
    return this.tx(() => {
      const run = this.getRun(runId);
      if (!RETRYABLE_RUN_STATUSES.includes(run.status)) {
        throw new EngineError(`Cannot retry a ${run.status} run`, 409);
      }
      const task = this.getActiveTask(run.taskId);
      if (run.visitId !== task.currentVisitId) throw new EngineError("Task has moved on since this run", 409);
      const latest = this.latestInSlot(run.batchId, run.batchPosition);
      if (latest && latest.id !== run.id) throw new EngineError("A newer attempt of this action exists", 409);

      const retry = this.insertRunCopy(run, overrides ? { ...(run.overrides ?? {}), ...overrides } : run.overrides);
      this.timeline(task.id, run.visitId, retry.id, "run.retried", `Retrying ${run.label}`);
      if (run.phaseStateId) this.evaluatePhase(run.phaseStateId);
      this.publish({ type: "task.changed", taskId: task.id });
      return retry;
    });
  }

  cancelRun(runId: number): void {
    this.tx(() => {
      const run = this.getRun(runId);
      if (!ACTIVE_RUN_STATUSES.includes(run.status)) throw new EngineError(`Run is already ${run.status}`, 409);
      this.cancelRunRow(run, "Cancelled by user");
      this.skipRestOfBatch(run);
      if (run.phaseStateId) this.evaluatePhase(run.phaseStateId);
      this.publish({ type: "task.changed", taskId: run.taskId });
    });
  }

  cancelActiveRuns(taskId: string, exceptRunId?: number): void {
    this.tx(() => this.cancelActiveRunsInternal(taskId, exceptRunId, "Task archived"));
  }

  markArchived(taskId: string, options: { initiatedByRunId?: number; worktreeRemoved: boolean }): void {
    this.tx(() => {
      const task = this.getActiveTask(taskId);
      this.cancelActiveRunsInternal(task.id, options.initiatedByRunId, "Task archived");
      const now = Date.now();
      this.db
        .update(s.tasks)
        .set({
          status: "archived",
          archivedAt: now,
          updatedAt: now,
          worktreePath: options.worktreeRemoved ? null : task.worktreePath,
        })
        .where(eq(s.tasks.id, task.id))
        .run();
      if (task.currentVisitId) {
        this.db
          .update(s.stageVisits)
          .set({ exitedAt: now })
          .where(and(eq(s.stageVisits.id, task.currentVisitId), sql`${s.stageVisits.exitedAt} IS NULL`))
          .run();
      }
      this.timeline(
        task.id,
        task.currentVisitId,
        null,
        "task.archived",
        options.worktreeRemoved ? "Archived (worktree removed, branch kept)" : "Archived",
      );
      this.publish({ type: "task.changed", taskId: task.id });
    });
  }

  // ---------------------------------------------------------------- runner interface

  /** Moves queued runs to running, respecting the long-running concurrency cap. */
  claimRuns(): RunRow[] {
    return this.tx(() => {
      const queued = this.db
        .select()
        .from(s.actionRuns)
        .where(eq(s.actionRuns.status, "queued"))
        .orderBy(asc(s.actionRuns.id))
        .all();
      if (queued.length === 0) return [];

      let longRunning = this.db
        .select({ actionType: s.actionRuns.actionType })
        .from(s.actionRuns)
        .where(eq(s.actionRuns.status, "running"))
        .all()
        .filter((run) => this.options.isLongRunning(run.actionType)).length;

      const claimed: RunRow[] = [];
      for (const run of queued) {
        const isLong = this.options.isLongRunning(run.actionType);
        if (isLong && longRunning >= this.options.maxConcurrentLongRuns) continue;
        if (isLong) longRunning++;
        const updated = this.db
          .update(s.actionRuns)
          .set({ status: "running", startedAt: Date.now() })
          .where(eq(s.actionRuns.id, run.id))
          .returning()
          .get();
        this.timeline(run.taskId, run.visitId, run.id, "run.started", `${run.label} started`);
        this.publish({ type: "run.changed", taskId: run.taskId, runId: run.id });
        this.publish({ type: "task.changed", taskId: run.taskId });
        claimed.push(updated);
      }
      return claimed;
    });
  }

  finishRun(runId: number, result: RunResult): void {
    this.tx(() => {
      const run = this.db.select().from(s.actionRuns).where(eq(s.actionRuns.id, runId)).get();
      if (!run || run.status !== "running") return; // cancelled or finished meanwhile
      const now = Date.now();

      if (result.ok) {
        this.db
          .update(s.actionRuns)
          .set({
            status: "succeeded",
            endedAt: now,
            outputs: result.outputs ?? {},
            sessionId: result.sessionId ?? null,
            usage: result.usage ?? null,
          })
          .where(eq(s.actionRuns.id, run.id))
          .run();
        const suffix = result.summary ? `: ${result.summary}` : "";
        this.timeline(run.taskId, run.visitId, run.id, "run.succeeded", `${run.label} succeeded${suffix}`);
        this.fireChain(run, "action.succeeded");
        this.advanceBatch(run);
      } else {
        this.db
          .update(s.actionRuns)
          .set({
            status: "failed",
            endedAt: now,
            error: result.error,
            outputs: result.outputs ?? null,
            sessionId: result.sessionId ?? null,
            usage: result.usage ?? null,
          })
          .where(eq(s.actionRuns.id, run.id))
          .run();
        this.timeline(run.taskId, run.visitId, run.id, "run.failed", `${run.label} failed: ${result.error}`);
        this.fireChain(run, "action.failed");
        this.skipRestOfBatch(run);
      }

      if (run.phaseStateId) this.evaluatePhase(run.phaseStateId);
      this.publish({ type: "run.changed", taskId: run.taskId, runId: run.id });
      this.publish({ type: "task.changed", taskId: run.taskId });
    });
  }

  /** On startup: anything still "running" belonged to a previous server process. */
  markInterruptedRuns(): number {
    return this.tx(() => {
      const running = this.db.select().from(s.actionRuns).where(eq(s.actionRuns.status, "running")).all();
      for (const run of running) {
        this.db
          .update(s.actionRuns)
          .set({ status: "interrupted", endedAt: Date.now(), error: "Server stopped while this action was running" })
          .where(eq(s.actionRuns.id, run.id))
          .run();
        this.timeline(run.taskId, run.visitId, run.id, "run.interrupted", `${run.label} was interrupted`);
        this.skipRestOfBatch(run);
        if (run.phaseStateId) this.evaluatePhase(run.phaseStateId);
        this.publish({ type: "run.changed", taskId: run.taskId, runId: run.id });
        this.publish({ type: "task.changed", taskId: run.taskId });
      }
      if (running.length) this.publish({ type: "runs.queued" });
      return running.length;
    });
  }

  // ---------------------------------------------------------------- internals: stages & phases

  private enterStage(taskId: string, stageId: string, options: { runActions: boolean }): void {
    const stage = this.db.select().from(s.stages).where(eq(s.stages.id, stageId)).get();
    if (!stage) throw new EngineError(`Stage ${stageId} not found`, 404);
    const previousVisits = this.db
      .select({ id: s.stageVisits.id })
      .from(s.stageVisits)
      .where(and(eq(s.stageVisits.taskId, taskId), eq(s.stageVisits.stageId, stageId)))
      .all().length;
    const now = Date.now();
    const visit = this.db
      .insert(s.stageVisits)
      .values({
        id: randomUUID(),
        taskId,
        stageId,
        stageName: stage.name,
        attempt: previousVisits + 1,
        enteredAt: now,
      })
      .returning()
      .get();

    const phaseDefs = this.db
      .select()
      .from(s.phases)
      .where(eq(s.phases.stageId, stageId))
      .orderBy(asc(s.phases.position))
      .all();
    const phaseStates = phaseDefs.map((phase) =>
      this.db
        .insert(s.phaseStates)
        .values({
          id: randomUUID(),
          visitId: visit.id,
          phaseId: phase.id,
          name: phase.name,
          position: phase.position,
          completion: phase.completion,
          status: "pending",
        })
        .returning()
        .get(),
    );

    this.db
      .update(s.tasks)
      .set({ currentStageId: stageId, currentVisitId: visit.id, updatedAt: now })
      .where(eq(s.tasks.id, taskId))
      .run();
    const attemptSuffix = visit.attempt > 1 ? ` (attempt ${visit.attempt})` : "";
    this.timeline(taskId, visit.id, null, "stage.entered", `Entered ${stage.name}${attemptSuffix}`);
    this.publish({ type: "task.changed", taskId });

    if (options.runActions) this.fire(taskId, visit.id, "stage.entered", { stageId }, null, null);
    const first = phaseStates[0];
    if (first) this.startPhase(first, options.runActions);
  }

  private exitCurrentVisit(task: TaskRow, options: { runActions: boolean; exceptRunId?: number }): void {
    if (!task.currentVisitId) return;
    const visit = this.getVisit(task.currentVisitId);
    const conditions = [
      eq(s.actionRuns.visitId, visit.id),
      inArray(s.actionRuns.status, [...ACTIVE_RUN_STATUSES]),
    ];
    if (options.exceptRunId !== undefined) conditions.push(ne(s.actionRuns.id, options.exceptRunId));
    for (const run of this.db.select().from(s.actionRuns).where(and(...conditions)).all()) {
      this.cancelRunRow(run, "Task left the stage");
    }
    this.db.update(s.stageVisits).set({ exitedAt: Date.now() }).where(eq(s.stageVisits.id, visit.id)).run();
    this.timeline(task.id, visit.id, null, "stage.exited", `Left ${visit.stageName}`);
    if (options.runActions) this.fire(task.id, visit.id, "stage.exited", { stageId: visit.stageId }, null, null);
  }

  private startPhase(phase: PhaseStateRow, runActions: boolean): void {
    const visit = this.getVisit(phase.visitId);
    this.db
      .update(s.phaseStates)
      .set({ status: "running", startedAt: Date.now() })
      .where(eq(s.phaseStates.id, phase.id))
      .run();
    this.timeline(visit.taskId, visit.id, null, "phase.started", `Started ${phase.name}`);
    this.publish({ type: "task.changed", taskId: visit.taskId });
    if (runActions && phase.phaseId) {
      this.fire(visit.taskId, visit.id, "phase.started", { stageId: visit.stageId, phaseId: phase.phaseId }, phase.id, null);
    }
  }

  /**
   * Recomputes a phase from the latest attempt of each run tagged to it:
   * anything active → running; any non-success → failed; all succeeded → complete (auto mode).
   * A phase with no runs waits for the user.
   */
  private evaluatePhase(phaseStateId: string): void {
    const phase = this.findPhaseState(phaseStateId);
    if (!phase || phase.status === "done" || phase.status === "pending") return;
    const visit = this.getVisit(phase.visitId);
    const task = this.getTask(visit.taskId);
    if (task.status !== "active" || task.currentVisitId !== visit.id) return;

    const latest = latestAttempts(
      this.db.select().from(s.actionRuns).where(eq(s.actionRuns.phaseStateId, phase.id)).all(),
    );
    let status: PhaseStatus = "running";
    if (latest.length > 0 && !latest.some((run) => isActive(run.status))) {
      if (latest.some((run) => run.status !== "succeeded")) {
        status = "failed";
      } else if (phase.completion === "auto") {
        this.completePhaseInternal(phase, "auto");
        return;
      }
    }
    if (status === phase.status) return;
    this.db.update(s.phaseStates).set({ status }).where(eq(s.phaseStates.id, phase.id)).run();
    if (status === "failed") this.timeline(task.id, visit.id, null, "phase.failed", `${phase.name} failed`);
    this.publish({ type: "task.changed", taskId: task.id });
  }

  private completePhaseInternal(phase: PhaseStateRow, by: "auto" | "manual"): void {
    const visit = this.getVisit(phase.visitId);
    const active = this.db
      .select()
      .from(s.actionRuns)
      .where(and(eq(s.actionRuns.phaseStateId, phase.id), inArray(s.actionRuns.status, [...ACTIVE_RUN_STATUSES])))
      .all();
    for (const run of active) this.cancelRunRow(run, "Phase marked done");

    this.db
      .update(s.phaseStates)
      .set({ status: "done", completedAt: Date.now(), completedBy: by })
      .where(eq(s.phaseStates.id, phase.id))
      .run();
    this.timeline(
      visit.taskId,
      visit.id,
      null,
      "phase.completed",
      `Completed ${phase.name}${by === "manual" ? " (manually)" : ""}`,
    );
    this.publish({ type: "task.changed", taskId: visit.taskId });
    if (phase.phaseId) {
      this.fire(visit.taskId, visit.id, "phase.completed", { stageId: visit.stageId, phaseId: phase.phaseId }, null, null);
    }

    const task = this.getTask(visit.taskId);
    if (task.status !== "active" || task.currentVisitId !== visit.id) return;
    const next = this.db
      .select()
      .from(s.phaseStates)
      .where(
        and(
          eq(s.phaseStates.visitId, visit.id),
          gt(s.phaseStates.position, phase.position),
          eq(s.phaseStates.status, "pending"),
        ),
      )
      .orderBy(asc(s.phaseStates.position))
      .limit(1)
      .get();
    if (next) this.startPhase(next, true);
    else this.completeStageInternal(visit);
  }

  private completeStageInternal(visit: VisitRow): void {
    const fresh = this.getVisit(visit.id);
    if (fresh.completedAt) return;
    this.db.update(s.stageVisits).set({ completedAt: Date.now() }).where(eq(s.stageVisits.id, visit.id)).run();
    this.timeline(visit.taskId, visit.id, null, "stage.completed", `Completed ${visit.stageName}`);
    this.publish({ type: "task.changed", taskId: visit.taskId });
    this.fire(visit.taskId, visit.id, "stage.completed", { stageId: visit.stageId }, null, null);
  }

  // ---------------------------------------------------------------- internals: runs & batches

  private fire(
    taskId: string,
    visitId: string,
    trigger: Trigger,
    match: TriggerMatch,
    phaseStateId: string | null,
    parentRunId: number | null,
  ): RunRow[] {
    if (this.getTask(taskId).status !== "active") return [];
    const conditions = [eq(s.actionBindings.trigger, trigger), eq(s.actionBindings.enabled, true)];
    if (CHAIN_TRIGGERS.includes(trigger)) {
      if (!match.afterBindingId) return [];
      conditions.push(eq(s.actionBindings.afterBindingId, match.afterBindingId));
    } else {
      if (!match.stageId) return [];
      conditions.push(eq(s.actionBindings.stageId, match.stageId));
      if (PHASE_TRIGGERS.includes(trigger)) {
        if (!match.phaseId) return [];
        conditions.push(eq(s.actionBindings.phaseId, match.phaseId));
      }
    }
    const bindings = this.db
      .select()
      .from(s.actionBindings)
      .where(and(...conditions))
      .orderBy(asc(s.actionBindings.position))
      .all();
    return this.createBatch(taskId, visitId, bindings, trigger, phaseStateId, parentRunId);
  }

  private fireChain(run: RunRow, trigger: "action.succeeded" | "action.failed"): void {
    if (!run.bindingId) return;
    // Chained runs inherit the parent's phase so they count toward its completion.
    this.fire(run.taskId, run.visitId, trigger, { afterBindingId: run.bindingId }, run.phaseStateId, run.id);
  }

  /** Bindings fired together run one after another, in position order. */
  private createBatch(
    taskId: string,
    visitId: string,
    bindings: BindingRow[],
    trigger: Trigger,
    phaseStateId: string | null,
    parentRunId: number | null,
  ): RunRow[] {
    if (bindings.length === 0) return [];
    const batchId = randomUUID();
    const now = Date.now();
    const runs = bindings.map((binding, index) =>
      this.db
        .insert(s.actionRuns)
        .values({
          taskId,
          visitId,
          phaseStateId,
          bindingId: binding.id,
          bindingKey: binding.key,
          label: binding.label,
          actionType: binding.actionType,
          trigger,
          config: binding.config,
          overrides: null,
          batchId,
          batchPosition: index,
          status: index === 0 ? "queued" : "waiting",
          parentRunId,
          createdAt: now,
        })
        .returning()
        .get(),
    );
    for (const run of runs) this.publish({ type: "run.changed", taskId, runId: run.id });
    this.publish({ type: "runs.queued" });
    return runs;
  }

  private insertRunCopy(run: RunRow, overrides: Record<string, unknown> | null): RunRow {
    const copy = this.db
      .insert(s.actionRuns)
      .values({
        taskId: run.taskId,
        visitId: run.visitId,
        phaseStateId: run.phaseStateId,
        bindingId: run.bindingId,
        bindingKey: run.bindingKey,
        label: run.label,
        actionType: run.actionType,
        trigger: run.trigger,
        config: run.config,
        overrides,
        batchId: run.batchId,
        batchPosition: run.batchPosition,
        status: "queued",
        retryOfRunId: run.id,
        parentRunId: run.parentRunId,
        createdAt: Date.now(),
      })
      .returning()
      .get();
    this.publish({ type: "run.changed", taskId: run.taskId, runId: copy.id });
    this.publish({ type: "runs.queued" });
    return copy;
  }

  private advanceBatch(run: RunRow): void {
    const next = this.latestInSlot(run.batchId, run.batchPosition + 1);
    if (!next) return;
    if (next.status === "waiting") {
      this.db.update(s.actionRuns).set({ status: "queued" }).where(eq(s.actionRuns.id, next.id)).run();
      this.publish({ type: "run.changed", taskId: next.taskId, runId: next.id });
      this.publish({ type: "runs.queued" });
    } else if (next.status === "skipped") {
      // An earlier failure skipped it; the failed step has now been retried successfully.
      this.insertRunCopy(next, next.overrides);
    }
  }

  private skipRestOfBatch(run: RunRow): void {
    const waiting = this.db
      .select()
      .from(s.actionRuns)
      .where(
        and(
          eq(s.actionRuns.batchId, run.batchId),
          gt(s.actionRuns.batchPosition, run.batchPosition),
          eq(s.actionRuns.status, "waiting"),
        ),
      )
      .all();
    for (const skipped of waiting) {
      this.db
        .update(s.actionRuns)
        .set({ status: "skipped", endedAt: Date.now() })
        .where(eq(s.actionRuns.id, skipped.id))
        .run();
      this.publish({ type: "run.changed", taskId: skipped.taskId, runId: skipped.id });
    }
  }

  private cancelRunRow(run: RunRow, reason: string): void {
    this.db
      .update(s.actionRuns)
      .set({ status: "cancelled", endedAt: Date.now(), error: reason })
      .where(eq(s.actionRuns.id, run.id))
      .run();
    if (run.status !== "waiting") {
      this.timeline(run.taskId, run.visitId, run.id, "run.cancelled", `${run.label} cancelled: ${reason}`);
    }
    this.publish({ type: "run.changed", taskId: run.taskId, runId: run.id });
    if (run.status === "running") this.publish({ type: "run.cancelled", taskId: run.taskId, runId: run.id });
  }

  private cancelActiveRunsInternal(taskId: string, exceptRunId: number | undefined, reason: string): void {
    const conditions = [eq(s.actionRuns.taskId, taskId), inArray(s.actionRuns.status, [...ACTIVE_RUN_STATUSES])];
    if (exceptRunId !== undefined) conditions.push(ne(s.actionRuns.id, exceptRunId));
    for (const run of this.db.select().from(s.actionRuns).where(and(...conditions)).all()) {
      this.cancelRunRow(run, reason);
    }
  }

  private latestInSlot(batchId: string, batchPosition: number): RunRow | undefined {
    return this.db
      .select()
      .from(s.actionRuns)
      .where(and(eq(s.actionRuns.batchId, batchId), eq(s.actionRuns.batchPosition, batchPosition)))
      .orderBy(desc(s.actionRuns.id))
      .limit(1)
      .get();
  }

  // ---------------------------------------------------------------- internals: misc

  private summarize(task: TaskRow): TaskSummary {
    const visit = task.currentVisitId ? this.getVisit(task.currentVisitId) : undefined;
    const phases = visit ? this.phaseStatesOf(visit.id) : [];
    const runs = visit ? this.db.select().from(s.actionRuns).where(eq(s.actionRuns.visitId, visit.id)).all() : [];
    return {
      ...task,
      badge: computeBadge(task, phases, latestAttempts(runs)),
      phaseProgress: { done: phases.filter((phase) => phase.status === "done").length, total: phases.length },
      enteredStageAt: visit?.enteredAt ?? null,
    };
  }

  private getVisit(id: string): VisitRow {
    const visit = this.db.select().from(s.stageVisits).where(eq(s.stageVisits.id, id)).get();
    if (!visit) throw new EngineError(`Stage visit ${id} not found`, 404);
    return visit;
  }

  private findPhaseState(id: string): PhaseStateRow | undefined {
    return this.db.select().from(s.phaseStates).where(eq(s.phaseStates.id, id)).get();
  }

  private phaseStatesOf(visitId: string): PhaseStateRow[] {
    return this.db
      .select()
      .from(s.phaseStates)
      .where(eq(s.phaseStates.visitId, visitId))
      .orderBy(asc(s.phaseStates.position))
      .all();
  }

  private timeline(
    taskId: string,
    visitId: string | null,
    runId: number | null,
    type: string,
    message: string,
    data: Record<string, unknown> | null = null,
  ): void {
    const event = this.db
      .insert(s.timelineEvents)
      .values({ taskId, visitId, runId, type, message, data, at: Date.now() })
      .returning({ id: s.timelineEvents.id })
      .get();
    this.publish({ type: "timeline.appended", taskId, eventId: event.id });
  }
}

// ---------------------------------------------------------------- helpers

const isActive = (status: RunStatus) => ACTIVE_RUN_STATUSES.includes(status);

/** Retries share a batch slot; only the newest attempt in each slot counts. */
function latestAttempts(runs: RunRow[]): RunRow[] {
  const bySlot = new Map<string, RunRow>();
  for (const run of runs) {
    const slot = `${run.batchId}:${run.batchPosition}`;
    const existing = bySlot.get(slot);
    if (!existing || run.id > existing.id) bySlot.set(slot, run);
  }
  return [...bySlot.values()];
}

function computeBadge(task: TaskRow, phases: PhaseStateRow[], latest: RunRow[]): TaskBadge {
  if (task.status === "archived") return "archived";
  if (latest.some((run) => run.status === "running")) return "running";
  if (latest.some((run) => run.status === "queued" || run.status === "waiting")) return "queued";
  const donePhases = new Set(phases.filter((phase) => phase.status === "done").map((phase) => phase.id));
  const unresolvedFailure = latest.some(
    (run) =>
      (run.status === "failed" || run.status === "interrupted") &&
      !(run.phaseStateId && donePhases.has(run.phaseStateId)),
  );
  if (unresolvedFailure || phases.some((phase) => phase.status === "failed")) return "failed";
  if (phases.some((phase) => phase.status === "running")) return "needs-you";
  return "idle";
}

function lazyRecord<T>(get: (key: string) => T): Record<string, T> {
  return new Proxy({} as Record<string, T>, {
    get: (_target, property) => (typeof property === "string" ? get(property) : undefined),
  });
}

function dedupe(events: InternalEvent[]): InternalEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    if (event.type === "timeline.appended" || event.type === "run.log" || event.type === "run.cancelled") return true;
    const key = JSON.stringify(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
