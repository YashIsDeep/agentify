import { fileURLToPath } from "node:url";
import type { TaskLink, TicketDraft } from "@wm/shared";
import { afterEach, describe, expect, it } from "vitest";
import { adfToText } from "../src/integrations/jira";
import { parseDraft } from "../src/services/ticket-draft";
import { fakeHttp, type HttpCall, json, type Route } from "./fake-http";
import { createHarness, type Harness, removeDir } from "./helpers";

const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

let h: Harness | undefined;

afterEach(async () => {
  if (!h) return;
  await h.close();
  removeDir(h.dataDir);
  h = undefined;
});

function setup(routes: Record<string, Route>): HttpCall[] {
  const fake = fakeHttp(routes);
  h = createHarness({ http: fake.http });
  h.agents.setPathOverride("codex", FAKE_CODEX);
  return fake.calls;
}

const send = async (method: string, path: string, body: unknown) => {
  const response = await h!.app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as TicketDraft & { error?: string } };
};
const draft = (link: TaskLink) => send("POST", "/api/tickets/draft", { link });

const jiraIssue = (summary: string) => ({
  key: "WM-42",
  fields: {
    summary,
    description: {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Users can't log in." }] },
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Show an error" }] }] }],
        },
      ],
    },
    issuetype: { name: "Bug" },
    status: { name: "To Do" },
    labels: ["auth"],
  },
});

const jiraValues = (host: string, email: string) => ({ baseUrl: `https://${host}`, email, apiToken: "t" });

describe("drafting a task from its ticket", () => {
  it("reads the Jira ticket through the matching connection and has the cheap model draft it", async () => {
    const calls = setup({ "GET /rest/api/3/issue/*": () => jiraIssue("Login is broken") });
    h!.connections.create({ name: "Other site", type: "jira", values: jiraValues("other.atlassian.net", "other@x.com") });
    h!.connections.create({ name: "Team", type: "jira", values: jiraValues("team.atlassian.net", "me@x.com") });

    const { status, body } = await draft({ type: "jira", value: "https://team.atlassian.net/browse/WM-42" });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      title: "Drafted: Login is broken",
      issueKey: "WM-42",
      connectionName: "Team",
      drafter: { agent: "codex", model: "gpt-5.6-luna", effort: "low" },
      warning: null,
    });
    // Read-only, with the ticket's facts and its description turned from ADF into Markdown.
    expect(body.description).toContain("model:gpt-5.6-luna | access:read-only | effort:low");
    expect(body.description).toContain("Type: Bug");
    expect(body.description).toContain("Users can't log in.\n\n- Show an error");
    // The connection on the link's own site is tried first.
    expect(calls[0]?.path).toBe("/rest/api/3/issue/WM-42");
    expect(calls[0]?.headers.authorization).toBe(`Basic ${Buffer.from("me@x.com:t").toString("base64")}`);
  }, 30_000);

  it("copies the ticket's own text when the model can't draft it", async () => {
    setup({ "GET /rest/api/3/issue/*": () => jiraIssue("FAIL to log in") });
    h!.connections.create({ name: "Team", type: "jira", values: jiraValues("team.atlassian.net", "me@x.com") });

    const { status, body } = await draft({ type: "jira", value: "WM-42" });

    expect(status).toBe(200);
    expect(body).toMatchObject({ title: "FAIL to log in", drafter: null });
    expect(body.description).toBe("Users can't log in.\n\n- Show an error");
    expect(body.warning).toContain("Codex couldn't draft it (model exploded)");
  }, 30_000);

  it("reads Linear issues, and copies without a model when drafting is switched off", async () => {
    setup({
      "POST /graphql": () => ({
        data: {
          issues: {
            nodes: [
              {
                id: "i1",
                identifier: "ENG-7",
                title: "Speed up search",
                description: "Search takes **4s**.",
                url: "https://linear.app/acme/issue/ENG-7",
                state: { id: "s1", name: "Todo" },
                team: { id: "t1", key: "ENG", states: { nodes: [] } },
              },
            ],
          },
        },
      }),
    });
    h!.connections.create({ name: "Acme", type: "linear", values: { apiKey: "k" } });

    const saved = await send("PUT", "/api/settings/ticket-draft", { agent: null, model: "gpt-5.6-luna" });
    expect(saved.body).toEqual({ agent: null, model: null, effort: null });

    const { body } = await draft({ type: "linear", value: "https://linear.app/acme/issue/ENG-7/speed-up-search" });
    expect(body).toMatchObject({
      title: "Speed up search",
      description: "Search takes **4s**.",
      issueKey: "ENG-7",
      drafter: null,
      warning: null,
    });
  });

  it("rejects a drafting model the agent doesn't accept", async () => {
    setup({});
    expect(await (await h!.app.request("/api/settings/ticket-draft")).json()).toEqual({
      agent: "codex",
      model: "gpt-5.6-luna",
      effort: "low",
    });
    const { status, body } = await send("PUT", "/api/settings/ticket-draft", { agent: "codex", model: "not a model" });
    expect(status).toBe(400);
    expect(body.error).toContain("not a Codex model");
  }, 30_000);

  it("explains what's missing before calling anything", async () => {
    const calls = setup({ "GET /rest/api/3/issue/*": () => json({ errorMessages: ["Issue does not exist"] }, 404) });

    expect((await draft({ type: "jira", value: "WM-42" })).body.error).toContain("Add a Jira connection");
    expect((await draft({ type: "notion", value: "https://notion.so/x" })).body.error).toContain("Only Jira and Linear");

    h!.connections.create({ name: "Team", type: "jira", values: jiraValues("team.atlassian.net", "me@x.com") });
    expect((await draft({ type: "jira", value: "not a key" })).body.error).toContain("does not contain a Jira issue key");
    expect(calls).toHaveLength(0);

    const missing = await draft({ type: "jira", value: "WM-404" });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain("Couldn't read WM-404");
    expect(missing.body.error).toContain("Issue does not exist");
  });
});

describe("ticket text", () => {
  it("renders Atlassian Document Format as Markdown", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Steps" }] },
        {
          type: "orderedList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Open " }, { type: "text", text: "/login", marks: [{ type: "code" }] }] }] },
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Submit" }] },
                { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "twice" }] }] }] },
              ],
            },
          ],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "See " },
            { type: "text", text: "the spec", marks: [{ type: "link", attrs: { href: "https://x.test/spec" } }] },
            { type: "hardBreak" },
            { type: "mention", attrs: { text: "@sam" } },
          ],
        },
        { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "login()" }] },
      ],
    };
    expect(adfToText(doc)).toBe(
      "## Steps\n\n1. Open `/login`\n2. Submit\n  - twice\n\nSee [the spec](https://x.test/spec)\n@sam\n\n```ts\nlogin()\n```",
    );
    expect(adfToText(null)).toBe("");
    expect(adfToText("plain v2 text")).toBe("plain v2 text");
  });

  it("reads the draft out of a reply that isn't bare JSON", () => {
    expect(parseDraft('```json\n{"title": " Fix  login ", "description": "- a\\n- b"}\n```')).toEqual({
      title: "Fix login",
      description: "- a\n- b",
    });
    expect(parseDraft('Here you go: {"title": "Only a title"}')).toEqual({ title: "Only a title", description: "" });
    expect(parseDraft('{"description": "no title"}')).toBeNull();
    expect(parseDraft("not json")).toBeNull();
  });
});
