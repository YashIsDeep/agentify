import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConnectionInfo, ConnectionTestResult, ConnectionType, ConnectionTypeInfo } from "@wm/shared";
import { ExternalLink, KeyRound, Plug, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useApi } from "../api-context";
import {
  Button,
  Callout,
  Card,
  CardGrid,
  CardHeader,
  Dialog,
  DialogBody,
  DialogFooter,
  EmptyState,
  Field,
  FormStack,
  Page,
  Tag,
  useToast,
} from "../ui";
import { BrandIcon, hasBrandIcon } from "./BrandIcon";

const typeIcon = (type: string, size: number) => (hasBrandIcon(type) ? <BrandIcon brand={type} size={size} /> : <Plug size={size} />);

export function ConnectionsView() {
  const api = useApi();
  const types = useQuery({ queryKey: ["connection-types"], queryFn: api.connectionTypes, staleTime: Infinity });
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.connections });
  const [adding, setAdding] = useState<ConnectionTypeInfo | null>(null);
  const addButtons = (
    <div className="conn-add">
      {types.data?.map((type) => (
        <Button key={type.type} icon={hasBrandIcon(type.type) ? <BrandIcon brand={type.type} size={14} /> : Plus} onClick={() => setAdding(type)}>
          Add {type.label}
        </Button>
      ))}
    </div>
  );

  return (
    <Page
      title="Connections"
      tip="Accounts that workflow actions sign in to. They belong to this workspace, and secrets are never shown again once saved."
      narrow
    >
      {connections.error && (
        <Callout tone="danger">
          Could not load connections: {connections.error.message}{" "}
          <Button variant="link" onClick={() => void connections.refetch()}>
            Try again
          </Button>
        </Callout>
      )}

      {connections.data?.length === 0 ? (
        <EmptyState icon={Plug} title="No connections yet" action={addButtons}>
          Add one to let actions move Jira issues, update Linear, or write to Notion.
        </EmptyState>
      ) : (
        <>
          <CardGrid>
            {connections.data?.map((connection) => {
              const type = types.data?.find((candidate) => candidate.type === connection.type);
              return type ? <ConnectionCard key={connection.id} connection={connection} type={type} /> : null;
            })}
          </CardGrid>
          {connections.data && addButtons}
        </>
      )}

      {adding && <NewConnectionDialog type={adding} onClose={() => setAdding(null)} />}
    </Page>
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

/** The name, then the fields the server declares for this type of connection. */
function ConnectionFields({
  type,
  form,
  secretsSet,
  autoFocus = false,
}: {
  type: ConnectionTypeInfo;
  form: ReturnType<typeof useConnectionForm>;
  secretsSet: string[];
  autoFocus?: boolean;
}) {
  return (
    <>
      <Field label="Name">
        <input value={form.name} onChange={(event) => form.setName(event.target.value)} autoFocus={autoFocus} placeholder={`Work ${type.label}`} />
      </Field>
      {type.fields.map((field) => {
        const saved = field.secret && secretsSet.includes(field.name);
        return (
          <Field
            key={field.name}
            label={field.label}
            optional={!field.required}
            tip={
              (field.help || saved) && (
                <>
                  {field.help && <p>{field.help}</p>}
                  {saved && <p>Leave blank to keep the saved value.</p>}
                </>
              )
            }
          >
            <input
              type={field.secret ? "password" : "text"}
              autoComplete="off"
              value={form.values[field.name] ?? ""}
              placeholder={saved && !form.changed(field.name) ? "•••••••• saved" : field.placeholder}
              onChange={(event) => form.set(field.name, event.target.value)}
            />
          </Field>
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
    <Card>
      <CardHeader brand={type.type} icon={typeIcon(type.type, 20)} title={connection.name} aside={<Tag>{type.label}</Tag>} />

      <form
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <FormStack>
          <ConnectionFields type={type} form={form} secretsSet={connection.secretsSet} />
          {/* Labels are already cased for display ("API token"), so use them verbatim. */}
          {missing.length > 0 && <Callout tone="danger">Still needs {missing.map((field) => field.label).join(" and ")}.</Callout>}
          <div className="agent-row">
            <Button type="submit" variant="primary" disabled={!unsaved || !form.name.trim()} loading={save.isPending} loadingText="Saving…">
              Save
            </Button>
            <Button
              icon={KeyRound}
              loading={test.isPending}
              loadingText="Testing…"
              // Test signs in with what is stored, not with what is typed here.
              title={unsaved ? "Tests the saved credentials. Save first to test your changes." : "Sign in with the saved credentials"}
              onClick={() => test.mutate()}
            >
              Test
            </Button>
            <span className="spacer" />
            <Button variant="danger" icon={Trash2} onClick={() => setDeleting(true)}>
              Delete
            </Button>
          </div>
        </FormStack>
      </form>

      {result &&
        (result.ok ? (
          <Callout tone="success">
            Authenticated as {result.detail} in {(result.durationMs / 1000).toFixed(1)}s
          </Callout>
        ) : (
          <Callout tone="danger">{result.error}</Callout>
        ))}

      {deleting && (
        <Dialog title="Delete connection" onClose={() => setDeleting(false)}>
          <DialogBody lead={connection.name}>
            <p className="muted small">
              Actions using it will fail until you pick another one. The credential is removed from <code>secrets.json</code>.
            </p>
          </DialogBody>
          <DialogFooter onCancel={() => setDeleting(false)} busy={remove.isPending}>
            <Button variant="danger" loading={remove.isPending} loadingText="Deleting…" onClick={() => remove.mutate()}>
              Delete connection
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </Card>
  );
}

function NewConnectionDialog({ type, onClose }: { type: ConnectionTypeInfo; onClose: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const form = useConnectionForm(type);

  const create = useMutation({
    mutationFn: () => api.createConnection({ name: form.name, type: type.type as ConnectionType, values: form.payload() }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ["connections"] });
      toast(`Added “${created.name}”`);
      onClose();
    },
  });

  return (
    <Dialog title={`Add ${type.label} connection`} onClose={onClose} onSubmit={() => create.mutate()}>
      <DialogBody>
        <ConnectionFields type={type} form={form} secretsSet={[]} autoFocus />
        <a className="conn-docs" href={type.docsUrl} target="_blank" rel="noreferrer noopener">
          Where to create this credential
          <ExternalLink size={12} aria-hidden="true" />
        </a>
        {create.error && <Callout tone="danger">{create.error.message}</Callout>}
      </DialogBody>
      <DialogFooter onCancel={onClose} busy={create.isPending}>
        <Button type="submit" variant="primary" disabled={!form.name.trim()} loading={create.isPending} loadingText="Adding…">
          Add connection
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
