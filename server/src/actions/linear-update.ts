import { z } from "zod";
import { linearAdapter } from "../integrations/linear";
import type { ActionDefinition } from "./types";

const configSchema = z.object({
  connectionId: z.string().default(""),
  issue: z.string().default("{{task.links.linear}}"),
  /** Workflow state name in the issue's team. Blank = comment only. */
  state: z.string().default(""),
  comment: z.string().default(""),
});

export const linearUpdateAction: ActionDefinition<z.output<typeof configSchema>> = {
  type: "linear-update",
  label: "Linear: update issue",
  description: "Moves a Linear issue to another workflow state and optionally adds a comment.",
  configSchema,
  connectionType: "linear",
  fields: [
    { name: "connectionId", label: "Connection", kind: "connection", default: "" },
    {
      name: "issue",
      label: "Issue",
      kind: "text",
      default: "{{task.links.linear}}",
      templated: true,
      advanced: true,
      help: "Issue id like ENG-123, or its URL. The default uses the task's “linear” link.",
    },
    {
      name: "state",
      label: "Move to state",
      kind: "text",
      default: "",
      templated: true,
      placeholder: "In Progress",
      help: "A workflow state in the issue's own team. Leave blank to only comment.",
    },
    { name: "comment", label: "Comment", kind: "textarea", default: "", templated: true, placeholder: "Markdown; leave blank for no comment" },
  ],
  async run({ config, services, signal, log }) {
    // See jira-transition: an unlinked task is a no-op, an unreadable reference is an error.
    if (!config.issue.trim()) {
      log("No Linear issue linked to this task — nothing to update.");
      return { summary: "no issue linked" };
    }

    const { connection, client } = services.connections.client(config.connectionId, linearAdapter);
    const issue = await client.issue(config.issue, signal);
    log(`${connection.name}: ${issue.identifier} ${issue.title}`);

    let state = issue.state?.name ?? null;
    if (config.state.trim()) {
      const wanted = config.state.trim();
      const match = issue.team.states.nodes.find((candidate) => candidate.name.toLowerCase() === wanted.toLowerCase());
      if (!match) {
        const names = issue.team.states.nodes.map((candidate) => candidate.name).join(", ") || "none";
        throw new Error(`Team ${issue.team.key} has no state “${wanted}”. Its states are: ${names}`);
      }
      await client.setState(issue.id, match.id, signal);
      state = match.name;
      log(`Moved to ${match.name}`);
    }

    if (config.comment.trim()) {
      await client.comment(issue.id, config.comment.trim(), signal);
      log("Comment added");
    }

    return {
      outputs: { identifier: issue.identifier, url: issue.url, state },
      summary: state ? `${issue.identifier} → ${state}` : issue.identifier,
    };
  },
};
