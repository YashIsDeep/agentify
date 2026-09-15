import { APPROVAL_ACTION } from "@wm/shared";
import { z } from "zod";
import type { ActionDefinition } from "./types";

const configSchema = z.object({
  instructions: z.string().default(""),
  /** A stage id in the same workflow; empty offers no Send back. */
  sendBackTo: z.string().default(""),
  askForNote: z.boolean().default(true),
});

/**
 * Pauses a stage's list until you decide. The engine settles it (`approveRun`, `sendBack`), so it is
 * only registered here for its editor fields and config validation.
 */
export const approvalAction: ActionDefinition<z.output<typeof configSchema>> = {
  type: APPROVAL_ACTION,
  label: "Approval",
  description:
    "A checkpoint of its own: waits here until you approve, then the next action runs. To sign off an agent's work, switch on the coding agent's own approval instead.",
  configSchema,
  fields: [
    {
      name: "instructions",
      label: "Instructions",
      kind: "textarea",
      default: "",
      templated: true,
      placeholder: "Read requirements.md, then approve.",
      help: "Shown on the task while it waits.",
    },
    {
      name: "sendBackTo",
      label: "Send back to",
      kind: "stage",
      default: "",
      noneLabel: "No Send back button",
      help: "Offers Send back next to Approve. Sending a task back to this same stage runs its actions again.",
    },
    {
      name: "askForNote",
      label: "Ask for a note when sending back",
      kind: "boolean",
      default: true,
      help: "Saved on the task as {{task.lastFeedback}}, so the next attempt's prompts can use it.",
    },
  ],
  async run() {
    throw new Error("An approval waits for you and is never run");
  },
};
