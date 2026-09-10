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

/** Jira Cloud REST v3, authenticated with an API token (Basic email:token). */
export class JiraClient {
  private readonly baseUrl: string;
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
