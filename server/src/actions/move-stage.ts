import { z } from "zod";
import type { ActionDefinition } from "./types";

const configSchema = z.object({
  /** "next" or a stage id in the same workflow. */
  target: z.string().min(1),
});

export const moveStageAction: ActionDefinition<z.output<typeof configSchema>> = {
  type: "move-stage",
  label: "Move to stage",
  description: 'Moves the task to the next stage, or to a specific stage (e.g. "send back to Implement").',
  configSchema,
  fields: [{ name: "target", label: "Destination", kind: "stage", default: "next" }],
  async run({ config, run, task, services }) {
    const { engine } = services;
    if (engine.getTask(task.id).currentVisitId !== run.visitId) {
      throw new Error("Task is no longer in the stage that triggered this move");
    }
    const targetId = config.target === "next" ? engine.nextStageId(task.id) : config.target;
    if (!targetId) throw new Error("Task is already in the last stage");
    const moved = engine.moveTask(task.id, targetId, { runActions: true, initiatedByRunId: run.id });
    return { outputs: moved, summary: `moved to ${moved.stageName}` };
  },
};
