import { COMPLETION_MODES } from "@wm/shared";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import type { CompletionMode } from "@wm/shared";
import type { DraftPhase, DraftStage } from "../../lib/draft";
import { moveItem } from "../../lib/draft";

export function StageForm({
  stage,
  taskCount,
  onChange,
  onAddPhase,
  onRemovePhase,
}: {
  stage: DraftStage;
  taskCount: number;
  onChange: (patch: Partial<DraftStage>) => void;
  onAddPhase: () => void;
  onRemovePhase: (phaseId: string) => void;
}) {
  const setPhase = (index: number, patch: Partial<DraftPhase>) =>
    onChange({ phases: stage.phases.map((phase, i) => (i === index ? { ...phase, ...patch } : phase)) });

  return (
    <div className="binding-form">
      <header className="section-heading">
        <h3>{stage.name || "Stage"}</h3>
      </header>

      <div className="form-grid">
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
          <span>Phases</span>
          <p className="hint">
            Tasks work through phases in order. <strong>Auto</strong> phases finish when their actions succeed;{" "}
            <strong>manual</strong> ones wait for you. Phase definitions are copied onto a task when it enters the stage, so
            edits here apply from the next visit.
          </p>
          <ol className="tpl-phase-rows">
            {stage.phases.map((phase, index) => (
              <li key={phase.id} className="tpl-phase-row">
                <span className="phase-index">{index + 1}.</span>
                <input
                  value={phase.name}
                  aria-label={`Phase ${index + 1} name`}
                  onChange={(event) => setPhase(index, { name: event.target.value })}
                />
                <select
                  value={phase.completion}
                  aria-label={`Phase ${index + 1} completion`}
                  onChange={(event) => setPhase(index, { completion: event.target.value as CompletionMode })}
                >
                  {COMPLETION_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {mode}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Move phase up"
                  disabled={index === 0}
                  onClick={() => onChange({ phases: moveItem(stage.phases, index, -1) })}
                >
                  <ChevronUp size={13} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Move phase down"
                  disabled={index === stage.phases.length - 1}
                  onClick={() => onChange({ phases: moveItem(stage.phases, index, 1) })}
                >
                  <ChevronDown size={13} />
                </button>
                <button type="button" className="icon-button danger" aria-label={`Delete ${phase.name}`} onClick={() => onRemovePhase(phase.id)}>
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ol>
          <button type="button" className="button small ghost" onClick={onAddPhase}>
            <Plus size={13} />
            Add phase
          </button>
        </div>

        {taskCount > 0 && (
          <p className="hint">
            {taskCount} active {taskCount === 1 ? "task is" : "tasks are"} in this stage. They keep the phases they entered
            with, and this stage can't be deleted until they move on.
          </p>
        )}
      </div>
    </div>
  );
}
