import { useMutation, useQuery } from "@tanstack/react-query";
import type { WorkflowDef, WorkflowUsage } from "@wm/shared";
import { useState } from "react";
import { useApi } from "../../api-context";
import { countOf } from "../../lib/format";
import { Button, Callout, Checkbox, Dialog, DialogBody, DialogFooter, Field, useToast } from "../../ui";
import { EmojiPicker } from "../EmojiPicker";

/** Names a new workflow, empty or copied from `copyFrom`, and creates it. */
export function NewWorkflowDialog({
  copyFrom,
  onClose,
  onCreated,
}: {
  copyFrom: WorkflowDef | null;
  onClose: () => void;
  onCreated: (workflow: WorkflowDef) => void | Promise<void>;
}) {
  const api = useApi();
  const [name, setName] = useState(copyFrom ? `${copyFrom.name} copy` : "");
  const [icon, setIcon] = useState(copyFrom?.icon ?? "");
  const create = useMutation({
    mutationFn: () => api.createWorkflow({ name, icon, copyFromWorkflowId: copyFrom?.id ?? null }),
    onSuccess: (created) => void onCreated(created),
  });

  return (
    <Dialog title={copyFrom ? `Duplicate ${copyFrom.name}` : "New workflow"} onClose={onClose} onSubmit={() => create.mutate()}>
      <DialogBody>
        <Field label="Name" group>
          <div className="wf-name-row">
            <EmojiPicker value={icon} onChange={setIcon} label="Pick an icon" />
            <input value={name} onChange={(event) => setName(event.target.value)} autoFocus placeholder="Feature" aria-label="Name" />
          </div>
        </Field>
        {create.error && <Callout tone="danger">{create.error.message}</Callout>}
      </DialogBody>
      <DialogFooter onCancel={onClose} busy={create.isPending}>
        <Button type="submit" variant="primary" disabled={!name.trim()} loading={create.isPending} loadingText="Creating…">
          {copyFrom ? "Duplicate" : "Create workflow"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Deletes a workflow. One that tasks use takes its tasks with it, so that needs a tick first and the
 * dialog says exactly what goes.
 */
export function DeleteWorkflowDialog({
  workflow,
  onClose,
  onDeleted,
}: {
  workflow: WorkflowDef;
  onClose: () => void;
  onDeleted: () => void | Promise<void>;
}) {
  const api = useApi();
  const toast = useToast();
  // Fetched fresh on open: the count decides whether tasks go too.
  const usage = useQuery({ queryKey: ["workflow-usage", workflow.id], queryFn: () => api.workflowUsage(workflow.id), staleTime: 0 });
  const [deleteTasks, setDeleteTasks] = useState(false);
  const inUse = usage.data ? usage.data.activeTasks + usage.data.archivedTasks > 0 : false;
  const remove = useMutation({
    mutationFn: () => api.deleteWorkflow(workflow.id, inUse),
    onSuccess: async () => {
      toast(`Deleted “${workflow.name}”`);
      await onDeleted();
    },
    onError: (err) => {
      onClose();
      toast(err.message, "error");
    },
  });

  return (
    <Dialog title="Delete workflow" onClose={onClose}>
      <DialogBody lead={workflow.name}>
        {inUse && usage.data ? (
          <>
            <Callout tone="danger">
              {describeUsage(usage.data)} {usage.data.activeTasks + usage.data.archivedTasks === 1 ? "uses" : "use"} this workflow.
              Deleting it deletes them too, and that can't be undone.
            </Callout>
            <ul>
              <li>Stops anything still running on those tasks.</li>
              <li>Removes their worktrees, discarding uncommitted changes. Branches are kept.</li>
              <li>Deletes their timelines, transcripts and artifacts. They won't appear in the Archive.</li>
            </ul>
            <Checkbox checked={deleteTasks} onChange={setDeleteTasks} label="Delete the tasks as well" />
          </>
        ) : (
          <p className="muted small">This removes the workflow and its stages. No task uses it.</p>
        )}
      </DialogBody>
      <DialogFooter onCancel={onClose} busy={remove.isPending}>
        <Button
          variant="danger"
          disabled={usage.isFetching || (inUse && !deleteTasks)}
          loading={remove.isPending}
          loadingText="Deleting…"
          onClick={() => remove.mutate()}
        >
          {inUse ? "Delete workflow and tasks" : "Delete workflow"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** "2 active tasks and 1 archived task" */
function describeUsage({ activeTasks, archivedTasks }: WorkflowUsage): string {
  const parts: string[] = [];
  if (activeTasks) parts.push(countOf(activeTasks, "active task"));
  if (archivedTasks) parts.push(countOf(archivedTasks, "archived task"));
  return parts.join(" and ");
}
