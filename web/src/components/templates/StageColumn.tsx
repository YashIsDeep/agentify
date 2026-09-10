import type { ActionTypeInfo } from "@wm/shared";
import { ChevronLeft, ChevronRight, CircleDot, Plus, Trash2 } from "lucide-react";
import type { Draft, DraftStage } from "../../lib/draft";
import { cls } from "../../lib/format";

/** One stage as a board-like column: its phases, then the actions bound to it. */
export function StageColumn({
  draft,
  stage,
  index,
  actions,
  selectedBindingId,
  taskCount,
  onSelectStage,
  onSelectBinding,
  onMove,
  onDelete,
  onAddBinding,
  selected,
}: {
  draft: Draft;
  stage: DraftStage;
  index: number;
  actions: ActionTypeInfo[];
  selectedBindingId: string | null;
  taskCount: number;
  selected: boolean;
  onSelectStage: () => void;
  onSelectBinding: (bindingId: string) => void;
  onMove: (delta: number) => void;
  onDelete: () => void;
  onAddBinding: (action: ActionTypeInfo) => void;
}) {
  const label = (type: string) => actions.find((action) => action.type === type)?.label ?? type;

  return (
    <section className={cls("tpl-column", selected && "tpl-column-selected")}>
      <header className="tpl-column-header">
        <button type="button" className="tpl-stage-name" onClick={onSelectStage} title="Edit this stage">
          {stage.name}
        </button>
        {taskCount > 0 && <span className="chip" title={`${taskCount} active task(s) in this stage`}>{taskCount}</span>}
        <span className="spacer" />
        <button type="button" className="icon-button" aria-label="Move stage left" onClick={() => onMove(-1)} disabled={index === 0}>
          <ChevronLeft size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Move stage right"
          onClick={() => onMove(1)}
          disabled={index === draft.stages.length - 1}
        >
          <ChevronRight size={14} />
        </button>
        <button
          type="button"
          className="icon-button danger"
          aria-label={`Delete ${stage.name}`}
          onClick={onDelete}
          disabled={draft.stages.length === 1}
          title={draft.stages.length === 1 ? "A template needs at least one stage" : `Delete ${stage.name}`}
        >
          <Trash2 size={13} />
        </button>
      </header>

      <ol className="tpl-phases">
        {stage.phases.map((phase, phaseIndex) => (
          <li key={phase.id}>
            <button type="button" className="tpl-phase" onClick={onSelectStage}>
              <span className="phase-index">{phaseIndex + 1}.</span>
              <span className="phase-name">{phase.name}</span>
              <span className="mode">{phase.completion}</span>
            </button>
          </li>
        ))}
        {stage.phases.length === 0 && <li className="muted small tpl-empty">No phases</li>}
      </ol>

      <ul className="tpl-bindings">
        {stage.bindings.map((binding) => (
          <li key={binding.id}>
            <button
              type="button"
              className={cls("tpl-binding", binding.id === selectedBindingId && "tpl-binding-selected", !binding.enabled && "tpl-binding-off")}
              onClick={() => onSelectBinding(binding.id)}
            >
              <CircleDot size={12} />
              <span className="tpl-binding-label">{binding.label}</span>
              <span className="run-type">{label(binding.actionType)}</span>
            </button>
          </li>
        ))}
      </ul>

      <AddAction actions={actions} onAdd={onAddBinding} />
    </section>
  );
}

function AddAction({ actions, onAdd }: { actions: ActionTypeInfo[]; onAdd: (action: ActionTypeInfo) => void }) {
  return (
    <label className="tpl-add">
      <Plus size={13} />
      <select
        value=""
        aria-label="Add an action to this stage"
        onChange={(event) => {
          const action = actions.find((candidate) => candidate.type === event.target.value);
          if (action) onAdd(action);
          event.currentTarget.value = "";
        }}
      >
        <option value="">Add action…</option>
        {actions.map((action) => (
          <option key={action.type} value={action.type}>
            {action.label}
          </option>
        ))}
      </select>
    </label>
  );
}
