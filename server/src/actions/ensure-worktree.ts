import { constants, existsSync, lstatSync, statSync } from "node:fs";
import { copyFile, mkdir, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { git, gitSucceeds, slugify } from "../lib/git";
import { assertNoSymlinks } from "../paths";
import type { ActionDefinition, RunLog } from "./types";

const configSchema = z.object({
  branchPrefix: z.string().default("wm/"),
  /** Comma- or newline-separated gitignored paths, relative to the repository. */
  carryOver: z.string().default(".env"),
});

export const ensureWorktreeAction: ActionDefinition<z.output<typeof configSchema>> = {
  type: "ensure-worktree",
  label: "Ensure worktree",
  description:
    "Creates a dedicated git worktree and branch for the task (once). Does nothing for tasks without a repository.",
  configSchema,
  fields: [
    { name: "branchPrefix", label: "Branch prefix", kind: "text", default: "wm/", advanced: true, help: "Branch name is the prefix plus the task slug." },
    {
      name: "carryOver",
      label: "Carry over from the repository",
      kind: "textarea",
      default: ".env",
      placeholder: ".env, node_modules",
      help: "Gitignored paths to bring into the worktree, comma- or newline-separated. Files are copied; directories are linked, so installing in the worktree also changes the repository's copy.",
    },
  ],
  async run({ config, task, services, signal, log }) {
    if (!task.repoPath) {
      log("Task has no repository; nothing to do");
      return { outputs: { skipped: true }, summary: "no repository" };
    }
    const repo = task.repoPath;
    if (!task.useWorktree && !task.worktreePath) {
      log(`Task works in the repository checkout at ${repo}; no worktree needed`);
      return { outputs: { skipped: true }, summary: "worktree turned off" };
    }
    if (task.worktreePath && task.branch && task.baseBranch && existsSync(task.worktreePath)) {
      log(`Worktree already exists at ${task.worktreePath}`);
      // Still worth a pass: the list may have grown since the worktree was made, and anything
      // already there is left alone.
      await carryOver(repo, task.worktreePath, config.carryOver, log);
      return { outputs: { branch: task.branch, baseBranch: task.baseBranch, worktreePath: task.worktreePath } };
    }

    const onLine = (text: string, stream: "stdout" | "stderr") => log(text, stream);
    await git(["rev-parse", "--is-inside-work-tree"], { cwd: repo, signal });
    const baseBranch = task.baseBranch ?? (await git(["symbolic-ref", "--short", "HEAD"], { cwd: repo, signal }));
    const name = `${slugify(task.title)}-${task.id.slice(0, 8)}`;
    const branch = task.branch ?? `${config.branchPrefix}${name}`;
    const worktreePath = join(services.paths.worktreesDir, name);

    if (existsSync(worktreePath)) {
      const checkedOut = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath, signal });
      if (checkedOut !== branch) {
        throw new Error(`${worktreePath} already exists with ${checkedOut} checked out (expected ${branch})`);
      }
      log(`Reusing existing worktree at ${worktreePath}`);
    } else {
      const branchExists = await gitSucceeds(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repo);
      const args = branchExists
        ? ["worktree", "add", worktreePath, branch]
        : ["worktree", "add", "-b", branch, worktreePath, baseBranch];
      log(`$ git ${args.join(" ")}`);
      await git(args, { cwd: repo, signal, onLine });
    }

    await carryOver(repo, worktreePath, config.carryOver, log);
    services.engine.setTaskGitInfo(task.id, { branch, baseBranch, worktreePath });
    return { outputs: { branch, baseBranch, worktreePath }, summary: `worktree on ${branch}` };
  },
};

/**
 * A worktree is a clean checkout, so everything git ignores stays behind: the task starts without
 * the `.env` an agent needs and without the `node_modules` its test command expects, and the first
 * real stage fails for reasons that have nothing to do with the work. This brings the named paths
 * across, skipping whatever the repository doesn't have.
 */
async function carryOver(repo: string, worktreePath: string, list: string, log: RunLog): Promise<void> {
  for (const name of list.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean)) {
    const source = resolveInRepo(repo, name);
    const destination = join(worktreePath, relative(repo, source));
    if (!existsSync(source)) {
      log(`The repository has no ${name}; nothing to carry over`);
      continue;
    }
    // A tracked file of the same name, or an earlier run of this action, got there first.
    // lstat also sees dangling links: never overwrite a pre-existing directory entry.
    if (lstatSync(destination, { throwIfNoEntry: false })) continue;
    assertNoSymlinks(worktreePath, destination);
    try {
      await mkdir(dirname(destination), { recursive: true });
      if (statSync(source).isDirectory()) {
        // Directories are linked rather than copied: a junction (a plain symlink off Windows) is
        // instant even for a node_modules of tens of thousands of files, and neither needs the
        // elevation a Windows file symlink does. The catch — the worktree and the repository then
        // share one directory — is in the field's help text.
        await symlink(source, destination, process.platform === "win32" ? "junction" : "dir");
        log(`Linked ${name} into the worktree`);
      } else {
        // Single files are copied so that editing one in the worktree can't rewrite the original.
        await copyFile(source, destination, constants.COPYFILE_EXCL);
        log(`Copied ${name} into the worktree`);
      }
    } catch (err) {
      // The worktree itself is fine, so a locked file or a filesystem that refuses links shouldn't
      // strand the task; say so loudly instead and let the stage carry on.
      log(`Could not carry ${name} over: ${err instanceof Error ? err.message : String(err)}`, "stderr");
    }
  }
}

/** Follows `resolveInside` in paths.ts: a path that leaves the repository is refused, not followed. */
function resolveInRepo(repo: string, name: string): string {
  const target = resolve(repo, name);
  const rel = relative(repo, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Cannot carry over ${name}: it is outside the repository`);
  }
  assertNoSymlinks(repo, target);
  return target;
}
