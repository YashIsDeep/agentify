import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWorkspaceSchema, workspaceSchema, type WorkspaceInfo } from "@wm/shared";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z, ZodError } from "zod";
import { bootstrap, type AppContext } from "./bootstrap";
import type { AppConfig } from "./config";
import { localOnly } from "./api/security";
import * as s from "./db/schema";
import { EngineError } from "./engine/engine";

type BootstrapOptions = Parameters<typeof bootstrap>[1];
const catalogSchema = z.object({ version: z.literal(1), workspaces: z.array(workspaceSchema).min(1) });

/**
 * A workspace owns a complete runtime, database and secrets file. The default workspace keeps
 * the original paths, so existing tasks, worktrees, credentials and external links remain valid.
 */
export class WorkspaceManager {
  private readonly contexts = new Map<string, AppContext>();
  private readonly catalogFile: string;
  private workspaces: WorkspaceInfo[];
  private running = false;
  readonly defaultContext: AppContext;

  constructor(private readonly config: AppConfig, private readonly options: BootstrapOptions = {}) {
    this.catalogFile = join(config.dataDir, "workspaces.json");
    const firstRun = !existsSync(join(config.dataDir, "db.sqlite"));
    this.defaultContext = bootstrap(config, {
      ...options,
      seed: options?.seed ?? firstRun,
      workspaceId: "default",
      externalLongRuns: () => this.externalLongRuns("default"),
    });
    this.register("default", this.defaultContext);
    if (existsSync(this.catalogFile)) {
      this.workspaces = catalogSchema.parse(JSON.parse(readFileSync(this.catalogFile, "utf8"))).workspaces;
      if (!this.workspaces.some((workspace) => workspace.id === "default") ||
          new Set(this.workspaces.map((workspace) => workspace.id)).size !== this.workspaces.length) {
        this.defaultContext.sqlite.close();
        throw new Error("Invalid workspace catalog");
      }
    } else {
      const now = Date.now();
      this.workspaces = [{ id: "default", name: "My workspace", createdAt: now, updatedAt: now }];
      this.persist(this.workspaces);
    }
    // Load every workspace before starting runners so background work continues after a restart.
    for (const workspace of this.workspaces) {
      if (workspace.id !== "default") this.register(workspace.id, this.open(workspace.id));
    }
  }

  list(): WorkspaceInfo[] {
    return this.workspaces.map((workspace) => ({ ...workspace }));
  }

  get(id: string): AppContext {
    const context = this.contexts.get(id);
    if (!context) throw new EngineError("Workspace not found", 404);
    return context;
  }

  rename(id: string, raw: unknown): WorkspaceInfo {
    this.get(id);
    const { name } = createWorkspaceSchema.parse(raw);
    const next = this.workspaces.map((workspace) => workspace.id === id ? { ...workspace, name, updatedAt: Date.now() } : workspace);
    this.persist(next);
    this.workspaces = next;
    return { ...next.find((workspace) => workspace.id === id)! };
  }

  create(raw: unknown, sourceId?: string): WorkspaceInfo {
    const { name } = createWorkspaceSchema.parse(raw);
    const source = sourceId === undefined ? undefined : this.get(sourceId);
    const now = Date.now();
    const workspace = { id: randomUUID(), name, createdAt: now, updatedAt: now };
    const target = this.open(workspace.id);
    try {
      if (source) {
        // IDs are local to a database. Keeping them preserves stage targets, connection references
        // and output keys without copying any tasks, runs, artifacts or archive records.
        target.sqlite.transaction(() => {
          const workflows = source.db.select().from(s.workflows).all();
          const stages = source.db.select().from(s.stages).all();
          const bindings = source.db.select().from(s.actionBindings).all();
          const settings = source.db.select().from(s.settings).all();
          if (workflows.length) target.db.insert(s.workflows).values(workflows).run();
          if (stages.length) target.db.insert(s.stages).values(stages).run();
          if (bindings.length) target.db.insert(s.actionBindings).values(bindings).run();
          if (settings.length) target.db.insert(s.settings).values(settings).run();
        })();
        if (existsSync(source.paths.secretsFile)) {
          copyFileSync(source.paths.secretsFile, target.paths.secretsFile);
          chmodSync(target.paths.secretsFile, 0o600);
        }
      }
      // Publish only after every copy succeeds. A failed copy never becomes selectable.
      const next = [...this.workspaces, workspace];
      this.persist(next);
      this.workspaces = next;
      this.register(workspace.id, target);
    } catch (error) {
      target.sqlite.close();
      throw error;
    }
    if (this.running) target.runner.start();
    return { ...workspace };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const context of this.contexts.values()) context.runner.start();
  }

  async close(): Promise<void> {
    this.running = false;
    await Promise.all([...this.contexts.values()].map((context) => context.close()));
  }

  private open(id: string): AppContext {
    return bootstrap(
      { ...this.config, dataDir: join(this.config.dataDir, "workspaces", id) },
      { ...this.options, seed: false, workspaceId: id, externalLongRuns: () => this.externalLongRuns(id) },
    );
  }

  private externalLongRuns(id: string): number {
    let total = 0;
    for (const [otherId, context] of this.contexts) {
      if (otherId === id) continue;
      total += context.db.select({ actionType: s.actionRuns.actionType }).from(s.actionRuns)
        .where(eq(s.actionRuns.status, "running")).all()
        .filter((run) => context.registry.get(run.actionType)?.longRunning).length;
    }
    return total;
  }

  private register(id: string, context: AppContext): void {
    this.contexts.set(id, context);
    context.engine.on((event) => {
      if (!this.running || (event.type !== "run.changed" && event.type !== "run.cancelled")) return;
      // A freed slot should wake queued work even when it belongs to another workspace.
      for (const [otherId, other] of this.contexts) {
        if (otherId !== id) other.engine.publish({ type: "runs.queued" });
      }
    });
  }

  private persist(workspaces: WorkspaceInfo[]): void {
    const temporary = `${this.catalogFile}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, workspaces }, null, 2), { mode: 0o600 });
    renameSync(temporary, this.catalogFile);
  }
}

export function bootstrapWorkspaces(config: AppConfig, options: BootstrapOptions = {}) {
  const workspaces = new WorkspaceManager(config, options);
  const app = new Hono();
  app.use("*", localOnly({ allowedOriginPorts: [config.port, ...config.devOriginPorts] }));
  app.onError((error, c) => {
    if (error instanceof EngineError) return c.json({ error: error.message }, error.status);
    if (error instanceof ZodError) return c.json({ error: z.prettifyError(error) }, 400);
    console.error(error);
    return c.json({ error: "Internal server error" }, 500);
  });
  app.get("/api/workspaces", (c) => c.json(workspaces.list()));
  app.post("/api/workspaces", async (c) => c.json(workspaces.create(await readBody(c.req.raw)), 201));
  app.patch("/api/workspaces/:workspaceId", async (c) =>
    c.json(workspaces.rename(c.req.param("workspaceId"), await readBody(c.req.raw))),
  );
  app.post("/api/workspaces/:workspaceId/clone", async (c) =>
    c.json(workspaces.create(await readBody(c.req.raw), c.req.param("workspaceId")), 201),
  );
  app.all("/api/workspaces/:workspaceId/*", (c) => {
    const id = c.req.param("workspaceId");
    const context = workspaces.get(id);
    const url = new URL(c.req.url);
    const suffix = url.pathname.slice(`/api/workspaces/${id}`.length);
    url.pathname = suffix.startsWith("/mcp/") ? suffix : `/api${suffix}`;
    return context.app.fetch(new Request(url, c.req.raw));
  });
  // Older local API clients and saved URLs still address the original workspace.
  app.all("*", (c) => workspaces.defaultContext.app.fetch(c.req.raw));
  return { workspaces, app, start: () => workspaces.start(), close: () => workspaces.close() };
}

async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new EngineError("Invalid JSON body");
  }
}
