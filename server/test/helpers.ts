import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultRegistry } from "../src/actions/registry";
import { type AppContext, bootstrap } from "../src/bootstrap";
import { insertWorkflow, type SeedWorkflow } from "../src/seed/workflows";
import { testActions } from "./test-actions";

export interface Harness extends AppContext {
  dataDir: string;
  stageId(workflowId: string, name: string): string;
  addWorkflow(def: SeedWorkflow): string;
}

export function createHarness(
  options: { seed?: boolean; maxConcurrentLongRuns?: number; dataDir?: string; http?: typeof fetch } = {},
): Harness {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "wm-test-"));
  const registry = createDefaultRegistry();
  for (const action of testActions) registry.register(action);
  const ctx = bootstrap(
    {
      dataDir,
      host: "127.0.0.1",
      port: 2711,
      devOriginPorts: [2712],
      maxConcurrentLongRuns: options.maxConcurrentLongRuns ?? 3,
    },
    { registry, seed: options.seed ?? false, http: options.http },
  );
  ctx.runner.start();
  return {
    ...ctx,
    dataDir,
    stageId(workflowId, name) {
      const stage = ctx.engine.getWorkflow(workflowId).stages.find((st) => st.name === name);
      if (!stage) throw new Error(`No stage named ${name}`);
      return stage.id;
    },
    addWorkflow: (def) => insertWorkflow(ctx.db, def),
  };
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

export async function waitFor<T>(
  probe: () => T | undefined | null | false,
  { timeout = 15_000, interval = 20 } = {},
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    let lastError: unknown;
    try {
      const value = probe();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() > deadline) throw new Error(`waitFor timed out${lastError ? `: ${String(lastError)}` : ""}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

export function inspect(h: Harness) {
  const detail = (taskId: string) => h.engine.getTaskDetail(taskId);
  const currentVisit = (taskId: string) => {
    const d = detail(taskId);
    const visit = d.visits.find((v) => v.id === d.task.currentVisitId);
    if (!visit) throw new Error("Task has no current visit");
    return visit;
  };
  return {
    detail,
    currentVisit,
    stageName: (taskId: string) => currentVisit(taskId).stageName,
    /** The newest attempt of an action in the task's current stage visit. */
    latest: (taskId: string, key: string) =>
      currentVisit(taskId)
        .runs.filter((run) => run.bindingKey === key)
        .at(-1),
    /** Every action in the current visit has settled. */
    visitDone: (taskId: string) => currentVisit(taskId).completedAt !== null,
    runs: (taskId: string, key: string) =>
      detail(taskId)
        .visits.flatMap((v) => v.runs)
        .filter((run) => run.bindingKey === key),
  };
}
