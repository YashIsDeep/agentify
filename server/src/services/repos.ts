import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { RepoInfo } from "@wm/shared";
import { desc } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { EngineError } from "../engine/engine";
import { git } from "../lib/git";

/**
 * The repositories tasks have used, so the task form can offer a list instead of asking for a
 * path to be typed from memory. A mistyped path used to surface only when `ensure-worktree` ran,
 * halfway through a workflow.
 */
export class RepoService {
  constructor(private readonly db: Db) {}

  /** Distinct repo paths across tasks, most recently used first. */
  list(): RepoInfo[] {
    const rows = this.db
      .select({ path: s.tasks.repoPath, baseBranch: s.tasks.baseBranch, updatedAt: s.tasks.updatedAt })
      .from(s.tasks)
      .orderBy(desc(s.tasks.updatedAt))
      .all();

    const seen = new Map<string, RepoInfo>();
    for (const row of rows) {
      if (!row.path || seen.has(row.path)) continue;
      seen.set(row.path, { path: row.path, exists: existsSync(row.path), baseBranch: row.baseBranch });
    }
    return [...seen.values()];
  }

  /** Local branch names, so the base branch is chosen rather than remembered. */
  async branches(repoPath: string): Promise<string[]> {
    await this.assertGitRepo(repoPath);
    const output = await git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd: repoPath });
    return output.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  /**
   * Checked when a task is saved rather than when an action runs. Returns the resolved path so
   * a relative one is stored in a form git will accept later.
   */
  async validate(repoPath: string, baseBranch?: string | null): Promise<string> {
    const path = resolve(repoPath.trim());
    await this.assertGitRepo(path);
    if (baseBranch?.trim()) {
      const wanted = baseBranch.trim();
      const branches = await this.branches(path);
      // A freshly initialised repository has no branches until its first commit.
      if (branches.length === 0) {
        throw new EngineError(`That repository has no branches yet — it has no commits, so there is nothing to branch from.`);
      }
      if (!branches.includes(wanted)) {
        const shown = branches.slice(0, 10).join(", ");
        throw new EngineError(
          `“${wanted}” is not a branch in that repository. Its branches are: ${shown}${branches.length > 10 ? ", …" : ""}`,
        );
      }
    }
    return path;
  }

  private async assertGitRepo(repoPath: string): Promise<void> {
    if (!existsSync(repoPath)) throw new EngineError(`${repoPath} does not exist`);
    const inside = await git(["rev-parse", "--is-inside-work-tree"], { cwd: repoPath }).catch(() => "");
    if (inside !== "true") throw new EngineError(`${repoPath} is not a git repository`);
  }
}
