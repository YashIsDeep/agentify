import type { AgentId, StageAgentDefaults } from "@wm/shared";
import { AGENTS } from "../../lib/agents";
import type { DraftStage } from "../../lib/draft";
import { Field, FieldRow, FormStack } from "../../ui";
import { EffortSelect, keepEffort, ModelSelect, modelsFor, useAgentModels } from "../ModelSelect";

export function StageForm({
  stage,
  onChange,
}: {
  stage: DraftStage;
  onChange: (patch: Partial<DraftStage>) => void;
}) {
  const models = useAgentModels();
  const defaults = stage.agentDefaults;
  const setDefaults = (patch: Partial<StageAgentDefaults>) => {
    const next = { ...defaults, ...patch };
    // A model belongs to its agent and an effort to its model: drop what a new choice doesn't offer.
    if ("agent" in patch && models.data && next.agent && next.model && !modelsFor(models.data, next.agent).includes(next.model)) {
      next.model = null;
    }
    const effort = keepEffort(models.data, next.agent, next.model, next.effort ?? "") || null;
    onChange({ agentDefaults: { agent: next.agent, model: next.model, effort } });
  };

  return (
    <FormStack>
      <FieldRow>
        <Field label="Name" grow>
          <input value={stage.name} onChange={(event) => onChange({ name: event.target.value })} />
        </Field>
        <Field label="WIP limit" optional tip="A warning, shown on the board when more tasks than this are in the stage.">
          <input
            type="number"
            min={1}
            value={stage.wipLimit ?? ""}
            placeholder="None"
            onChange={(event) => onChange({ wipLimit: event.target.value === "" ? null : Number(event.target.value) })}
          />
        </Field>
      </FieldRow>

      <Field
        label="Coding agent defaults"
        group
        tip="Used by this stage's coding agents that leave agent, model or effort blank. Read as each run starts."
      >
        <FieldRow>
          <Field label="Agent">
            <select value={defaults.agent ?? ""} onChange={(event) => setDefaults({ agent: (event.target.value || null) as AgentId | null })}>
              <option value="">None</option>
              {AGENTS.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model" grow>
            <ModelSelect
              value={defaults.model ?? ""}
              agent={defaults.agent}
              blankLabel="Agent default"
              onChange={(value) => setDefaults({ model: value || null })}
            />
          </Field>
          <Field label="Effort">
            <EffortSelect
              value={defaults.effort ?? ""}
              agent={defaults.agent}
              model={defaults.model}
              onChange={(value) => setDefaults({ effort: value || null })}
            />
          </Field>
        </FieldRow>
      </Field>
    </FormStack>
  );
}
