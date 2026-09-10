import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { BindingDef, RunView, TaskSummary } from "@wm/shared";
import { TriangleAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api } from "../api";
import { useTaskAction } from "../hooks";
import { AGENTS } from "../lib/agents";
import { Modal } from "./Modal";
import { ModelSelect } from "./ModelSelect";
import { useToast } from "./Toast";

export function FeedbackDialog({
  taskId,
  binding,
  onClose,
}: {
  taskId: string;
  binding: BindingDef;
  onClose: () => void;
}) {
  const [feedback, setFeedback] = useState("");
  const action = useTaskAction();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    action.mutate(() => api.triggerAction(taskId, binding.id, feedback), { onSuccess: onClose });
  };

  return (
    <Modal title={binding.label} onClose={onClose} width={520}>
      <form onSubmit={submit}>
        <div className="modal-body form-grid">
          <label className="field">
            <span>Feedback</span>
            <textarea
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              rows={6}
              placeholder="What should change on the next attempt?"
              autoFocus
            />
          </label>
          <p className="hint">
            Saved on the task and available to prompts as <code>{"{{task.lastFeedback}}"}</code>.
          </p>
        </div>
        <footer className="modal-footer">
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={action.isPending}>
            {binding.label}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function RetryDialog({ run, onClose }: { run: RunView; onClose: () => void }) {
  const current = { ...run.config, ...(run.overrides ?? {}) } as { agent?: string; model?: string };
  const [agent, setAgent] = useState(current.agent ?? "claude");
  const [model, setModel] = useState(current.model ?? "");
  const action = useTaskAction();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    action.mutate(() => api.retryRun(run.id, { agent, model: model.trim() }), { onSuccess: onClose });
  };

  return (
    <Modal title={`Retry ${run.label}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body form-grid">
          {run.error && <div className="callout callout-danger">{run.error}</div>}
          <div className="field-row">
            <label className="field field-grow">
              <span>Agent</span>
              <select
                value={agent}
                onChange={(event) => {
                  setAgent(event.target.value);
                  setModel("");
                }}
                autoFocus
              >
                {AGENTS.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field field-grow">
              <span>Model</span>
              <ModelSelect value={model} agent={agent} onChange={setModel} />
            </label>
          </div>
          {agent !== (current.agent ?? "claude") && (
            <p className="hint">Switching agents starts a fresh session with the previous result added to the prompt.</p>
          )}
        </div>
        <footer className="modal-footer">
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={action.isPending}>
            Retry
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function ArchiveDialog({ task, onClose }: { task: TaskSummary; onClose: () => void }) {
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

  return (
    <Modal title="Archive task" onClose={onClose}>
      <div className="modal-body">
        <p className="dialog-lead">{task.title}</p>
        <ul className="plain-list">
          <li>Removes the git worktree. The branch is kept.</li>
          <li>Deletes action transcripts and logs.</li>
          <li>Keeps artifacts and the timeline, viewable from the Archive.</li>
        </ul>
        {error && (
          <div className="callout callout-danger">
            <TriangleAlert size={14} />
            <span>
              {error}
              <br />
              Force archiving discards uncommitted changes in the worktree.
            </span>
          </div>
        )}
      </div>
      <footer className="modal-footer">
        <button type="button" className="button ghost" onClick={onClose}>
          Cancel
        </button>
        {error ? (
          <button type="button" className="button danger" disabled={archive.isPending} onClick={() => archive.mutate(true)}>
            Force archive
          </button>
        ) : (
          <button type="button" className="button primary" disabled={archive.isPending} onClick={() => archive.mutate(false)} autoFocus>
            Archive
          </button>
        )}
      </footer>
    </Modal>
  );
}
