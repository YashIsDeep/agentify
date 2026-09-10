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
import { seedDefaultWorkflows } from "./seed/templates";
import { type ArchiveOptions, archiveTask } from "./services/archive";
import { ConnectionService } from "./services/connections";
import { RepoService } from "./services/repos";
import { SettingsStore } from "./services/settings";
import { TemplateService } from "./services/templates";

const WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));

/** Wires the app together. Call `runner.start()` to begin executing actions. */
export function bootstrap(
  config: AppConfig,
  options: { registry?: ActionRegistry; seed?: boolean; http?: HttpFetch } = {},
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
  });
  const archive = (taskId: string, archiveOptions?: ArchiveOptions) =>
    archiveTask(engine, paths, taskId, archiveOptions);
  const runner = new Runner({
    engine,
    registry,
    paths,
    services: { engine, paths, agents, connections, archiveTask: archive },
  });
  const templates = new TemplateService(db, sqlite, registry, engine, connections, agents);
  const repos = new RepoService(db);
  const app = createApp({ engine, paths, config, agents, connections, templates, repos, archiveTask: archive, webDist: WEB_DIST });

  return {
    config,
    paths,
    db,
    sqlite,
    settings,
    agents,
    connections,
    repos,
    registry,
    templates,
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
