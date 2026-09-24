import { type ActionTypeInfo, APPROVAL_ACTION } from "@wm/shared";
import { ArrowDown, ArrowUp, Bot, ChevronDown, ChevronRight, ChevronUp, Hand, Plus, Settings2, Terminal, Trash2, Zap } from "lucide-react";
import { agentLabel } from "../../lib/agents";
import type { Draft, DraftStage } from "../../lib/draft";
import { cls, countOf } from "../../lib/format";
import { Button, IconButton, InfoTip, Menu, Tag } from "../../ui";

/** The focused stage editor, with actions in execution order. */
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
  onMoveBinding,
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
  onMoveBinding: (index: number, delta: number) => void;
}) {
  const label = (type: string) => actions.find((action) => action.type === type)?.label ?? type;

  return (
    <section className={cls("wf-column", selected && "wf-column-selected")}>
      <header className="wf-column-header">
        <div className="wf-stage-title"><span className="wf-eyebrow">Stage {index + 1} of {draft.stages.length}</span><h3>{stage.name || "Untitled stage"}</h3></div>
        <Button icon={Settings2} onClick={onSelectStage}>
          Stage settings
        </Button>
      </header>
      <div className="wf-stage-toolbar">
        <span className="muted small">
          {countOf(taskCount, "active task")}
          {stage.wipLimit ? ` · WIP limit ${stage.wipLimit}` : ""}
        </span>
        <div className="wf-stage-tools">
          <IconButton label="Move stage earlier" icon={ArrowUp} onClick={() => onMove(-1)} disabled={index === 0} />
          <IconButton label="Move stage later" icon={ArrowDown} onClick={() => onMove(1)} disabled={index === draft.stages.length - 1} />
          <IconButton
            label={`Delete ${stage.name}`}
            icon={Trash2}
            variant="danger"
            onClick={onDelete}
            // Refused on save anyway; saying so here beats finding out after a round of other edits.
            disabled={draft.stages.length === 1 || taskCount > 0}
            disabledReason={
              draft.stages.length === 1 ? "A workflow needs at least one stage" : `Tasks are still in ${stage.name}; move them on before deleting it`
            }
          />
        </div>
      </div>
      {stage.agentDefaults.agent && (
        <div className="wf-stage-agent">
          {[agentLabel(stage.agentDefaults.agent), stage.agentDefaults.model, stage.agentDefaults.effort].filter(Boolean).join(" · ")}
        </div>
      )}
      <div className="wf-action-heading"><h4>Actions <Tag>{stage.bindings.length}</Tag><InfoTip>Run top to bottom, one at a time, when a task enters this stage.</InfoTip></h4><AddAction actions={actions} onAdd={onAddBinding} /></div>
      <div className="wf-sequence">
        <ol className="wf-bindings">
          {stage.bindings.map((binding, position) => (
            <li key={binding.id} className="wf-binding-item">
              <button
                type="button"
                className={cls("wf-binding", binding.id === selectedBindingId && "wf-binding-selected", !binding.enabled && "wf-binding-off")}
                onClick={() => onSelectBinding(binding.id)}
                title={binding.enabled ? undefined : "Switched off"}
              >
                <span className="action-index">{position + 1}</span>
                <span className={`wf-action-icon ${binding.actionType === APPROVAL_ACTION ? "is-approval" : ""}`}>
                  {binding.actionType === APPROVAL_ACTION ? <Hand size={17} /> : binding.actionType === "coding-agent" ? <Bot size={17} /> : binding.actionType === "shell" ? <Terminal size={17} /> : <Zap size={17} />}
                </span>
                <span className="wf-binding-content">
                  <span className="wf-binding-label">{binding.label || label(binding.actionType)}</span>
                  <span className="wf-binding-type">{label(binding.actionType)}</span>
                </span>
                {!binding.enabled && <Tag>Off</Tag>}
                <ChevronRight size={15} />
              </button>
              <span className="wf-binding-move">
                <IconButton label={`Move ${binding.label} up`} icon={ChevronUp} size="sm" disabled={position === 0} onClick={() => onMoveBinding(position, -1)} />
                <IconButton
                  label={`Move ${binding.label} down`}
                  icon={ChevronDown}
                  size="sm"
                  disabled={position === stage.bindings.length - 1}
                  onClick={() => onMoveBinding(position, 1)}
                />
              </span>
            </li>
          ))}
          {stage.bindings.length === 0 && <li className="wf-empty"><strong>No actions</strong><span>Tasks wait here until you move them on.</span></li>}
        </ol>
      </div>
    </section>
  );
}

function AddAction({ actions, onAdd }: { actions: ActionTypeInfo[]; onAdd: (action: ActionTypeInfo) => void }) {
  const trigger = (
    <Button icon={Plus} disabled={actions.length === 0}>
      Add action
      <ChevronDown size={13} aria-hidden="true" />
    </Button>
  );
  if (actions.length === 0) return trigger;
  return (
    <Menu
      label="Choose an action"
      width={340}
      trigger={trigger}
      items={actions.map((action) => ({ key: action.type, label: action.label, hint: action.description, onSelect: () => onAdd(action) }))}
    />
  );
}
