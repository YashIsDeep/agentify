import { useQuery } from "@tanstack/react-query";
import type { StageDef, TaskSummary } from "@wm/shared";
import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { useApi } from "../api-context";
import { useTaskAction } from "../hooks";
import { entryActionLabels, isActiveRun, latestAttempts } from "../lib/runs";
import { Button, Callout, Checkbox, Dialog, DialogBody, DialogFooter, Tag } from "../ui";

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

  return (
    <Dialog
      title="Move task"
      onClose={onClose}
      onSubmit={() => move.mutate(() => api.moveTask(task.id, to.id, runActions), { onSuccess: onClose })}
    >
      <DialogBody lead={task.title}>
        <div className="move-route">
          <Tag>{from?.name ?? "—"}</Tag>
          <ArrowRight size={14} aria-hidden="true" />
          <Tag tone="accent">{to.name}</Tag>
        </div>
        {hasActiveRuns && (
          <Callout tone="warn">Actions still running in {from?.name ?? "the current stage"} will be cancelled.</Callout>
        )}
        <div>
          <Checkbox checked={runActions} onChange={setRunActions} label="Run its actions" />
          <p className="muted small move-actions">
            {entryActions.length > 0 ? `In order: ${entryActions.join(" → ")}.` : `${to.name} has no actions.`}
          </p>
        </div>
      </DialogBody>
      <DialogFooter onCancel={onClose} busy={move.isPending}>
        <Button type="submit" variant="primary" loading={move.isPending} loadingText="Moving…" autoFocus>
          Move to {to.name}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
