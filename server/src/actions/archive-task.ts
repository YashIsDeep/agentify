import { z } from "zod";
import type { ActionDefinition } from "./types";

const configSchema = z.object({
  removeWorktree: z.boolean().default(true),
  /** Remove the worktree even with uncommitted changes (they are lost; the branch is kept). */
  force: z.boolean().default(false),
});

export const archiveTaskAction: ActionDefinition<z.output<typeof configSchema>> = {
  type: "archive-task",
  label: "Archive task",
  description: "Removes the worktree (branch kept), purges transcripts, and moves the task to the archive.",
  configSchema,
  fields: [
    { name: "removeWorktree", label: "Remove the worktree", kind: "boolean", default: true },
    {
      name: "force",
      label: "Remove it even with uncommitted changes",
      kind: "boolean",
      default: false,
      help: "Without this, archiving fails rather than discarding work.",
    },
  ],
  async run({ config, run, task, services }) {
    await services.archiveTask(task.id, { ...config, initiatedByRunId: run.id });
    return { summary: "task archived" };
  },
};
