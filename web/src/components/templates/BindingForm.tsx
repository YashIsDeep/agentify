import { type ActionTypeInfo, CHAIN_TRIGGERS, type ConnectionInfo, PHASE_TRIGGERS, TRIGGERS, type Trigger } from "@wm/shared";
import { Trash2 } from "lucide-react";
import type { Draft, DraftBinding, DraftStage } from "../../lib/draft";
import { allBindings } from "../../lib/draft";
import { ConfigFields } from "./ConfigFields";

const TRIGGER_LABELS: Record<Trigger, string> = {
  "stage.entered": "When the task enters this stage",
  "stage.exited": "When the task leaves this stage",
  "phase.started": "When a phase starts",
  "phase.completed": "When a phase completes",
  "stage.completed": "When every phase is done",
  manual: "When I press a button",
  "action.succeeded": "After another action succeeds",
  "action.failed": "After another action fails",
};

export function BindingForm({
  draft,
  stage,
  binding,
  actions,
  connections,
  onChange,
  onDelete,
}: {
  draft: Draft;
  stage: DraftStage;
  binding: DraftBinding;
  actions: ActionTypeInfo[];
  connections: ConnectionInfo[];
  onChange: (patch: Partial<DraftBinding>) => void;
  onDelete: () => void;
}) {
  const action = actions.find((candidate) => candidate.type === binding.actionType);
  const needsPhase = PHASE_TRIGGERS.includes(binding.trigger);
  const isChain = CHAIN_TRIGGERS.includes(binding.trigger);
  // An action can't follow itself, and chaining across stages never fires.
  const candidates = allBindings(draft).filter(({ binding: other, stage: from }) => other.id !== binding.id && from.id === stage.id);

  const changeTrigger = (trigger: Trigger) =>
    onChange({
      trigger,
      phaseId: PHASE_TRIGGERS.includes(trigger) ? (binding.phaseId ?? stage.phases[0]?.id ?? null) : binding.phaseId,
      afterBindingId: CHAIN_TRIGGERS.includes(trigger) ? (binding.afterBindingId ?? candidates[0]?.binding.id ?? null) : null,
    });

  const changeActionType = (type: string) => {
    const next = actions.find((candidate) => candidate.type === type);
    if (!next) return;
    onChange({
      actionType: type,
      config: Object.fromEntries(next.fields.map((field) => [field.name, field.default])),
      label: binding.label === action?.label ? next.label : binding.label,
    });
  };

  return (
    <div className="binding-form">
      <header className="section-heading">
        <h3>{binding.label || "Action"}</h3>
        <span className="spacer" />
        <button type="button" className="button small danger ghost" onClick={onDelete}>
          <Trash2 size={13} />
          Delete
        </button>
      </header>

      <div className="form-grid">
        <div className="field-row">
          <label className="field field-grow">
            <span>Name</span>
            <input value={binding.label} onChange={(event) => onChange({ label: event.target.value })} />
          </label>
          <label className="field">
            <span>Key</span>
            <input
              value={binding.key}
              className="mono"
              onChange={(event) => onChange({ key: event.target.value })}
            />
            <span className="hint">
              <code>{`{{outputs.${binding.key || "key"}}}`}</code>
            </span>
          </label>
        </div>

        <label className="field">
          <span>Runs</span>
          <select value={binding.trigger} onChange={(event) => changeTrigger(event.target.value as Trigger)}>
            {TRIGGERS.map((trigger) => (
              <option key={trigger} value={trigger}>
                {TRIGGER_LABELS[trigger]}
              </option>
            ))}
          </select>
        </label>

        {(needsPhase || binding.phaseId) && (
          <label className="field">
            <span>Phase</span>
            <select value={binding.phaseId ?? ""} onChange={(event) => onChange({ phaseId: event.target.value || null })}>
              {!needsPhase && <option value="">Not tied to a phase</option>}
              {stage.phases.map((phase) => (
                <option key={phase.id} value={phase.id}>
                  {phase.name}
                </option>
              ))}
            </select>
            {needsPhase && stage.phases.length === 0 && <span className="hint error">Add a phase to this stage first.</span>}
          </label>
        )}

        {isChain && (
          <label className="field">
            <span>After</span>
            <select value={binding.afterBindingId ?? ""} onChange={(event) => onChange({ afterBindingId: event.target.value || null })}>
              <option value="">Choose an action…</option>
              {candidates.map(({ binding: other }) => (
                <option key={other.id} value={other.id}>
                  {other.label}
                </option>
              ))}
            </select>
            {candidates.length === 0 && <span className="hint error">This stage has no other action to follow.</span>}
          </label>
        )}

        {binding.trigger === "manual" && (
          <label className="field field-check">
            <input type="checkbox" checked={binding.askFeedback} onChange={(event) => onChange({ askFeedback: event.target.checked })} />
            <span>Ask me for a note first</span>
            <span className="hint">
              Saved on the task and available to prompts as <code>{"{{task.lastFeedback}}"}</code>.
            </span>
          </label>
        )}

        <label className="field">
          <span>Action</span>
          <select value={binding.actionType} onChange={(event) => changeActionType(event.target.value)}>
            {actions.map((candidate) => (
              <option key={candidate.type} value={candidate.type}>
                {candidate.label}
              </option>
            ))}
          </select>
          {action && <span className="hint">{action.description}</span>}
        </label>

        {action && (
          <ConfigFields
            key={binding.id}
            action={action}
            config={binding.config}
            stages={draft.stages}
            connections={connections}
            onChange={(config) => onChange({ config })}
          />
        )}

        <label className="field field-check">
          <input type="checkbox" checked={binding.enabled} onChange={(event) => onChange({ enabled: event.target.checked })} />
          <span>Enabled</span>
          <span className="hint">
            {action?.connectionType
              ? "Disabled actions stay configured but never run. Enabling this one needs a connection."
              : "Disabled actions stay configured but never run."}
          </span>
        </label>
      </div>
    </div>
  );
}
