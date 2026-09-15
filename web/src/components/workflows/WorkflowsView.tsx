import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WorkflowDef, WorkflowUsage } from "@wm/shared";
import { Check, ChevronDown, ChevronRight, Copy, Info, MoreHorizontal, Plus, Save, Settings2, Trash2, TriangleAlert, Undo2 } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { ApiError } from "../../api";
import { useApi } from "../../api-context";
import { useUnsavedChangesGuard } from "../../lib/url-state";
import { useWorkspaceNavigation } from "../../workspace-context";
import {
  addBinding,
  addStage,
  allBindings,
  isDirty,
  moveBinding,
  moveItem,
  removeBinding,
  removeStage,
  toDraft,
  updateBinding,
  updateStage,
  type Draft,
} from "../../lib/draft";
import { EmojiPicker } from "../EmojiPicker";
import { Modal } from "../Modal";
import { Menu } from "../Menu";
import { useToast } from "../Toast";
import { BindingForm } from "./BindingForm";
import { StageColumn } from "./StageColumn";
import { StageForm } from "./StageForm";

type Selection = { kind: "stage"; stageId: string } | { kind: "binding"; bindingId: string } | null;

/**
 * Edits the workflow named in the URL, so Workflows opens on the board you came from and the board
 * you return to is the workflow you were editing.
 */
export function WorkflowsView({ workflows, workflowId }: { workflows: WorkflowDef[]; workflowId: string | undefined }) {
  const setQueryParams = useWorkspaceNavigation();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const workflow = workflows.find((candidate) => candidate.id === workflowId) ?? workflows[0];

  if (!workflow) return <>
    <div className="splash">
      <strong>No workflows yet</strong>
      <button type="button" className="button" onClick={() => setCreating(true)}><Plus size={15} />New workflow</button>
    </div>
    {creating && <NewWorkflowDialog copyFrom={null} onClose={() => setCreating(false)} onCreated={async (created) => {
      await queryClient.invalidateQueries({ queryKey: ["workflows"] });
      setCreating(false);
      setQueryParams({ workflow: created.id }, { replace: true });
    }} />}
  </>;
  // Remount on switch so the draft never carries over between workflows.
  return (
    <WorkflowEditor
      key={workflow.id}
      workflow={workflow}
      workflows={workflows}
      onSelect={(id, force) => setQueryParams({ workflow: id }, { replace: true, force })}
    />
  );
}

const DISCARD_PROMPT = "Discard unsaved changes to this workflow?";

function WorkflowEditor({
  workflow,
  workflows,
  onSelect,
}: {
  workflow: WorkflowDef;
  workflows: WorkflowDef[];
  /** Asks before discarding unsaved edits unless `force`d. */
  onSelect: (id: string, force?: boolean) => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(() => toDraft(workflow));
  const [selection, setSelection] = useState<Selection>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<"blank" | "copy" | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteTasks, setDeleteTasks] = useState(false);
  const [activeStageId, setActiveStageId] = useState(workflow.stages[0]?.id);
  const activeStage = draft.stages.find((stage) => stage.id === activeStageId) ?? draft.stages[0];
  const activeStageIndex = draft.stages.findIndex((stage) => stage.id === activeStage?.id);

  const actions = useQuery({ queryKey: ["action-types"], queryFn: api.actionTypes, staleTime: Infinity });
  const usage = useQuery({ queryKey: ["workflow-usage", workflow.id], queryFn: () => api.workflowUsage(workflow.id) });
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.connections });

  const dirty = isDirty(draft, workflow);
  const refreshWorkflows = () => queryClient.invalidateQueries({ queryKey: ["workflows"] });

  const save = useMutation({
    mutationFn: () => api.saveWorkflow(workflow.id, draft),
    onSuccess: async (saved) => {
      setError(null);
      // Swap the saved version in straight away; waiting for the refetch flashed "Unsaved changes".
      queryClient.setQueryData<WorkflowDef[]>(["workflows"], (list) =>
        list?.map((candidate) => (candidate.id === saved.id ? saved : candidate)),
      );
      setDraft(toDraft(saved));
      await refreshWorkflows();
      void queryClient.invalidateQueries({ queryKey: ["workflow-usage", workflow.id] });
      toast(`Saved “${saved.name}”`);
    },
    onError: (err) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: (force: boolean) => api.deleteWorkflow(workflow.id, force),
    onSuccess: async () => {
      setDeleting(false);
      toast(`Deleted “${workflow.name}”`);
      const next = workflows.find((candidate) => candidate.id !== workflow.id);
      if (next) onSelect(next.id, true);
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      await refreshWorkflows();
    },
    onError: (err) => {
      setDeleting(false);
      toast(err.message, "error");
    },
  });

  // Leaving for another page or workflow, or reloading, asks first.
  useUnsavedChangesGuard(dirty ? DISCARD_PROMPT : null);
  const inUse = usage.data ? usage.data.activeTasks + usage.data.archivedTasks > 0 : false;

  const startCreating = (mode: "blank" | "copy") => {
    if (dirty && !confirm(DISCARD_PROMPT)) return;
    setCreating(mode);
  };

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
  const closeEditor = () => setSelection(null);

  return (
    <div className="page-view wf-view">
      <div className="page-header">
        <div>
          <h2>Workflows</h2>
          <p className="muted">Design a repeatable path from idea to done.</p>
        </div>
        <button type="button" className="button" onClick={() => startCreating("blank")}>
          <Plus size={14} /> New workflow
        </button>
      </div>

      <section className="wf-overview" aria-label="Workflow details">
        <div className="wf-overview-heading">
          <EmojiPicker
            value={draft.icon}
            onChange={(icon) => edit({ ...draft, icon })}
            triggerClassName="wf-workflow-icon"
            triggerSize={22}
            label="Change workflow icon"
          />
          <label className="field wf-picker">
            <span>Editing workflow</span>
            <select
              value={workflow.id}
              onChange={(event) => onSelect(event.target.value)}
            >
              {workflows.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.icon ? `${candidate.icon} ` : ""}{candidate.name}
                </option>
              ))}
            </select>
          </label>
          <div className="wf-overview-counts">
            <span>{countOf(draft.stages.length, "stage")}</span>
            <span>{countOf(allBindings(draft).length, "action")}</span>
            {usage.data && <span>{countOf(usage.data.activeTasks, "active task")}</span>}
          </div>
          <Menu
            label="Workflow actions"
            trigger={<MoreHorizontal size={18} />}
            triggerLabel="Workflow actions"
            triggerClassName="icon-button"
            items={[
              { key: "copy", label: "Duplicate workflow", icon: Copy, onSelect: () => startCreating("copy") },
              { key: "delete", label: "Delete workflow", icon: Trash2, divided: true, onSelect: () => {
                void usage.refetch();
                setDeleteTasks(false);
                setDeleting(true);
              } },
            ]}
          />
        </div>
        <p className="wf-description">{draft.description || "Give this workflow a purpose. Add a description below."}</p>
        <details className="wf-details">
          <summary><Settings2 size={14} /><span>Name & description</span><ChevronDown size={14} /></summary>
          <div className="wf-metadata-fields">
            <label className="field">
              <span>Name</span>
              <input value={draft.name} onChange={(event) => edit({ ...draft, name: event.target.value })} />
            </label>
            <label className="field">
              <span>Description</span>
              <textarea rows={2} value={draft.description} onChange={(event) => edit({ ...draft, description: event.target.value })} placeholder="What is this workflow for?" />
            </label>
          </div>
        </details>
      </section>

      {error && (
        <div className="callout callout-danger">
          <TriangleAlert size={14} />
          <span>{error}</span>
        </div>
      )}

      {actions.error && <div className="callout callout-danger" role="alert">Could not load action types. <button type="button" className="link-button" onClick={() => void actions.refetch()}>Try again</button></div>}
      <div className="wf-workbench">
        <nav className="wf-stage-nav" aria-label="Workflow stages">
          <div className="wf-nav-heading"><h3>Workflow stages</h3><span className="chip">{draft.stages.length}</span></div>
          <p className="hint">Select a stage to shape what happens.</p>
          <label className="field wf-mobile-stage-picker">
            <span>Select stage</span>
            <select value={activeStage?.id ?? ""} onChange={(event) => { setActiveStageId(event.target.value); closeEditor(); }}>
              {draft.stages.map((stage, index) => <option key={stage.id} value={stage.id}>{index + 1}. {stage.name || "Untitled stage"}</option>)}
            </select>
          </label>
          <ol className="wf-stage-list">
            {draft.stages.map((stage, index) => (
              <li key={stage.id}>
                <button type="button" className={`wf-stage-link ${stage.id === activeStage?.id ? "is-active" : ""}`}
                  aria-current={stage.id === activeStage?.id ? "step" : undefined}
                  onClick={() => { setActiveStageId(stage.id); closeEditor(); }}>
                  <span className="wf-stage-number">{String(index + 1).padStart(2, "0")}</span>
                  <span className="wf-stage-link-copy"><strong>{stage.name || "Untitled stage"}</strong><span>{stage.bindings.length ? countOf(stage.bindings.length, "action") : "Manual stage"}</span></span>
                  <ChevronRight size={15} />
                </button>
              </li>
            ))}
          </ol>
          <button type="button" className="button wf-create-stage" onClick={() => {
            const next = addStage(draft);
            edit(next.draft);
            setActiveStageId(next.stageId);
            setSelection({ kind: "stage", stageId: next.stageId });
          }}><Plus size={15} />Add stage</button>
        </nav>
        <div className="wf-stage-detail">
        {activeStage && (
          <StageColumn
            key={activeStage.id}
            draft={draft}
            stage={activeStage}
            index={activeStageIndex}
            actions={actions.data ?? []}
            taskCount={usage.data?.activeByStage[activeStage.id] ?? 0}
            selected={selection?.kind === "stage" && selection.stageId === activeStage.id}
            selectedBindingId={selection?.kind === "binding" ? selection.bindingId : null}
            onSelectStage={() => setSelection({ kind: "stage", stageId: activeStage.id })}
            onSelectBinding={(bindingId) => setSelection({ kind: "binding", bindingId })}
            onMove={(delta) => edit({ ...draft, stages: moveItem(draft.stages, activeStageIndex, delta) })}
            onDelete={() => {
              setActiveStageId(draft.stages[activeStageIndex + 1]?.id ?? draft.stages[activeStageIndex - 1]?.id);
              edit(removeStage(draft, activeStage.id));
              setSelection(null);
            }}
            onAddBinding={(action) => {
              const next = addBinding(draft, activeStage.id, action);
              edit(next.draft);
              setSelection({ kind: "binding", bindingId: next.bindingId });
            }}
            onMoveBinding={(position, delta) => edit(moveBinding(draft, activeStage.id, position, delta))}
          />
        )}
        <div className="wf-hint"><Info size={15} /><p>Changes apply the next time a task enters a stage. Current actions keep running as configured.</p></div>
        </div>
      </div>

      {selected?.kind === "stage" && (
        <Modal title={selected.stage.name || "Stage"} onClose={closeEditor} width={640}>
          <div className="modal-body">
            <StageForm
              stage={selected.stage}
              taskCount={usage.data?.activeByStage[selected.stage.id] ?? 0}
              onChange={(patch) => edit(updateStage(draft, selected.stage.id, patch))}
            />
          </div>
          <EditorFooter dirty={dirty} onDone={closeEditor} />
        </Modal>
      )}
      {selected?.kind === "binding" && (
        <Modal title={selected.binding.label || "Action"} onClose={closeEditor} width={640}>
          <div className="modal-body">
            <BindingForm
              key={selected.binding.id}
              draft={draft}
              stage={selected.stage}
              binding={selected.binding}
              actions={actions.data ?? []}
              connections={connections.data ?? []}
              onChange={(patch) => edit(updateBinding(draft, selected.binding.id, patch))}
            />
          </div>
          <EditorFooter dirty={dirty} onDone={closeEditor}>
            <button
              type="button"
              className="button danger ghost"
              onClick={() => {
                edit(removeBinding(draft, selected.binding.id));
                closeEditor();
              }}
            >
              <Trash2 size={14} />
              Delete action
            </button>
          </EditorFooter>
        </Modal>
      )}

      <div className={`wf-savebar ${dirty ? "wf-savebar-dirty" : ""}`}>
        <span className={`wf-save-status ${dirty ? "warn" : "muted"}`} role="status">{dirty ? <span className="badge-dot" /> : <Check size={15} />}{dirty ? "Unsaved changes" : "All changes saved"}</span>
        <button type="button" className="button" disabled={!dirty || save.isPending} onClick={() => edit(toDraft(workflow))}>
          <Undo2 size={14} />
          Discard
        </button>
        <button type="button" className="button primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          <Save size={14} />
          {save.isPending ? "Saving…" : "Save workflow"}
        </button>
      </div>

      {creating && (
        <NewWorkflowDialog
          copyFrom={creating === "copy" ? workflow : null}
          onClose={() => setCreating(null)}
          onCreated={async (created) => {
            setCreating(null);
            await refreshWorkflows();
            // Unsaved edits were already confirmed away when the dialog opened.
            onSelect(created.id, true);
          }}
        />
      )}
      {deleting && (
        <Modal title="Delete workflow" onClose={() => setDeleting(false)}>
          <div className="modal-body">
            <p className="dialog-lead">{workflow.name}</p>
            {inUse && usage.data ? (
              <>
                <div className="callout callout-danger">
                  <TriangleAlert size={14} />
                  <span>
                    {describeUsage(usage.data)} {usage.data.activeTasks + usage.data.archivedTasks === 1 ? "uses" : "use"} this
                    workflow. Deleting it deletes them too, and that can't be undone.
                  </span>
                </div>
                <ul className="plain-list">
                  <li>Stops anything still running on those tasks.</li>
                  <li>Removes their worktrees, discarding uncommitted changes. Branches are kept.</li>
                  <li>Deletes their timelines, transcripts and artifacts. They won't appear in the Archive.</li>
                </ul>
                <label className="checkbox">
                  <input type="checkbox" checked={deleteTasks} onChange={(event) => setDeleteTasks(event.target.checked)} />
                  Delete the tasks as well
                </label>
              </>
            ) : (
              <p className="muted small">This removes the workflow and its stages. No task uses it.</p>
            )}
          </div>
          <footer className="modal-footer">
            <button type="button" className="button ghost" onClick={() => setDeleting(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="button danger"
              disabled={remove.isPending || usage.isFetching || (inUse && !deleteTasks)}
              onClick={() => remove.mutate(inUse)}
            >
              {inUse ? "Delete workflow and tasks" : "Delete"}
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}

function NewWorkflowDialog({
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
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.createWorkflow({ name, icon, copyFromWorkflowId: copyFrom?.id ?? null }),
    onSuccess: (created) => void onCreated(created),
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  return (
    <Modal title={copyFrom ? `Duplicate ${copyFrom.name}` : "New workflow"} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <div className="modal-body form-grid">
          <div className="field wf-name-field">
            <span>Name</span>
            <div className="wf-name-row">
              <EmojiPicker value={icon} onChange={setIcon} triggerClassName="wf-workflow-icon wf-workflow-icon-sm" label="Pick an icon" />
              <input value={name} onChange={(event) => setName(event.target.value)} autoFocus placeholder="Feature" aria-label="Name" />
            </div>
          </div>
          <p className="hint">
            {copyFrom ? "Copies every stage and action as last saved." : "Starts with a single Backlog stage."}
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

/** Stage and action dialogs edit the draft in place, so there's nothing to confirm — only a reminder to save. */
function EditorFooter({ dirty, onDone, children }: { dirty: boolean; onDone: () => void; children?: ReactNode }) {
  return (
    <footer className="modal-footer wf-editor-footer">
      {children}
      <span className="spacer" />
      {dirty && <span className="muted small">Save the workflow to keep these changes.</span>}
      <button type="button" className="button primary" onClick={onDone}>
        Done
      </button>
    </footer>
  );
}

const countOf = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** "2 active tasks and 1 archived task" */
function describeUsage({ activeTasks, archivedTasks }: WorkflowUsage): string {
  const parts: string[] = [];
  if (activeTasks) parts.push(countOf(activeTasks, "active task"));
  if (archivedTasks) parts.push(countOf(archivedTasks, "archived task"));
  return parts.join(" and ");
}
