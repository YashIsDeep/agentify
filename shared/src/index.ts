import { z } from "zod";

// ---------- workspaces ----------

export const workspaceSchema = z.object({
  id: z.union([z.literal("default"), z.uuid()]),
  name: z.string().trim().min(1).max(80),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type WorkspaceInfo = z.infer<typeof workspaceSchema>;
export const createWorkspaceSchema = z.object({ name: workspaceSchema.shape.name });
export type CreateWorkspaceInput = z.input<typeof createWorkspaceSchema>;

// ---------- enums ----------

/**
 * The action type for a gate that follows no agent — "approve once the merge request is merged".
 * The engine handles it itself: an approval never reaches the runner, it goes straight to
 * `awaiting-approval` and sits there until someone decides. A coding agent whose work you want to
 * sign off doesn't need one of these; it holds its own run open instead.
 */
export const APPROVAL_ACTION = "approval";

export const CODING_AGENT_ACTION = "coding-agent";

export const RUN_STATUSES = [
  "waiting", // later in the stage's list; runs once everything above it has finished
  "queued",
  "running",
  "awaiting-approval", // finished, and held open for you: approve, ask for changes, or send it back
  "quota-wait", // the agent hit its usage limit; requeued by itself at `resumeAt`
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "skipped", // failed or cancelled, and you chose to carry on past it
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ["waiting", "queued", "running", "awaiting-approval", "quota-wait"];
export const RETRYABLE_RUN_STATUSES: readonly RunStatus[] = ["failed", "cancelled", "interrupted", "skipped"];

export const TASK_STATUSES = ["active", "archived"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type TaskBadge = "running" | "quota" | "queued" | "failed" | "needs-you" | "idle" | "archived";

/** What a task's badge is about, so the header's lists can say more than the badge. */
export interface BadgeDetail {
  /** The action behind the badge, e.g. "Draft requirements"; for `start`, the stage. */
  label: string;
  /** Needs-you only: an agent's question, an approval, or a stage whose actions were never started. */
  reason?: "question" | "approval" | "start";
  /** Needs-you only: the agent run whose chat is where you answer or review. Absent without one. */
  chatRunId?: number;
  /** Quota only: whose limit, and when the run tries again. */
  agent?: AgentId | null;
  resetAt?: number;
}

// ---------- request schemas ----------

/** Offered in the task drawer. Any other type is still allowed, just not suggested. */
export const LINK_TYPES = ["jira", "linear", "notion", "github", "gitlab", "url"] as const;

export const taskLinkSchema = z.object({
  /**
   * Lower-cased on the way in. Template expressions read links by exact name — `{{task.links.jira}}` — so a
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
  /** Off: agents and commands work in the repository's own checkout instead of a task worktree. */
  useWorktree: z.boolean().default(true),
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
    useWorktree: z.boolean(),
    links: z.array(taskLinkSchema),
    tags: z.array(z.string().trim().min(1)),
    agentOverride: z.string().trim().min(1).nullable(),
    modelOverride: z.string().trim().min(1).nullable(),
    effortOverride: z.string().trim().min(1).nullable(),
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

export const sendBackSchema = z.object({
  /** Saved as `task.lastFeedback`; left unchanged when omitted. */
  note: z.string().optional(),
});

export const archiveTaskSchema = z.object({
  /** Remove the worktree even if it has uncommitted changes. */
  force: z.boolean().default(false),
});

export const retryRunSchema = z.object({
  overrides: z.record(z.string(), z.unknown()).optional(),
});

/** What you want changed before you approve; the agent picks its own session back up with it. */
export const requestChangesSchema = z.object({
  note: z.string().trim().min(1).max(10_000),
});

// ---------- coding agents ----------

export const AGENT_IDS = ["claude", "codex", "opencode", "cursor"] as const;
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
  /** Used when nothing more specific picks a model; null leaves it to the CLI. */
  defaultModel: string | null;
  /** Belongs to the default model: it never applies to a model chosen elsewhere. */
  defaultEffort: string | null;
}

// ---------- questions an agent asks mid-run ----------

export interface AgentQuestionField {
  id: string;
  text: string;
  /** `choice` renders the options as radio buttons, `text` as an input. */
  kind: "text" | "choice";
  options?: string[];
  multiline?: boolean;
}

/**
 * A question a running agent is blocked on. Stored on its run row rather than in memory, so
 * reloading the page (or opening the task elsewhere) still shows what is being asked.
 */
export interface AgentQuestion {
  id: string;
  runId: number;
  taskId: string;
  /** Context the agent gives before its questions. */
  preamble: string;
  fields: AgentQuestionField[];
  askedAt: number;
}

export const answerQuestionSchema = z.object({
  /** Field id → answer. A field left out is reported to the agent as unanswered. */
  answers: z.record(z.string(), z.string()).default({}),
  /** Abandon the question instead of answering; the agent is told to carry on alone. */
  skip: z.boolean().default(false),
});
export type AnswerQuestionInput = z.input<typeof answerQuestionSchema>;

/** The models an agent accepts, for the model dropdowns and save-time validation. */
export interface AgentModelList {
  agent: AgentId;
  models: string[];
  /** Reasoning-effort levels each listed model accepts, in the CLI's order; empty when it has none. */
  modelEfforts: Record<string, string[]>;
  /** Levels offered with no model chosen, or for a model the list doesn't know; empty when unknowable. */
  efforts: string[];
  /** `cli` when the CLI enumerated them itself, `builtin` when we fell back to a known list. */
  source: "cli" | "builtin";
}

/** The effort levels an agent accepts for `model`; a blank model means the CLI's own default. */
export function effortsFor(list: AgentModelList | undefined, model: string | null | undefined): string[] {
  if (!list) return [];
  const wanted = (model ?? "").trim();
  return (wanted ? list.modelEfforts[wanted] : undefined) ?? list.efforts;
}

/** One place an agent, model or effort can be set; a blank or missing field defers to the next. */
export interface AgentChoiceLayer {
  agent?: unknown;
  model?: unknown;
  effort?: unknown;
}

export interface AgentDefaults {
  model: string | null;
  effort: string | null;
}

export interface AgentChoice {
  agent: AgentId;
  model: string | null;
  effort: string | null;
}

export const NO_AGENT_DEFAULTS: AgentDefaults = { model: null, effort: null };

export const isAgentId = (value: unknown): value is AgentId => AGENT_IDS.includes(value as AgentId);
const choiceText = (value: unknown) => (typeof value === "string" && value.trim()) || null;

/**
 * Resolves layers ordered most specific first, then the chosen agent's saved defaults.
 *
 * The agent is the first one named. A model or effort only comes from a layer naming that agent or
 * none, since a Codex model means nothing to Claude. And an effort belongs to its model: once a
 * layer supplies the model, efforts further down (set for some other model) stop applying, while
 * one set above it still does — so a retry can raise the effort of the action's model.
 */
export function resolveAgentChoice(
  layers: AgentChoiceLayer[],
  defaults: (agent: AgentId) => AgentDefaults,
  fallbackAgent: AgentId = "claude",
): AgentChoice {
  const agent = layers.map((layer) => layer.agent).find(isAgentId) ?? fallbackAgent;
  let model: string | null = null;
  let effort: string | null = null;
  for (const layer of [...layers, { agent, ...defaults(agent) }]) {
    if (isAgentId(layer.agent) && layer.agent !== agent) continue;
    effort ??= choiceText(layer.effort);
    model ??= choiceText(layer.model);
    if (model) break;
  }
  return { agent, model, effort };
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

export const agentDefaultsSchema = z.object({
  /** Blank or null clears it. */
  model: z.string().trim().nullable(),
  effort: z.string().trim().nullable(),
});

export const testAgentSchema = z.object({
  /** Blank uses the agent's saved default. */
  model: z.string().trim().optional(),
  effort: z.string().trim().optional(),
});

// ---------- action metadata (drives the workflow editor's forms) ----------

export type ActionFieldKind =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "select"
  | "stage" // a stage in this workflow, or "next"
  | "agent"
  | "model" // a model the sibling `agent` field's CLI accepts
  | "effort" // a reasoning-effort level the sibling `agent` and `model` accept
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
  /** `stage` fields: offer a blank choice with this label instead of "The next stage". */
  noneLabel?: string;
  /** `{{task.title}}` and friends are interpolated before the run. */
  templated?: boolean;
  /** Only shown in the editor while the named boolean field of the same action is on. */
  dependsOn?: string;
  /** Rarely changed; the editor folds it away under "Advanced" unless it differs from its default. */
  advanced?: boolean;
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

// ---------- workflow editing ----------

/** Binding keys are referenced as `{{outputs.<key>.<field>}}`, so they must be identifiers. */
export const BINDING_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** One action in a stage's list. The list's order is the order they run in. */
export const bindingInputSchema = z.object({
  id: z.string().min(1),
  key: z.string().trim().regex(BINDING_KEY_PATTERN, "Use letters, digits and underscores, starting with a letter"),
  label: z.string().trim().min(1),
  actionType: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
  /** A failure is recorded but doesn't hold up the actions after it. */
  continueOnFailure: z.boolean().default(false),
});

const optionalChoice = z.string().trim().nullable().default(null).transform((value) => value || null);

/** Coding-agent choices a stage hands its actions for whatever they leave blank. Blank strings clear a field. */
export const stageAgentDefaultsSchema = z.object({
  agent: z
    .union([z.enum(AGENT_IDS), z.literal("")])
    .nullable()
    .default(null)
    .transform((value) => value || null),
  model: optionalChoice,
  effort: optionalChoice,
});
export type StageAgentDefaults = z.output<typeof stageAgentDefaultsSchema>;
export const NO_STAGE_AGENT_DEFAULTS: StageAgentDefaults = { agent: null, model: null, effort: null };

export const stageInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  wipLimit: z.number().int().positive().nullable().default(null),
  agentDefaults: stageAgentDefaultsSchema.default({ agent: null, model: null, effort: null }),
  bindings: z.array(bindingInputSchema).default([]),
});

/** A single emoji, or "" for the default board glyph. Emoji run long: a flag is 4 code units, a family with skin tones 20-odd. */
export const workflowIconSchema = z.string().trim().max(32).default("");

export const saveWorkflowSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().default(""),
  icon: workflowIconSchema,
  stages: z.array(stageInputSchema).min(1, "A workflow needs at least one stage"),
  /** The `updatedAt` the editor loaded; rejects saves over someone else's change. */
  updatedAt: z.number().optional(),
});
export type SaveWorkflowInput = z.input<typeof saveWorkflowSchema>;

export const createWorkflowSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().default(""),
  icon: workflowIconSchema,
  /** Copy the stages and actions of an existing workflow. */
  copyFromWorkflowId: z.string().min(1).nullish(),
});
export type CreateWorkflowInput = z.input<typeof createWorkflowSchema>;

// ---------- views ----------

export interface BindingDef {
  id: string;
  stageId: string;
  key: string;
  label: string;
  actionType: string;
  config: Record<string, unknown>;
  enabled: boolean;
  continueOnFailure: boolean;
  position: number;
}

export interface StageDef {
  id: string;
  name: string;
  position: number;
  wipLimit: number | null;
  agentDefaults: StageAgentDefaults;
  /** Run top to bottom when a task enters the stage. */
  bindings: BindingDef[];
}

/** A standalone Approval action's settings; a coding agent's sign-off uses the same shape. */
export interface ApprovalConfig {
  instructions: string;
  /** A stage id; empty when the approval offers no Send back. */
  sendBackTo: string;
  askForNote: boolean;
}

export interface WorkflowDef {
  id: string;
  name: string;
  description: string;
  /** The emoji shown on the board and in the sidebar; "" falls back to the default glyph. */
  icon: string;
  /** Save precondition for the workflow editor. */
  updatedAt: number;
  stages: StageDef[];
}

/** Why a workflow can't be deleted / a stage can't be removed. */
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
  useWorktree: boolean;
  links: TaskLink[];
  tags: string[];
  agentOverride: string | null;
  modelOverride: string | null;
  effortOverride: string | null;
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
  badgeDetail: BadgeDetail | null;
  /** How far through the current stage's actions the task is. */
  actionProgress: { done: number; total: number };
  enteredStageAt: number | null;
}

export interface RunView {
  id: number;
  taskId: string;
  visitId: string;
  bindingId: string | null;
  bindingKey: string;
  label: string;
  actionType: string;
  config: Record<string, unknown>;
  overrides: Record<string, unknown> | null;
  /** A stage visit's actions share one batch; the position is their place in the list. */
  batchId: string;
  batchPosition: number;
  status: RunStatus;
  continueOnFailure: boolean;
  retryOfRunId: number | null;
  outputs: Record<string, unknown> | null;
  error: string | null;
  sessionId: string | null;
  usage: Record<string, unknown> | null;
  /** Set while the agent is blocked waiting for an answer. */
  question: AgentQuestion | null;
  /** While `quota-wait`: when the run is queued again. */
  resumeAt: number | null;
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
  /** Empty until the stage's actions are started. */
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

/**
 * What a transcript line is, so a coding agent's run can be read as a conversation rather than a
 * wall of text. Plain actions (shell, git, artifacts) leave it unset and render as raw output.
 */
export type RunLogKind = "prompt" | "message" | "tool" | "tool-result" | "question" | "answer" | "notice";

export interface RunLogLine {
  at: number;
  stream: "stdout" | "stderr" | "info";
  text: string;
  kind?: RunLogKind;
  /** Tool name, on "tool" and "tool-result". */
  tool?: string;
  /** Pairs a "tool-result" with the "tool" line that started it. */
  ref?: string;
  /** Whether a "tool-result" succeeded. */
  ok?: boolean;
}

export interface ArtifactInfo {
  name: string;
  size: number;
  modifiedAt: number;
}

/** What happened to a file on the branch. A type change reads as a modification. */
export type TaskDiffStatus = "added" | "modified" | "deleted" | "renamed" | "copied";

export interface TaskDiffFile {
  path: string;
  /** Where the file came from, on a rename or a copy. */
  oldPath: string | null;
  status: TaskDiffStatus;
  insertions: number;
  deletions: number;
  /** Binary files have no line counts and no hunks. */
  binary: boolean;
  /** Created but never added to git. Still diffed in full; flagged so the review can say so. */
  untracked: boolean;
}

/** The branch's work, for the review stages: what changed, and the patch to read it in. */
export interface TaskDiff {
  branch: string;
  baseBranch: string;
  /** Where the diff was taken: the task's worktree, or its repository checkout. */
  path: string;
  files: TaskDiffFile[];
  insertions: number;
  deletions: number;
  /** Unified diff of the tracked files, empty when nothing has changed. */
  patch: string;
  /** The patch was cut short at the size limit; the file list is still complete. */
  truncated: boolean;
  /** Whether uncommitted work is included — it isn't when the branch isn't checked out. */
  uncommitted: boolean;
  /** The checkout has changes that aren't committed, which removing the worktree would discard. */
  dirty: boolean;
}

export type ServerEvent =
  | { type: "task.changed"; taskId: string }
  /** The workflow catalogue changed: one was created, saved or deleted. */
  | { type: "workflow.changed"; workflowId: string }
  | { type: "run.changed"; taskId: string; runId: number }
  | { type: "timeline.appended"; taskId: string; eventId: number }
  | { type: "run.log"; taskId: string; runId: number; line: RunLogLine };

// ---------- drafting a task from its ticket ----------

/** Link types the New task dialog can read a ticket from. */
export const TICKET_LINK_TYPES = ["jira", "linear"] as const;
export type TicketLinkType = (typeof TICKET_LINK_TYPES)[number];
export const isTicketLinkType = (type: string): type is TicketLinkType => TICKET_LINK_TYPES.includes(type as TicketLinkType);

export const draftFromTicketSchema = z.object({ link: taskLinkSchema });

export interface TicketDraft {
  title: string;
  description: string;
  /** The issue as its service names it, e.g. PROJ-123. */
  issueKey: string;
  connectionName: string;
  /** Who wrote the draft; null when the ticket's own text was copied. */
  drafter: AgentChoice | null;
  /** Why the ticket was copied although an agent is set to draft it. */
  warning: string | null;
  durationMs: number;
}

/** A null agent copies the ticket's own summary and description without a model. */
export const ticketDraftSettingsSchema = z.object({
  agent: z
    .union([z.enum(AGENT_IDS), z.literal("")])
    .nullable()
    .default(null)
    .transform((value) => value || null),
  model: optionalChoice,
  effort: optionalChoice,
});
export type TicketDraftSettings = z.output<typeof ticketDraftSettingsSchema>;
/** Reading a ticket is easy work, so the default is a cheap model at low effort. */
export const DEFAULT_TICKET_DRAFT_SETTINGS: TicketDraftSettings = { agent: "codex", model: "gpt-5.6-luna", effort: "low" };

/** Server-wide, shared by every workspace: how many long-running actions (agents) may run at once. */
export const concurrencySettingsSchema = z.object({ maxConcurrentAgents: z.number().int().min(1).max(50) });
export type ConcurrencySettings = z.output<typeof concurrencySettingsSchema>;
export const DEFAULT_MAX_CONCURRENT_AGENTS = 10;
