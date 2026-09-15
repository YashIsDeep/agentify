import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RunView, TaskSummary } from "@wm/shared";
import { TriangleAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useApi } from "../api-context";
import { useTaskAction } from "../hooks";
import { AGENTS } from "../lib/agents";
import { Modal } from "./Modal";
import { EffortSelect, keepEffort, ModelSelect, useAgentModels } from "./ModelSelect";
import { useToast } from "./Toast";

/** An approval's Send back, with a note for the next attempt. */
export function SendBackDialog({ run, stageName, onClose }: { run: RunView; stageName: string; onClose: () => void }) {
  const api = useApi();
  const [note, setNote] = useState("");
  const action = useTaskAction();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    action.mutate(() => api.sendBackRun(run.id, note), { onSuccess: onClose });
  };

  return (
    <Modal title={`Send back to ${stageName}`} onClose={onClose} width={520}>
      <form onSubmit={submit}>
        <div className="modal-body form-grid">
          <label className="field">
            <span>Note</span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
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
            Send back to {stageName}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function RetryDialog({ run, onClose }: { run: RunView; onClose: () => void }) {
  const api = useApi();
  const current = { ...run.config, ...(run.overrides ?? {}) } as { agent?: string; model?: string; effort?: string };
  // The action may leave its agent to the stage; then start from the agent that actually ran.
  const ranWith = typeof run.outputs?.agent === "string" ? run.outputs.agent : null;
  const initialAgent = current.agent || ranWith || "claude";
  const [agent, setAgent] = useState(initialAgent);
  const [model, setModel] = useState(current.model ?? "");
  const [effort, setEffort] = useState(current.effort ?? "");
  const models = useAgentModels();
  const action = useTaskAction();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    action.mutate(() => api.retryRun(run.id, { agent, model: model.trim(), effort }), { onSuccess: onClose });
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
                  setEffort(keepEffort(models.data, event.target.value, "", effort));
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
              <ModelSelect
                value={model}
                agent={agent}
                blankLabel="Default"
                onChange={(value) => {
                  setModel(value);
                  setEffort(keepEffort(models.data, agent, value, effort));
                }}
              />
            </label>
            <label className="field">
              <span>Effort</span>
              <EffortSelect value={effort} agent={agent} model={model} blankLabel="Default" onChange={setEffort} />
            </label>
          </div>
          {agent !== initialAgent && (
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
