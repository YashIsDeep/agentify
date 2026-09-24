import { type ActionTypeInfo, APPROVAL_ACTION, BINDING_KEY_PATTERN, type ConnectionInfo } from "@wm/shared";
import type { Draft, DraftBinding, DraftStage } from "../../lib/draft";
import { allBindings } from "../../lib/draft";
import { Checkbox, Disclosure, Field, FieldRow, FormStack } from "../../ui";
import { advancedCustomised, ConfigFields } from "./ConfigFields";

/**
 * One action's settings: what it is and what it does up top, then the switch that includes it in
 * the stage, and everything rarely touched (its key, timeouts, failure handling) folded away.
 */
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

  const configProps = action && {
    action,
    config: binding.config,
    stages: draft.stages,
    connections,
    stageAgent: stage.agentDefaults.agent,
    stageDefaults: stage.agentDefaults,
    onChange: (config: Record<string, unknown>) => onChange({ config }),
  };

  return (
    <FormStack>
      <FieldRow>
        <Field label="Name" grow>
          <input value={binding.label} onChange={(event) => onChange({ label: event.target.value })} />
        </Field>
        <Field label="Action" grow tip={action?.description}>
          <select value={binding.actionType} onChange={(event) => changeActionType(event.target.value)}>
            {actions.map((candidate) => (
              <option key={candidate.type} value={candidate.type}>
                {candidate.label}
              </option>
            ))}
          </select>
        </Field>
      </FieldRow>

      {configProps && <ConfigFields key={binding.id} {...configProps} />}

      <Checkbox
        checked={binding.enabled}
        onChange={(enabled) => onChange({ enabled })}
        label="Enabled"
        tip={`Switched off, it keeps its settings but is skipped.${action?.connectionType ? " Switching it on needs a connection." : ""}`}
      />

      <Disclosure
        summary="Advanced"
        defaultOpen={keyError !== null || binding.continueOnFailure || (action !== undefined && advancedCustomised(action, binding.config))}
      >
        <Field
          label="Key"
          error={keyError}
          tip={
            <>
              Later actions read this one's results as <code>{`{{outputs.${key || "key"}.…}}`}</code>.
            </>
          }
        >
          <input value={binding.key} className="mono" onChange={(event) => onChange({ key: event.target.value })} aria-invalid={keyError !== null} />
        </Field>
        {configProps && <ConfigFields key={`${binding.id}-advanced`} {...configProps} advanced />}
        {binding.actionType !== APPROVAL_ACTION && (
          <Checkbox
            checked={binding.continueOnFailure}
            onChange={(continueOnFailure) => onChange({ continueOnFailure })}
            label="Continue if this fails"
            tip="The failure still shows on the task, but the actions after it run anyway."
          />
        )}
      </Disclosure>
    </FormStack>
  );
}
