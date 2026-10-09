import type { ActionField, ConnectionType, RunLogLine, RunUsage } from "@wm/shared";
import type { z } from "zod";
import type { AgentService } from "../agents/service";
import type { RunRow, TaskRow } from "../db/schema";
import type { Engine } from "../engine/engine";
import type { Paths } from "../paths";
import type { ArchiveOptions } from "../services/archive";
import type { ConnectionService } from "../services/connections";
import type { QuestionService } from "../services/questions";

export interface ActionServices {
  engine: Engine;
  paths: Paths;
  agents: AgentService;
  connections: ConnectionService;
  questions: QuestionService;
  archiveTask(taskId: string, options?: ArchiveOptions): Promise<void>;
}

/**
 * Appends to the run's transcript. Most actions just write text; the coding agent passes a whole
 * entry so its output can be replayed as a conversation instead of a flat log.
 */
export interface RunLog {
  (text: string, stream?: RunLogLine["stream"]): void;
  (entry: Omit<RunLogLine, "at">): void;
}

export interface ActionContext<Config> {
  /** Already template-rendered and validated against the action's schema. */
  config: Config;
  run: RunRow;
  /** Task as it was when the run started. */
  task: TaskRow;
  artifactDir: string;
  /** WM_* variables describing the task, for child processes. */
  env: Record<string, string>;
  log: RunLog;
  signal: AbortSignal;
  services: ActionServices;
  render(template: string): string;
}

export interface ActionResult {
  outputs?: Record<string, unknown>;
  summary?: string;
  sessionId?: string | null;
  usage?: RunUsage | null;
}

/** A failure that still carries results worth recording (e.g. an agent session id to resume). */
export class ActionError extends Error {
  override name = "ActionError";
  constructor(
    message: string,
    readonly details: Omit<ActionResult, "summary">,
  ) {
    super(message);
  }
}

/** The agent hit its usage limit. The run waits instead of failing, and is queued again at `resetAt`. */
export class UsageLimitError extends ActionError {
  override name = "UsageLimitError";
  constructor(
    message: string,
    readonly resetAt: number,
    details: Omit<ActionResult, "summary"> = {},
  ) {
    super(message, details);
  }
}

export interface ActionDefinition<Config> {
  type: string;
  label: string;
  description: string;
  configSchema: z.ZodType<Config>;
  /**
   * Editable config fields, in display order. Declared rather than reflected out of
   * `configSchema` so each field can carry a widget, help text and a default; the schema
   * stays the authority on what is actually valid.
   */
  fields: ActionField[];
  /** Set when the action talks to a third-party service; its `connection` field is filtered to this type. */
  connectionType?: ConnectionType;
  /** Counts against the concurrent long-running action cap (coding agents). */
  longRunning?: boolean;
  /**
   * Set when the config holds something executed as code (a command line). The runner then checks the
   * config as written, before templates are rendered: afterwards, task text an attacker controls is
   * indistinguishable from the workflow's own.
   */
  validateBeforeRender?: boolean;
  /**
   * Set when the action works in the task's worktree, given its config as saved. The runner then
   * creates the worktree first if the task is meant to have one and hasn't, so a stage needs no
   * “Ensure worktree” above it.
   */
  worksInWorktree?: (config: Record<string, unknown>) => boolean;
  run(ctx: ActionContext<Config>): Promise<ActionResult | void>;
}

/** The config the editor starts a newly added action with. */
export function defaultConfig(definition: AnyActionDefinition): Record<string, unknown> {
  return Object.fromEntries(definition.fields.map((field) => [field.name, field.default]));
}

// The registry holds actions with heterogeneous config types.
export type AnyActionDefinition = ActionDefinition<any>;
