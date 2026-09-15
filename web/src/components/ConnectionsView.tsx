import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConnectionInfo, ConnectionTestResult, ConnectionType, ConnectionTypeInfo } from "@wm/shared";
import { Check, ExternalLink, KeyRound, Plug, Plus, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useApi } from "../api-context";
import { BrandIcon, hasBrandIcon } from "./BrandIcon";
import { Modal } from "./Modal";
import { useToast } from "./Toast";

export function ConnectionsView() {
  const api = useApi();
  const types = useQuery({ queryKey: ["connection-types"], queryFn: api.connectionTypes, staleTime: Infinity });
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.connections });
  const [adding, setAdding] = useState<ConnectionTypeInfo | null>(null);

  return (
    <div className="page-view">
      <div className="page-header">
        <div>
          <h2>Connections</h2>
          <p className="muted">
            Connections belong to this workspace. Clone the workspace to reuse them, including saved credentials.
            Secret values are never shown after saving.
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
            {hasBrandIcon(type.type) ? <BrandIcon brand={type.type} size={14} /> : <Plus size={14} />}
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
  /** After a save, secrets go back to their "saved" placeholder and nothing counts as edited. */
  const markSaved = () => {
    const secret = new Set(type.fields.filter((field) => field.secret).map((field) => field.name));
    setValues((current) => Object.fromEntries(Object.entries(current).filter(([field]) => !secret.has(field))));
    setTouched(new Set());
  };

  return { name, setName, values, set, changed, payload, touched, markSaved };
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
  const api = useApi();
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
      form.markSaved();
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
  const unsaved = form.touched.size > 0 || form.name !== connection.name;

  return (
    <section className="agent-card">
      <header className="agent-card-header">
        {hasBrandIcon(type.type) ? <BrandIcon brand={type.type} size={18} /> : <Plug size={18} />}
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
          <button type="submit" className="button primary" disabled={save.isPending || !unsaved || !form.name.trim()}>
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
        {/* Test authenticates with what is stored, not with what is typed here. */}
        {unsaved && <p className="hint">Test uses the saved credentials. Save first to test your changes.</p>}
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
  const api = useApi();
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
