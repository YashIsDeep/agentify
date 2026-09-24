import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RunView, TaskSummary } from "@wm/shared";
import { useState } from "react";
import { useApi } from "../api-context";
import { useTaskAction } from "../hooks";
import { AGENTS } from "../lib/agents";
import { Button, Callout, Dialog, DialogBody, DialogFooter, Field, FieldRow, useToast } from "../ui";
import { EffortSelect, keepEffort, ModelSelect, useAgentModels } from "./ModelSelect";

/** An approval's Send back, with a note for the next attempt. */
export function SendBackDialog({ run, stageName, onClose }: { run: RunView; stageName: string; onClose: () => void }) {
  const api = useApi();
  const [note, setNote] = useState("");
  const action = useTaskAction();

  return (
    <Dialog
      title={`Send back to ${stageName}`}
      size="md"
      onClose={onClose}
      onSubmit={() => action.mutate(() => api.sendBackRun(run.id, note), { onSuccess: onClose })}
    >
      <DialogBody>
        <Field
          label="Note"
          tip={
            <>
              Saved on the task, where prompts can use it as <code>{"{{task.lastFeedback}}"}</code>.
            </>
          }
        >
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={6}
            placeholder="What should change on the next attempt?"
            autoFocus
          />
        </Field>
      </DialogBody>
      <DialogFooter onCancel={onClose} busy={action.isPending}>
        <Button type="submit" variant="primary" loading={action.isPending} loadingText="Sending back…">
          Send back to {stageName}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

export function RetryDialog({ run, onClose }: { run: RunView; onClose: () => void }) {
  const api = useApi();
  const current = { ...run.config, ...(run.overrides ?? {}) } as { agent?: string; model?: string; effort?: string };
  // The action may leave its agent to the stage; then start from the agent that actually ran.
  const ranWith = typeof run.outputs?.agent === "string" ? run.outputs.agent : null;
  const [agent, setAgent] = useState(current.agent || ranWith || "claude");
  const [model, setModel] = useState(current.model ?? "");
  const [effort, setEffort] = useState(current.effort ?? "");
  const models = useAgentModels();
  const action = useTaskAction();

  return (
    <Dialog
      title={`Retry ${run.label}`}
      size="md"
      onClose={onClose}
      onSubmit={() => action.mutate(() => api.retryRun(run.id, { agent, model: model.trim(), effort }), { onSuccess: onClose })}
    >
      <DialogBody>
        {run.error && <Callout tone="danger">{run.error}</Callout>}
        <FieldRow>
          <Field label="Agent" tip="Switching agents starts a fresh session, with the previous result added to the prompt.">
            <select
              value={agent}
              onChange={(event) => {
                setAgent(event.target.value);
                setModel("");
                setEffort(keepEffort(models.data, event.target.value, "", effort));
              }}
              autoFocus
            >
              {AGENTS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model" grow>
            <ModelSelect
              value={model}
              agent={agent}
              blankLabel="Default"
              onChange={(value) => {
                setModel(value);
                setEffort(keepEffort(models.data, agent, value, effort));
              }}
            />
          </Field>
          <Field label="Effort">
            <EffortSelect value={effort} agent={agent} model={model} blankLabel="Default" onChange={setEffort} />
          </Field>
        </FieldRow>
      </DialogBody>
      <DialogFooter onCancel={onClose} busy={action.isPending}>
        <Button type="submit" variant="primary" loading={action.isPending} loadingText="Retrying…">
          Retry
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

export function ArchiveDialog({ task, onClose }: { task: TaskSummary; onClose: () => void }) {
  const api = useApi();
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const toast = useToast();
  const archive = useMutation({
    mutationFn: (force: boolean) => api.archiveTask(task.id, force),
    onSuccess: (detail) => {
      queryClient.setQueryData(["task", detail.task.id], detail);
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      toast(`Archived “${detail.task.title}”`);
      onClose();
    },
    onError: (err) => setError(err.message),
  });
  // Shares the review card's query. Only a task with its own worktree loses anything here.
  const diff = useQuery({
    queryKey: ["diff", task.id],
    queryFn: () => api.taskDiff(task.id),
    enabled: !!task.worktreePath && !!task.branch,
  });
  const dirty = diff.data?.dirty ?? false;
  const force = dirty || !!error;

  return (
    <Dialog title="Archive task" onClose={onClose}>
      <DialogBody lead={task.title}>
        <ul>
          <li>Removes the git worktree. The branch is kept.</li>
          <li>Deletes action transcripts and logs.</li>
          <li>Keeps artifacts and the timeline, viewable from the Archive.</li>
        </ul>
        {dirty && !error && (
          <Callout tone="warn">
            The worktree has changes that aren't committed. Archiving discards them; commit them first to keep them on{" "}
            {task.branch}.
          </Callout>
        )}
        {error && (
          <Callout tone="danger">
            {error}
            {"\n"}Force archiving discards uncommitted changes in the worktree.
          </Callout>
        )}
      </DialogBody>
      <DialogFooter onCancel={onClose} busy={archive.isPending}>
        {force ? (
          <Button variant="danger" loading={archive.isPending} loadingText="Archiving…" onClick={() => archive.mutate(true)}>
            {error ? "Force archive" : "Discard changes and archive"}
          </Button>
        ) : (
          <Button variant="primary" loading={archive.isPending} loadingText="Archiving…" onClick={() => archive.mutate(false)}>
            Archive task
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
