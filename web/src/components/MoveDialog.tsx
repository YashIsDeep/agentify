import { useQuery } from "@tanstack/react-query";
import type { StageDef, TaskSummary } from "@wm/shared";
import { ArrowRight, TriangleAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useApi } from "../api-context";
import { useTaskAction } from "../hooks";
import { entryActionLabels, isActiveRun, latestAttempts } from "../lib/runs";
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
  const api = useApi();
  const [runActions, setRunActions] = useState(true);
  const move = useTaskAction();
  const entryActions = entryActionLabels(to);
  // The badge alone misses an agent that is blocked on a question ("needs you", but still running),
  // so look at the runs themselves once the detail is at hand.
  const detail = useQuery({ queryKey: ["task", task.id], queryFn: () => api.task(task.id) });
  const visit = detail.data?.visits.find((v) => v.id === detail.data.task.currentVisitId);
  const hasActiveRuns = visit
    ? latestAttempts(visit.runs).some(isActiveRun)
    : task.badge === "running" || task.badge === "queued" || task.badge === "quota";

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
            Run its actions
          </label>
          <p className="hint">
            {entryActions.length > 0 ? `In order: ${entryActions.join(" → ")}.` : `${to.name} has no actions.`}
            {!runActions && entryActions.length > 0 && " You can start them from the task later."}
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
