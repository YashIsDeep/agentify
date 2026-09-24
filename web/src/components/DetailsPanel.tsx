import type { TaskDetail, TaskSummary } from "@wm/shared";
import { type FormEvent, useEffect, useState } from "react";
import { useApi } from "../api-context";
import { useTaskAction } from "../hooks";
import { AGENTS } from "../lib/agents";
import { parseTags } from "../lib/format";
import { cleanLinks, type LinkDraft } from "../lib/links";
import { latestOutputs } from "../lib/runs";
import { useUnsavedChangesGuard } from "../lib/url-state";
import { Button, DetailList, Field, FieldRow, FormStack } from "../ui";
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
        {/* A fieldset, so an archived task's whole form is read-only in one go. */}
        <fieldset className="details-fieldset" disabled={readOnly}>
          <FormStack>
            <Field label="Title">
              <input value={form.title} onChange={(e) => update({ title: e.target.value })} required />
            </Field>
            <Field label="Description" optional>
              <textarea value={form.description} rows={5} onChange={(e) => update({ description: e.target.value })} />
            </Field>
            <RepoFields repoPath={form.repoPath} baseBranch={form.baseBranch} optional onChange={update} />
            {form.repoPath.trim() !== "" && (
              <WorktreeCheck
                checked={form.useWorktree || !!task.worktreePath}
                disabled={!!task.worktreePath}
                onChange={(useWorktree) => update({ useWorktree })}
              />
            )}
            <Field label="Tags" optional>
              <input value={form.tags} onChange={(e) => update({ tags: e.target.value })} placeholder="Comma-separated, e.g. ui, backend" />
            </Field>
            <LinksField links={form.links} optional onChange={(links) => update({ links })} />
            <FieldRow>
              <Field
                label="Coding agent"
                grow
                tip="Overrides every coding-agent action on this task, ahead of the action's and stage's own choices. The Retry dialog can override again."
              >
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
              </Field>
              <Field label="Model" grow>
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
              </Field>
              <Field label="Effort">
                <EffortSelect
                  value={form.effortOverride}
                  agent={form.agentOverride || null}
                  model={form.modelOverride}
                  blankLabel="No override"
                  onChange={(value) => update({ effortOverride: value })}
                />
              </Field>
            </FieldRow>
          </FormStack>
        </fieldset>
        {!readOnly && (
          <div className="form-actions">
            {dirty && (
              <Button
                variant="ghost"
                onClick={() => {
                  setForm(toForm(task));
                  setDirty(false);
                }}
              >
                Discard
              </Button>
            )}
            <Button type="submit" variant="primary" disabled={!dirty || !form.title.trim()} loading={save.isPending} loadingText="Saving…">
              Save changes
            </Button>
          </div>
        )}
      </form>

      <section className="info-section">
        <h4>Git</h4>
        <DetailList
          mono
          items={[
            ["Branch", task.branch],
            ["Base", task.baseBranch],
            ["Worktree", task.worktreePath],
          ]}
        />
      </section>

      {outputs.length > 0 && (
        <section className="info-section">
          <h4>Outputs</h4>
          {outputs.map((output) => (
            <div key={output.key} className="output">
              <div className="output-label">
                {output.label} <code>{output.key}</code>
              </div>
              <DetailList mono items={Object.entries(output.outputs).map(([key, value]) => [key, <OutputValue value={value} />])} />
            </div>
          ))}
        </section>
      )}

      <section className="info-section">
        <h4>History</h4>
        <DetailList
          items={[
            ["Created", new Date(task.createdAt).toLocaleString()],
            ...(task.archivedAt ? ([["Archived", new Date(task.archivedAt).toLocaleString()]] as [string, string][]) : []),
          ]}
        />
      </section>
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
