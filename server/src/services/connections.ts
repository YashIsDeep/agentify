import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type ConnectionInfo,
  type ConnectionTestResult,
  type ConnectionType,
  type ConnectionTypeInfo,
  type CreateConnectionInput,
  createConnectionSchema,
  type UpdateConnectionInput,
  updateConnectionSchema,
} from "@wm/shared";
import { EngineError } from "../engine/engine";
import { DEFAULT_CONNECTION_ADAPTERS } from "../integrations";
import { normalizeBaseUrl } from "../integrations/jira";
import { writePrivateFile } from "../lib/atomic-file";
import type { AnyConnectionAdapter, ConnectionAdapter, ConnectionValues, HttpFetch } from "../integrations/types";
import type { Paths } from "../paths";

/** A connection with its secrets. Server-side only — the API returns {@link ConnectionInfo}. */
export interface ConnectionRecord {
  id: string;
  name: string;
  type: ConnectionType;
  values: ConnectionValues;
  createdAt: number;
  updatedAt: number;
}

interface SecretsFile {
  version: 1;
  connections: ConnectionRecord[];
}

const EMPTY: SecretsFile = { version: 1, connections: [] };

/**
 * Named credentials for the integration actions.
 *
 * They live in `secrets.json` beside the database rather than in it, so the database stays
 * safe to copy, inspect and export while the tokens do not travel with a workflow. Secret
 * field values never leave this process: the API reports only which ones are set.
 */
export class ConnectionService {
  private readonly adapters: Map<ConnectionType, AnyConnectionAdapter>;

  constructor(
    private readonly paths: Paths,
    private readonly http: HttpFetch = globalThis.fetch,
    adapters: AnyConnectionAdapter[] = DEFAULT_CONNECTION_ADAPTERS,
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.type, adapter]));
  }

  types(): ConnectionTypeInfo[] {
    return [...this.adapters.values()].map(({ type, label, description, docsUrl, fields }) => ({
      type,
      label,
      description,
      docsUrl,
      fields,
    }));
  }

  adapter(type: ConnectionType): AnyConnectionAdapter {
    const adapter = this.adapters.get(type);
    if (!adapter) throw new EngineError(`Unknown connection type "${type}"`, 404);
    return adapter;
  }

  list(): ConnectionInfo[] {
    return this.read().connections.map((connection) => this.toInfo(connection));
  }

  /** The full record, secrets included. For actions, not for responses. */
  get(id: string): ConnectionRecord {
    const connection = this.read().connections.find((candidate) => candidate.id === id);
    if (!connection) throw new EngineError("Connection not found", 404);
    return connection;
  }

  create(raw: CreateConnectionInput): ConnectionInfo {
    const input = createConnectionSchema.parse(raw);
    const adapter = this.adapter(input.type);
    const now = Date.now();
    const connection: ConnectionRecord = {
      id: randomUUID(),
      name: input.name,
      type: input.type,
      values: clean(adapter, input.values),
      createdAt: now,
      updatedAt: now,
    };
    const file = this.read();
    this.write({ ...file, connections: [...file.connections, connection] });
    return this.toInfo(connection);
  }

  /** Only the fields present are changed, so the browser can save a form it never saw secrets for. */
  update(id: string, raw: UpdateConnectionInput): ConnectionInfo {
    const input = updateConnectionSchema.parse(raw);
    const file = this.read();
    const current = file.connections.find((candidate) => candidate.id === id);
    if (!current) throw new EngineError("Connection not found", 404);
    const adapter = this.adapter(current.type);

    const next: ConnectionRecord = {
      ...current,
      name: input.name ?? current.name,
      values: clean(adapter, { ...current.values, ...input.values }),
      updatedAt: Date.now(),
    };
    this.write({ ...file, connections: file.connections.map((candidate) => (candidate.id === id ? next : candidate)) });
    return this.toInfo(next);
  }

  remove(id: string): void {
    const file = this.read();
    if (!file.connections.some((connection) => connection.id === id)) throw new EngineError("Connection not found", 404);
    this.write({ ...file, connections: file.connections.filter((connection) => connection.id !== id) });
  }

  /** Builds a client and asks the service who we are. */
  async test(id: string): Promise<ConnectionTestResult> {
    const started = Date.now();
    const connection = this.get(id);
    const adapter = this.adapter(connection.type);
    try {
      const detail = await adapter.test(adapter.client(connection.values, this.http));
      return { ok: true, detail, error: null, durationMs: Date.now() - started };
    } catch (err) {
      return { ok: false, detail: "", error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - started };
    }
  }

  /**
   * Resolves the connection an action is configured with, or explains what to fix.
   * Actions pass their own adapter, so the client comes back typed.
   */
  client<T>(id: string, adapter: ConnectionAdapter<T>): { connection: ConnectionRecord; client: T } {
    if (!id) throw new Error(`This action has no ${adapter.label} connection selected. Pick one in the workflow editor.`);
    const connection = this.read().connections.find((candidate) => candidate.id === id);
    if (!connection) throw new Error(`The ${adapter.label} connection this action used has been deleted. Pick another one.`);
    if (connection.type !== adapter.type) throw new Error(`“${connection.name}” is a ${connection.type} connection, not ${adapter.label}`);
    return { connection, client: adapter.client(connection.values, this.http) };
  }

  /** Whether a workflow may enable an action bound to this connection. */
  exists(id: string, type: ConnectionType): boolean {
    return this.read().connections.some((connection) => connection.id === id && connection.type === type);
  }

  private toInfo(connection: ConnectionRecord): ConnectionInfo {
    const secretNames = new Set(this.adapter(connection.type).fields.filter((field) => field.secret).map((field) => field.name));
    return {
      id: connection.id,
      name: connection.name,
      type: connection.type,
      values: Object.fromEntries(Object.entries(connection.values).filter(([name]) => !secretNames.has(name))),
      secretsSet: [...secretNames].filter((name) => !!connection.values[name]),
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    };
  }

  // ---------------------------------------------------------------- file

  private read(): SecretsFile {
    let text: string;
    try {
      text = readFileSync(this.paths.secretsFile, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
      throw err;
    }
    const parsed = JSON.parse(text) as SecretsFile;
    return { version: 1, connections: parsed.connections ?? [] };
  }

  /** Written owner-only, and atomically: a half-written secrets file would lose every credential. */
  private write(file: SecretsFile): void {
    writePrivateFile(this.paths.secretsFile, `${JSON.stringify(file, null, 2)}\n`);
  }
}

/** Keeps only the fields the adapter declares, trimmed; blanks are dropped rather than stored. */
function clean(adapter: AnyConnectionAdapter, values: ConnectionValues): ConnectionValues {
  const cleaned: ConnectionValues = {};
  for (const field of adapter.fields) {
    const value = values[field.name]?.trim();
    if (value) cleaned[field.name] = value;
  }
  if (adapter.type === "jira" && cleaned.baseUrl) {
    try {
      normalizeBaseUrl(cleaned.baseUrl);
    } catch (error) {
      throw new EngineError(error instanceof Error ? error.message : "Invalid Jira site URL");
    }
  }
  return cleaned;
}
