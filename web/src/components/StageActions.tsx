import {
  APPROVAL_ACTION,
  CODING_AGENT_ACTION,
  type AgentChoiceLayer,
  type BindingDef,
  isAgentId,
  NO_AGENT_DEFAULTS,
  resolveAgentChoice,
  type StageDef,
} from "@wm/shared";
import { Hand, ListOrdered } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { agentLabel } from "../lib/agents";

/**
 * A compact header control reveals the stage's entry actions on demand.
 * A popover rather than an inline expansion: the columns are fixed-height and their bodies scroll,
 * so growing the header would push the cards out of view.
 */
export function StageActions({ stage, stages }: { stage: StageDef; stages: StageDef[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const enabled = stage.bindings.filter((binding) => binding.enabled);
  const switchedOff = stage.bindings.filter((binding) => !binding.enabled);
  const approvals = enabled.filter(waitsForYou).length;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    // Capture phase: the triggers stop pointerdown from bubbling, so a click on another column's
    // trigger would never reach document and both popovers would stand open at once.
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  if (enabled.length === 0) return null;

  const onKeyDown = (event: KeyboardEvent) => {
    if (!open || event.key !== "Escape") return;
    // Stop here so an open task drawer doesn't close along with the popover.
    event.stopPropagation();
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className="column-actions" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className="column-actions-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${open ? "Hide" : "Show"} what runs in ${stage.name}`}
        title={`${enabled.length} ${enabled.length === 1 ? "action" : "actions"}${approvals > 0 ? " · Includes approval" : ""}`}
        // The header sits inside the column's drop target, so keep the press to this button.
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <ListOrdered size={15} />
      </button>
      {open && (
        <div id={panelId} className="stage-flow">
          <p className="stage-flow-head">Runs in order on entry</p>
          <ol className="stage-flow-list">
            {enabled.map((binding, index) => (
              <li key={binding.id} className="stage-flow-step">
                <span className="stage-flow-index">{index + 1}</span>
                <span className="stage-flow-body">
                  <span className="stage-flow-label">{binding.label}</span>
                  <span className="stage-flow-notes">
                    <span className="stage-flow-type">{binding.actionType}</span>
                    {waitsForYou(binding) && (
                      <span className="stage-flow-wait">
                        <Hand size={11} />
                        Waits for you
                      </span>
                    )}
                    {notesFor(binding, stage, stages).map((note) => (
                      <span key={note} className="stage-flow-note">
                        {note}
                      </span>
                    ))}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          {switchedOff.length > 0 && (
            <p className="stage-flow-off">Switched off: {switchedOff.map((binding) => binding.label).join(", ")}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** An Approval action, or a coding agent told to hold its run open until you sign the work off. */
const waitsForYou = (binding: BindingDef): boolean =>
  binding.actionType === APPROVAL_ACTION || (binding.actionType === CODING_AGENT_ACTION && binding.config.requireApproval === true);

/** What else the workflow pins on this action: where an approval can send back, the agent, failures. */
function notesFor(binding: BindingDef, stage: StageDef, stages: StageDef[]): string[] {
  const notes: string[] = [];
  const sendBackTo = typeof binding.config.sendBackTo === "string" ? binding.config.sendBackTo : "";
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
