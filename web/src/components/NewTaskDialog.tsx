import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { WorkflowDef } from "@wm/shared";
import { type FormEvent, useState } from "react";
import { api } from "../api";
import { parseTags } from "../lib/format";
import { Modal } from "./Modal";
import { RepoFields } from "./RepoFields";
import { useToast } from "./Toast";

export function NewTaskDialog({
  workflows,
  defaultWorkflowId,
  onClose,
  onCreated,
}: {
  workflows: WorkflowDef[];
  defaultWorkflowId: string;
  onClose: () => void;
  onCreated: (taskId: string) => void;
}) {
  const [form, setForm] = useState({
    workflowId: defaultWorkflowId,
    stageId: "",
    title: "",
    description: "",
    repoPath: "",
    baseBranch: "",
    tags: "",
  });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value, ...(key === "workflowId" ? { stageId: "" } : {}) }));
  const workflow = workflows.find((w) => w.id === form.workflowId);

  const queryClient = useQueryClient();
  const toast = useToast();
  const create = useMutation({
    mutationFn: () =>
      api.createTask({
        workflowId: form.workflowId,
        stageId: form.stageId || undefined,
        title: form.title,
        description: form.description,
        repoPath: form.repoPath.trim() || null,
        baseBranch: form.baseBranch.trim() || null,
        tags: parseTags(form.tags),
      }),
    onSuccess: (detail) => {
      queryClient.setQueryData(["task", detail.task.id], detail);
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      toast(`Created “${detail.task.title}”`);
      onCreated(detail.task.id);
    },
    onError: (error) => toast(error.message, "error"),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (form.title.trim()) create.mutate();
  };

  return (
    <Modal title="New task" onClose={onClose} width={540}>
      <form onSubmit={submit}>
        <div className="modal-body form-grid">
          <label className="field">
            <span>Title</span>
            <input value={form.title} onChange={set("title")} placeholder="Add login page" autoFocus required />
          </label>
          <label className="field">
            <span>Description</span>
            <textarea value={form.description} onChange={set("description")} rows={4} placeholder="Markdown supported" />
          </label>
          <div className="field-row">
            <label className="field">
              <span>Workflow</span>
              <select value={form.workflowId} onChange={set("workflowId")}>
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Start in</span>
              <select value={form.stageId} onChange={set("stageId")}>
                {workflow?.stages.map((stage, index) => (
                  <option key={stage.id} value={index === 0 ? "" : stage.id}>
                    {stage.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <RepoFields
            repoPath={form.repoPath}
            baseBranch={form.baseBranch}
            onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
          />
          <label className="field">
            <span>Tags</span>
            <input value={form.tags} onChange={set("tags")} placeholder="frontend, auth" />
          </label>
        </div>
        <footer className="modal-footer">
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={create.isPending || !form.title.trim()}>
            Create task
          </button>
        </footer>
      </form>
    </Modal>
  );
}
