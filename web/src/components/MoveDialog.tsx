import type { StageDef, TaskSummary } from "@wm/shared";
import { ArrowRight, TriangleAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api } from "../api";
import { useTaskAction } from "../hooks";
import { entryActionLabels } from "../lib/runs";
import { Modal } from "./Modal";

export function MoveDialog({
  task,
  from,
  to,
  onClose,
}: {
  task: TaskSummary;
  from: StageDef | undefined;
  to: StageDef;
  onClose: () => void;
}) {
  const [runActions, setRunActions] = useState(true);
  const move = useTaskAction();
  const entryActions = entryActionLabels(to);
  const hasActiveRuns = task.badge === "running" || task.badge === "queued";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    move.mutate(() => api.moveTask(task.id, to.id, runActions), { onSuccess: onClose });
  };

  return (
    <Modal title="Move task" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body">
          <p className="dialog-lead">{task.title}</p>
          <div className="move-route">
            <span className="chip">{from?.name ?? "—"}</span>
            <ArrowRight size={14} />
            <span className="chip chip-strong">{to.name}</span>
          </div>
          {hasActiveRuns && (
            <div className="callout callout-warn">
              <TriangleAlert size={14} />
              Actions still running in {from?.name ?? "the current stage"} will be cancelled.
            </div>
          )}
          <label className="checkbox">
            <input type="checkbox" checked={runActions} onChange={(event) => setRunActions(event.target.checked)} />
            Run entry actions
          </label>
          <p className="hint">
            {entryActions.length > 0 ? `Will run: ${entryActions.join(", ")}.` : `${to.name} has no entry actions.`}
            {!runActions && entryActions.length > 0 && " You can complete its phases by hand."}
          </p>
        </div>
        <footer className="modal-footer">
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={move.isPending} autoFocus>
            Move to {to.name}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
