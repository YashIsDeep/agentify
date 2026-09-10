import type { ActionField, ConnectionType, RunLogLine } from "@wm/shared";
import type { z } from "zod";
import type { AgentService } from "../agents/service";
import type { RunRow, TaskRow } from "../db/schema";
import type { Engine } from "../engine/engine";
import type { Paths } from "../paths";
import type { ArchiveOptions } from "../services/archive";
import type { ConnectionService } from "../services/connections";

export interface ActionServices {
  engine: Engine;
  paths: Paths;
  agents: AgentService;
  connections: ConnectionService;
  archiveTask(taskId: string, options?: ArchiveOptions): Promise<void>;
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
  log(text: string, stream?: RunLogLine["stream"]): void;
  signal: AbortSignal;
  services: ActionServices;
  render(template: string): string;
}

export interface ActionResult {
  outputs?: Record<string, unknown>;
  summary?: string;
  sessionId?: string | null;
  usage?: Record<string, unknown> | null;
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
  run(ctx: ActionContext<Config>): Promise<ActionResult | void>;
}

/** The config the editor starts a newly added action with. */
export function defaultConfig(definition: AnyActionDefinition): Record<string, unknown> {
  return Object.fromEntries(definition.fields.map((field) => [field.name, field.default]));
}

// The registry holds actions with heterogeneous config types.
export type AnyActionDefinition = ActionDefinition<any>;
