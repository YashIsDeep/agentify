import { fileURLToPath } from "node:url";
import { type ActionRegistry, createDefaultRegistry } from "./actions/registry";
import { AgentService } from "./agents/service";
import { createApp } from "./api/app";
import type { AppConfig } from "./config";
import { openDb } from "./db/client";
import { Engine } from "./engine/engine";
import type { HttpFetch } from "./integrations/types";
import { Runner } from "./engine/runner";
import { createPaths, ensureBaseDirs } from "./paths";
import { seedDefaultWorkflows } from "./seed/workflows";
import { type ArchiveOptions, archiveTask } from "./services/archive";
import { ConnectionService } from "./services/connections";
import { QuestionService } from "./services/questions";
import { RepoService } from "./services/repos";
import { SettingsStore } from "./services/settings";
import { WorkflowService } from "./services/workflows";
import { TicketDraftService } from "./services/ticket-draft";

const WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));

/** Wires the app together. Call `runner.start()` to begin executing actions. */
export function bootstrap(
  config: AppConfig,
  options: { registry?: ActionRegistry; seed?: boolean; http?: HttpFetch; workspaceId?: string; externalLongRuns?: () => number } = {},
) {
  const paths = createPaths(config.dataDir);
  ensureBaseDirs(paths);
  const { db, sqlite } = openDb(paths.dbFile);
  if (options.seed ?? true) seedDefaultWorkflows(db, sqlite);

  const settings = new SettingsStore(db);
  const agents = new AgentService(settings);
  const connections = new ConnectionService(paths, options.http);
  const registry = options.registry ?? createDefaultRegistry();
  const engine = new Engine(db, sqlite, {
    paths,
    isLongRunning: (actionType) => registry.get(actionType)?.longRunning ?? false,
    maxConcurrentLongRuns: config.maxConcurrentLongRuns,
    externalLongRuns: options.externalLongRuns,
  });
  const archive = (taskId: string, archiveOptions?: ArchiveOptions) =>
    archiveTask(engine, paths, taskId, archiveOptions);
  const questionBase = `http://127.0.0.1:${config.port}${options.workspaceId ? `/api/workspaces/${options.workspaceId}` : ""}`;
  const questions = new QuestionService(db, engine, questionBase);
  // Agents from a previous process died with it, so nothing is listening for those answers.
  questions.clearStale();
  const runner = new Runner({
    engine,
    registry,
    paths,
    services: { engine, paths, agents, connections, questions, archiveTask: archive },
  });
  const workflows = new WorkflowService(db, sqlite, registry, engine, connections, agents, paths);
  const repos = new RepoService(db);
  const tickets = new TicketDraftService(settings, connections, agents);
  const app = createApp({
    engine,
    paths,
    config,
    agents,
    connections,
    workflows,
    repos,
    questions,
    tickets,
    archiveTask: archive,
    webDist: WEB_DIST,
  });

  return {
    config,
    paths,
    db,
    sqlite,
    settings,
    agents,
    connections,
    repos,
    questions,
    tickets,
    registry,
    workflows,
    engine,
    runner,
    app,
    archiveTask: archive,
    close: async () => {
      await runner.stop();
      sqlite.close();
    },
  };
}

export type AppContext = ReturnType<typeof bootstrap>;
