import type {
  CompletionMode,
  PhaseStatus,
  RunStatus,
  TaskLink,
  TaskStatus,
  Trigger,
} from "@wm/shared";
import {
  type AnySQLiteColumn,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

// ---------- templates ----------

export const workflows = sqliteTable("workflows", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const stages = sqliteTable(
  "stages",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    wipLimit: integer("wip_limit"),
  },
  (t) => [index("stages_workflow_idx").on(t.workflowId, t.position)],
);

export const phases = sqliteTable(
  "phases",
  {
    id: text("id").primaryKey(),
    stageId: text("stage_id")
      .notNull()
      .references(() => stages.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    completion: text("completion").$type<CompletionMode>().notNull(),
  },
  (t) => [index("phases_stage_idx").on(t.stageId, t.position)],
);

export const actionBindings = sqliteTable(
  "action_bindings",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    stageId: text("stage_id")
      .notNull()
      .references(() => stages.id, { onDelete: "cascade" }),
    phaseId: text("phase_id").references(() => phases.id, { onDelete: "cascade" }),
    /** For action.succeeded / action.failed: the binding whose run completion fires this one. */
    afterBindingId: text("after_binding_id").references((): AnySQLiteColumn => actionBindings.id, {
      onDelete: "cascade",
    }),
    /** Unique per workflow; used as `{{outputs.<key>}}`. */
    key: text("key").notNull(),
    label: text("label").notNull(),
    trigger: text("trigger").$type<Trigger>().notNull(),
    actionType: text("action_type").notNull(),
    config: json<Record<string, unknown>>("config").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    askFeedback: integer("ask_feedback", { mode: "boolean" }).notNull().default(false),
    position: integer("position").notNull(),
  },
  (t) => [
    uniqueIndex("bindings_workflow_key_idx").on(t.workflowId, t.key),
    index("bindings_stage_trigger_idx").on(t.stageId, t.trigger),
    index("bindings_after_idx").on(t.afterBindingId),
  ],
);

// ---------- runtime ----------

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    repoPath: text("repo_path"),
    baseBranch: text("base_branch"),
    branch: text("branch"),
    worktreePath: text("worktree_path"),
    links: json<TaskLink[]>("links").notNull(),
    tags: json<string[]>("tags").notNull(),
    agentOverride: text("agent_override"),
    modelOverride: text("model_override"),
    lastFeedback: text("last_feedback"),
    status: text("status").$type<TaskStatus>().notNull().default("active"),
    currentStageId: text("current_stage_id"),
    currentVisitId: text("current_visit_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    archivedAt: integer("archived_at"),
  },
  (t) => [index("tasks_workflow_status_idx").on(t.workflowId, t.status)],
);

/** One stay of a task in a stage. Stage name is snapshotted so history survives template edits. */
export const stageVisits = sqliteTable(
  "stage_visits",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    stageId: text("stage_id").notNull(),
    stageName: text("stage_name").notNull(),
    attempt: integer("attempt").notNull(),
    enteredAt: integer("entered_at").notNull(),
    completedAt: integer("completed_at"),
    exitedAt: integer("exited_at"),
  },
  (t) => [index("visits_task_idx").on(t.taskId, t.stageId)],
);

/** Phase definitions snapshotted at stage entry. */
export const phaseStates = sqliteTable(
  "phase_states",
  {
    id: text("id").primaryKey(),
    visitId: text("visit_id")
      .notNull()
      .references(() => stageVisits.id, { onDelete: "cascade" }),
    phaseId: text("phase_id"),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    completion: text("completion").$type<CompletionMode>().notNull(),
    status: text("status").$type<PhaseStatus>().notNull(),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    completedBy: text("completed_by").$type<"auto" | "manual">(),
  },
  (t) => [index("phase_states_visit_idx").on(t.visitId, t.position)],
);

export const actionRuns = sqliteTable(
  "action_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    visitId: text("visit_id")
      .notNull()
      .references(() => stageVisits.id, { onDelete: "cascade" }),
    phaseStateId: text("phase_state_id").references(() => phaseStates.id, { onDelete: "cascade" }),
    bindingId: text("binding_id"),
    bindingKey: text("binding_key").notNull(),
    label: text("label").notNull(),
    actionType: text("action_type").notNull(),
    trigger: text("trigger").$type<Trigger>().notNull(),
    /** Raw (unrendered) config snapshotted when the run was created. */
    config: json<Record<string, unknown>>("config").notNull(),
    overrides: json<Record<string, unknown>>("overrides"),
    /** Runs created by one trigger firing execute sequentially in batch order. */
    batchId: text("batch_id").notNull(),
    batchPosition: integer("batch_position").notNull(),
    status: text("status").$type<RunStatus>().notNull(),
    retryOfRunId: integer("retry_of_run_id"),
    parentRunId: integer("parent_run_id"),
    outputs: json<Record<string, unknown>>("outputs"),
    error: text("error"),
    sessionId: text("session_id"),
    usage: json<Record<string, unknown>>("usage"),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    endedAt: integer("ended_at"),
  },
  (t) => [
    index("runs_status_idx").on(t.status),
    index("runs_task_idx").on(t.taskId, t.bindingKey),
    index("runs_visit_idx").on(t.visitId),
    index("runs_batch_idx").on(t.batchId, t.batchPosition),
    index("runs_phase_state_idx").on(t.phaseStateId),
  ],
);

export const timelineEvents = sqliteTable(
  "timeline_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    visitId: text("visit_id"),
    runId: integer("run_id"),
    type: text("type").notNull(),
    message: text("message").notNull(),
    data: json<Record<string, unknown>>("data"),
    at: integer("at").notNull(),
  },
  (t) => [index("timeline_task_idx").on(t.taskId, t.id)],
);

/** App-wide settings (e.g. agent executable overrides), one JSON value per key. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: json<unknown>("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type WorkflowRow = typeof workflows.$inferSelect;
export type StageRow = typeof stages.$inferSelect;
export type PhaseRow = typeof phases.$inferSelect;
export type BindingRow = typeof actionBindings.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type VisitRow = typeof stageVisits.$inferSelect;
export type PhaseStateRow = typeof phaseStates.$inferSelect;
export type RunRow = typeof actionRuns.$inferSelect;
export type TimelineRow = typeof timelineEvents.$inferSelect;
