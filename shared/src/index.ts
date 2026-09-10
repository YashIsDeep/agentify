import { z } from "zod";

// ---------- enums ----------

export const TRIGGERS = [
  "stage.entered",
  "stage.exited",
  "phase.started",
  "phase.completed",
  "stage.completed",
  "manual",
  "action.succeeded",
  "action.failed",
] as const;
export type Trigger = (typeof TRIGGERS)[number];
export const PHASE_TRIGGERS: readonly Trigger[] = ["phase.started", "phase.completed"];
export const CHAIN_TRIGGERS: readonly Trigger[] = ["action.succeeded", "action.failed"];

export const RUN_STATUSES = [
  "waiting", // later position in a batch, not yet eligible
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "skipped",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ["waiting", "queued", "running"];
export const RETRYABLE_RUN_STATUSES: readonly RunStatus[] = ["failed", "cancelled", "interrupted", "skipped"];

export const PHASE_STATUSES = ["pending", "running", "done", "failed"] as const;
export type PhaseStatus = (typeof PHASE_STATUSES)[number];

export const COMPLETION_MODES = ["auto", "manual"] as const;
export type CompletionMode = (typeof COMPLETION_MODES)[number];

export const TASK_STATUSES = ["active", "archived"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type TaskBadge = "running" | "queued" | "failed" | "needs-you" | "idle" | "archived";

// ---------- request schemas ----------

/** Offered in the task drawer. Any other type is still allowed, just not suggested. */
export const LINK_TYPES = ["jira", "linear", "notion", "github", "gitlab", "url"] as const;

export const taskLinkSchema = z.object({
  /**
   * Lower-cased on the way in. Templates read links by exact name — `{{task.links.jira}}` — so a
   * link typed "Jira" would render empty and its integration action would quietly do nothing.
   */
  type: z.string().trim().min(1).toLowerCase(),
  value: z.string().trim().min(1),
});
export type TaskLink = z.infer<typeof taskLinkSchema>;

export const createTaskSchema = z.object({
  workflowId: z.string().min(1),
  title: z.string().trim().min(1),
  description: z.string().default(""),
  repoPath: z.string().trim().min(1).nullish(),
  baseBranch: z.string().trim().min(1).nullish(),
  links: z.array(taskLinkSchema).default([]),
  tags: z.array(z.string().trim().min(1)).default([]),
  /** Defaults to the workflow's first stage. */
  stageId: z.string().min(1).optional(),
});
export type CreateTaskInput = z.input<typeof createTaskSchema>;

export const updateTaskSchema = z
  .object({
    title: z.string().trim().min(1),
    description: z.string(),
    repoPath: z.string().trim().min(1).nullable(),
    baseBranch: z.string().trim().min(1).nullable(),
    links: z.array(taskLinkSchema),
    tags: z.array(z.string().trim().min(1)),
    agentOverride: z.string().trim().min(1).nullable(),
    modelOverride: z.string().trim().min(1).nullable(),
  })
  .partial();
export type UpdateTaskInput = z.input<typeof updateTaskSchema>;

/** A repository some task already uses, offered in the task form's dropdown. */
export interface RepoInfo {
  path: string;
  /** False when the folder has since been moved or deleted. */
  exists: boolean;
}

export const listTasksQuerySchema = z.object({
  workflowId: z.string().min(1).optional(),
  status: z.enum(TASK_STATUSES).optional(),
});

export const moveTaskSchema = z.object({
  stageId: z.string().min(1),
  runActions: z.boolean().default(true),
});

export const triggerBindingSchema = z.object({
  feedback: z.string().optional(),
});

export const archiveTaskSchema = z.object({
  /** Remove the worktree even if it has uncommitted changes. */
  force: z.boolean().default(false),
});

export const retryRunSchema = z.object({
  overrides: z.record(z.string(), z.unknown()).optional(),
});

// ---------- coding agents ----------

export const AGENT_IDS = ["claude", "codex", "opencode"] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export type Autonomy = "read-only" | "autonomous";

export type AgentUsage = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** True for subscription-backed agents, where cost is notional. */
  estimated?: boolean;
};

export interface AgentStatus {
  id: AgentId;
  label: string;
  installed: boolean;
  /** Executable actually used (after resolving npm shims). */
  path: string | null;
  pathOverride: string | null;
  version: string | null;
  loggedIn: boolean | null;
  authDetail: string | null;
  error: string | null;
  installCommand: string;
  loginCommand: string;
  modelHints: string[];
}

/** The models an agent accepts, for the model dropdowns and save-time validation. */
export interface AgentModelList {
  agent: AgentId;
  models: string[];
  /** `cli` when the CLI enumerated them itself, `builtin` when we fell back to a known list. */
  source: "cli" | "builtin";
}

export interface AgentTestResult {
  ok: boolean;
  text: string;
  error: string | null;
  durationMs: number;
  usage: AgentUsage | null;
}

export const updateAgentSchema = z.object({
  /** Executable, .js entry or npm .cmd shim; null restores auto-detection. */
  path: z.string().trim().min(1).nullable(),
});

export const testAgentSchema = z.object({
  model: z.string().trim().optional(),
});

// ---------- action metadata (drives the template editor's forms) ----------

export type ActionFieldKind =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "select"
  | "stage" // a stage in this workflow, or "next"
  | "agent"
  | "model" // a model the sibling `agent` field's CLI accepts
  | "connection" // a saved connection of the action's `connectionType`
  | "key-value";

export interface ActionField {
  name: string;
  label: string;
  kind: ActionFieldKind;
  /** Value used when the action is added in the editor. */
  default: unknown;
  help?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  /** `{{task.title}}` and friends are interpolated before the run. */
  templated?: boolean;
  keyLabel?: string;
  valueLabel?: string;
}

export interface ActionTypeInfo {
  type: string;
  label: string;
  description: string;
  /** Counts against the concurrent long-running action cap. */
  longRunning: boolean;
  /** Set for integration actions; their `connection` field only lists connections of this type. */
  connectionType: ConnectionType | null;
  fields: ActionField[];
}

// ---------- connections ----------

export const CONNECTION_TYPES = ["jira", "linear", "notion"] as const;
export type ConnectionType = (typeof CONNECTION_TYPES)[number];

export interface ConnectionField {
  name: string;
  label: string;
  /** Never sent back to the browser; write-only. */
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
}

export interface ConnectionTypeInfo {
  type: ConnectionType;
  label: string;
  description: string;
  /** Where to create the credential. */
  docsUrl: string;
  fields: ConnectionField[];
}

/** A saved connection as the browser sees it: secret values are replaced by `secretsSet`. */
export interface ConnectionInfo {
  id: string;
  name: string;
  type: ConnectionType;
  values: Record<string, string>;
  /** Names of the secret fields that currently hold a value. */
  secretsSet: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ConnectionTestResult {
  ok: boolean;
  /** Who we authenticated as, when it worked. */
  detail: string;
  error: string | null;
  durationMs: number;
}

export const createConnectionSchema = z.object({
  name: z.string().trim().min(1),
  type: z.enum(CONNECTION_TYPES),
  values: z.record(z.string(), z.string()).default({}),
});
export type CreateConnectionInput = z.input<typeof createConnectionSchema>;

export const updateConnectionSchema = z.object({
  name: z.string().trim().min(1).optional(),
  /** Only the keys present are changed; omit a secret to keep it, send "" to clear it. */
  values: z.record(z.string(), z.string()).default({}),
});
export type UpdateConnectionInput = z.input<typeof updateConnectionSchema>;

// ---------- template editing ----------

/** Binding keys are referenced as `{{outputs.<key>.<field>}}`, so they must be identifiers. */
export const BINDING_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const phaseInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  completion: z.enum(COMPLETION_MODES),
});

export const bindingInputSchema = z.object({
  id: z.string().min(1),
  key: z.string().trim().regex(BINDING_KEY_PATTERN, "Use letters, digits and underscores, starting with a letter"),
  label: z.string().trim().min(1),
  trigger: z.enum(TRIGGERS),
  phaseId: z.string().min(1).nullable().default(null),
  afterBindingId: z.string().min(1).nullable().default(null),
  actionType: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
  askFeedback: z.boolean().default(false),
});

export const stageInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  wipLimit: z.number().int().positive().nullable().default(null),
  phases: z.array(phaseInputSchema).default([]),
  bindings: z.array(bindingInputSchema).default([]),
});

export const saveWorkflowSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().default(""),
  stages: z.array(stageInputSchema).min(1, "A template needs at least one stage"),
  /** The `updatedAt` the editor loaded; rejects saves over someone else's change. */
  updatedAt: z.number().optional(),
});
export type SaveWorkflowInput = z.input<typeof saveWorkflowSchema>;

export const createWorkflowSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().default(""),
  /** Copy the stages, phases and bindings of an existing template. */
  copyFromWorkflowId: z.string().min(1).nullish(),
});
export type CreateWorkflowInput = z.input<typeof createWorkflowSchema>;

// ---------- views ----------

export interface PhaseDef {
  id: string;
  name: string;
  position: number;
  completion: CompletionMode;
}

export interface BindingDef {
  id: string;
  stageId: string;
  phaseId: string | null;
  afterBindingId: string | null;
  key: string;
  label: string;
  trigger: Trigger;
  actionType: string;
  config: Record<string, unknown>;
  enabled: boolean;
  askFeedback: boolean;
  position: number;
}

export interface StageDef {
  id: string;
  name: string;
  position: number;
  wipLimit: number | null;
  phases: PhaseDef[];
  bindings: BindingDef[];
}

export interface WorkflowDef {
  id: string;
  name: string;
  description: string;
  /** Save precondition for the template editor. */
  updatedAt: number;
  stages: StageDef[];
}

/** Why a template can't be deleted / a stage can't be removed. */
export interface WorkflowUsage {
  activeTasks: number;
  archivedTasks: number;
  /** Active task counts per stage id; only stages that hold tasks appear. */
  activeByStage: Record<string, number>;
}

export interface TaskRecord {
  id: string;
  workflowId: string;
  title: string;
  description: string;
  repoPath: string | null;
  baseBranch: string | null;
  branch: string | null;
  worktreePath: string | null;
  links: TaskLink[];
  tags: string[];
  agentOverride: string | null;
  modelOverride: string | null;
  lastFeedback: string | null;
  status: TaskStatus;
  currentStageId: string | null;
  currentVisitId: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface TaskSummary extends TaskRecord {
  badge: TaskBadge;
  phaseProgress: { done: number; total: number };
  enteredStageAt: number | null;
}

export interface PhaseStateView {
  id: string;
  visitId: string;
  phaseId: string | null;
  name: string;
  position: number;
  completion: CompletionMode;
  status: PhaseStatus;
  startedAt: number | null;
  completedAt: number | null;
  completedBy: "auto" | "manual" | null;
}

export interface RunView {
  id: number;
  taskId: string;
  visitId: string;
  phaseStateId: string | null;
  bindingId: string | null;
  bindingKey: string;
  label: string;
  actionType: string;
  trigger: Trigger;
  config: Record<string, unknown>;
  overrides: Record<string, unknown> | null;
  batchId: string;
  batchPosition: number;
  status: RunStatus;
  retryOfRunId: number | null;
  parentRunId: number | null;
  outputs: Record<string, unknown> | null;
  error: string | null;
  sessionId: string | null;
  usage: Record<string, unknown> | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface VisitView {
  id: string;
  taskId: string;
  stageId: string;
  stageName: string;
  attempt: number;
  enteredAt: number;
  completedAt: number | null;
  exitedAt: number | null;
  phases: PhaseStateView[];
  runs: RunView[];
}

export interface TimelineEventView {
  id: number;
  taskId: string;
  visitId: string | null;
  runId: number | null;
  type: string;
  message: string;
  data: Record<string, unknown> | null;
  at: number;
}

export interface TaskDetail {
  task: TaskSummary;
  visits: VisitView[];
  timeline: TimelineEventView[];
}

export interface RunLogLine {
  at: number;
  stream: "stdout" | "stderr" | "info";
  text: string;
}

export interface ArtifactInfo {
  name: string;
  size: number;
  modifiedAt: number;
}

export type ServerEvent =
  | { type: "task.changed"; taskId: string }
  | { type: "run.changed"; taskId: string; runId: number }
  | { type: "timeline.appended"; taskId: string; eventId: number }
  | { type: "run.log"; taskId: string; runId: number; line: RunLogLine };
