import type { AgentId, StageAgentDefaults } from "@wm/shared";
import { AGENTS } from "../../lib/agents";
import type { DraftStage } from "../../lib/draft";
import { EffortSelect, keepEffort, ModelSelect, modelsFor, useAgentModels } from "../ModelSelect";

export function StageForm({
  stage,
  taskCount,
  onChange,
}: {
  stage: DraftStage;
  taskCount: number;
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
    <div className="form-grid wf-form">
      <div className="field-row">
        <label className="field field-grow">
          <span>Name</span>
          <input value={stage.name} onChange={(event) => onChange({ name: event.target.value })} />
        </label>
        <label className="field">
          <span>WIP limit</span>
          <input
            type="number"
            min={1}
            value={stage.wipLimit ?? ""}
            placeholder="None"
            onChange={(event) => onChange({ wipLimit: event.target.value === "" ? null : Number(event.target.value) })}
          />
          <span className="hint">A warning only.</span>
        </label>
      </div>

      <div className="field">
        <span>Coding agent defaults</span>
        <div className="field-row">
          <label className="field">
            <span>Agent</span>
            <select
              value={defaults.agent ?? ""}
              onChange={(event) => setDefaults({ agent: (event.target.value || null) as AgentId | null })}
            >
              <option value="">None</option>
              {AGENTS.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field field-grow">
            <span>Model</span>
            <ModelSelect
              value={defaults.model ?? ""}
              agent={defaults.agent}
              blankLabel="Agent default"
              onChange={(value) => setDefaults({ model: value || null })}
            />
          </label>
          <label className="field">
            <span>Effort</span>
            <EffortSelect
              value={defaults.effort ?? ""}
              agent={defaults.agent}
              model={defaults.model}
              onChange={(value) => setDefaults({ effort: value || null })}
            />
          </label>
        </div>
        <p className="hint">
          Coding-agent actions in this stage use these for whatever they leave blank; the agent's own default (Agents page)
          comes after. Read as each run starts, so edits apply to the next run.
        </p>
      </div>

      <p className="hint">
        A task entering this stage runs its actions top to bottom, one at a time. Add, open and reorder them on the stage's
        editor. To sign off an agent's work, switch on <strong>Wait for my approval</strong> inside that coding agent; a
        standalone <strong>Approval</strong> is for checkpoints that follow no agent.
      </p>

      {taskCount > 0 && (
        <p className="hint">
          {taskCount} active {taskCount === 1 ? "task is" : "tasks are"} in this stage. They keep the actions they entered
          with, and this stage can't be deleted until they move on.
        </p>
      )}
    </div>
  );
}
