import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  AGENT_IDS,
  type ArtifactInfo,
  archiveTaskSchema,
  createConnectionSchema,
  createTaskSchema,
  createWorkflowSchema,
  saveWorkflowSchema,
  testAgentSchema,
  updateAgentSchema,
  listTasksQuerySchema,
  moveTaskSchema,
  type RunLogLine,
  retryRunSchema,
  type ServerEvent,
  triggerBindingSchema,
  updateConnectionSchema,
  updateTaskSchema,
} from "@wm/shared";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ZodError, z } from "zod";
import type { AgentService } from "../agents/service";
import type { AppConfig } from "../config";
import { EngineError, type Engine, type InternalEvent } from "../engine/engine";
import { type Paths, resolveInside } from "../paths";
import type { ConnectionService } from "../services/connections";
import type { RepoService } from "../services/repos";
import type { TemplateService } from "../services/templates";
import { localOnly } from "./security";
import { serveWeb } from "./static";

export interface AppDeps {
  engine: Engine;
  paths: Paths;
  config: AppConfig;
  agents: AgentService;
  connections: ConnectionService;
  templates: TemplateService;
  repos: RepoService;
  archiveTask(taskId: string, options?: { force?: boolean }): Promise<void>;
  /** Built web app to serve at `/`, if present. */
  webDist?: string;
}

const SERVER_EVENT_TYPES = new Set<InternalEvent["type"]>(["task.changed", "run.changed", "timeline.appended", "run.log"]);
const runIdSchema = z.coerce.number().int().positive();
const agentIdSchema = z.enum(AGENT_IDS);

export function createApp({ engine, paths, config, agents, connections, templates, repos, archiveTask, webDist }: AppDeps): Hono {
  const app = new Hono();
  app.use("*", localOnly({ allowedOriginPorts: [config.port, ...config.devOriginPorts] }));

  app.onError((err, c) => {
    if (err instanceof EngineError) return c.json({ error: err.message }, err.status);
    if (err instanceof ZodError) return c.json({ error: z.prettifyError(err), issues: err.issues }, 400);
    console.error(err);
    return c.json({ error: "Internal server error" }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  // ---- workflows
  app.get("/api/workflows", (c) => c.json(engine.listWorkflows()));
  app.get("/api/workflows/:id", (c) => c.json(engine.getWorkflow(c.req.param("id"))));
  app.get("/api/workflows/:id/usage", (c) => c.json(engine.workflowUsage(engine.getWorkflow(c.req.param("id")).id)));

  app.post("/api/workflows", async (c) => c.json(templates.create(createWorkflowSchema.parse(await readJson(c))), 201));

  app.put("/api/workflows/:id", async (c) =>
    c.json(await templates.save(c.req.param("id"), saveWorkflowSchema.parse(await readJson(c)))),
  );

  app.delete("/api/workflows/:id", (c) => {
    templates.remove(c.req.param("id"));
    return c.body(null, 204);
  });

  // ---- action catalogue (drives the template editor's forms)
  app.get("/api/action-types", (c) => c.json(templates.actionTypes()));

  // ---- repositories (source for the task form's dropdowns)
  app.get("/api/repos", (c) => c.json(repos.list()));

  app.get("/api/repos/branches", async (c) => {
    const path = c.req.query("path");
    if (!path) throw new EngineError("Query parameter 'path' is required");
    return c.json(await repos.branches(path));
  });

  // ---- tasks
  app.get("/api/tasks", (c) => c.json(engine.listTasks(listTasksQuerySchema.parse(c.req.query()))));

  app.post("/api/tasks", async (c) => {
    const input = createTaskSchema.parse(await readJson(c));
    // Checked here rather than when ensure-worktree runs, which is far too late to fix a typo.
    if (input.repoPath) input.repoPath = await repos.validate(input.repoPath, input.baseBranch);
    const task = engine.createTask(input);
    return c.json(engine.getTaskDetail(task.id), 201);
  });

  app.get("/api/tasks/:id", (c) => c.json(engine.getTaskDetail(c.req.param("id"))));

  app.patch("/api/tasks/:id", async (c) => {
    const id = c.req.param("id");
    const patch = updateTaskSchema.parse(await readJson(c));
    if (patch.repoPath) {
      const baseBranch = patch.baseBranch === undefined ? engine.getTask(id).baseBranch : patch.baseBranch;
      patch.repoPath = await repos.validate(patch.repoPath, baseBranch);
    } else if (patch.baseBranch) {
      const repoPath = engine.getTask(id).repoPath;
      if (repoPath) await repos.validate(repoPath, patch.baseBranch);
    }
    if (patch.modelOverride) {
      // The override applies to every coding-agent action on the task, so it only has to be
      // valid for the agent it will actually run under.
      const agent = patch.agentOverride ?? engine.getTask(id).agentOverride;
      const error = await agents.validateModelFor(agent, patch.modelOverride);
      if (error) throw new EngineError(error);
    }
    engine.updateTask(id, patch);
    return c.json(engine.getTaskDetail(id));
  });

  app.post("/api/tasks/:id/move", async (c) => {
    const id = c.req.param("id");
    const { stageId, runActions } = moveTaskSchema.parse(await readJson(c));
    engine.moveTask(id, stageId, { runActions });
    return c.json(engine.getTaskDetail(id));
  });

  app.post("/api/tasks/:id/phases/:phaseStateId/complete", (c) => {
    const id = c.req.param("id");
    engine.completePhase(id, c.req.param("phaseStateId"));
    return c.json(engine.getTaskDetail(id));
  });

  app.post("/api/tasks/:id/stage/complete", (c) => {
    const id = c.req.param("id");
    engine.completeStage(id);
    return c.json(engine.getTaskDetail(id));
  });

  app.post("/api/tasks/:id/bindings/:bindingId/trigger", async (c) => {
    const id = c.req.param("id");
    engine.triggerManual(id, c.req.param("bindingId"), triggerBindingSchema.parse(await readJson(c)));
    return c.json(engine.getTaskDetail(id));
  });

  app.post("/api/tasks/:id/archive", async (c) => {
    const id = c.req.param("id");
    await archiveTask(id, archiveTaskSchema.parse(await readJson(c)));
    return c.json(engine.getTaskDetail(id));
  });

  // ---- artifacts
  app.get("/api/tasks/:id/artifacts", async (c) => {
    const dir = paths.artifactDir(engine.getTask(c.req.param("id")).id);
    if (!existsSync(dir)) return c.json([]);
    const files: ArtifactInfo[] = [];
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = join(entry.parentPath, entry.name);
      const info = await stat(file);
      files.push({ name: relative(dir, file).split(sep).join("/"), size: info.size, modifiedAt: info.mtimeMs });
    }
    return c.json(files.sort((a, b) => a.name.localeCompare(b.name)));
  });

  app.get("/api/tasks/:id/artifact", async (c) => {
    const task = engine.getTask(c.req.param("id"));
    const name = c.req.query("name");
    if (!name) throw new EngineError("Query parameter 'name' is required");
    let file: string;
    try {
      file = resolveInside(paths.artifactDir(task.id), name);
    } catch {
      throw new EngineError("Invalid artifact name");
    }
    if (!existsSync(file)) throw new EngineError("Artifact not found", 404);
    // Always plain text: artifacts must never render as HTML on this origin.
    return c.body(await readFile(file), 200, {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    });
  });

  // ---- runs
  app.get("/api/runs/:id/log", async (c) => {
    const run = engine.getRun(runIdSchema.parse(c.req.param("id")));
    const file = paths.runLog(run.taskId, run.id);
    if (!existsSync(file)) return c.json([]);
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    return c.json(lines.map((line) => JSON.parse(line) as RunLogLine));
  });

  app.post("/api/runs/:id/retry", async (c) => {
    const { overrides } = retryRunSchema.parse(await readJson(c));
    if (overrides?.model) {
      const error = await agents.validateModelFor(overrides.agent as string | null, String(overrides.model));
      if (error) throw new EngineError(error);
    }
    const retry = engine.retryRun(runIdSchema.parse(c.req.param("id")), overrides);
    return c.json(engine.getTaskDetail(retry.taskId));
  });

  app.post("/api/runs/:id/cancel", (c) => {
    const run = engine.getRun(runIdSchema.parse(c.req.param("id")));
    engine.cancelRun(run.id);
    return c.json(engine.getTaskDetail(run.taskId));
  });

  // ---- agents
  app.get("/api/agents", async (c) => c.json(await agents.statuses()));
  app.get("/api/agent-models", async (c) => c.json(await agents.allModels()));

  app.put("/api/agents/:id", async (c) => {
    const id = agentIdSchema.parse(c.req.param("id"));
    agents.setPathOverride(id, updateAgentSchema.parse(await readJson(c)).path);
    return c.json(await agents.status(id));
  });

  app.post("/api/agents/:id/test", async (c) => {
    const id = agentIdSchema.parse(c.req.param("id"));
    const { model } = testAgentSchema.parse(await readJson(c));
    return c.json(await agents.test(id, model));
  });

  // ---- connections (credentials live in secrets.json; secret values are never returned)
  app.get("/api/connection-types", (c) => c.json(connections.types()));
  app.get("/api/connections", (c) => c.json(connections.list()));

  app.post("/api/connections", async (c) => c.json(connections.create(createConnectionSchema.parse(await readJson(c))), 201));

  app.put("/api/connections/:id", async (c) =>
    c.json(connections.update(c.req.param("id"), updateConnectionSchema.parse(await readJson(c)))),
  );

  app.delete("/api/connections/:id", (c) => {
    connections.remove(c.req.param("id"));
    return c.body(null, 204);
  });

  app.post("/api/connections/:id/test", async (c) => c.json(await connections.test(c.req.param("id"))));

  // ---- live updates
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = engine.on((event) => {
        if (!SERVER_EVENT_TYPES.has(event.type)) return;
        const serverEvent = event as ServerEvent;
        void stream.writeSSE({ event: serverEvent.type, data: JSON.stringify(serverEvent) });
      });
      // Write immediately so headers flush and the client's EventSource opens without waiting for a ping.
      await stream.writeSSE({ event: "ready", data: "" });
      // The client treats ~40s of silence as a dead connection.
      const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }), 15_000);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(ping);
      unsubscribe();
    }),
  );

  if (webDist && existsSync(join(webDist, "index.html"))) serveWeb(app, webDist);

  return app;
}

async function readJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new EngineError("Invalid JSON body");
  }
}
