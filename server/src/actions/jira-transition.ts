import { z } from "zod";
import { issueKey, jiraAdapter } from "../integrations/jira";
import type { ActionDefinition } from "./types";

const configSchema = z.object({
  connectionId: z.string().default(""),
  issue: z.string().default("{{task.links.jira}}"),
  /** Transition name as shown on the board (or its id). Blank = comment only. */
  transition: z.string().default(""),
  comment: z.string().default(""),
});

export const jiraTransitionAction: ActionDefinition<z.output<typeof configSchema>> = {
  type: "jira-transition",
  label: "Jira: transition issue",
  description: "Moves a Jira issue to another status and optionally adds a comment.",
  configSchema,
  connectionType: "jira",
  fields: [
    { name: "connectionId", label: "Connection", kind: "connection", default: "" },
    {
      name: "issue",
      label: "Issue",
      kind: "text",
      default: "{{task.links.jira}}",
      templated: true,
      help: "Issue key or URL. The default uses the task's “jira” link.",
    },
    {
      name: "transition",
      label: "Transition to",
      kind: "text",
      default: "",
      templated: true,
      placeholder: "In Progress",
      help: "The transition's name as it appears on the board. Leave blank to only comment.",
    },
    { name: "comment", label: "Comment", kind: "textarea", default: "", templated: true, placeholder: "Leave blank for no comment" },
  ],
  async run({ config, services, signal, log }) {
    // Not every task has a Jira issue. An empty reference means "nothing to do" rather than a
    // failure, so the action can be bound workflow-wide; a reference that is present but
    // unreadable is still an error, so a typo never passes silently.
    if (!config.issue.trim()) {
      log("No Jira issue linked to this task — nothing to transition.");
      return { summary: "no issue linked" };
    }

    const { connection, client } = services.connections.client(config.connectionId, jiraAdapter);
    const key = issueKey(config.issue);
    log(`${connection.name}: ${key}`);

    let transitionId: string | null = null;
    if (config.transition.trim()) {
      const wanted = config.transition.trim();
      const available = await client.transitions(key, signal);
      const match = available.find((option) => option.name.toLowerCase() === wanted.toLowerCase() || option.id === wanted);
      if (!match) {
        const names = available.map((option) => option.name).join(", ") || "none";
        throw new Error(`${key} has no transition “${wanted}”. Available from its current status: ${names}`);
      }
      await client.transition(key, match.id, signal);
      transitionId = match.id;
      log(`Transitioned to ${match.to?.name ?? match.name}`);
    }

    if (config.comment.trim()) {
      await client.comment(key, config.comment.trim(), signal);
      log("Comment added");
    }

    const issue = await client.issue(key, signal);
    const status = issue.fields?.status?.name ?? null;
    return { outputs: { issueKey: key, status, transitionId }, summary: status ? `${key} → ${status}` : key };
  },
};
