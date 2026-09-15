import { randomUUID } from "node:crypto";
import {
  type ActionTypeInfo,
  AGENT_IDS,
  type AgentId,
  CHAIN_TRIGGERS,
  type CreateWorkflowInput,
  createWorkflowSchema,
  PHASE_TRIGGERS,
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
import type { ConnectionService } from "./connections";

type StageInput = z.output<typeof saveWorkflowSchema>["stages"][number];
type BindingInput = StageInput["bindings"][number];

/**
 * Create / edit / delete workflow templates.
 *
 * Editing a live template is safe because the runtime keeps its own copies: stage visits
 * snapshot the stage name, phase states snapshot the phase definitions, and action runs
 * snapshot their config. So edits apply from the next stage visit onwards and history
 * never changes underneath a task. The one thing that would strand a task is deleting the
 * stage it is standing in, which `save` refuses.
 */
export class TemplateService {
  constructor(
    private readonly db: Db,
    private readonly sqlite: Sqlite,
    private readonly registry: ActionRegistry,
    private readonly engine: Engine,
    private readonly connections: ConnectionService,
    private readonly agents: AgentService,
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
    return this.sqlite.transaction(() => {
      const id = randomUUID();
      const now = Date.now();
      this.db
        .insert(s.workflows)
        .values({ id, name: input.name, description: input.description, createdAt: now, updatedAt: now })
        .run();

      const stages = input.copyFromWorkflowId
        ? copyStages(this.engine.getWorkflow(input.copyFromWorkflowId).stages)
        : [{ id: randomUUID(), name: "Backlog", wipLimit: null, phases: [], bindings: [] }];
      this.write(id, stages);
      return this.engine.getWorkflow(id);
    })();
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

    return this.sqlite.transaction(() => {
      const current = this.engine.getWorkflow(id); // 404s if it's gone
      if (input.updatedAt !== undefined && input.updatedAt !== current.updatedAt) {
        throw new EngineError("This template changed in another window. Reload before saving.", 409);
      }

      this.guardStageDeletions(id, current, stages);

      const now = Date.now();
      this.db
        .update(s.workflows)
        .set({ name: input.name, description: input.description, updatedAt: now })
        .where(eq(s.workflows.id, id))
        .run();
      this.write(id, stages, current);
      return this.engine.getWorkflow(id);
    })();
  }

  remove(id: string): void {
    this.sqlite.transaction(() => {
      const workflow = this.engine.getWorkflow(id);
      const usage = this.engine.workflowUsage(id);
      const total = usage.activeTasks + usage.archivedTasks;
      if (total > 0) {
        throw new EngineError(
          `“${workflow.name}” still has ${describeTasks(usage)}. Templates are kept as long as any task references them.`,
          409,
        );
      }
      this.db.delete(s.workflows).where(eq(s.workflows.id, id)).run(); // cascades to stages/phases/bindings
    })();
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
    seen("phase id", stages.flatMap((stage) => stage.phases.map((phase) => phase.id)));
    seen("action id", bindings.map(({ binding }) => binding.id));
    seen("action key", bindings.map(({ binding }) => binding.key));

    const stageIds = new Set(stages.map((stage) => stage.id));
    const bindingsById = new Map(bindings.map(({ binding }) => [binding.id, binding]));

    for (const { binding, stage } of bindings) {
      const where = `${stage.name} → ${binding.label}`;
      const phaseIds = new Set(stage.phases.map((phase) => phase.id));

      if (binding.phaseId && !phaseIds.has(binding.phaseId)) {
        throw new EngineError(`${where}: the chosen phase is not in this stage`);
      }
      if (PHASE_TRIGGERS.includes(binding.trigger) && !binding.phaseId) {
        throw new EngineError(`${where}: “${binding.trigger}” needs a phase`);
      }
      if (CHAIN_TRIGGERS.includes(binding.trigger)) {
        if (!binding.afterBindingId) throw new EngineError(`${where}: “${binding.trigger}” needs an action to follow`);
        if (!bindingsById.has(binding.afterBindingId)) {
          throw new EngineError(`${where}: the action it follows no longer exists`);
        }
      } else if (binding.afterBindingId) {
        throw new EngineError(`${where}: only action.succeeded / action.failed can follow another action`);
      }

      const action = this.registry.get(binding.actionType);
      if (!action) throw new EngineError(`${where}: unknown action type “${binding.actionType}”`);

      const parsed = action.configSchema.safeParse(binding.config);
      if (!parsed.success) throw new EngineError(`${where}: ${z.prettifyError(parsed.error).replace(/\n+/g, "; ")}`);
      // Store the parsed config so defaults are filled in and unknown keys dropped.
      binding.config = parsed.data as Record<string, unknown>;

      if (binding.actionType === "move-stage") {
        const target = (binding.config as { target: string }).target;
        if (target !== "next" && !stageIds.has(target)) {
          throw new EngineError(`${where}: its destination stage is not part of this template`);
        }
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

    detectChainCycles(bindingsById);
    return stages;
  }

  /**
   * A bad model used to surface only when the agent ran, halfway through a workflow. Catching it
   * here means a template can't be saved with a model its agent doesn't accept.
   */
  private async validateAgentModels(stages: StageInput[]): Promise<void> {
    for (const stage of stages) {
      for (const binding of stage.bindings) {
        if (binding.actionType !== "coding-agent") continue;
        const config = binding.config as { agent?: string; model?: string };
        const agent = AGENT_IDS.includes(config.agent as AgentId) ? (config.agent as AgentId) : "claude";
        const error = await this.agents.validateModel(agent, config.model);
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
   * Order matters: bindings are re-pointed before their old phase or stage is deleted,
   * because both cascade to `action_bindings` and would otherwise take live rows with them.
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
      const values = { id: stage.id, workflowId, name: stage.name, position, wipLimit: stage.wipLimit };
      this.db
        .insert(s.stages)
        .values(values)
        .onConflictDoUpdate({ target: s.stages.id, set: { name: values.name, position, wipLimit: values.wipLimit } })
        .run();

      stage.phases.forEach((phase, phasePosition) => {
        this.db
          .insert(s.phases)
          .values({ id: phase.id, stageId: stage.id, name: phase.name, position: phasePosition, completion: phase.completion })
          .onConflictDoUpdate({
            target: s.phases.id,
            set: { stageId: stage.id, name: phase.name, position: phasePosition, completion: phase.completion },
          })
          .run();
      });
    });

    keptBindings.forEach(({ binding, stage }, position) => {
      const values = {
        id: binding.id,
        workflowId,
        stageId: stage.id,
        phaseId: binding.phaseId,
        // Linked in a second pass: the target may not exist yet.
        afterBindingId: null,
        key: binding.key,
        label: binding.label,
        trigger: binding.trigger,
        actionType: binding.actionType,
        config: binding.config,
        enabled: binding.enabled,
        askFeedback: binding.askFeedback,
        position,
      };
      const { id: _id, workflowId: _workflowId, ...set } = values;
      this.db.insert(s.actionBindings).values(values).onConflictDoUpdate({ target: s.actionBindings.id, set }).run();
    });

    for (const { binding } of keptBindings) {
      if (!binding.afterBindingId) continue;
      this.db
        .update(s.actionBindings)
        .set({ afterBindingId: binding.afterBindingId })
        .where(eq(s.actionBindings.id, binding.id))
        .run();
    }

    if (!current) return;
    const gonePhases = removed(
      current.stages.flatMap((stage) => stage.phases),
      stages.flatMap((stage) => stage.phases),
    );
    if (gonePhases.length > 0) this.db.delete(s.phases).where(inArray(s.phases.id, gonePhases)).run();

    const goneStages = removed(current.stages, stages);
    if (goneStages.length > 0) this.db.delete(s.stages).where(inArray(s.stages.id, goneStages)).run();
  }
}

// ---------------------------------------------------------------- helpers

/** Deep-copies stages with fresh ids, rewriting phase, chain and stage-id references. */
function copyStages(stages: StageDef[]): StageInput[] {
  const ids = new Map<string, string>();
  const fresh = (old: string) => {
    const id = ids.get(old) ?? randomUUID();
    ids.set(old, id);
    return id;
  };
  for (const stage of stages) {
    fresh(stage.id);
    for (const phase of stage.phases) fresh(phase.id);
    for (const binding of stage.bindings) fresh(binding.id);
  }
  // A stage id can appear inside config (move-stage targets); remap those too.
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
    phases: stage.phases.map((phase) => ({ id: fresh(phase.id), name: phase.name, completion: phase.completion })),
    bindings: stage.bindings.map((binding) => ({
      id: fresh(binding.id),
      key: binding.key,
      label: binding.label,
      trigger: binding.trigger,
      phaseId: binding.phaseId ? fresh(binding.phaseId) : null,
      afterBindingId: binding.afterBindingId ? fresh(binding.afterBindingId) : null,
      actionType: binding.actionType,
      config: remap(binding.config) as Record<string, unknown>,
      enabled: binding.enabled,
      askFeedback: binding.askFeedback,
    })),
  }));
}

/** `a` fires on `b` which fires on `a` would spin forever at runtime. */
function detectChainCycles(bindings: Map<string, BindingInput>): void {
  const state = new Map<string, "visiting" | "done">();
  const walk = (id: string, path: string[]): void => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      const cycle = [...path.slice(path.indexOf(id)), id].map((step) => bindings.get(step)?.label ?? step);
      throw new EngineError(`These actions trigger each other in a loop: ${cycle.join(" → ")}`);
    }
    state.set(id, "visiting");
    const after = bindings.get(id)?.afterBindingId;
    if (after) walk(after, [...path, id]);
    state.set(id, "done");
  };
  for (const id of bindings.keys()) walk(id, []);
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function describeTasks({ activeTasks, archivedTasks }: WorkflowUsage): string {
  const parts: string[] = [];
  if (activeTasks) parts.push(`${activeTasks} active ${plural(activeTasks, "task", "tasks")}`);
  if (archivedTasks) parts.push(`${archivedTasks} archived ${plural(archivedTasks, "task", "tasks")}`);
  return parts.join(" and ");
}
