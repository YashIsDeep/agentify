import { graphqlMessages, requestJson, requireValue } from "./http";
import type { ConnectionAdapter, ConnectionValues, HttpFetch } from "./types";

const SERVICE = "Linear";
const ENDPOINT = "https://api.linear.app/graphql";

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  /** Markdown. */
  description?: string | null;
  url: string;
  state: { id: string; name: string } | null;
  team: { id: string; key: string; states: { nodes: { id: string; name: string }[] } };
}

/** Linear's GraphQL API, authenticated with a personal API key. */
export class LinearClient {
  private readonly key: string;

  constructor(
    values: ConnectionValues,
    private readonly http: HttpFetch,
  ) {
    this.key = requireValue(values, "apiKey", "API key", SERVICE);
  }

  async graphql<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const body = await requestJson<{ data?: T; errors?: unknown[] }>(ENDPOINT, {
      method: "POST",
      headers: { authorization: this.key },
      body: { query, variables },
      signal,
      service: SERVICE,
      http: this.http,
    });
    // GraphQL reports failures with HTTP 200 and an `errors` array.
    if (body.errors?.length) throw new Error(`${SERVICE}: ${graphqlMessages(body.errors)}`);
    if (!body.data) throw new Error(`${SERVICE} returned no data`);
    return body.data;
  }

  async me(signal?: AbortSignal): Promise<string> {
    const data = await this.graphql<{ viewer: { name?: string; email?: string } }>(
      "query { viewer { name email } }",
      {},
      signal,
    );
    return data.viewer.name ?? data.viewer.email ?? "authenticated";
  }

  async issue(identifier: string, signal?: AbortSignal): Promise<LinearIssue> {
    const { team, number } = splitIdentifier(identifier);
    const data = await this.graphql<{ issues: { nodes: LinearIssue[] } }>(
      `query Issue($team: String!, $number: Float!) {
        issues(filter: { team: { key: { eq: $team } }, number: { eq: $number } }, first: 1) {
          nodes { id identifier title description url state { id name } team { id key states(first: 100) { nodes { id name } } } }
        }
      }`,
      { team, number },
      signal,
    );
    const issue = data.issues.nodes[0];
    if (!issue) throw new Error(`No Linear issue ${team}-${number}`);
    return issue;
  }

  async setState(issueId: string, stateId: string, signal?: AbortSignal): Promise<void> {
    const data = await this.graphql<{ issueUpdate: { success: boolean } }>(
      "mutation Update($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }",
      { id: issueId, stateId },
      signal,
    );
    if (!data.issueUpdate.success) throw new Error("Linear rejected the state change");
  }

  async comment(issueId: string, body: string, signal?: AbortSignal): Promise<void> {
    const data = await this.graphql<{ commentCreate: { success: boolean } }>(
      "mutation Comment($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success } }",
      { id: issueId, body },
      signal,
    );
    if (!data.commentCreate.success) throw new Error("Linear rejected the comment");
  }
}

export const linearAdapter: ConnectionAdapter<LinearClient> = {
  type: "linear",
  label: "Linear",
  description: "Move issues between workflow states and post comments.",
  docsUrl: "https://linear.app/settings/account/security",
  fields: [
    {
      name: "apiKey",
      label: "API key",
      secret: true,
      required: true,
      help: "Linear → Settings → Security & access → Personal API keys.",
    },
  ],
  client: (values, http) => new LinearClient(values, http),
  test: (client) => client.me(),
};

/** Accepts `ENG-123`, a Linear issue URL, or text containing either. */
export function splitIdentifier(value: string): { team: string; number: number } {
  const trimmed = value.trim();
  const match = /([A-Za-z][A-Za-z0-9]*)-(\d+)/.exec(trimmed);
  if (!match?.[1] || !match[2]) throw new Error(`"${trimmed || "(empty)"}" does not contain a Linear issue id like ENG-123`);
  return { team: match[1].toUpperCase(), number: Number(match[2]) };
}
