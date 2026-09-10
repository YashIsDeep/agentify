import type { ActionTypeInfo, CompletionMode, SaveWorkflowInput, Trigger, WorkflowDef } from "@wm/shared";
import { BINDING_KEY_PATTERN } from "@wm/shared";

/**
 * The editor's working copy of a template. Ids are generated on the client so a brand-new
 * phase can be referenced by a brand-new binding before anything is saved; the server treats
 * ids it hasn't seen as inserts.
 */
export interface DraftPhase {
  id: string;
  name: string;
  completion: CompletionMode;
}

export interface DraftBinding {
  id: string;
  key: string;
  label: string;
  trigger: Trigger;
  phaseId: string | null;
  afterBindingId: string | null;
  actionType: string;
  config: Record<string, unknown>;
  enabled: boolean;
  askFeedback: boolean;
}

export interface DraftStage {
  id: string;
  name: string;
  wipLimit: number | null;
  phases: DraftPhase[];
  bindings: DraftBinding[];
}

export interface Draft {
  name: string;
  description: string;
  updatedAt: number;
  stages: DraftStage[];
}

export const newId = (): string => crypto.randomUUID();

export function toDraft(workflow: WorkflowDef): Draft {
  return {
    name: workflow.name,
    description: workflow.description,
    updatedAt: workflow.updatedAt,
    stages: workflow.stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      wipLimit: stage.wipLimit,
      phases: stage.phases.map(({ id, name, completion }) => ({ id, name, completion })),
      bindings: stage.bindings.map((binding) => ({
        id: binding.id,
        key: binding.key,
        label: binding.label,
        trigger: binding.trigger,
        phaseId: binding.phaseId,
        afterBindingId: binding.afterBindingId,
        actionType: binding.actionType,
        config: binding.config,
        enabled: binding.enabled,
        askFeedback: binding.askFeedback,
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
  const stage: DraftStage = { id: newId(), name: uniqueName(draft.stages.map((s) => s.name), "New stage"), wipLimit: null, phases: [], bindings: [] };
  const stages = [...draft.stages];
  stages.splice(at, 0, stage);
  return { draft: { ...draft, stages }, stageId: stage.id };
}

/**
 * Removes a stage plus anything that pointed at it: bindings that follow one of its actions,
 * and `move-stage` destinations. Leaving those behind would fail validation on save.
 */
export function removeStage(draft: Draft, stageId: string): Draft {
  const stage = draft.stages.find((s) => s.id === stageId);
  if (!stage) return draft;
  const goneBindingIds = new Set(stage.bindings.map((binding) => binding.id));

  return {
    ...draft,
    stages: draft.stages
      .filter((s) => s.id !== stageId)
      .map((s) => ({
        ...s,
        bindings: s.bindings
          .filter((binding) => !(binding.afterBindingId && goneBindingIds.has(binding.afterBindingId)))
          .map((binding) =>
            binding.actionType === "move-stage" && binding.config.target === stageId
              ? { ...binding, config: { ...binding.config, target: "next" } }
              : binding,
          ),
      })),
  };
}

export function addPhase(draft: Draft, stageId: string): Draft {
  const stage = draft.stages.find((s) => s.id === stageId);
  if (!stage) return draft;
  const phase: DraftPhase = { id: newId(), name: uniqueName(stage.phases.map((p) => p.name), "New phase"), completion: "manual" };
  return updateStage(draft, stageId, { phases: [...stage.phases, phase] });
}

/** Bindings tied to the phase fall back to the stage; phase triggers become stage triggers. */
export function removePhase(draft: Draft, stageId: string, phaseId: string): Draft {
  const stage = draft.stages.find((s) => s.id === stageId);
  if (!stage) return draft;
  return updateStage(draft, stageId, {
    phases: stage.phases.filter((phase) => phase.id !== phaseId),
    bindings: stage.bindings.map((binding) =>
      binding.phaseId === phaseId
        ? {
            ...binding,
            phaseId: null,
            trigger: binding.trigger === "phase.started" ? "stage.entered" : binding.trigger === "phase.completed" ? "stage.completed" : binding.trigger,
          }
        : binding,
    ),
  });
}

export function addBinding(draft: Draft, stageId: string, action: ActionTypeInfo): { draft: Draft; bindingId: string } {
  const stage = draft.stages.find((s) => s.id === stageId);
  if (!stage) return { draft, bindingId: "" };
  const binding: DraftBinding = {
    id: newId(),
    key: uniqueKey(draft, action.type),
    label: action.label,
    trigger: stage.phases.length > 0 ? "phase.started" : "stage.entered",
    phaseId: stage.phases[0]?.id ?? null,
    afterBindingId: null,
    actionType: action.type,
    config: Object.fromEntries(action.fields.map((field) => [field.name, field.default])),
    enabled: true,
    askFeedback: false,
  };
  return { draft: updateStage(draft, stageId, { bindings: [...stage.bindings, binding] }), bindingId: binding.id };
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

/** Also drops chains that followed it, which would otherwise dangle. */
export function removeBinding(draft: Draft, bindingId: string): Draft {
  return {
    ...draft,
    stages: draft.stages.map((stage) => ({
      ...stage,
      bindings: stage.bindings.filter((binding) => binding.id !== bindingId && binding.afterBindingId !== bindingId),
    })),
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
