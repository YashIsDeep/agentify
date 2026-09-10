import { requestJson, requireValue } from "./http";
import type { ConnectionAdapter, ConnectionValues, HttpFetch } from "./types";

const SERVICE = "Notion";
const ENDPOINT = "https://api.notion.com";
const VERSION = "2022-06-28";

/** Notion caps a request at 100 children, and a single rich-text run at 2000 characters. */
const MAX_BLOCKS_PER_REQUEST = 100;
const MAX_TEXT = 2000;

export type NotionBlock = Record<string, unknown>;

export class NotionClient {
  private readonly token: string;

  constructor(
    values: ConnectionValues,
    private readonly http: HttpFetch,
  ) {
    this.token = requireValue(values, "token", "integration token", SERVICE);
  }

  private request<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    return requestJson<T>(`${ENDPOINT}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, "notion-version": VERSION },
      service: SERVICE,
      http: this.http,
    });
  }

  async me(signal?: AbortSignal): Promise<string> {
    const user = await this.request<{ name?: string; bot?: { owner?: { user?: { name?: string } } } }>("/v1/users/me", { signal });
    return user.name ?? user.bot?.owner?.user?.name ?? "authenticated";
  }

  /** Appends in chunks; Notion rejects more than 100 children at a time. */
  async append(blockId: string, blocks: NotionBlock[], signal?: AbortSignal): Promise<void> {
    for (let index = 0; index < blocks.length; index += MAX_BLOCKS_PER_REQUEST) {
      await this.request(`/v1/blocks/${blockId}/children`, {
        method: "PATCH",
        body: { children: blocks.slice(index, index + MAX_BLOCKS_PER_REQUEST) },
        signal,
      });
    }
  }

  /** A database's title property is named by the user, so look it up rather than guessing. */
  async titleProperty(databaseId: string, signal?: AbortSignal): Promise<string> {
    const database = await this.request<{ properties?: Record<string, { type?: string }> }>(`/v1/databases/${databaseId}`, { signal });
    const title = Object.entries(database.properties ?? {}).find(([, property]) => property.type === "title");
    if (!title) throw new Error("That Notion database has no title property");
    return title[0];
  }

  async createPage(
    databaseId: string,
    title: string,
    blocks: NotionBlock[],
    signal?: AbortSignal,
  ): Promise<{ id: string; url: string }> {
    const property = await this.titleProperty(databaseId, signal);
    const page = await this.request<{ id: string; url?: string }>("/v1/pages", {
      method: "POST",
      body: {
        parent: { database_id: databaseId },
        properties: { [property]: { title: richText(title) } },
        children: blocks.slice(0, MAX_BLOCKS_PER_REQUEST),
      },
      signal,
    });
    if (blocks.length > MAX_BLOCKS_PER_REQUEST) await this.append(page.id, blocks.slice(MAX_BLOCKS_PER_REQUEST), signal);
    return { id: page.id, url: page.url ?? "" };
  }
}

export const notionAdapter: ConnectionAdapter<NotionClient> = {
  type: "notion",
  label: "Notion",
  description: "Append blocks to a page, or create a page in a database.",
  docsUrl: "https://www.notion.so/my-integrations",
  fields: [
    {
      name: "token",
      label: "Internal integration token",
      secret: true,
      required: true,
      help: "Create an internal integration, then share the target page or database with it — otherwise Notion answers 404.",
    },
  ],
  client: (values, http) => new NotionClient(values, http),
  test: (client) => client.me(),
};

const DASHED = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
// Bounded by non-alphanumerics: a page URL is `Some-Title-<32 hex>`, and title letters can be hex too.
const PLAIN = /(?<![0-9A-Za-z])[0-9a-fA-F]{32}(?![0-9A-Za-z])/;

/** Accepts a raw id, a dashed UUID, or any Notion URL containing one. */
export function notionId(value: string): string {
  const trimmed = value.trim();
  const dashed = DASHED.exec(trimmed)?.[0];
  if (dashed) return dashed.toLowerCase();

  const id = PLAIN.exec(trimmed)?.[0].toLowerCase();
  if (!id) throw new Error(`"${trimmed || "(empty)"}" does not contain a Notion id`);
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

function richText(text: string): { type: "text"; text: { content: string } }[] {
  const runs: { type: "text"; text: { content: string } }[] = [];
  for (let index = 0; index < Math.max(text.length, 1); index += MAX_TEXT) {
    runs.push({ type: "text", text: { content: text.slice(index, index + MAX_TEXT) } });
  }
  return runs;
}

const block = (type: string, text: string, extra: Record<string, unknown> = {}): NotionBlock => ({
  object: "block",
  type,
  [type]: { rich_text: richText(text), ...extra },
});

/**
 * Converts the common Markdown shapes an agent writes into Notion blocks: headings, bullet
 * and numbered lists, quotes, fenced code and rules. Inline formatting is left as literal
 * text — Notion's rich-text model would need a real Markdown parser to do it properly.
 */
export function markdownToBlocks(markdown: string): NotionBlock[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: NotionBlock[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length > 0) blocks.push(block("paragraph", paragraph.join("\n")));
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      while (++index < lines.length && !/^\s*```/.test(lines[index] ?? "")) code.push(lines[index] ?? "");
      blocks.push(block("code", code.join("\n"), { language: notionLanguage(fence[1]) }));
      continue;
    }

    const converted = convertLine(line);
    if (converted === "blank") flush();
    else if (converted) {
      flush();
      blocks.push(converted);
    } else paragraph.push(line);
  }
  flush();
  return blocks;
}

/** A block for this line, `"blank"` to end the current paragraph, or null to keep collecting one. */
function convertLine(line: string): NotionBlock | "blank" | null {
  if (!line.trim()) return "blank";
  if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) return { object: "block", type: "divider", divider: {} };

  const heading = /^(#{1,3})\s+(.*)$/.exec(line);
  if (heading?.[1]) return block(`heading_${heading[1].length}`, heading[2] ?? "");

  const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
  if (bullet) return block("bulleted_list_item", bullet[1] ?? "");

  const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
  if (numbered) return block("numbered_list_item", numbered[1] ?? "");

  const quote = /^\s*>\s?(.*)$/.exec(line);
  if (quote) return block("quote", quote[1] ?? "");

  return null;
}

/** Notion validates `language` against a fixed list; anything unknown is rejected. */
const LANGUAGES = new Set([
  "bash", "c", "c#", "c++", "css", "diff", "docker", "go", "graphql", "html", "java", "javascript", "json", "kotlin",
  "markdown", "php", "plain text", "powershell", "python", "ruby", "rust", "shell", "sql", "swift", "typescript", "xml", "yaml",
]);
const LANGUAGE_ALIASES: Record<string, string> = { js: "javascript", ts: "typescript", sh: "shell", ps1: "powershell", yml: "yaml", py: "python" };

function notionLanguage(tag: string | undefined): string {
  const name = (tag ?? "").toLowerCase();
  const resolved = LANGUAGE_ALIASES[name] ?? name;
  return LANGUAGES.has(resolved) ? resolved : "plain text";
}
