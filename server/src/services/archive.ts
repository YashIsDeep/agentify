import { existsSync } from "node:fs";
import { EngineError, type Engine } from "../engine/engine";
import { git } from "../lib/git";
import { type Paths, purgeTranscripts } from "../paths";

export interface ArchiveOptions {
  removeWorktree?: boolean;
  force?: boolean;
  /** The archive-task run doing this; it is not cancelled and purges transcripts itself when it ends. */
  initiatedByRunId?: number;
}

export async function archiveTask(engine: Engine, paths: Paths, taskId: string, options: ArchiveOptions = {}) {
  const task = engine.getTask(taskId);
  if (task.status !== "active") throw new EngineError("Task is already archived", 409);

  // Stop anything still working in the worktree before removing it.
  engine.cancelActiveRuns(taskId, options.initiatedByRunId);

  let worktreeRemoved = false;
  if ((options.removeWorktree ?? true) && task.repoPath && task.worktreePath && existsSync(task.worktreePath)) {
    const args = ["worktree", "remove", ...(options.force ? ["--force"] : []), task.worktreePath];
    try {
      await git(args, { cwd: task.repoPath });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new EngineError(
        `Could not remove the worktree. Commit or discard changes, or archive with force. ${reason}`,
        409,
      );
    }
    worktreeRemoved = true;
  }

  engine.markArchived(taskId, { initiatedByRunId: options.initiatedByRunId, worktreeRemoved });
  if (options.initiatedByRunId === undefined) await purgeTranscripts(paths, taskId);
}
