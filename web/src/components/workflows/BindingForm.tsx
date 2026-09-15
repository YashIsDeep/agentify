import { type ActionTypeInfo, APPROVAL_ACTION, BINDING_KEY_PATTERN, type ConnectionInfo } from "@wm/shared";
import type { Draft, DraftBinding, DraftStage } from "../../lib/draft";
import { allBindings } from "../../lib/draft";
import { ConfigFields } from "./ConfigFields";

export function BindingForm({
  draft,
  stage,
  binding,
  actions,
  connections,
  onChange,
}: {
  draft: Draft;
  stage: DraftStage;
  binding: DraftBinding;
  actions: ActionTypeInfo[];
  connections: ConnectionInfo[];
  onChange: (patch: Partial<DraftBinding>) => void;
}) {
  const action = actions.find((candidate) => candidate.type === binding.actionType);
  const index = stage.bindings.findIndex((candidate) => candidate.id === binding.id);
  const previous = index > 0 ? stage.bindings[index - 1] : undefined;
  // Checked as it's typed, not only when the save is refused.
  const key = binding.key.trim();
  const keyError = !BINDING_KEY_PATTERN.test(key)
    ? "Use letters, digits and underscores, starting with a letter."
    : allBindings(draft).some(({ binding: other }) => other.id !== binding.id && other.key.trim() === key)
      ? "Another action in this workflow already uses this key."
      : null;

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
    <div className="form-grid wf-form">
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
            aria-invalid={keyError !== null}
          />
          {keyError ? (
            <span className="hint error">{keyError}</span>
          ) : (
            <span className="hint">
              <code>{`{{outputs.${key}}}`}</code>
            </span>
          )}
        </label>
      </div>

      <p className="hint">
        {previous
          ? `Runs after “${previous.label}”: action ${index + 1} of ${stage.bindings.length} in ${stage.name}.`
          : `Runs first when a task enters ${stage.name}.`}{" "}
        Reorder with the arrows beside each action.
      </p>

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
          stageAgent={stage.agentDefaults.agent}
          onChange={(config) => onChange({ config })}
        />
      )}

      {binding.actionType !== APPROVAL_ACTION && (
        <label className="field field-check">
          <input
            type="checkbox"
            checked={binding.continueOnFailure}
            onChange={(event) => onChange({ continueOnFailure: event.target.checked })}
          />
          <span>Continue if this fails</span>
          <span className="hint">The failure still shows on the task, but the actions after it run anyway.</span>
        </label>
      )}

      <label className="field field-check">
        <input type="checkbox" checked={binding.enabled} onChange={(event) => onChange({ enabled: event.target.checked })} />
        <span>Enabled</span>
        <span className="hint">
          {action?.connectionType
            ? "Switched-off actions stay configured but are left out when the list runs. Enabling this one needs a connection."
            : "Switched-off actions stay configured but are left out when the list runs."}
        </span>
      </label>
    </div>
  );
}
