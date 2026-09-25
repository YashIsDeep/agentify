import { lstatSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface Paths {
  dataDir: string;
  dbFile: string;
  secretsFile: string;
  tasksDir: string;
  worktreesDir: string;
  taskDir(taskId: string): string;
  /** Kept after archival. */
  artifactDir(taskId: string): string;
  /** Transcripts and scratch output; purged on archival. */
  runsDir(taskId: string): string;
  runLog(taskId: string, runId: number): string;
  runOutputFile(taskId: string, runId: number): string;
}

export function createPaths(dataDir: string): Paths {
  const tasksDir = join(dataDir, "tasks");
  return {
    dataDir,
    dbFile: join(dataDir, "db.sqlite"),
    secretsFile: join(dataDir, "secrets.json"),
    tasksDir,
    worktreesDir: join(dataDir, "worktrees"),
    taskDir: (taskId) => join(tasksDir, taskId),
    artifactDir: (taskId) => join(tasksDir, taskId, "artifacts"),
    runsDir: (taskId) => join(tasksDir, taskId, "runs"),
    runLog: (taskId, runId) => join(tasksDir, taskId, "runs", `${runId}.jsonl`),
    runOutputFile: (taskId, runId) => join(tasksDir, taskId, "runs", `${runId}.outputs.json`),
  };
}

export function ensureBaseDirs(paths: Paths): void {
  mkdirSync(paths.tasksDir, { recursive: true });
  mkdirSync(paths.worktreesDir, { recursive: true });
}

/** Resolves `name` under `root`, rejecting anything that escapes it. */
export function resolveInside(root: string, name: string): string {
  const target = resolve(root, name);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Invalid artifact name: ${name}`);
  }
  assertNoSymlinks(root, target);
  return target;
}

/** Reject existing links from a trusted root through a contained target (including the root). */
export function assertNoSymlinks(root: string, target: string = root): void {
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path is outside ${root}`);
  }
  // Lexical containment alone follows links outside the root on read/write.
  // lstat also detects dangling symlinks and Windows junctions. Check the root itself.
  let current = resolve(root);
  for (const part of ["", ...rel.split(sep)]) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Unsafe path: ${current} (symbolic link)`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}

export async function purgeTranscripts(paths: Paths, taskId: string): Promise<void> {
  await rm(paths.runsDir(taskId), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
    (err: unknown) => console.warn(`Could not purge transcripts for task ${taskId}:`, err),
  );
}

/** Everything on disk for a task, artifacts included — for tasks deleted outright. */
export async function purgeTaskDir(paths: Paths, taskId: string): Promise<void> {
  await rm(paths.taskDir(taskId), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
    (err: unknown) => console.warn(`Could not delete the files of task ${taskId}:`, err),
  );
}
