import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TaskDiff, TaskDiffFile, TaskDiffStatus } from "@wm/shared";
import type { TaskRow } from "../db/schema";
import { EngineError } from "../engine/engine";
import { git } from "../lib/git";

/** Keeps one enormous change from filling the response, and the review card, with unreadable patch. */
const MAX_PATCH_CHARS = 400_000;

const STATUS: Record<string, TaskDiffStatus> = { A: "added", D: "deleted", R: "renamed", C: "copied" };

/**
 * What a task's branch changed, so the review stages can show the diff they ask about instead of
 * sending you to a terminal. Uncommitted work counts: an agent that stopped before committing has
 * still done the work you are being asked to look at.
 */
export async function taskDiff(task: TaskRow): Promise<TaskDiff> {
  if (!task.repoPath) throw new EngineError("This task has no repository, so there is nothing to diff.");
  if (!task.branch || !task.baseBranch) {
    throw new EngineError("This task has no branch yet; it gets one when its worktree is created.");
  }
  const { branch, baseBranch } = task;
  const cwd = task.worktreePath ?? task.repoPath;
  if (!existsSync(cwd)) throw new EngineError(`${cwd} no longer exists, so its diff can't be read.`);

  // Uncommitted work only counts where the branch is actually checked out.
  const checkedOut = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd }).catch(() => "");
  const uncommitted = checkedOut === branch;
  const base = await git(["merge-base", baseBranch, uncommitted ? "HEAD" : branch], { cwd }).catch(() => {
    throw new EngineError(`Could not compare ${branch} with ${baseBranch} in ${cwd}; check that both branches still exist.`);
  });
  // `git diff <base>` reaches the working tree; naming the branch as well stops at its last commit.
  const range = uncommitted ? [base] : [base, branch];

  const { files, patch, truncated } = await withUntracked(cwd, uncommitted, async (env, untracked) => ({
    files: await changedFiles(cwd, range, env, untracked),
    ...(await readPatch(cwd, range, env)),
  }));

  // What archiving would throw away: anything not yet committed where the branch is checked out.
  const dirty = uncommitted && (await git(["status", "--porcelain"], { cwd })).length > 0;

  return {
    branch,
    baseBranch,
    path: cwd,
    dirty,
    files,
    insertions: files.reduce((total, file) => total + file.insertions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    patch,
    truncated,
    uncommitted,
  };
}

/** `--name-status` says what happened to each file, `--numstat` how much of it changed. */
async function changedFiles(
  cwd: string,
  range: string[],
  env: Record<string, string>,
  untracked: Set<string>,
): Promise<TaskDiffFile[]> {
  const statuses = parseStatuses(await git(["diff", "--name-status", "-M", "-z", ...range], { cwd, env }));
  const counts = parseCounts(await git(["diff", "--numstat", "-M", "-z", ...range], { cwd, env }));
  return [...statuses].map(([path, { status, oldPath }]) => ({
    path,
    oldPath,
    status,
    insertions: counts.get(path)?.insertions ?? 0,
    deletions: counts.get(path)?.deletions ?? 0,
    binary: counts.get(path)?.binary ?? false,
    untracked: untracked.has(path),
  }));
}

/** Keeps each `git add` well inside Windows' command-line limit. */
const ADD_BATCH = 200;

/**
 * Files an agent wrote but never added are often the heart of the change (a new module, its
 * tests), so they are diffed like any other. `git add -N` marks them intent-to-add, which makes
 * `git diff` show them as new files with hunks — done on a scratch copy of the index, so the
 * worktree's own staging area is never touched.
 */
async function withUntracked<T>(
  cwd: string,
  uncommitted: boolean,
  read: (env: Record<string, string>, untracked: Set<string>) => Promise<T>,
): Promise<T> {
  const paths = uncommitted ? records(await git(["ls-files", "--others", "--exclude-standard", "-z"], { cwd })) : [];
  if (!paths.length) return read({}, new Set());

  const scratch = await mkdtemp(join(tmpdir(), "wm-diff-"));
  try {
    const index = join(scratch, "index");
    const real = resolve(cwd, await git(["rev-parse", "--git-path", "index"], { cwd }));
    if (existsSync(real)) await copyFile(real, index);
    const env = { GIT_INDEX_FILE: index };
    for (let i = 0; i < paths.length; i += ADD_BATCH) {
      await git(["add", "--intent-to-add", "--", ...paths.slice(i, i + ADD_BATCH)], { cwd, env });
    }
    return await read(env, new Set(paths));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Read line by line so a huge diff is cut at its end rather than at its start: `runProcess` keeps
 * the tail of what a command printed, which is the wrong half of a patch.
 */
async function readPatch(cwd: string, range: string[], env: Record<string, string>): Promise<{ patch: string; truncated: boolean }> {
  const lines: string[] = [];
  let length = 0;
  let truncated = false;
  await git(["-c", "core.quotePath=false", "diff", "-M", ...range], {
    cwd,
    env,
    onLine: (text, stream) => {
      if (stream !== "stdout" || truncated) return;
      if (length + text.length > MAX_PATCH_CHARS) {
        truncated = true;
        return;
      }
      lines.push(text);
      length += text.length + 1;
    },
  });
  return { patch: lines.join("\n"), truncated };
}

/** `-z` output: NUL-separated fields, so paths arrive verbatim however odd they are. */
const records = (output: string): string[] => output.split("\0").filter(Boolean);

/** `M\0path\0`, or `R100\0old\0new\0` when the file moved. */
function parseStatuses(output: string): Map<string, { status: TaskDiffStatus; oldPath: string | null }> {
  const fields = records(output);
  const byPath = new Map<string, { status: TaskDiffStatus; oldPath: string | null }>();
  for (let i = 0; i < fields.length; ) {
    const code = fields[i++]!;
    const moved = code.startsWith("R") || code.startsWith("C");
    const oldPath = moved ? (fields[i++] ?? null) : null;
    const path = fields[i++];
    if (path === undefined) break;
    byPath.set(path, { status: STATUS[code[0]!] ?? "modified", oldPath });
  }
  return byPath;
}

/** `added\tdeleted\tpath\0`, or `added\tdeleted\t\0old\0new\0` when the file moved. `-` counts are binary. */
function parseCounts(output: string): Map<string, { insertions: number; deletions: number; binary: boolean }> {
  const fields = records(output);
  const byPath = new Map<string, { insertions: number; deletions: number; binary: boolean }>();
  for (let i = 0; i < fields.length; ) {
    const [added = "", deleted = "", inline = ""] = fields[i++]!.split("\t");
    let path = inline;
    if (!path) {
      i += 1; // the old path; the counts belong to where the file is now
      path = fields[i++] ?? "";
    }
    if (!path) break;
    byPath.set(path, {
      insertions: Number.parseInt(added, 10) || 0,
      deletions: Number.parseInt(deleted, 10) || 0,
      binary: added === "-",
    });
  }
  return byPath;
}
