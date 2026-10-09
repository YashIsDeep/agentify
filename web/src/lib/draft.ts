import type { ActionTypeInfo, SaveWorkflowInput, StageAgentDefaults, WorkflowDef } from "@wm/shared";
import { APPROVAL_ACTION, BINDING_KEY_PATTERN, NO_STAGE_AGENT_DEFAULTS } from "@wm/shared";

/**
 * The editor's working copy of a workflow. Ids are generated on the client so a brand-new stage can
 * be referenced (a Send back, a move) before anything is saved; the server treats ids it hasn't
 * seen as inserts.
 */
export interface DraftBinding {
  id: string;
  key: string;
  label: string;
  actionType: string;
  config: Record<string, unknown>;
  enabled: boolean;
  continueOnFailure: boolean;
}

export interface DraftStage {
  id: string;
  name: string;
  wipLimit: number | null;
  agentDefaults: StageAgentDefaults;
  stayWhenDone: boolean;
  /** In the order they run. */
  bindings: DraftBinding[];
}

export interface Draft {
  name: string;
  description: string;
  icon: string;
  updatedAt: number;
  stages: DraftStage[];
}

export const newId = (): string => crypto.randomUUID();

export function toDraft(workflow: WorkflowDef): Draft {
  return {
    name: workflow.name,
    description: workflow.description,
    icon: workflow.icon,
    updatedAt: workflow.updatedAt,
    stages: workflow.stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      wipLimit: stage.wipLimit,
      agentDefaults: { ...stage.agentDefaults },
      stayWhenDone: stage.stayWhenDone,
      bindings: stage.bindings.map((binding) => ({
        id: binding.id,
        key: binding.key,
        label: binding.label,
        actionType: binding.actionType,
        config: binding.config,
        enabled: binding.enabled,
        continueOnFailure: binding.continueOnFailure,
      })),
    })),
  };
}

export const toSaveInput = (draft: Draft): SaveWorkflowInput => draft;

export const isDirty = (draft: Draft, workflow: WorkflowDef): boolean =>
  JSON.stringify(draft) !== JSON.stringify(toDraft(workflow));

// ---------------------------------------------------------------- list edits

/** Moves `index` by `delta`, clamped. Returns the same array when nothing would change. */
export function moveItem<T>(items: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= items.length || index < 0 || index >= items.length) return items;
  const next = [...items];
  next.splice(target, 0, ...next.splice(index, 1));
  return next;
}

export const replaceAt = <T>(items: T[], index: number, item: T): T[] =>
  items.map((existing, i) => (i === index ? item : existing));

// ---------------------------------------------------------------- draft edits

export const updateStage = (draft: Draft, stageId: string, patch: Partial<DraftStage>): Draft => ({
  ...draft,
  stages: draft.stages.map((stage) => (stage.id === stageId ? { ...stage, ...patch } : stage)),
});

export function addStage(draft: Draft, at = draft.stages.length): { draft: Draft; stageId: string } {
  const stage: DraftStage = {
    id: newId(),
    name: uniqueName(draft.stages.map((s) => s.name), "New stage"),
    wipLimit: null,
    agentDefaults: { ...NO_STAGE_AGENT_DEFAULTS },
    stayWhenDone: false,
    bindings: [],
  };
  const stages = [...draft.stages];
  stages.splice(at, 0, stage);
  return { draft: { ...draft, stages }, stageId: stage.id };
}

/**
 * Removes a stage plus anything that pointed at it: `move-stage` destinations fall back to the next
 * stage and Send backs are dropped. Leaving them behind would fail validation on save.
 */
export function removeStage(draft: Draft, stageId: string): Draft {
  if (!draft.stages.some((s) => s.id === stageId)) return draft;
  return {
    ...draft,
    stages: draft.stages
      .filter((s) => s.id !== stageId)
      .map((s) => ({
        ...s,
        bindings: s.bindings.map((binding) => {
          if (binding.actionType === "move-stage" && binding.config.target === stageId) {
            return { ...binding, config: { ...binding.config, target: "next" } };
          }
          // Both the Approval action and a coding agent's own approval can point at a stage.
          if (binding.config.sendBackTo === stageId) {
            return { ...binding, config: { ...binding.config, sendBackTo: "" } };
          }
          return binding;
        }),
      })),
  };
}

/** A named starting point for an action, such as a coding agent's Plan loop. */
export interface ActionPreset {
  label: string;
  config: Record<string, unknown>;
}

/** Appends to the end of the stage's list, where it runs last. */
export function addBinding(
  draft: Draft,
  stageId: string,
  action: ActionTypeInfo,
  preset?: ActionPreset,
): { draft: Draft; bindingId: string } {
  const stage = draft.stages.find((s) => s.id === stageId);
  if (!stage) return { draft, bindingId: "" };
  const binding: DraftBinding = {
    id: newId(),
    key: uniqueKey(draft, action.type),
    label: preset?.label ?? action.label,
    actionType: action.type,
    config: { ...Object.fromEntries(action.fields.map((field) => [field.name, field.default])), ...preset?.config },
    enabled: true,
    continueOnFailure: false,
  };
  return { draft: updateStage(draft, stageId, { bindings: [...stage.bindings, binding] }), bindingId: binding.id };
}

export function moveBinding(draft: Draft, stageId: string, index: number, delta: number): Draft {
  const stage = draft.stages.find((s) => s.id === stageId);
  if (!stage) return draft;
  const bindings = moveItem(stage.bindings, index, delta);
  return bindings === stage.bindings ? draft : updateStage(draft, stageId, { bindings });
}

export function updateBinding(draft: Draft, bindingId: string, patch: Partial<DraftBinding>): Draft {
  return {
    ...draft,
    stages: draft.stages.map((stage) => ({
      ...stage,
      bindings: stage.bindings.map((binding) => (binding.id === bindingId ? { ...binding, ...patch } : binding)),
    })),
  };
}

export function removeBinding(draft: Draft, bindingId: string): Draft {
  return {
    ...draft,
    stages: draft.stages.map((stage) => ({ ...stage, bindings: stage.bindings.filter((binding) => binding.id !== bindingId) })),
  };
}

export const allBindings = (draft: Draft): { binding: DraftBinding; stage: DraftStage }[] =>
  draft.stages.flatMap((stage) => stage.bindings.map((binding) => ({ binding, stage })));

// ---------------------------------------------------------------- naming

function uniqueName(existing: string[], base: string): string {
  if (!existing.includes(base)) return base;
  for (let n = 2; ; n++) if (!existing.includes(`${base} ${n}`)) return `${base} ${n}`;
}

/** Turns an action type into a valid, unused binding key: "coding-agent" → "codingAgent2". */
export function uniqueKey(draft: Draft, base: string): string {
  const camel = base.replace(/[-_ ]+(.)/g, (_match, char: string) => char.toUpperCase()).replace(/[^A-Za-z0-9_]/g, "");
  const seed = BINDING_KEY_PATTERN.test(camel) ? camel : `action${camel}`;
  const taken = new Set(allBindings(draft).map(({ binding }) => binding.key));
  if (!taken.has(seed)) return seed;
  for (let n = 2; ; n++) if (!taken.has(`${seed}${n}`)) return `${seed}${n}`;
}
