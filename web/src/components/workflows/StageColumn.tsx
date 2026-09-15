import { type ActionTypeInfo, APPROVAL_ACTION } from "@wm/shared";
import { ArrowDown, ArrowUp, Bot, ChevronDown, ChevronRight, ChevronUp, CircleDot, Hand, Plus, Settings2, Terminal, Trash2, Zap } from "lucide-react";
import { agentLabel } from "../../lib/agents";
import type { Draft, DraftStage } from "../../lib/draft";
import { cls } from "../../lib/format";
import { Menu } from "../Menu";

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
        <button type="button" className="button" onClick={onSelectStage}><Settings2 size={14} />Stage settings</button>
      </header>
      <div className="wf-stage-toolbar">
        <span className="hint">{taskCount} active {taskCount === 1 ? "task" : "tasks"}{stage.wipLimit ? ` · WIP limit ${stage.wipLimit}` : " · No task limit"}</span>
        <div className="wf-stage-tools">
          <button type="button" className="icon-button" aria-label="Move stage earlier" title="Move stage earlier" onClick={() => onMove(-1)} disabled={index === 0}>
            <ArrowUp size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Move stage later"
            title="Move stage later"
            onClick={() => onMove(1)}
            disabled={index === draft.stages.length - 1}
          >
            <ArrowDown size={14} />
          </button>
          <button
            type="button"
            className="icon-button danger"
            aria-label={`Delete ${stage.name}`}
            onClick={onDelete}
            // Refused on save anyway; saying so here beats finding out after a round of other edits.
            disabled={draft.stages.length === 1 || taskCount > 0}
            title={
              draft.stages.length === 1
                ? "A workflow needs at least one stage"
                : taskCount > 0
                  ? `Tasks are still in ${stage.name}; move them on before deleting it`
                  : `Delete ${stage.name}`
            }
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      {stage.agentDefaults.agent && <div className="wf-stage-agent" title={stage.agentDefaults.model ?? undefined}>{agentLabel(stage.agentDefaults.agent)}{stage.agentDefaults.model ? ` · ${stage.agentDefaults.model}` : ""}</div>}
      <div className="wf-action-heading"><div><h4>Actions <span className="chip">{stage.bindings.length}</span></h4><p className="hint">Run in order when a task enters this stage.</p></div><AddAction actions={actions} onAdd={onAddBinding} /></div>
      {/* Scrolls as one piece so the end-of-sequence marker only shows when the last action does. */}
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
                <span className="action-index">{String(position + 1).padStart(2, "0")}</span>
                <span className={`wf-action-icon ${binding.actionType === APPROVAL_ACTION ? "is-approval" : ""}`}>
                  {binding.actionType === APPROVAL_ACTION ? <Hand size={17} /> : binding.actionType === "coding-agent" ? <Bot size={17} /> : binding.actionType === "shell" ? <Terminal size={17} /> : <Zap size={17} />}
                </span>
                <span className="wf-binding-content">
                  <span className="wf-binding-label">{binding.label || label(binding.actionType)}</span>
                  <span className="wf-binding-type">{label(binding.actionType)}</span>
                </span>
                {!binding.enabled && <span className="chip">Disabled</span>}
                <ChevronRight size={15} />
              </button>
              <span className="wf-binding-move">
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Move ${binding.label} up`}
                  disabled={position === 0}
                  onClick={() => onMoveBinding(position, -1)}
                >
                  <ChevronUp size={12} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Move ${binding.label} down`}
                  disabled={position === stage.bindings.length - 1}
                  onClick={() => onMoveBinding(position, 1)}
                >
                  <ChevronDown size={12} />
                </button>
              </span>
            </li>
          ))}
          {stage.bindings.length === 0 && <li className="wf-empty"><span className="wf-empty-icon"><CircleDot size={24} /></span><strong>A little breathing room</strong><span>Tasks pause here until you move them.<br />Add an action when you’re ready to automate this step.</span></li>}
        </ol>
        {stage.bindings.length > 0 && <p className="wf-sequence-end"><CircleDot size={12} />End of this stage’s action sequence</p>}
      </div>
    </section>
  );
}

function AddAction({ actions, onAdd }: { actions: ActionTypeInfo[]; onAdd: (action: ActionTypeInfo) => void }) {
  if (actions.length === 0) return <button type="button" className="button" disabled><Plus size={14} />Add action</button>;
  return (
    <div className="wf-action-menu"><Menu label="Choose an action" trigger={<><Plus size={14} />Add action<ChevronDown size={13} /></>} triggerClassName="button"
      items={actions.map((action) => ({ key: action.type, label: action.label, hint: action.description, onSelect: () => onAdd(action) }))} /></div>
  );
}
