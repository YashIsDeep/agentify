import { LINK_TYPES, type TaskDetail, type TaskSummary } from "@wm/shared";
import { Archive, Plus, Trash2 } from "lucide-react";
import { type FormEvent, Fragment, useEffect, useState } from "react";
import { api } from "../api";
import { useTaskAction } from "../hooks";
import { AGENTS } from "../lib/agents";
import { parseTags } from "../lib/format";
import { latestOutputs } from "../lib/runs";
import { ArchiveDialog } from "./dialogs";
import { ModelSelect } from "./ModelSelect";
import { RepoFields } from "./RepoFields";

interface FormState {
  title: string;
  description: string;
  repoPath: string;
  baseBranch: string;
  tags: string;
  links: { type: string; value: string }[];
  agentOverride: string;
  modelOverride: string;
}

const toForm = (task: TaskSummary): FormState => ({
  title: task.title,
  description: task.description,
  repoPath: task.repoPath ?? "",
  baseBranch: task.baseBranch ?? "",
  tags: task.tags.join(", "),
  links: task.links.map((link) => ({ ...link })),
  agentOverride: task.agentOverride ?? "",
  modelOverride: task.modelOverride ?? "",
});

export function DetailsPanel({ detail }: { detail: TaskDetail }) {
  const { task } = detail;
  const readOnly = task.status === "archived";
  const [form, setForm] = useState(() => toForm(task));
  const [dirty, setDirty] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const save = useTaskAction();

  // Follow live updates unless the user has unsaved edits.
  useEffect(() => {
    if (!dirty) setForm(toForm(task));
  }, [task, dirty]);

  const update = (patch: Partial<FormState>) => {
    setForm((current) => ({ ...current, ...patch }));
    setDirty(true);
  };
  const updateLink = (index: number, patch: Partial<FormState["links"][number]>) =>
    update({ links: form.links.map((link, i) => (i === index ? { ...link, ...patch } : link)) });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(
      () =>
        api.updateTask(task.id, {
          title: form.title,
          description: form.description,
          repoPath: form.repoPath.trim() || null,
          baseBranch: form.baseBranch.trim() || null,
          tags: parseTags(form.tags),
          links: form.links.filter((link) => link.type.trim() && link.value.trim()),
          agentOverride: form.agentOverride || null,
          modelOverride: form.modelOverride.trim() || null,
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
          <label className="field">
            <span>Tags</span>
            <input value={form.tags} onChange={(e) => update({ tags: e.target.value })} placeholder="comma separated" />
          </label>

          <div className="field">
            <span>Links</span>
            {form.links.map((link, index) => (
              <div key={index} className="link-row">
                {/* A dropdown because `{{task.links.jira}}` matches the type exactly: a link typed
                    "Jira" would render empty and its integration action would quietly skip. */}
                <select
                  className="link-type"
                  value={link.type}
                  onChange={(e) => updateLink(index, { type: e.target.value })}
                >
                  {link.type === "" && <option value="">Type…</option>}
                  {LINK_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                  {link.type !== "" && !LINK_TYPES.includes(link.type as (typeof LINK_TYPES)[number]) && (
                    <option value={link.type}>{link.type}</option>
                  )}
                </select>
                <input value={link.value} placeholder="PROJ-123 or URL" onChange={(e) => updateLink(index, { value: e.target.value })} />
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Remove link"
                  onClick={() => update({ links: form.links.filter((_, i) => i !== index) })}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <button type="button" className="link-button" onClick={() => update({ links: [...form.links, { type: "", value: "" }] })}>
              <Plus size={13} /> Add link
            </button>
          </div>

          <div className="field-row">
            <label className="field field-grow">
              <span>Coding agent</span>
              <select value={form.agentOverride} onChange={(e) => update({ agentOverride: e.target.value })}>
                <option value="">Each action's default</option>
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
                blankLabel="Action / CLI default"
                onChange={(value) => update({ modelOverride: value })}
              />
            </label>
          </div>
          <p className="hint">Overrides apply to every coding-agent action on this task; the Retry dialog can override again.</p>
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
