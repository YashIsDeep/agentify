import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConnectionInfo, ConnectionTestResult, ConnectionType, ConnectionTypeInfo } from "@wm/shared";
import { Check, ExternalLink, KeyRound, Plug, Plus, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { Modal } from "./Modal";
import { useToast } from "./Toast";

export function ConnectionsView() {
  const types = useQuery({ queryKey: ["connection-types"], queryFn: api.connectionTypes, staleTime: Infinity });
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.connections });
  const [adding, setAdding] = useState<ConnectionTypeInfo | null>(null);

  return (
    <div className="page-view">
      <div className="page-header">
        <div>
          <h2>Connections</h2>
          <p className="muted">
            Credentials for the Jira, Linear and Notion actions. They are stored in{" "}
            <code>secrets.json</code> beside the database — never inside it, and never copied when a template is duplicated
            or exported. Secrets are write-only: once saved, the browser only learns that they are set.
          </p>
        </div>
      </div>

      {connections.error && <p className="error">{connections.error.message}</p>}

      <div className="agent-grid">
        {connections.data?.map((connection) => {
          const type = types.data?.find((candidate) => candidate.type === connection.type);
          return type ? <ConnectionCard key={connection.id} connection={connection} type={type} /> : null;
        })}
      </div>

      {connections.data?.length === 0 && <p className="muted">No connections yet.</p>}

      <div className="conn-add">
        {types.data?.map((type) => (
          <button key={type.type} type="button" className="button" onClick={() => setAdding(type)}>
            <Plus size={14} />
            Add {type.label}
          </button>
        ))}
      </div>

      {adding && <NewConnectionDialog type={adding} onClose={() => setAdding(null)} />}
    </div>
  );
}

/** A field the user left untouched is omitted, so saving a form never clears a secret. */
function useConnectionForm(type: ConnectionTypeInfo, connection?: ConnectionInfo) {
  const [name, setName] = useState(connection?.name ?? type.label);
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...(connection?.values ?? {}) }));
  const [touched, setTouched] = useState<Set<string>>(new Set());

  const set = (field: string, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setTouched((current) => new Set(current).add(field));
  };

  const changed = (field: string) => touched.has(field);
  const payload = () => Object.fromEntries([...touched].map((field) => [field, values[field] ?? ""]));

  return { name, setName, values, set, changed, payload, touched };
}

function ConnectionFields({
  type,
  form,
  secretsSet,
}: {
  type: ConnectionTypeInfo;
  form: ReturnType<typeof useConnectionForm>;
  secretsSet: string[];
}) {
  return (
    <>
      {type.fields.map((field) => {
        const saved = field.secret && secretsSet.includes(field.name);
        return (
          <label className="field" key={field.name}>
            <span>
              {field.label}
              {field.required ? "" : " (optional)"}
            </span>
            <input
              type={field.secret ? "password" : "text"}
              autoComplete="off"
              value={form.values[field.name] ?? ""}
              placeholder={saved && !form.changed(field.name) ? "•••••••• saved" : field.placeholder}
              onChange={(event) => form.set(field.name, event.target.value)}
            />
            {field.help && <span className="hint">{field.help}</span>}
            {saved && !form.changed(field.name) && <span className="hint">Leave blank to keep the saved value.</span>}
          </label>
        );
      })}
    </>
  );
}

function ConnectionCard({ connection, type }: { connection: ConnectionInfo; type: ConnectionTypeInfo }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const form = useConnectionForm(type, connection);
  const [result, setResult] = useState<ConnectionTestResult | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["connections"] });

  const save = useMutation({
    mutationFn: () => api.updateConnection(connection.id, { name: form.name, values: form.payload() }),
    onSuccess: async () => {
      await refresh();
      toast(`Saved “${form.name}”`);
    },
    onError: (error) => toast(error.message, "error"),
  });

  const test = useMutation({
    mutationFn: () => api.testConnection(connection.id),
    onMutate: () => setResult(null),
    onSuccess: setResult,
    onError: (error) => setResult({ ok: false, detail: "", error: error.message, durationMs: 0 }),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteConnection(connection.id),
    onSuccess: async () => {
      setDeleting(false);
      await refresh();
      toast(`Deleted “${connection.name}”`);
    },
    onError: (error) => {
      setDeleting(false);
      toast(error.message, "error");
    },
  });

  const missing = type.fields.filter((field) => field.required && !form.values[field.name] && !connection.secretsSet.includes(field.name));

  return (
    <section className="agent-card">
      <header className="agent-card-header">
        <Plug size={18} />
        <h3>{connection.name}</h3>
        <span className="pill pill-muted">{type.label}</span>
      </header>

      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <label className="field">
          <span>Name</span>
          <input value={form.name} onChange={(event) => form.setName(event.target.value)} />
        </label>
        <ConnectionFields type={type} form={form} secretsSet={connection.secretsSet} />

        {missing.length > 0 && (
          <div className="callout callout-danger">
            <TriangleAlert size={14} />
            {/* Labels are already cased for display ("API token"), so use them verbatim. */}
            <span>Still needs {missing.map((field) => field.label).join(" and ")}.</span>
          </div>
        )}

        <div className="agent-row">
          <button type="submit" className="button primary" disabled={save.isPending}>
            Save
          </button>
          <button type="button" className="button" disabled={test.isPending} onClick={() => test.mutate()}>
            <KeyRound size={14} />
            {test.isPending ? "Testing…" : "Test"}
          </button>
          <span className="spacer" />
          <button type="button" className="button danger ghost" onClick={() => setDeleting(true)}>
            <Trash2 size={14} />
            Delete
          </button>
        </div>
      </form>

      {result &&
        (result.ok ? (
          <div className="callout callout-success">
            <Check size={14} />
            <span>
              Authenticated as {result.detail} in {(result.durationMs / 1000).toFixed(1)}s
            </span>
          </div>
        ) : (
          <div className="callout callout-danger">
            <TriangleAlert size={14} />
            <span>{result.error}</span>
          </div>
        ))}

      {deleting && (
        <Modal title="Delete connection" onClose={() => setDeleting(false)}>
          <div className="modal-body">
            <p className="dialog-lead">{connection.name}</p>
            <p className="muted small">
              Actions using it will fail until you pick another one. The credential is removed from{" "}
              <code>secrets.json</code>.
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
    </section>
  );
}

function NewConnectionDialog({ type, onClose }: { type: ConnectionTypeInfo; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const form = useConnectionForm(type);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.createConnection({ name: form.name, type: type.type as ConnectionType, values: form.payload() }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ["connections"] });
      toast(`Added “${created.name}”`);
      onClose();
    },
    onError: (err) => setError(err.message),
  });

  return (
    <Modal title={`Add ${type.label} connection`} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <div className="modal-body form-grid">
          <p className="muted small">{type.description}</p>
          <label className="field">
            <span>Name</span>
            <input value={form.name} onChange={(event) => form.setName(event.target.value)} autoFocus placeholder="Work Jira" />
          </label>
          <ConnectionFields type={type} form={form} secretsSet={[]} />
          <a className="hint link-row" href={type.docsUrl} target="_blank" rel="noreferrer noopener">
            Where to create this credential
            <ExternalLink size={12} />
          </a>
          {error && <div className="callout callout-danger">{error}</div>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!form.name.trim() || create.isPending}>
            Add
          </button>
        </footer>
      </form>
    </Modal>
  );
}
