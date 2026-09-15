import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  AGENT_IDS,
  agentDefaultsSchema,
  type ArtifactInfo,
  answerQuestionSchema,
  archiveTaskSchema,
  createConnectionSchema,
  createTaskSchema,
  createWorkflowSchema,
  draftFromTicketSchema,
  isAgentId,
  saveWorkflowSchema,
  testAgentSchema,
  updateAgentSchema,
  listTasksQuerySchema,
  moveTaskSchema,
  type RunLogLine,
  requestChangesSchema,
  retryRunSchema,
  type ServerEvent,
  sendBackSchema,
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
import { taskDiff } from "../services/diff";
import type { QuestionService } from "../services/questions";
import type { RepoService } from "../services/repos";
import type { WorkflowService } from "../services/workflows";
import type { TicketDraftService } from "../services/ticket-draft";
import { mountMcp } from "./mcp";
import { localOnly } from "./security";
import { serveWeb } from "./static";

export interface AppDeps {
  engine: Engine;
  paths: Paths;
  config: AppConfig;
  agents: AgentService;
  connections: ConnectionService;
  workflows: WorkflowService;
  repos: RepoService;
  questions: QuestionService;
  tickets: TicketDraftService;
  archiveTask(taskId: string, options?: { force?: boolean }): Promise<void>;
  /** Built web app to serve at `/`, if present. */
  webDist?: string;
}

const SERVER_EVENT_TYPES = new Set<InternalEvent["type"]>(["task.changed", "run.changed", "timeline.appended", "run.log"]);
const runIdSchema = z.coerce.number().int().positive();
const agentIdSchema = z.enum(AGENT_IDS);

export function createApp({
  engine,
  paths,
  config,
  agents,
  connections,
  workflows,
  repos,
  questions,
  tickets,
  archiveTask,
  webDist,
}: AppDeps): Hono {
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

  app.post("/api/workflows", async (c) => c.json(workflows.create(createWorkflowSchema.parse(await readJson(c))), 201));

  app.put("/api/workflows/:id", async (c) =>
    c.json(await workflows.save(c.req.param("id"), saveWorkflowSchema.parse(await readJson(c)))),
  );

  // ?force=true also deletes the tasks still using the workflow.
  app.delete("/api/workflows/:id", async (c) => {
    await workflows.remove(c.req.param("id"), { force: c.req.query("force") === "true" });
    return c.body(null, 204);
  });

  // ---- action catalogue (drives the workflow editor's forms)
  app.get("/api/action-types", (c) => c.json(workflows.actionTypes()));

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
    if (patch.modelOverride || patch.effortOverride) {
      // Overrides apply to every coding-agent action on the task, so they only have to be valid
      // for the agent they will actually run under — and the effort for the model it pairs with.
      const task = engine.getTask(id);
      const error = await agents.validateChoiceFor(
        patch.agentOverride === undefined ? task.agentOverride : patch.agentOverride,
        patch.modelOverride === undefined ? task.modelOverride : patch.modelOverride,
        patch.effortOverride === undefined ? task.effortOverride : patch.effortOverride,
      );
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

  // Runs the current stage's actions when the task was moved in without running them.
  app.post("/api/tasks/:id/start", (c) => {
    const id = c.req.param("id");
    engine.startActions(id);
    return c.json(engine.getTaskDetail(id));
  });

  app.post("/api/tasks/:id/archive", async (c) => {
    const id = c.req.param("id");
    await archiveTask(id, archiveTaskSchema.parse(await readJson(c)));
    return c.json(engine.getTaskDetail(id));
  });

  // ---- the branch's diff, for the stages that ask you to review it
  app.get("/api/tasks/:id/diff", async (c) => c.json(await taskDiff(engine.getTask(c.req.param("id")))));

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
    if (overrides?.model || overrides?.effort) {
      const error = await agents.validateChoiceFor(
        overrides.agent as string | null,
        String(overrides.model ?? ""),
        String(overrides.effort ?? ""),
      );
      if (error) throw new EngineError(error);
    }
    const retry = engine.retryRun(runIdSchema.parse(c.req.param("id")), overrides);
    return c.json(engine.getTaskDetail(retry.taskId));
  });

  // "Try now" on a run waiting for a usage limit: the user expects the limit has already lifted.
  app.post("/api/runs/:id/resume", (c) => {
    const run = engine.getRun(runIdSchema.parse(c.req.param("id")));
    const agent = run.outputs?.agent;
    engine.resumeQuotaRun(run.id);
    if (isAgentId(agent)) agents.clearQuotaHold(agent);
    return c.json(engine.getTaskDetail(run.taskId));
  });

  app.post("/api/runs/:id/cancel", (c) => {
    const run = engine.getRun(runIdSchema.parse(c.req.param("id")));
    engine.cancelRun(run.id);
    return c.json(engine.getTaskDetail(run.taskId));
  });

  app.post("/api/runs/:id/skip", (c) => {
    const run = engine.skipRun(runIdSchema.parse(c.req.param("id")));
    return c.json(engine.getTaskDetail(run.taskId));
  });

  app.post("/api/runs/:id/approve", (c) => {
    const run = engine.approveRun(runIdSchema.parse(c.req.param("id")));
    return c.json(engine.getTaskDetail(run.taskId));
  });

  // "Request changes" at an agent's approval: the same run carries on with what you asked for.
  app.post("/api/runs/:id/request-changes", async (c) => {
    const { note } = requestChangesSchema.parse(await readJson(c));
    const run = engine.requestChanges(runIdSchema.parse(c.req.param("id")), note);
    return c.json(engine.getTaskDetail(run.taskId));
  });

  app.post("/api/runs/:id/send-back", async (c) => {
    const run = engine.getRun(runIdSchema.parse(c.req.param("id")));
    engine.sendBack(run.id, sendBackSchema.parse(await readJson(c)));
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

  app.put("/api/agents/:id/defaults", async (c) => {
    const id = agentIdSchema.parse(c.req.param("id"));
    await agents.setDefaults(id, agentDefaultsSchema.parse(await readJson(c)));
    return c.json(await agents.status(id));
  });

  app.post("/api/agents/:id/test", async (c) => {
    const id = agentIdSchema.parse(c.req.param("id"));
    return c.json(await agents.test(id, testAgentSchema.parse(await readJson(c))));
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

  // ---- drafting a new task's title and description from its linked ticket
  app.post("/api/tickets/draft", async (c) => c.json(await tickets.draft(draftFromTicketSchema.parse(await readJson(c)).link)));
  app.get("/api/settings/ticket-draft", (c) => c.json(tickets.getSettings()));
  app.put("/api/settings/ticket-draft", async (c) => c.json(await tickets.saveSettings(await readJson(c))));

  // ---- questions a running agent is blocked on
  app.get("/api/questions", (c) => c.json(questions.pending()));

  app.post("/api/questions/:id/answer", async (c) => {
    const { answers, skip } = answerQuestionSchema.parse(await readJson(c));
    const taskId = questions.answer(c.req.param("id"), { answers, skip });
    return c.json(engine.getTaskDetail(taskId));
  });

  // The agent's own channel for asking. Scoped to one run by the token in the path.
  mountMcp(app, questions);

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
