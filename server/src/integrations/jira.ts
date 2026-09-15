import { requestJson, requireValue } from "./http";
import type { ConnectionAdapter, ConnectionValues, HttpFetch } from "./types";

const SERVICE = "Jira";

export interface JiraTransition {
  id: string;
  name: string;
  to?: { name?: string };
}

export interface JiraIssue {
  key: string;
  fields?: { summary?: string; status?: { name?: string } };
}

/** What a person reads on the ticket, for drafting a task from it. */
export interface JiraIssueContent {
  key: string;
  fields?: {
    summary?: string;
    /** Atlassian Document Format in REST v3. */
    description?: unknown;
    issuetype?: { name?: string };
    status?: { name?: string };
    priority?: { name?: string };
    labels?: string[];
    parent?: { key?: string; fields?: { summary?: string } };
  };
}

/** Jira Cloud REST v3, authenticated with an API token (Basic email:token). */
export class JiraClient {
  /** The site's origin, e.g. https://team.atlassian.net. */
  readonly baseUrl: string;
  private readonly auth: string;

  constructor(
    values: ConnectionValues,
    private readonly http: HttpFetch,
  ) {
    this.baseUrl = normalizeBaseUrl(requireValue(values, "baseUrl", "site URL", SERVICE));
    const email = requireValue(values, "email", "email", SERVICE);
    const token = requireValue(values, "apiToken", "API token", SERVICE);
    this.auth = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  }

  private request<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    return requestJson<T>(`${this.baseUrl}${path}`, {
      ...init,
      headers: { authorization: this.auth },
      service: SERVICE,
      http: this.http,
    });
  }

  async me(signal?: AbortSignal): Promise<string> {
    const user = await this.request<{ displayName?: string; emailAddress?: string }>("/rest/api/3/myself", { signal });
    return user.displayName ?? user.emailAddress ?? "authenticated";
  }

  issue(key: string, signal?: AbortSignal): Promise<JiraIssue> {
    return this.request<JiraIssue>(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status`, { signal });
  }

  issueContent(key: string, signal?: AbortSignal): Promise<JiraIssueContent> {
    return this.request<JiraIssueContent>(
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,issuetype,status,priority,labels,parent`,
      { signal },
    );
  }

  async transitions(key: string, signal?: AbortSignal): Promise<JiraTransition[]> {
    const body = await this.request<{ transitions?: JiraTransition[] }>(
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
      { signal },
    );
    return body.transitions ?? [];
  }

  transition(key: string, transitionId: string, signal?: AbortSignal): Promise<void> {
    return this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      method: "POST",
      body: { transition: { id: transitionId } },
      signal,
    });
  }

  comment(key: string, text: string, signal?: AbortSignal): Promise<void> {
    return this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      method: "POST",
      body: { body: adf(text) },
      signal,
    });
  }
}

export const jiraAdapter: ConnectionAdapter<JiraClient> = {
  type: "jira",
  label: "Jira",
  description: "Transition issues and post comments on a Jira Cloud site.",
  docsUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
  fields: [
    { name: "baseUrl", label: "Site URL", required: true, placeholder: "https://your-team.atlassian.net" },
    { name: "email", label: "Account email", required: true, placeholder: "you@example.com" },
    {
      name: "apiToken",
      label: "API token",
      secret: true,
      required: true,
      help: "Create one under Atlassian account → Security → API tokens.",
    },
  ],
  client: (values, http) => new JiraClient(values, http),
  test: (client) => client.me(),
};

/** Accepts a bare key, a full issue URL, or text containing one. */
export function issueKey(value: string): string {
  const trimmed = value.trim();
  const match = /([A-Za-z][A-Za-z0-9_]*-\d+)/.exec(trimmed);
  if (!match?.[1]) throw new Error(`"${trimmed || "(empty)"}" does not contain a Jira issue key like PROJ-123`);
  return match[1].toUpperCase();
}

function normalizeBaseUrl(value: string): string {
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    throw new Error(`"${value}" is not a valid Jira site URL`);
  }
}

interface AdfNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  content?: AdfNode[];
}

/** Flattens an Atlassian Document Format description into Markdown for reading. */
export function adfToText(document: unknown): string {
  return renderAdf(document, 0).replace(/\n{3,}/g, "\n\n").trim();
}

function renderAdf(value: unknown, depth: number): string {
  if (typeof value === "string") return value; // REST v2 descriptions are plain text
  if (!value || typeof value !== "object") return "";
  const node = value as AdfNode;
  const children = () => (node.content ?? []).map((child) => renderAdf(child, depth)).join("");
  switch (node.type) {
    case "text": {
      const text = node.text ?? "";
      const href = node.marks?.find((mark) => mark.type === "link")?.attrs?.href;
      if (typeof href === "string" && href !== text) return `[${text}](${href})`;
      return node.marks?.some((mark) => mark.type === "code") ? `\`${text}\`` : text;
    }
    case "hardBreak":
      return "\n";
    case "paragraph":
      return `${children()}\n\n`;
    case "heading":
      return `${"#".repeat(Number(node.attrs?.level) || 1)} ${children()}\n\n`;
    case "bulletList":
    case "orderedList": {
      const items = (node.content ?? []).map((item, index) => {
        const marker = node.type === "orderedList" ? `${index + 1}.` : "-";
        // A list item's paragraphs would otherwise leave blank lines between items.
        return `${"  ".repeat(depth)}${marker} ${renderAdf(item, depth + 1).trim().replace(/\n{2,}/g, "\n")}`;
      });
      return `${items.join("\n")}\n\n`;
    }
    case "codeBlock":
      return `\`\`\`${typeof node.attrs?.language === "string" ? node.attrs.language : ""}\n${children()}\n\`\`\`\n\n`;
    case "blockquote":
      return `${children()
        .trim()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n`;
    case "rule":
      return "---\n\n";
    case "tableRow":
      return `| ${(node.content ?? []).map((cell) => renderAdf(cell, depth).trim().replace(/\s*\n+\s*/g, " ")).join(" | ")} |\n`;
    case "table":
      return `${children()}\n`;
    case "mention":
    case "emoji":
    case "status":
      return typeof node.attrs?.text === "string" ? node.attrs.text : "";
    case "inlineCard":
    case "blockCard":
    case "embedCard":
      return typeof node.attrs?.url === "string" ? node.attrs.url : "";
    case "media":
    case "mediaSingle":
    case "mediaGroup":
      return "";
    default:
      return children();
  }
}

/** Jira comments are Atlassian Document Format, not plain text or markdown. */
function adf(text: string): Record<string, unknown> {
  const paragraphs = text.split(/\r?\n\s*\r?\n/).map((block) => block.trim()).filter(Boolean);
  return {
    type: "doc",
    version: 1,
    content: (paragraphs.length > 0 ? paragraphs : [text.trim() || " "]).map((block) => ({
      type: "paragraph",
      content: [{ type: "text", text: block }],
    })),
  };
}
