import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  type ActionTypeInfo,
  AGENT_IDS,
  type AgentId,
  APPROVAL_ACTION,
  type CreateWorkflowInput,
  createWorkflowSchema,
  NO_STAGE_AGENT_DEFAULTS,
  type SaveWorkflowInput,
  saveWorkflowSchema,
  type StageDef,
  type WorkflowDef,
  type WorkflowUsage,
} from "@wm/shared";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { ActionRegistry } from "../actions/registry";
import type { AgentService } from "../agents/service";
import type { Db, Sqlite } from "../db/client";
import * as s from "../db/schema";
import { EngineError, type Engine } from "../engine/engine";
import { git } from "../lib/git";
import { type Paths, purgeTaskDir } from "../paths";
import { clearLeftovers } from "./archive";
import type { ConnectionService } from "./connections";

type StageInput = z.output<typeof saveWorkflowSchema>["stages"][number];

/**
 * Create / edit / delete workflows.
 *
 * Editing a live workflow is safe because the runtime keeps its own copies: stage visits
 * snapshot the stage name, and a visit's runs are created (config included) when its actions
 * start. So edits apply from the next stage visit onwards and history never changes underneath
 * a task. The one thing that would strand a task is deleting the stage it is standing in, which
 * `save` refuses.
 */
export class WorkflowService {
  constructor(
    private readonly db: Db,
    private readonly sqlite: Sqlite,
    private readonly registry: ActionRegistry,
    private readonly engine: Engine,
    private readonly connections: ConnectionService,
    private readonly agents: AgentService,
    private readonly paths: Paths,
  ) {}

  actionTypes(): ActionTypeInfo[] {
    return this.registry.list().map((action) => ({
      type: action.type,
      label: action.label,
      description: action.description,
      longRunning: action.longRunning ?? false,
      connectionType: action.connectionType ?? null,
      fields: action.fields,
    }));
  }

  create(raw: CreateWorkflowInput): WorkflowDef {
    const input = createWorkflowSchema.parse(raw);
    const created = this.sqlite.transaction(() => {
      const id = randomUUID();
      const now = Date.now();
      this.db
        .insert(s.workflows)
        .values({ id, name: input.name, description: input.description, icon: input.icon, createdAt: now, updatedAt: now })
        .run();

      const stages = input.copyFromWorkflowId
        ? copyStages(this.engine.getWorkflow(input.copyFromWorkflowId).stages)
        : [{ id: randomUUID(), name: "Backlog", wipLimit: null, agentDefaults: { ...NO_STAGE_AGENT_DEFAULTS }, bindings: [] }];
      this.write(id, stages);
      return this.engine.getWorkflow(id);
    })();
    // Published outside the transaction so other tabs only hear about a workflow that is committed.
    this.engine.publish({ type: "workflow.changed", workflowId: created.id });
    return created;
  }

  /**
   * Async because validating a coding agent's model means asking the CLI which models it accepts,
   * and better-sqlite3 transactions must be synchronous — so everything that needs I/O happens
   * before the transaction opens.
   */
  async save(id: string, raw: SaveWorkflowInput): Promise<WorkflowDef> {
    const input = saveWorkflowSchema.parse(raw);
    const stages = this.validate(input.stages);
    await this.validateAgentModels(stages);

    const saved = this.sqlite.transaction(() => {
      const current = this.engine.getWorkflow(id); // 404s if it's gone
      if (input.updatedAt !== undefined && input.updatedAt !== current.updatedAt) {
        throw new EngineError("This workflow changed in another window. Reload before saving.", 409);
      }

      this.guardStageDeletions(id, current, stages);

      const now = Date.now();
      this.db
        .update(s.workflows)
        .set({ name: input.name, description: input.description, icon: input.icon, updatedAt: now })
        .where(eq(s.workflows.id, id))
        .run();
      this.write(id, stages, current);
      return this.engine.getWorkflow(id);
    })();
    this.engine.publish({ type: "workflow.changed", workflowId: id });
    return saved;
  }

  /**
   * A workflow that tasks still reference is kept unless `force`d, which deletes those tasks with it:
   * their runs are stopped, their worktrees removed (branches kept) and their files purged.
   */
  async remove(id: string, options: { force?: boolean } = {}): Promise<void> {
    this.refuseIfInUse(id, options);
    const tasks = this.db.select().from(s.tasks).where(eq(s.tasks.workflowId, id)).all();

    // Stop agents before pulling their worktrees out from under them. One at a time: git locks the worktree list.
    for (const task of tasks) this.engine.cancelActiveRuns(task.id);
    for (const task of tasks) await removeWorktree(task);

    const deleted = this.sqlite.transaction(() => {
      this.refuseIfInUse(id, options); // a task may have been created meanwhile
      const taskIds = this.db
        .select({ id: s.tasks.id })
        .from(s.tasks)
        .where(eq(s.tasks.workflowId, id))
        .all()
        .map((row) => row.id);
      this.engine.deleteTasks(taskIds);
      this.db.delete(s.workflows).where(eq(s.workflows.id, id)).run(); // cascades to stages/phases/bindings
      return taskIds;
    })();
    this.engine.publish({ type: "workflow.changed", workflowId: id });
    await Promise.all(deleted.map((taskId) => purgeTaskDir(this.paths, taskId)));
  }

  private refuseIfInUse(id: string, { force }: { force?: boolean }): void {
    const workflow = this.engine.getWorkflow(id); // 404s if it's gone
    const usage = this.engine.workflowUsage(id);
    if (force || usage.activeTasks + usage.archivedTasks === 0) return;
    throw new EngineError(
      `“${workflow.name}” still has ${describeTasks(usage)}. Delete it with its tasks, or keep it while they need it.`,
      409,
    );
  }

  // ---------------------------------------------------------------- validation

  /** Throws on anything the schema alone can't catch: references, uniqueness, action config. */
  private validate(stages: StageInput[]): StageInput[] {
    const seen = <T>(what: string, values: T[]): void => {
      const duplicate = values.find((value, index) => values.indexOf(value) !== index);
      if (duplicate !== undefined) throw new EngineError(`Duplicate ${what} “${String(duplicate)}”`);
    };

    const bindings = stages.flatMap((stage) => stage.bindings.map((binding) => ({ binding, stage })));
    seen("stage id", stages.map((stage) => stage.id));
    seen("action id", bindings.map(({ binding }) => binding.id));
    seen("action key", bindings.map(({ binding }) => binding.key));

    const stageIds = new Set(stages.map((stage) => stage.id));

    for (const { binding, stage } of bindings) {
      const where = `${stage.name} → ${binding.label}`;
      const action = this.registry.get(binding.actionType);
      if (!action) throw new EngineError(`${where}: unknown action type “${binding.actionType}”`);

      const parsed = action.configSchema.safeParse(binding.config);
      if (!parsed.success) throw new EngineError(`${where}: ${z.prettifyError(parsed.error).replace(/\n+/g, "; ")}`);
      // Store the parsed config so defaults are filled in and unknown keys dropped.
      binding.config = parsed.data as Record<string, unknown>;

      if (binding.actionType === "move-stage") {
        const target = (binding.config as { target: string }).target;
        if (target !== "next" && !stageIds.has(target)) {
          throw new EngineError(`${where}: its destination stage is not part of this workflow`);
        }
      }
      // Both the Approval action and a coding agent's own approval can offer a Send back.
      const sendBackTo = (binding.config as { sendBackTo?: string }).sendBackTo;
      if (sendBackTo && !stageIds.has(sendBackTo)) {
        throw new EngineError(`${where}: the stage it sends back to is not part of this workflow`);
      }

      // Integration actions may sit unconfigured as long as they are switched off; enabling
      // one without a live connection would only fail at the worst moment, mid-workflow.
      if (action.connectionType && binding.enabled) {
        const connectionId = (binding.config as { connectionId?: string }).connectionId ?? "";
        if (!connectionId) throw new EngineError(`${where}: choose a ${action.connectionType} connection, or turn the action off`);
        if (!this.connections.exists(connectionId, action.connectionType)) {
          throw new EngineError(`${where}: its ${action.connectionType} connection no longer exists`);
        }
      }
    }
    return stages;
  }

  /**
   * A bad model used to surface only when the agent ran, halfway through a workflow. Catching it
   * here means a workflow can't be saved with a model its agent doesn't accept, or an effort
   * level that model doesn't offer — on an action or in a stage's defaults.
   */
  private async validateAgentModels(stages: StageInput[]): Promise<void> {
    for (const stage of stages) {
      const defaults = stage.agentDefaults;
      const stageError = await this.agents.validateChoiceFor(defaults.agent, defaults.model, defaults.effort);
      if (stageError) throw new EngineError(`${stage.name} → coding-agent defaults: ${stageError}`);

      for (const binding of stage.bindings) {
        if (binding.actionType !== "coding-agent") continue;
        const config = binding.config as { agent?: string; model?: string; effort?: string };
        // A blank agent takes the stage's. With neither, the agent is only settled at run time (a
        // task override, else Claude), so the choice just has to suit some agent — as for a task override.
        const agent = AGENT_IDS.includes(config.agent as AgentId) ? (config.agent as AgentId) : defaults.agent;
        const error = await this.agents.validateChoiceFor(agent, config.model, config.effort);
        if (error) throw new EngineError(`${stage.name} → ${binding.label}: ${error}`);
      }
    }
  }

  private guardStageDeletions(workflowId: string, current: WorkflowDef, stages: StageInput[]): void {
    const kept = new Set(stages.map((stage) => stage.id));
    const removed = current.stages.filter((stage) => !kept.has(stage.id));
    if (removed.length === 0) return;

    const { activeByStage } = this.engine.workflowUsage(workflowId);
    const blocked = removed.filter((stage) => activeByStage[stage.id]);
    if (blocked.length > 0) {
      const detail = blocked.map((stage) => `${stage.name} (${activeByStage[stage.id]})`).join(", ");
      throw new EngineError(`Move the tasks out of ${detail} before deleting ${plural(blocked.length, "that stage", "those stages")}.`, 409);
    }
  }

  // ---------------------------------------------------------------- persistence

  /**
   * Applies `stages` as the complete set for the workflow.
   *
   * Order matters: bindings are re-pointed before their old stage is deleted, because that
   * cascades to `action_bindings` and would otherwise take live rows with it.
   */
  private write(workflowId: string, stages: StageInput[], current?: WorkflowDef): void {
    const keptBindings = stages.flatMap((stage) => stage.bindings.map((binding) => ({ binding, stage })));
    const removed = <T extends { id: string }>(existing: T[], kept: { id: string }[]): string[] => {
      const keptIds = new Set(kept.map((row) => row.id));
      return existing.filter((row) => !keptIds.has(row.id)).map((row) => row.id);
    };

    const goneBindings = current ? removed(current.stages.flatMap((stage) => stage.bindings), keptBindings.map((b) => b.binding)) : [];
    if (goneBindings.length > 0) {
      this.db.delete(s.actionBindings).where(inArray(s.actionBindings.id, goneBindings)).run();
    }

    stages.forEach((stage, position) => {
      const { agent: defaultAgent, model: defaultModel, effort: defaultEffort } = stage.agentDefaults;
      const set = { name: stage.name, position, wipLimit: stage.wipLimit, defaultAgent, defaultModel, defaultEffort };
      this.db
        .insert(s.stages)
        .values({ id: stage.id, workflowId, ...set })
        .onConflictDoUpdate({ target: s.stages.id, set })
        .run();
    });

    keptBindings.forEach(({ binding, stage }, position) => {
      const values = {
        id: binding.id,
        workflowId,
        stageId: stage.id,
        key: binding.key,
        label: binding.label,
        actionType: binding.actionType,
        config: binding.config,
        enabled: binding.enabled,
        continueOnFailure: binding.continueOnFailure,
        position,
      };
      const { id: _id, workflowId: _workflowId, ...set } = values;
      this.db.insert(s.actionBindings).values(values).onConflictDoUpdate({ target: s.actionBindings.id, set }).run();
    });

    if (!current) return;
    const goneStages = removed(current.stages, stages);
    if (goneStages.length > 0) this.db.delete(s.stages).where(inArray(s.stages.id, goneStages)).run();
  }
}

// ---------------------------------------------------------------- helpers

/** Deep-copies stages with fresh ids, rewriting stage-id references. */
function copyStages(stages: StageDef[]): StageInput[] {
  const ids = new Map<string, string>();
  const fresh = (old: string) => {
    const id = ids.get(old) ?? randomUUID();
    ids.set(old, id);
    return id;
  };
  for (const stage of stages) {
    fresh(stage.id);
    for (const binding of stage.bindings) fresh(binding.id);
  }
  // A stage id can appear inside config (move-stage targets, Send back); remap those too.
  const remap = (value: unknown): unknown => {
    if (typeof value === "string") return ids.get(value) ?? value;
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)]));
    }
    return value;
  };

  return stages.map((stage) => ({
    id: fresh(stage.id),
    name: stage.name,
    wipLimit: stage.wipLimit,
    agentDefaults: { ...stage.agentDefaults },
    bindings: stage.bindings.map((binding) => ({
      id: fresh(binding.id),
      key: binding.key,
      label: binding.label,
      actionType: binding.actionType,
      config: remap(binding.config) as Record<string, unknown>,
      enabled: binding.enabled,
      continueOnFailure: binding.continueOnFailure,
    })),
  }));
}

/** Best effort: a worktree git won't remove is left on disk rather than blocking the delete. */
async function removeWorktree(task: s.TaskRow): Promise<void> {
  if (!task.repoPath || !task.worktreePath || !existsSync(task.worktreePath)) return;
  try {
    await git(["worktree", "remove", "--force", task.worktreePath], { cwd: task.repoPath });
    await clearLeftovers(task.worktreePath);
  } catch (err) {
    console.warn(`Could not remove the worktree of deleted task ${task.id}:`, err);
  }
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function describeTasks({ activeTasks, archivedTasks }: WorkflowUsage): string {
  const parts: string[] = [];
  if (activeTasks) parts.push(`${activeTasks} active ${plural(activeTasks, "task", "tasks")}`);
  if (archivedTasks) parts.push(`${archivedTasks} archived ${plural(archivedTasks, "task", "tasks")}`);
  return parts.join(" and ");
}
