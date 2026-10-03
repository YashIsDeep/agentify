import type { AgentQuestion, RunStatus, RunUsage, TaskLink, TaskStatus } from "@wm/shared";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

// ---------- workflows ----------

export const workflows = sqliteTable("workflows", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  /** An emoji; "" means the UI draws its default board glyph instead. */
  icon: text("icon").notNull().default(""),
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
    /** Coding-agent defaults for this stage's actions that leave agent, model or effort blank. */
    defaultAgent: text("default_agent"),
    defaultModel: text("default_model"),
    defaultEffort: text("default_effort"),
  },
  (t) => [index("stages_workflow_idx").on(t.workflowId, t.position)],
);

/** A stage's actions, run in `position` order when a task enters the stage. */
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
    /** Unique per workflow; used as `{{outputs.<key>}}`. */
    key: text("key").notNull(),
    label: text("label").notNull(),
    actionType: text("action_type").notNull(),
    config: json<Record<string, unknown>>("config").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** A failure doesn't hold up the actions after it. */
    continueOnFailure: integer("continue_on_failure", { mode: "boolean" }).notNull().default(false),
    position: integer("position").notNull(),
  },
  (t) => [
    uniqueIndex("bindings_workflow_key_idx").on(t.workflowId, t.key),
    index("bindings_stage_idx").on(t.stageId, t.position),
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
    useWorktree: integer("use_worktree", { mode: "boolean" }).notNull().default(true),
    links: json<TaskLink[]>("links").notNull(),
    tags: json<string[]>("tags").notNull(),
    agentOverride: text("agent_override"),
    modelOverride: text("model_override"),
    effortOverride: text("effort_override"),
    /** The latest reviewer note, from a Send back or a Request changes; prompts read it as
     * `{{task.lastFeedback}}` and actions get it as `WM_LAST_FEEDBACK`. */
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

/** One stay of a task in a stage. Stage name is snapshotted so history survives workflow edits. */
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
    bindingId: text("binding_id"),
    bindingKey: text("binding_key").notNull(),
    label: text("label").notNull(),
    actionType: text("action_type").notNull(),
    /** Raw (unrendered) config snapshotted when the run was created. */
    config: json<Record<string, unknown>>("config").notNull(),
    overrides: json<Record<string, unknown>>("overrides"),
    /** A stage visit's actions form one batch and run one after another, in position order. */
    batchId: text("batch_id").notNull(),
    batchPosition: integer("batch_position").notNull(),
    status: text("status").$type<RunStatus>().notNull(),
    /** Snapshotted from the action, like its config. */
    continueOnFailure: integer("continue_on_failure", { mode: "boolean" }).notNull().default(false),
    retryOfRunId: integer("retry_of_run_id"),
    outputs: json<Record<string, unknown>>("outputs"),
    error: text("error"),
    sessionId: text("session_id"),
    usage: json<RunUsage>("usage"),
    /** Set while the agent is blocked on a question, so a reload still shows what it asked. */
    question: json<AgentQuestion>("question"),
    /** Changes you asked for at an approval; the next start of this same run sends them to the agent. */
    followUp: text("follow_up"),
    /** While `quota-wait`: when the runner queues it again. */
    resumeAt: integer("resume_at"),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    endedAt: integer("ended_at"),
  },
  (t) => [
    index("runs_status_idx").on(t.status),
    index("runs_task_idx").on(t.taskId, t.bindingKey),
    index("runs_visit_idx").on(t.visitId),
    index("runs_batch_idx").on(t.batchId, t.batchPosition),
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
export type BindingRow = typeof actionBindings.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type VisitRow = typeof stageVisits.$inferSelect;
export type RunRow = typeof actionRuns.$inferSelect;
export type TimelineRow = typeof timelineEvents.$inferSelect;
