import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { git, gitSucceeds, slugify } from "../lib/git";
import type { ActionDefinition } from "./types";

const configSchema = z.object({
  branchPrefix: z.string().default("wm/"),
});

export const ensureWorktreeAction: ActionDefinition<z.output<typeof configSchema>> = {
  type: "ensure-worktree",
  label: "Ensure worktree",
  description:
    "Creates a dedicated git worktree and branch for the task (once). Does nothing for tasks without a repository.",
  configSchema,
  fields: [
    { name: "branchPrefix", label: "Branch prefix", kind: "text", default: "wm/", help: "Branch name is the prefix plus the task slug." },
  ],
  async run({ config, task, services, signal, log }) {
    if (!task.repoPath) {
      log("Task has no repository; nothing to do");
      return { outputs: { skipped: true }, summary: "no repository" };
    }
    if (task.worktreePath && task.branch && task.baseBranch && existsSync(task.worktreePath)) {
      log(`Worktree already exists at ${task.worktreePath}`);
      return { outputs: { branch: task.branch, baseBranch: task.baseBranch, worktreePath: task.worktreePath } };
    }

    const repo = task.repoPath;
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

    services.engine.setTaskGitInfo(task.id, { branch, baseBranch, worktreePath });
    return { outputs: { branch, baseBranch, worktreePath }, summary: `worktree on ${branch}` };
  },
};
