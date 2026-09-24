import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import {
  ACTIVE_RUN_STATUSES,
  AGENT_IDS,
  type AgentId,
  APPROVAL_ACTION,
  CODING_AGENT_ACTION,
  type BadgeDetail,
  type CreateTaskInput,
  createTaskSchema,
  isAgentId,
  NO_STAGE_AGENT_DEFAULTS,
  RETRYABLE_RUN_STATUSES,
  type RunStatus,
  type ServerEvent,
  type StageAgentDefaults,
  type TaskBadge,
  type TaskDetail,
  type TaskStatus,
  type TaskSummary,
  type UpdateTaskInput,
  updateTaskSchema,
  type WorkflowDef,
  type WorkflowUsage,
} from "@wm/shared";
import { and, asc, count, desc, eq, inArray, isNotNull, lt, lte, ne, type SQL, sql } from "drizzle-orm";
import type { Db, Sqlite } from "../db/client";
import * as s from "../db/schema";
import type { BindingRow, RunRow, TaskRow, VisitRow } from "../db/schema";
import { type Paths, resolveInside } from "../paths";
import { renderString, type Scope } from "./template";

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
  /** Other workspace runtimes on this server share the same process limit. */
  externalLongRuns?: () => number;
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
      /** A usage limit, not a failure: the run waits and is queued again at this time. */
      resumeAt?: number;
    };

export interface RunScope extends Scope {
  task: Omit<TaskRow, "links"> & { links: Record<string, string> };
  stage: { id: string; name: string };
  visit: { id: string; attempt: number };
  run: { id: number; key: string; label: string };
  artifacts: Record<string, string | undefined>;
  artifactPath: Record<string, string>;
  outputs: Record<string, Record<string, unknown> | undefined>;
}

const toStageAgentDefaults = (stage: typeof s.stages.$inferSelect): StageAgentDefaults => ({
  agent: isAgentId(stage.defaultAgent) ? stage.defaultAgent : null,
  model: stage.defaultModel,
  effort: stage.defaultEffort,
});

/**
 * Owns all workflow state transitions. Every public mutation runs in a single SQLite
 * transaction; events are emitted only after commit. Action execution lives in Runner.
 *
 * A stage is an ordered list of actions. Entering it (or pressing Start) creates one batch holding
 * a run per enabled action; each run becomes eligible when the one above it settles, and the visit
 * is complete once every run has.
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
      icon: workflow.icon,
      updatedAt: workflow.updatedAt,
      stages: stageRows.map((stage) => ({
        id: stage.id,
        name: stage.name,
        position: stage.position,
        wipLimit: stage.wipLimit,
        agentDefaults: toStageAgentDefaults(stage),
        bindings: bindingRows
          .filter((binding) => binding.stageId === stage.id)
          .map(({ workflowId: _workflowId, ...binding }) => binding),
      })),
    };
  }

  /**
   * The coding-agent defaults of the stage a run was created in. Read when the run starts rather
   * than snapshotted, so a workflow edit applies from the next run (retries included).
   */
  stageAgentDefaultsForRun(run: RunRow): StageAgentDefaults {
    const visit = this.getVisit(run.visitId);
    const stage = this.db.select().from(s.stages).where(eq(s.stages.id, visit.stageId)).get();
    return stage ? toStageAgentDefaults(stage) : { ...NO_STAGE_AGENT_DEFAULTS };
  }

  /** What still depends on a workflow: blocks deleting it, and deleting the stages tasks sit in. */
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
    const runs = this.db.select().from(s.actionRuns).where(eq(s.actionRuns.taskId, id)).orderBy(asc(s.actionRuns.id)).all();
    const timeline = this.db
      .select()
      .from(s.timelineEvents)
      .where(eq(s.timelineEvents.taskId, id))
      .orderBy(asc(s.timelineEvents.id))
      .all();

    return {
      task: this.summarize(task),
      visits: visits.map((visit) => ({ ...visit, runs: runs.filter((run) => run.visitId === visit.id) })),
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
    const artifactDir = this.options.paths.artifactDir(task.id);
    const links: Record<string, string> = {};
    for (const link of task.links) links[link.type] ??= link.value;

    return {
      // No feedback is the usual case, so it renders empty without being reported as missing.
      task: { ...task, links, lastFeedback: task.lastFeedback ?? "" },
      stage: { id: visit.stageId, name: visit.stageName },
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
          useWorktree: input.useWorktree,
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
      const task = this.getActiveTask(id);
      if (patch.useWorktree === false && task.worktreePath) {
        throw new EngineError("This task already has a worktree; archiving the task removes it");
      }
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
      this.exitCurrentVisit(task, { exceptRunId: options.initiatedByRunId });
      this.enterStage(task.id, stage.id, { runActions: options.runActions ?? true });
      return { stageId: stage.id, stageName: stage.name };
    });
  }

  /** Runs the current stage's actions for a task that entered it without running them. */
  startActions(taskId: string): RunRow[] {
    return this.tx(() => {
      const task = this.getActiveTask(taskId);
      if (!task.currentVisitId) throw new EngineError("Task is not in a stage", 409);
      const visit = this.getVisit(task.currentVisitId);
      if (this.runsOf(visit.id).length > 0) throw new EngineError(`${visit.stageName}'s actions have already started`, 409);
      const bindings = this.enabledBindings(visit.stageId);
      if (bindings.length === 0) throw new EngineError(`${visit.stageName} has no actions to run`, 409);
      this.timeline(task.id, visit.id, null, "actions.started", `Started ${visit.stageName}'s actions`);
      const runs = this.createBatch(task.id, visit.id, bindings);
      this.publish({ type: "task.changed", taskId: task.id });
      return runs;
    });
  }

  retryRun(runId: number, overrides?: Record<string, unknown>): RunRow {
    return this.tx(() => {
      const run = this.getRun(runId);
      if (!RETRYABLE_RUN_STATUSES.includes(run.status)) {
        throw new EngineError(`Cannot retry a ${run.status} run`, 409);
      }
      const task = this.getActiveTask(run.taskId);
      this.assertLatestInCurrentVisit(task, run);

      const retry = this.insertRunCopy(run, overrides ? { ...(run.overrides ?? {}), ...overrides } : run.overrides);
      this.timeline(task.id, run.visitId, retry.id, "run.retried", `Retrying ${run.label}`);
      this.publish({ type: "task.changed", taskId: task.id });
      return retry;
    });
  }

  /** Carries on past an action that failed or was cancelled, as if it had succeeded. */
  skipRun(runId: number): RunRow {
    return this.tx(() => {
      const run = this.getRun(runId);
      if (run.status !== "failed" && run.status !== "cancelled" && run.status !== "interrupted") {
        throw new EngineError(`Only a failed, cancelled or interrupted action can be skipped, not a ${run.status} one`, 409);
      }
      const task = this.getActiveTask(run.taskId);
      this.assertLatestInCurrentVisit(task, run);

      const skipped = this.db
        .update(s.actionRuns)
        .set({ status: "skipped", endedAt: run.endedAt ?? Date.now() })
        .where(eq(s.actionRuns.id, run.id))
        .returning()
        .get();
      this.timeline(task.id, run.visitId, run.id, "run.skipped", `Skipped ${run.label}`);
      this.publish({ type: "run.changed", taskId: task.id, runId: run.id });
      this.settled(skipped);
      this.publish({ type: "task.changed", taskId: task.id });
      return skipped;
    });
  }

  /**
   * Settles an approval that is waiting for you, so the next action runs. Approving means the last
   * Send back's note has been dealt with, so it is cleared rather than handed to later stages as if
   * it were about their work.
   */
  approveRun(runId: number): RunRow {
    return this.tx(() => {
      const { run, task } = this.waitingApproval(runId);
      if (task.lastFeedback !== null) {
        this.db.update(s.tasks).set({ lastFeedback: null, updatedAt: Date.now() }).where(eq(s.tasks.id, task.id)).run();
      }
      const approved = this.db
        .update(s.actionRuns)
        .set({ status: "succeeded", endedAt: Date.now(), outputs: { ...(run.outputs ?? {}), decision: "approved" } })
        .where(eq(s.actionRuns.id, run.id))
        .returning()
        .get();
      this.timeline(task.id, run.visitId, run.id, "run.approved", `Approved ${run.label}`);
      this.publish({ type: "run.changed", taskId: task.id, runId: run.id });
      this.settled(approved);
      this.publish({ type: "task.changed", taskId: task.id });
      return approved;
    });
  }

  /** An approval's Send back: saves the note as feedback and moves the task to the approval's stage. */
  sendBack(runId: number, options: { note?: string } = {}): { stageId: string; stageName: string } {
    return this.tx(() => {
      const { run, task } = this.waitingApproval(runId);
      const target = String({ ...run.config, ...(run.overrides ?? {}) }.sendBackTo ?? "");
      if (!target) throw new EngineError(`${run.label} has no Send back`, 409);
      const stage = this.db.select().from(s.stages).where(eq(s.stages.id, target)).get();
      if (!stage || stage.workflowId !== task.workflowId) {
        throw new EngineError(`The stage ${run.label} sends back to no longer exists`, 409);
      }

      if (options.note !== undefined) {
        this.db
          .update(s.tasks)
          .set({ lastFeedback: options.note, updatedAt: Date.now() })
          .where(eq(s.tasks.id, task.id))
          .run();
        this.timeline(task.id, run.visitId, null, "feedback", options.note);
      }
      // Settled without advancing: the task is leaving, so nothing after the approval should start.
      this.db
        .update(s.actionRuns)
        .set({
          status: "succeeded",
          endedAt: Date.now(),
          outputs: { ...(run.outputs ?? {}), decision: "sent back", stageId: stage.id, stageName: stage.name },
        })
        .where(eq(s.actionRuns.id, run.id))
        .run();
      this.timeline(task.id, run.visitId, run.id, "run.sent-back", `${run.label}: sent back to ${stage.name}`);
      this.publish({ type: "run.changed", taskId: task.id, runId: run.id });
      return this.moveTask(task.id, stage.id, { runActions: true });
    });
  }

  /**
   * "Request changes" at an agent's approval. The same run goes back in the queue carrying your
   * note, so the agent picks its own session up and the chat reads as one conversation.
   */
  requestChanges(runId: number, note: string): RunRow {
    return this.tx(() => {
      const { run, task } = this.waitingApproval(runId);
      if (run.actionType !== CODING_AGENT_ACTION) {
        throw new EngineError(`${run.label} has no agent to send changes to; approve it or send it back`, 400);
      }
      const updated = this.db
        .update(s.actionRuns)
        .set({ status: "queued", followUp: note, endedAt: null, error: null })
        .where(eq(s.actionRuns.id, run.id))
        .returning()
        .get();
      // The note reaches the agent as this run's follow-up. It is deliberately not saved as
      // task.lastFeedback: that would hand a note about, say, the requirements to the next stage's
      // agent as "reviewer feedback" on its own work.
      this.timeline(task.id, run.visitId, run.id, "feedback", note);
      this.timeline(task.id, run.visitId, run.id, "run.changes-requested", `Asked ${run.label} for changes`);
      this.publish({ type: "run.changed", taskId: task.id, runId: run.id });
      this.publish({ type: "task.changed", taskId: task.id });
      this.publish({ type: "runs.queued" });
      return updated;
    });
  }

  cancelRun(runId: number): void {
    this.tx(() => {
      const run = this.getRun(runId);
      if (!ACTIVE_RUN_STATUSES.includes(run.status)) throw new EngineError(`Run is already ${run.status}`, 409);
      this.cancelRunRow(run, "Cancelled by user");
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

  /** Deletes tasks and everything recorded against them, stopping anything still running. Their files are the caller's. */
  deleteTasks(taskIds: string[]): void {
    if (taskIds.length === 0) return;
    this.tx(() => {
      for (const taskId of taskIds) {
        this.cancelActiveRunsInternal(taskId, undefined, "Task deleted");
        this.publish({ type: "task.changed", taskId });
      }
      this.db.delete(s.tasks).where(inArray(s.tasks.id, taskIds)).run(); // cascades to visits, runs and timeline
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
      longRunning += this.options.externalLongRuns?.() ?? 0;

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
        // An agent set to wait for your sign-off stops here instead: the list stays put until you decide.
        const gated = this.wantsApproval(run);
        const outputs = result.outputs ?? {};
        const finished = this.db
          .update(s.actionRuns)
          .set({
            status: gated ? "awaiting-approval" : "succeeded",
            endedAt: now,
            outputs: gated ? { ...outputs, instructions: this.renderInstructions(run) } : outputs,
            sessionId: result.sessionId ?? null,
            usage: result.usage ?? null,
            followUp: null,
          })
          .where(eq(s.actionRuns.id, run.id))
          .returning()
          .get();
        const suffix = result.summary ? `: ${result.summary}` : "";
        // A gated run hasn't succeeded as far as the stage is concerned, so the timeline says what
        // actually happened: it is waiting on you, with what it cost to get there.
        if (gated) {
          const cost = result.summary ? ` · ${result.summary}` : "";
          this.timeline(run.taskId, run.visitId, run.id, "approval.waiting", `Waiting for your approval: ${run.label}${cost}`);
        } else {
          this.timeline(run.taskId, run.visitId, run.id, "run.succeeded", `${run.label} succeeded${suffix}`);
          this.settled(finished);
        }
      } else if (result.resumeAt !== undefined) {
        // Nothing is wrong with the work, so the list stays put: the run just waits.
        this.db
          .update(s.actionRuns)
          .set({
            status: "quota-wait",
            endedAt: now,
            resumeAt: result.resumeAt,
            error: result.error,
            // A run parked before it could start keeps what its earlier attempt recorded.
            outputs: result.outputs ?? run.outputs,
            sessionId: result.sessionId ?? run.sessionId,
            usage: result.usage ?? run.usage,
          })
          .where(eq(s.actionRuns.id, run.id))
          .run();
        this.timeline(
          run.taskId,
          run.visitId,
          run.id,
          "run.quota-wait",
          `${run.label} hit a usage limit and carries on at ${new Date(result.resumeAt).toLocaleString()}`,
        );
      } else {
        const failed = this.db
          .update(s.actionRuns)
          .set({
            status: "failed",
            endedAt: now,
            error: result.error,
            outputs: result.outputs ?? null,
            sessionId: result.sessionId ?? null,
            usage: result.usage ?? null,
            followUp: null,
          })
          .where(eq(s.actionRuns.id, run.id))
          .returning()
          .get();
        const carryOn = run.continueOnFailure ? " (continuing)" : "";
        this.timeline(run.taskId, run.visitId, run.id, "run.failed", `${run.label} failed${carryOn}: ${result.error}`);
        // Otherwise the actions below wait until it is retried or skipped.
        if (run.continueOnFailure) this.settled(failed);
      }

      this.publish({ type: "run.changed", taskId: run.taskId, runId: run.id });
      this.publish({ type: "task.changed", taskId: run.taskId });
    });
  }

  /** On startup: anything still "running" belonged to a previous server process. Runs awaiting you keep waiting. */
  markInterruptedRuns(): number {
    return this.tx(() => {
      const running = this.db
        .select()
        .from(s.actionRuns)
        .where(eq(s.actionRuns.status, "running"))
        .all();
      for (const run of running) {
        this.db
          .update(s.actionRuns)
          .set({ status: "interrupted", endedAt: Date.now(), error: "Server stopped while this action was running" })
          .where(eq(s.actionRuns.id, run.id))
          .run();
        this.timeline(run.taskId, run.visitId, run.id, "run.interrupted", `${run.label} was interrupted`);
        this.publish({ type: "run.changed", taskId: run.taskId, runId: run.id });
        this.publish({ type: "task.changed", taskId: run.taskId });
      }
      if (running.length) this.publish({ type: "runs.queued" });
      return running.length;
    });
  }

  /** Queues the runs whose usage limit has reset. */
  requeueDueQuotaRuns(now = Date.now()): number {
    return this.tx(() => {
      const due = this.db
        .select()
        .from(s.actionRuns)
        .where(and(eq(s.actionRuns.status, "quota-wait"), lte(s.actionRuns.resumeAt, now)))
        .all();
      for (const run of due) this.requeueQuotaRun(run, `${run.label}: the usage limit has reset, trying again`);
      return due.length;
    });
  }

  /** "Try now": the user expects the limit has lifted before the time the agent gave. */
  resumeQuotaRun(runId: number): RunRow {
    return this.tx(() => {
      const run = this.getRun(runId);
      if (run.status !== "quota-wait") throw new EngineError(`Run is ${run.status}, not waiting for a usage limit`, 409);
      this.getActiveTask(run.taskId);
      return this.requeueQuotaRun(run, `Trying ${run.label} again now`);
    });
  }

  /** When the runner next has a usage-limited run to wake. */
  nextQuotaResumeAt(): number | null {
    const row = this.db
      .select({ at: s.actionRuns.resumeAt })
      .from(s.actionRuns)
      .where(and(eq(s.actionRuns.status, "quota-wait"), isNotNull(s.actionRuns.resumeAt)))
      .orderBy(asc(s.actionRuns.resumeAt))
      .limit(1)
      .get();
    return row?.at ?? null;
  }

  // ---------------------------------------------------------------- internals: stages

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

    this.db
      .update(s.tasks)
      .set({ currentStageId: stageId, currentVisitId: visit.id, updatedAt: now })
      .where(eq(s.tasks.id, taskId))
      .run();
    const attemptSuffix = visit.attempt > 1 ? ` (attempt ${visit.attempt})` : "";
    this.timeline(taskId, visit.id, null, "stage.entered", `Entered ${stage.name}${attemptSuffix}`);
    this.publish({ type: "task.changed", taskId });

    if (options.runActions) this.createBatch(taskId, visit.id, this.enabledBindings(stageId));
  }

  private exitCurrentVisit(task: TaskRow, options: { exceptRunId?: number }): void {
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
  }

  /** Marks the visit complete once every action in its list has settled. */
  private completeVisitIfDone(visitId: string): void {
    const visit = this.getVisit(visitId);
    if (visit.completedAt) return;
    const latest = latestAttempts(this.runsOf(visit.id));
    if (latest.length === 0 || !latest.every(isSettled)) return;
    this.db.update(s.stageVisits).set({ completedAt: Date.now() }).where(eq(s.stageVisits.id, visit.id)).run();
    this.timeline(visit.taskId, visit.id, null, "stage.completed", `Completed ${visit.stageName}`);
    this.publish({ type: "task.changed", taskId: visit.taskId });
  }

  private enabledBindings(stageId: string): BindingRow[] {
    return this.db
      .select()
      .from(s.actionBindings)
      .where(and(eq(s.actionBindings.stageId, stageId), eq(s.actionBindings.enabled, true)))
      .orderBy(asc(s.actionBindings.position))
      .all();
  }

  // ---------------------------------------------------------------- internals: runs & batches

  /** One run per action, in list order. Only the first is eligible; the rest wait their turn. */
  private createBatch(taskId: string, visitId: string, bindings: BindingRow[]): RunRow[] {
    if (bindings.length === 0 || this.getTask(taskId).status !== "active") return [];
    const batchId = randomUUID();
    const now = Date.now();
    const runs = bindings.map((binding, index) =>
      this.db
        .insert(s.actionRuns)
        .values({
          taskId,
          visitId,
          bindingId: binding.id,
          bindingKey: binding.key,
          label: binding.label,
          actionType: binding.actionType,
          config: binding.config,
          overrides: null,
          batchId,
          batchPosition: index,
          status: "waiting",
          continueOnFailure: binding.continueOnFailure,
          createdAt: now,
        })
        .returning()
        .get(),
    );
    for (const run of runs) this.publish({ type: "run.changed", taskId, runId: run.id });
    this.activate(runs[0]!);
    return runs;
  }

  private insertRunCopy(run: RunRow, overrides: Record<string, unknown> | null): RunRow {
    const copy = this.db
      .insert(s.actionRuns)
      .values({
        taskId: run.taskId,
        visitId: run.visitId,
        bindingId: run.bindingId,
        bindingKey: run.bindingKey,
        label: run.label,
        actionType: run.actionType,
        config: run.config,
        overrides,
        batchId: run.batchId,
        batchPosition: run.batchPosition,
        status: "waiting",
        continueOnFailure: run.continueOnFailure,
        retryOfRunId: run.id,
        createdAt: Date.now(),
      })
      .returning()
      .get();
    this.publish({ type: "run.changed", taskId: run.taskId, runId: copy.id });
    return this.activate(copy);
  }

  /**
   * Makes a waiting run eligible. An action joins the runner's queue; an approval starts waiting for
   * you straight away, with its instructions rendered now so they describe the task as it stands.
   */
  private activate(run: RunRow): RunRow {
    if (run.actionType !== APPROVAL_ACTION) {
      const queued = this.db.update(s.actionRuns).set({ status: "queued" }).where(eq(s.actionRuns.id, run.id)).returning().get();
      this.publish({ type: "run.changed", taskId: run.taskId, runId: run.id });
      this.publish({ type: "runs.queued" });
      return queued;
    }
    const waiting = this.db
      .update(s.actionRuns)
      .set({ status: "awaiting-approval", startedAt: Date.now(), outputs: { instructions: this.renderInstructions(run) } })
      .where(eq(s.actionRuns.id, run.id))
      .returning()
      .get();
    this.timeline(run.taskId, run.visitId, run.id, "approval.waiting", `Waiting for your approval: ${run.label}`);
    this.publish({ type: "run.changed", taskId: run.taskId, runId: run.id });
    this.publish({ type: "task.changed", taskId: run.taskId });
    return waiting;
  }

  /** A coding agent's sign-off keeps its own field, so it and the agent's prompt don't collide. */
  private renderInstructions(run: RunRow): string {
    const config = { ...run.config, ...(run.overrides ?? {}) };
    const instructions = run.actionType === CODING_AGENT_ACTION ? config.approvalInstructions : config.instructions;
    if (typeof instructions !== "string" || !instructions) return "";
    try {
      return renderString(instructions, this.buildScope(run));
    } catch {
      return instructions;
    }
  }

  /** A run in the list is done with (succeeded, skipped, or failed but allowed to): start the next, maybe finish the visit. */
  private settled(run: RunRow): void {
    const next = this.latestInSlot(run.batchId, run.batchPosition + 1);
    // Only a run still waiting: after a retry of an earlier action, the ones below may have run already.
    if (next?.status === "waiting" && this.getTask(run.taskId).status === "active") this.activate(next);
    this.completeVisitIfDone(run.visitId);
  }

  private assertLatestInCurrentVisit(task: TaskRow, run: RunRow): void {
    if (run.visitId !== task.currentVisitId) throw new EngineError("Task has moved on since this run", 409);
    const latest = this.latestInSlot(run.batchId, run.batchPosition);
    if (latest && latest.id !== run.id) throw new EngineError("A newer attempt of this action exists", 409);
  }

  private waitingApproval(runId: number): { run: RunRow; task: TaskRow } {
    const run = this.getRun(runId);
    if (run.status !== "awaiting-approval") throw new EngineError(`${run.label} is not waiting for approval`, 409);
    const task = this.getActiveTask(run.taskId);
    if (run.visitId !== task.currentVisitId) throw new EngineError("Task has moved on since this approval", 409);
    return { run, task };
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

  /** Whether this coding agent was told to stop for your sign-off rather than simply succeed. */
  private wantsApproval(run: RunRow): boolean {
    if (run.actionType !== CODING_AGENT_ACTION) return false;
    return { ...run.config, ...(run.overrides ?? {}) }.requireApproval === true;
  }

  /** The same row goes back in the queue, so its transcript and session carry on where they stopped. */
  private requeueQuotaRun(run: RunRow, message: string): RunRow {
    const updated = this.db
      .update(s.actionRuns)
      .set({ status: "queued", resumeAt: null, endedAt: null, error: null })
      .where(eq(s.actionRuns.id, run.id))
      .returning()
      .get();
    this.timeline(run.taskId, run.visitId, run.id, "run.resumed", message);
    this.publish({ type: "run.changed", taskId: run.taskId, runId: run.id });
    this.publish({ type: "task.changed", taskId: run.taskId });
    this.publish({ type: "runs.queued" });
    return updated;
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
    const latest = visit ? latestAttempts(this.runsOf(visit.id)) : [];
    // Before anything has started, progress counts what Start would run.
    const unstarted = visit && latest.length === 0 && task.status === "active" ? this.enabledBindings(visit.stageId).length : 0;
    const { badge, detail } = computeBadge(task, latest, unstarted > 0 ? visit!.stageName : null);
    return {
      ...task,
      badge,
      badgeDetail: detail,
      actionProgress: latest.length
        ? { done: latest.filter(isSettled).length, total: latest.length }
        : { done: 0, total: unstarted },
      enteredStageAt: visit?.enteredAt ?? null,
    };
  }

  private getVisit(id: string): VisitRow {
    const visit = this.db.select().from(s.stageVisits).where(eq(s.stageVisits.id, id)).get();
    if (!visit) throw new EngineError(`Stage visit ${id} not found`, 404);
    return visit;
  }

  private runsOf(visitId: string): RunRow[] {
    return this.db.select().from(s.actionRuns).where(eq(s.actionRuns.visitId, visitId)).orderBy(asc(s.actionRuns.id)).all();
  }

  /** Appends an entry to a task's timeline. Public so services can record what they did. */
  timeline(
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

/** Done with, as far as the list is concerned: the next action may start. */
function isSettled(run: RunRow): boolean {
  return run.status === "succeeded" || run.status === "skipped" || (run.status === "failed" && run.continueOnFailure);
}

/** Holds up the list until you retry or skip it. */
function isBlocking(run: RunRow): boolean {
  return (
    (run.status === "failed" && !run.continueOnFailure) || run.status === "interrupted" || run.status === "cancelled"
  );
}

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

/** One badge per task, and what it is about, so the board and the header's counts always agree. */
function computeBadge(
  task: TaskRow,
  latest: RunRow[],
  unstartedStage: string | null,
): { badge: TaskBadge; detail: BadgeDetail | null } {
  if (task.status === "archived") return { badge: "archived", detail: null };
  // Before "running": a blocked agent is technically running, but it is waiting on you.
  const asking = latest.find((run) => run.question);
  if (asking) return { badge: "needs-you", detail: { label: asking.label, reason: "question" } };
  const approval = latest.find((run) => run.status === "awaiting-approval");
  if (approval) return { badge: "needs-you", detail: { label: approval.label, reason: "approval" } };
  const running = latest.find((run) => run.status === "running");
  if (running) return { badge: "running", detail: { label: running.label } };
  const limited = latest
    .filter((run) => run.status === "quota-wait")
    .sort((a, b) => (a.resumeAt ?? Infinity) - (b.resumeAt ?? Infinity))[0];
  if (limited) {
    const agent = limited.outputs?.agent;
    return {
      badge: "quota",
      detail: { label: limited.label, agent: isAgentId(agent) ? agent : null, resetAt: limited.resumeAt ?? undefined },
    };
  }
  const blocked = latest.find(isBlocking);
  if (blocked) return { badge: "failed", detail: { label: blocked.label } };
  const queued = latest.find((run) => run.status === "queued") ?? latest.find((run) => run.status === "waiting");
  if (queued) return { badge: "queued", detail: { label: queued.label } };
  if (unstartedStage) return { badge: "needs-you", detail: { label: unstartedStage, reason: "start" } };
  return { badge: "idle", detail: null };
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
