import type { TaskDetail, TaskSummary } from "@wm/shared";
import { Archive } from "lucide-react";
import { type FormEvent, Fragment, useEffect, useState } from "react";
import { useApi } from "../api-context";
import { useTaskAction } from "../hooks";
import { AGENTS } from "../lib/agents";
import { parseTags } from "../lib/format";
import { cleanLinks, type LinkDraft } from "../lib/links";
import { latestOutputs } from "../lib/runs";
import { useUnsavedChangesGuard } from "../lib/url-state";
import { ArchiveDialog } from "./dialogs";
import { LinksField } from "./LinksField";
import { EffortSelect, keepEffort, ModelSelect, useAgentModels } from "./ModelSelect";
import { RepoFields, WorktreeCheck } from "./RepoFields";

interface FormState {
  title: string;
  description: string;
  repoPath: string;
  baseBranch: string;
  useWorktree: boolean;
  tags: string;
  links: LinkDraft[];
  agentOverride: string;
  modelOverride: string;
  effortOverride: string;
}

const toForm = (task: TaskSummary): FormState => ({
  title: task.title,
  description: task.description,
  repoPath: task.repoPath ?? "",
  baseBranch: task.baseBranch ?? "",
  useWorktree: task.useWorktree,
  tags: task.tags.join(", "),
  links: task.links.map((link) => ({ ...link })),
  agentOverride: task.agentOverride ?? "",
  modelOverride: task.modelOverride ?? "",
  effortOverride: task.effortOverride ?? "",
});

export function DetailsPanel({ detail }: { detail: TaskDetail }) {
  const api = useApi();
  const { task } = detail;
  const readOnly = task.status === "archived";
  const [form, setForm] = useState(() => toForm(task));
  const [dirty, setDirty] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const save = useTaskAction();
  const models = useAgentModels();
  // Closing the drawer or opening another task used to drop edits without a word.
  useUnsavedChangesGuard(dirty ? `Discard your unsaved changes to “${task.title}”?` : null);

  // Follow live updates unless the user has unsaved edits.
  useEffect(() => {
    if (!dirty) setForm(toForm(task));
  }, [task, dirty]);

  const update = (patch: Partial<FormState>) => {
    setForm((current) => ({ ...current, ...patch }));
    setDirty(true);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(
      () =>
        api.updateTask(task.id, {
          title: form.title,
          description: form.description,
          repoPath: form.repoPath.trim() || null,
          baseBranch: form.baseBranch.trim() || null,
          useWorktree: form.useWorktree,
          tags: parseTags(form.tags),
          links: cleanLinks(form.links),
          agentOverride: form.agentOverride || null,
          modelOverride: form.modelOverride.trim() || null,
          effortOverride: form.effortOverride || null,
        }),
      { onSuccess: () => setDirty(false) },
    );
  };

  const outputs = latestOutputs(detail);

  return (
    <div className="details">
      <form onSubmit={submit}>
        <fieldset className="fieldset form-grid" disabled={readOnly}>
          <label className="field">
            <span>Title</span>
            <input value={form.title} onChange={(e) => update({ title: e.target.value })} required />
          </label>
          <label className="field">
            <span>Description</span>
            <textarea value={form.description} rows={5} onChange={(e) => update({ description: e.target.value })} />
          </label>
          <RepoFields repoPath={form.repoPath} baseBranch={form.baseBranch} onChange={update} />
          {form.repoPath.trim() !== "" && (
            <WorktreeCheck
              checked={form.useWorktree || !!task.worktreePath}
              disabled={!!task.worktreePath}
              onChange={(useWorktree) => update({ useWorktree })}
            />
          )}
          <label className="field">
            <span>Tags</span>
            <input value={form.tags} onChange={(e) => update({ tags: e.target.value })} placeholder="comma separated" />
          </label>

          <LinksField links={form.links} onChange={(links) => update({ links })} />

          <div className="field-row">
            <label className="field field-grow">
              <span>Coding agent</span>
              <select
                value={form.agentOverride}
                onChange={(e) =>
                  update({
                    agentOverride: e.target.value,
                    effortOverride: keepEffort(models.data, e.target.value || null, form.modelOverride, form.effortOverride),
                  })
                }
              >
                <option value="">No override</option>
                {AGENTS.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field field-grow">
              <span>Model</span>
              <ModelSelect
                value={form.modelOverride}
                agent={form.agentOverride || null}
                blankLabel="No override"
                onChange={(value) =>
                  update({
                    modelOverride: value,
                    effortOverride: keepEffort(models.data, form.agentOverride || null, value, form.effortOverride),
                  })
                }
              />
            </label>
            <label className="field">
              <span>Effort</span>
              <EffortSelect
                value={form.effortOverride}
                agent={form.agentOverride || null}
                model={form.modelOverride}
                blankLabel="No override"
                onChange={(value) => update({ effortOverride: value })}
              />
            </label>
          </div>
          <p className="hint">
            Overrides apply to every coding-agent action on this task, ahead of the action's and stage's own choices; the
            Retry dialog can override again.
          </p>
        </fieldset>
        {!readOnly && (
          <div className="form-actions">
            {dirty && (
              <button
                type="button"
                className="button ghost"
                onClick={() => {
                  setForm(toForm(task));
                  setDirty(false);
                }}
              >
                Discard
              </button>
            )}
            <button type="submit" className="button primary" disabled={!dirty || save.isPending || !form.title.trim()}>
              Save changes
            </button>
          </div>
        )}
      </form>

      <section className="info-section">
        <h4>Git</h4>
        <dl className="info">
          <dt>Branch</dt>
          <dd className="mono">{task.branch ?? "—"}</dd>
          <dt>Base</dt>
          <dd className="mono">{task.baseBranch ?? "—"}</dd>
          <dt>Worktree</dt>
          <dd className="mono">{task.worktreePath ?? "—"}</dd>
        </dl>
      </section>

      {outputs.length > 0 && (
        <section className="info-section">
          <h4>Outputs</h4>
          {outputs.map((output) => (
            <div key={output.key} className="output">
              <div className="output-label">
                {output.label} <code>{output.key}</code>
              </div>
              <dl className="info">
                {Object.entries(output.outputs).map(([key, value]) => (
                  <Fragment key={key}>
                    <dt>{key}</dt>
                    <dd className="mono">
                      <OutputValue value={value} />
                    </dd>
                  </Fragment>
                ))}
              </dl>
            </div>
          ))}
        </section>
      )}

      <section className="info-section">
        <h4>History</h4>
        <dl className="info">
          <dt>Created</dt>
          <dd>{new Date(task.createdAt).toLocaleString()}</dd>
          {task.archivedAt && (
            <>
              <dt>Archived</dt>
              <dd>{new Date(task.archivedAt).toLocaleString()}</dd>
            </>
          )}
        </dl>
      </section>

      {!readOnly && (
        <section className="danger-zone">
          <div>
            <h4>Archive task</h4>
            <p className="muted small">Removes the worktree (branch kept) and transcripts. Artifacts and the timeline stay.</p>
          </div>
          <button type="button" className="button danger" onClick={() => setArchiving(true)}>
            <Archive size={14} />
            Archive
          </button>
        </section>
      )}
      {archiving && <ArchiveDialog task={task} onClose={() => setArchiving(false)} />}
    </div>
  );
}

function OutputValue({ value }: { value: unknown }) {
  if (typeof value === "string" && /^https?:\/\//.test(value)) {
    return (
      <a href={value} target="_blank" rel="noreferrer">
        {value}
      </a>
    );
  }
  return <>{typeof value === "string" ? value : JSON.stringify(value)}</>;
}
