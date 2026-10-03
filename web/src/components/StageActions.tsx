import {
  actionGate,
  type AgentChoiceLayer,
  type BindingDef,
  isAgentId,
  NO_AGENT_DEFAULTS,
  resolveAgentChoice,
  type StageDef,
} from "@wm/shared";
import { Hand, ListOrdered } from "lucide-react";
import { useActionTypeLabel } from "../hooks";
import { agentLabel } from "../lib/agents";
import { IconButton, Popover } from "../ui";

/**
 * A compact header control that shows the stage's entry actions on demand. A popover rather than an
 * inline expansion: the columns are fixed-height and their bodies scroll, so growing the header
 * would push the cards out of view.
 */
export function StageActions({ stage, stages }: { stage: StageDef; stages: StageDef[] }) {
  const enabled = stage.bindings.filter((binding) => binding.enabled);
  const switchedOff = stage.bindings.filter((binding) => !binding.enabled);
  const typeLabel = useActionTypeLabel();
  if (enabled.length === 0) return null;

  return (
    <Popover
      label={`What runs in ${stage.name}`}
      align="end"
      width={320}
      className="stage-flow"
      trigger={<IconButton label={`What runs in ${stage.name}`} icon={ListOrdered} size="sm" />}
    >
      <p className="stage-flow-head">Runs in order on entry</p>
      <ol className="stage-flow-list">
        {enabled.map((binding, index) => (
          <li key={binding.id} className="stage-flow-step">
            <span className="stage-flow-index">{index + 1}</span>
            <span className="stage-flow-body">
              <span className="stage-flow-label">{binding.label}</span>
              <span className="stage-flow-notes">
                <span>{typeLabel(binding.actionType)}</span>
                {actionGate(binding.actionType, binding.config) && (
                  <span className="stage-flow-wait">
                    <Hand size={11} aria-hidden="true" />
                    Waits for you
                  </span>
                )}
                {notesFor(binding, stage, stages).map((note) => (
                  <span key={note}>{note}</span>
                ))}
              </span>
            </span>
          </li>
        ))}
      </ol>
      {switchedOff.length > 0 && (
        <p className="stage-flow-off">Switched off: {switchedOff.map((binding) => binding.label).join(", ")}</p>
      )}
    </Popover>
  );
}

/** What else the workflow pins on this action: where an approval can send back, the agent, failures. */
function notesFor(binding: BindingDef, stage: StageDef, stages: StageDef[]): string[] {
  const notes: string[] = [];
  const sendBackTo = actionGate(binding.actionType, binding.config)?.sendBackTo;
  if (sendBackTo) notes.push(`Can send back to ${stages.find((candidate) => candidate.id === sendBackTo)?.name ?? "another stage"}`);
  const agent = describeStageAgent(binding, stage);
  if (agent) notes.push(agent);
  if (binding.continueOnFailure) notes.push("Continues if it fails");
  return notes;
}

/**
 * The agent the workflow names, by the server's own layering minus the layers only a task has. A
 * blank result means nothing is pinned here, so the task's override or the agent's default decides.
 */
function describeStageAgent(binding: BindingDef, stage: StageDef): string {
  const layers: AgentChoiceLayer[] = [binding.config, stage.agentDefaults];
  if (!layers.some((layer) => isAgentId(layer.agent) || layer.model || layer.effort)) return "";
  const { agent, model, effort } = resolveAgentChoice(layers, () => NO_AGENT_DEFAULTS);
  const named = layers.some((layer) => isAgentId(layer.agent));
  return [named ? agentLabel(agent) : null, model, effort].filter(Boolean).join(" · ");
}
