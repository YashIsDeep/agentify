import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WorkflowDef } from "@wm/shared";
import { Check, ChevronRight, Copy, MoreHorizontal, Plus, Save, Trash2, Undo2 } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useApi } from "../../api-context";
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
import { countOf } from "../../lib/format";
import { useUnsavedChangesGuard } from "../../lib/url-state";
import { Button, Callout, Dialog, DialogBody, DialogFooter, Field, IconButton, Menu, Page, Splash, useToast } from "../../ui";
import { useWorkspaceNavigation } from "../../workspace-context";
import { EmojiPicker } from "../EmojiPicker";
import { BindingForm } from "./BindingForm";
import { StageColumn } from "./StageColumn";
import { StageForm } from "./StageForm";
import { DeleteWorkflowDialog, NewWorkflowDialog } from "./WorkflowDialogs";

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

  if (!workflow) {
    return (
      <>
        <Splash title="No workflows yet" action={<Button icon={Plus} onClick={() => setCreating(true)}>New workflow</Button>} />
        {creating && (
          <NewWorkflowDialog
            copyFrom={null}
            onClose={() => setCreating(false)}
            onCreated={async (created) => {
              await queryClient.invalidateQueries({ queryKey: ["workflows"] });
              setCreating(false);
              setQueryParams({ workflow: created.id }, { replace: true });
            }}
          />
        )}
      </>
    );
  }
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
  // The saved version the draft started from. Another tab (or the API) saving a newer one is
  // picked up at once while there are no edits here; with edits, you choose, below.
  const [base, setBase] = useState(workflow);
  if (workflow.updatedAt !== base.updatedAt && !isDirty(draft, base)) {
    setBase(workflow);
    setDraft(toDraft(workflow));
  }
  const stale = workflow.updatedAt !== base.updatedAt;
  const [selection, setSelection] = useState<Selection>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<"blank" | "copy" | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [activeStageId, setActiveStageId] = useState(workflow.stages[0]?.id);
  const activeStage = draft.stages.find((stage) => stage.id === activeStageId) ?? draft.stages[0];
  const activeStageIndex = draft.stages.findIndex((stage) => stage.id === activeStage?.id);

  const actions = useQuery({ queryKey: ["action-types"], queryFn: api.actionTypes, staleTime: Infinity });
  const usage = useQuery({ queryKey: ["workflow-usage", workflow.id], queryFn: () => api.workflowUsage(workflow.id) });
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.connections });

  const dirty = isDirty(draft, base);
  const refreshWorkflows = () => queryClient.invalidateQueries({ queryKey: ["workflows"] });

  const save = useMutation({
    mutationFn: () => api.saveWorkflow(workflow.id, draft),
    onSuccess: async (saved) => {
      setError(null);
      // Swap the saved version in straight away; waiting for the refetch flashed "Unsaved changes".
      queryClient.setQueryData<WorkflowDef[]>(["workflows"], (list) =>
        list?.map((candidate) => (candidate.id === saved.id ? saved : candidate)),
      );
      setBase(saved);
      setDraft(toDraft(saved));
      await refreshWorkflows();
      void queryClient.invalidateQueries({ queryKey: ["workflow-usage", workflow.id] });
      toast(`Saved “${saved.name}”`);
    },
    onError: (err) => setError(err.message),
  });

  // Leaving for another page or workflow, or reloading, asks first.
  useUnsavedChangesGuard(dirty ? DISCARD_PROMPT : null);

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
  /** Drops the draft for the newest saved version. */
  const reload = () => {
    setBase(workflow);
    edit(toDraft(workflow));
  };
  const closeEditor = () => setSelection(null);

  return (
    <Page
      title="Workflows"
      tip="Saved changes apply the next time a task enters a stage. Actions already running keep their old setup."
      actions={
        <Button icon={Plus} onClick={() => startCreating("blank")}>
          New workflow
        </Button>
      }
      className="wf-view"
    >
      <section className="wf-overview" aria-label="Workflow details">
        <div className="wf-overview-heading">
          <EmojiPicker value={draft.icon} onChange={(icon) => edit({ ...draft, icon })} size="lg" label="Change workflow icon" />
          <Field label="Editing workflow" className="wf-picker">
            <select value={workflow.id} onChange={(event) => onSelect(event.target.value)}>
              {workflows.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.icon ? `${candidate.icon} ` : ""}
                  {candidate.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="wf-overview-counts">
            <span>{countOf(draft.stages.length, "stage")}</span>
            <span>{countOf(allBindings(draft).length, "action")}</span>
            {usage.data && <span>{countOf(usage.data.activeTasks, "active task")}</span>}
          </div>
          <Menu
            label="Workflow actions"
            trigger={<IconButton label="Workflow actions" icon={MoreHorizontal} />}
            items={[
              { key: "copy", label: "Duplicate workflow", icon: Copy, onSelect: () => startCreating("copy") },
              { key: "delete", label: "Delete workflow", icon: Trash2, divided: true, danger: true, onSelect: () => setDeleting(true) },
            ]}
          />
        </div>
        <div className="wf-metadata-fields">
          <Field label="Name">
            <input value={draft.name} onChange={(event) => edit({ ...draft, name: event.target.value })} />
          </Field>
          <Field label="Description" optional>
            <textarea
              rows={2}
              value={draft.description}
              onChange={(event) => edit({ ...draft, description: event.target.value })}
              placeholder="What is this workflow for?"
            />
          </Field>
        </div>
      </section>

      {stale ? (
        <Callout tone="warn">
          This workflow was saved somewhere else while you were editing it.{" "}
          <Button variant="link" onClick={() => confirm(DISCARD_PROMPT) && reload()}>
            Load the saved version
          </Button>
        </Callout>
      ) : (
        error && <Callout tone="danger">{error}</Callout>
      )}
      {actions.error && (
        <Callout tone="danger">
          Could not load action types.{" "}
          <Button variant="link" onClick={() => void actions.refetch()}>
            Try again
          </Button>
        </Callout>
      )}

      <div className="wf-workbench">
        <nav className="wf-stage-nav" aria-label="Workflow stages">
          <h3 className="wf-nav-heading">Stages</h3>
          <Field label="Select stage" className="wf-mobile-stage-picker">
            <select
              value={activeStage?.id ?? ""}
              onChange={(event) => {
                setActiveStageId(event.target.value);
                closeEditor();
              }}
            >
              {draft.stages.map((stage, index) => (
                <option key={stage.id} value={stage.id}>
                  {index + 1}. {stage.name || "Untitled stage"}
                </option>
              ))}
            </select>
          </Field>
          <ol className="wf-stage-list">
            {draft.stages.map((stage, index) => (
              <li key={stage.id}>
                <button
                  type="button"
                  className={`wf-stage-link ${stage.id === activeStage?.id ? "is-active" : ""}`}
                  aria-current={stage.id === activeStage?.id ? "step" : undefined}
                  onClick={() => {
                    setActiveStageId(stage.id);
                    closeEditor();
                  }}
                >
                  <span className="wf-stage-number">{index + 1}</span>
                  <span className="wf-stage-link-copy">
                    <strong>{stage.name || "Untitled stage"}</strong>
                    <span>{stage.bindings.length ? countOf(stage.bindings.length, "action") : "No actions"}</span>
                  </span>
                  <ChevronRight size={15} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ol>
          <Button
            icon={Plus}
            className="wf-create-stage"
            onClick={() => {
              const next = addStage(draft);
              edit(next.draft);
              setActiveStageId(next.stageId);
              setSelection({ kind: "stage", stageId: next.stageId });
            }}
          >
            Add stage
          </Button>
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
              onAddBinding={(action, preset) => {
                const next = addBinding(draft, activeStage.id, action, preset);
                edit(next.draft);
                setSelection({ kind: "binding", bindingId: next.bindingId });
              }}
              onMoveBinding={(position, delta) => edit(moveBinding(draft, activeStage.id, position, delta))}
            />
          )}
        </div>
      </div>

      {selected?.kind === "stage" && (
        <Dialog title="Stage settings" size="lg" onClose={closeEditor}>
          <DialogBody>
            <StageForm stage={selected.stage} onChange={(patch) => edit(updateStage(draft, selected.stage.id, patch))} />
          </DialogBody>
          <EditorFooter dirty={dirty} onDone={closeEditor} />
        </Dialog>
      )}
      {selected?.kind === "binding" && (
        <Dialog title="Action settings" size="lg" onClose={closeEditor}>
          <DialogBody>
            <BindingForm
              key={selected.binding.id}
              draft={draft}
              stage={selected.stage}
              binding={selected.binding}
              actions={actions.data ?? []}
              connections={connections.data ?? []}
              onChange={(patch) => edit(updateBinding(draft, selected.binding.id, patch))}
            />
          </DialogBody>
          <EditorFooter dirty={dirty} onDone={closeEditor}>
            <Button
              variant="danger"
              icon={Trash2}
              onClick={() => {
                edit(removeBinding(draft, selected.binding.id));
                closeEditor();
              }}
            >
              Delete action
            </Button>
          </EditorFooter>
        </Dialog>
      )}

      <div className={`wf-savebar ${dirty ? "wf-savebar-dirty" : ""}`}>
        <span className={`wf-save-status ${dirty ? "text-warn" : "muted"}`} role="status">
          {dirty ? <span className="wf-save-dot" /> : <Check size={15} aria-hidden="true" />}
          {dirty ? "Unsaved changes" : "All changes saved"}
        </span>
        <Button icon={Undo2} disabled={!dirty || save.isPending} onClick={reload}>
          Discard
        </Button>
        <Button variant="primary" icon={Save} disabled={!dirty} loading={save.isPending} loadingText="Saving…" onClick={() => save.mutate()}>
          Save workflow
        </Button>
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
        <DeleteWorkflowDialog
          workflow={workflow}
          onClose={() => setDeleting(false)}
          onDeleted={async () => {
            setDeleting(false);
            const next = workflows.find((candidate) => candidate.id !== workflow.id);
            if (next) onSelect(next.id, true);
            void queryClient.invalidateQueries({ queryKey: ["tasks"] });
            await refreshWorkflows();
          }}
        />
      )}
    </Page>
  );
}

/** Stage and action dialogs edit the draft in place, so there's nothing to confirm — only a reminder to save. */
function EditorFooter({ dirty, onDone, children }: { dirty: boolean; onDone: () => void; children?: ReactNode }) {
  return (
    <DialogFooter start={children}>
      {dirty && <span className="muted small">Save the workflow to keep these changes.</span>}
      <Button variant="primary" onClick={onDone}>
        Done
      </Button>
    </DialogFooter>
  );
}
