import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WorkflowDef } from "@wm/shared";
import { Copy, Plus, Save, Trash2, TriangleAlert, Undo2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../../api";
import {
  addBinding,
  addPhase,
  addStage,
  allBindings,
  isDirty,
  moveItem,
  removeBinding,
  removePhase,
  removeStage,
  toDraft,
  updateBinding,
  updateStage,
  type Draft,
} from "../../lib/draft";
import { Modal } from "../Modal";
import { useToast } from "../Toast";
import { BindingForm } from "./BindingForm";
import { StageColumn } from "./StageColumn";
import { StageForm } from "./StageForm";

type Selection = { kind: "stage"; stageId: string } | { kind: "binding"; bindingId: string } | null;

export function TemplatesView({ workflows }: { workflows: WorkflowDef[] }) {
  const [workflowId, setWorkflowId] = useState(() => workflows[0]?.id ?? "");
  const workflow = workflows.find((candidate) => candidate.id === workflowId) ?? workflows[0];

  if (!workflow) return <div className="splash">No templates yet.</div>;
  // Remount on switch so the draft never carries over between templates.
  return <TemplateEditor key={workflow.id} workflow={workflow} workflows={workflows} onSelect={setWorkflowId} />;
}

function TemplateEditor({
  workflow,
  workflows,
  onSelect,
}: {
  workflow: WorkflowDef;
  workflows: WorkflowDef[];
  onSelect: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(() => toDraft(workflow));
  const [selection, setSelection] = useState<Selection>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<"blank" | "copy" | null>(null);
  const [deleting, setDeleting] = useState(false);

  const actions = useQuery({ queryKey: ["action-types"], queryFn: api.actionTypes, staleTime: Infinity });
  const usage = useQuery({ queryKey: ["workflow-usage", workflow.id], queryFn: () => api.workflowUsage(workflow.id) });
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.connections });

  const dirty = isDirty(draft, workflow);
  const refreshWorkflows = () => queryClient.invalidateQueries({ queryKey: ["workflows"] });

  const save = useMutation({
    mutationFn: () => api.saveWorkflow(workflow.id, draft),
    onSuccess: async (saved) => {
      setError(null);
      setDraft(toDraft(saved));
      await refreshWorkflows();
      void queryClient.invalidateQueries({ queryKey: ["workflow-usage", workflow.id] });
      toast(`Saved “${saved.name}”`);
    },
    onError: (err) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteWorkflow(workflow.id),
    onSuccess: async () => {
      setDeleting(false);
      toast(`Deleted “${workflow.name}”`);
      const next = workflows.find((candidate) => candidate.id !== workflow.id);
      if (next) onSelect(next.id);
      await refreshWorkflows();
    },
    onError: (err) => {
      setDeleting(false);
      toast(err.message, "error");
    },
  });

  // Leaving with unsaved edits loses them; the browser prompt is the only hook we get.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const selected = useMemo(() => {
    if (selection?.kind === "stage") {
      const stage = draft.stages.find((candidate) => candidate.id === selection.stageId);
      return stage ? ({ kind: "stage", stage } as const) : null;
    }
    if (selection?.kind === "binding") {
      const found = allBindings(draft).find(({ binding }) => binding.id === selection.bindingId);
      return found ? ({ kind: "binding", ...found } as const) : null;
    }
    return null;
  }, [draft, selection]);

  const edit = (next: Draft) => {
    setDraft(next);
    setError(null);
  };

  return (
    <div className="page-view tpl-view">
      <div className="page-header">
        <div className="field-row">
          <label className="field">
            <span>Template</span>
            <select
              value={workflow.id}
              onChange={(event) => {
                if (dirty && !confirm("Discard unsaved changes to this template?")) return;
                onSelect(event.target.value);
              }}
            >
              {workflows.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field field-grow">
            <span>Name</span>
            <input value={draft.name} onChange={(event) => edit({ ...draft, name: event.target.value })} />
          </label>
          <label className="field field-grow">
            <span>Description</span>
            <input value={draft.description} onChange={(event) => edit({ ...draft, description: event.target.value })} />
          </label>
        </div>
        <div className="tpl-actions">
          <button type="button" className="button" onClick={() => setCreating("blank")}>
            <Plus size={14} />
            New
          </button>
          <button type="button" className="button" onClick={() => setCreating("copy")}>
            <Copy size={14} />
            Duplicate
          </button>
          <button type="button" className="button danger ghost" onClick={() => setDeleting(true)}>
            <Trash2 size={14} />
            Delete
          </button>
        </div>
      </div>

      {error && (
        <div className="callout callout-danger">
          <TriangleAlert size={14} />
          <span>{error}</span>
        </div>
      )}

      <div className="tpl-board">
        {draft.stages.map((stage, index) => (
          <StageColumn
            key={stage.id}
            draft={draft}
            stage={stage}
            index={index}
            actions={actions.data ?? []}
            taskCount={usage.data?.activeByStage[stage.id] ?? 0}
            selected={selection?.kind === "stage" && selection.stageId === stage.id}
            selectedBindingId={selection?.kind === "binding" ? selection.bindingId : null}
            onSelectStage={() => setSelection({ kind: "stage", stageId: stage.id })}
            onSelectBinding={(bindingId) => setSelection({ kind: "binding", bindingId })}
            onMove={(delta) => edit({ ...draft, stages: moveItem(draft.stages, index, delta) })}
            onDelete={() => {
              edit(removeStage(draft, stage.id));
              setSelection(null);
            }}
            onAddBinding={(action) => {
              const next = addBinding(draft, stage.id, action);
              edit(next.draft);
              setSelection({ kind: "binding", bindingId: next.bindingId });
            }}
          />
        ))}
        <button
          type="button"
          className="tpl-add-stage"
          onClick={() => {
            const next = addStage(draft);
            edit(next.draft);
            setSelection({ kind: "stage", stageId: next.stageId });
          }}
        >
          <Plus size={16} />
          Add stage
        </button>
      </div>

      <div className="tpl-detail">
        {selected?.kind === "stage" ? (
          <StageForm
            stage={selected.stage}
            taskCount={usage.data?.activeByStage[selected.stage.id] ?? 0}
            onChange={(patch) => edit(updateStage(draft, selected.stage.id, patch))}
            onAddPhase={() => edit(addPhase(draft, selected.stage.id))}
            onRemovePhase={(phaseId) => edit(removePhase(draft, selected.stage.id, phaseId))}
          />
        ) : selected?.kind === "binding" ? (
          <BindingForm
            key={selected.binding.id}
            draft={draft}
            stage={selected.stage}
            binding={selected.binding}
            actions={actions.data ?? []}
            connections={connections.data ?? []}
            onChange={(patch) => edit(updateBinding(draft, selected.binding.id, patch))}
            onDelete={() => {
              edit(removeBinding(draft, selected.binding.id));
              setSelection(null);
            }}
          />
        ) : (
          <p className="muted small tpl-hint">
            Pick a stage or an action above to edit it. Changes apply the next time a task enters a stage — tasks already in
            one keep the phases they started with.
          </p>
        )}
      </div>

      <div className="tpl-savebar">
        <span className="muted small">{dirty ? "Unsaved changes" : "Saved"}</span>
        <button type="button" className="button" disabled={!dirty || save.isPending} onClick={() => edit(toDraft(workflow))}>
          <Undo2 size={14} />
          Discard
        </button>
        <button type="button" className="button primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          <Save size={14} />
          {save.isPending ? "Saving…" : "Save template"}
        </button>
      </div>

      {creating && (
        <NewTemplateDialog
          copyFrom={creating === "copy" ? workflow : null}
          onClose={() => setCreating(null)}
          onCreated={async (created) => {
            setCreating(null);
            await refreshWorkflows();
            onSelect(created.id);
          }}
        />
      )}
      {deleting && (
        <Modal title="Delete template" onClose={() => setDeleting(false)}>
          <div className="modal-body">
            <p className="dialog-lead">{workflow.name}</p>
            <p className="muted small">
              {usage.data && usage.data.activeTasks + usage.data.archivedTasks > 0
                ? "Tasks still reference this template, so it can't be deleted."
                : "This removes the template and its stages. Tasks are unaffected because none use it."}
            </p>
          </div>
          <footer className="modal-footer">
            <button type="button" className="button ghost" onClick={() => setDeleting(false)}>
              Cancel
            </button>
            <button type="button" className="button danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
              Delete
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}

function NewTemplateDialog({
  copyFrom,
  onClose,
  onCreated,
}: {
  copyFrom: WorkflowDef | null;
  onClose: () => void;
  onCreated: (workflow: WorkflowDef) => void | Promise<void>;
}) {
  const [name, setName] = useState(copyFrom ? `${copyFrom.name} copy` : "");
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.createWorkflow({ name, copyFromWorkflowId: copyFrom?.id ?? null }),
    onSuccess: (created) => void onCreated(created),
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  return (
    <Modal title={copyFrom ? `Duplicate ${copyFrom.name}` : "New template"} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <div className="modal-body form-grid">
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} autoFocus placeholder="Feature" />
          </label>
          <p className="hint">
            {copyFrom ? "Copies every stage, phase and action." : "Starts with a single Backlog stage."}
          </p>
          {error && <div className="callout callout-danger">{error}</div>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!name.trim() || create.isPending}>
            Create
          </button>
        </footer>
      </form>
    </Modal>
  );
}
