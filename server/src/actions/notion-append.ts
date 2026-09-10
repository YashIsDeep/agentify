import { z } from "zod";
import { markdownToBlocks, notionAdapter, notionId } from "../integrations/notion";
import type { ActionDefinition } from "./types";
import { remoteId } from "./validation";

const configSchema = z.object({
  connectionId: z.string().default(""),
  mode: z.enum(["append", "create-page"]).default("append"),
  /** Page id/URL when appending, database id/URL when creating. */
  target: remoteId("The page or database", /[0-9a-fA-F]{32}|[0-9a-fA-F-]{36}/, "a Notion URL or 32-character id"),
  title: z.string().default("{{task.title}}"),
  content: z.string().default(""),
});

export const notionAppendAction: ActionDefinition<z.output<typeof configSchema>> = {
  type: "notion-append",
  label: "Notion: write",
  description: "Appends Markdown to a Notion page, or creates a page in a database.",
  configSchema,
  connectionType: "notion",
  fields: [
    { name: "connectionId", label: "Connection", kind: "connection", default: "" },
    {
      name: "mode",
      label: "What to do",
      kind: "select",
      default: "append",
      options: [
        { value: "append", label: "Append to an existing page" },
        { value: "create-page", label: "Create a page in a database" },
      ],
    },
    {
      name: "target",
      label: "Page or database",
      kind: "text",
      default: "",
      templated: true,
      placeholder: "Paste the Notion URL",
      help: "Share it with your integration in Notion first, or the API answers 404.",
    },
    { name: "title", label: "Page title", kind: "text", default: "{{task.title}}", templated: true, help: "Used when creating a page." },
    {
      name: "content",
      label: "Content",
      kind: "textarea",
      default: "",
      templated: true,
      help: "Markdown headings, lists, quotes and code fences become Notion blocks; inline formatting stays literal.",
    },
  ],
  async run({ config, services, signal, log }) {
    const { connection, client } = services.connections.client(config.connectionId, notionAdapter);
    const target = notionId(config.target);
    const blocks = markdownToBlocks(config.content);
    if (blocks.length === 0) throw new Error("There is nothing to write — the content is empty.");

    if (config.mode === "create-page") {
      const title = config.title.trim() || "Untitled";
      log(`${connection.name}: creating “${title}” (${blocks.length} blocks)`);
      const page = await client.createPage(target, title, blocks, signal);
      return { outputs: { pageId: page.id, url: page.url, blocks: blocks.length }, summary: page.url || title };
    }

    log(`${connection.name}: appending ${blocks.length} block(s)`);
    await client.append(target, blocks, signal);
    return { outputs: { pageId: target, blocks: blocks.length }, summary: `${blocks.length} block(s) appended` };
  },
};
