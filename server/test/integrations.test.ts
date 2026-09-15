import type { RunView } from "@wm/shared";
import { afterEach, describe, expect, it } from "vitest";
import { issueKey } from "../src/integrations/jira";
import { splitIdentifier } from "../src/integrations/linear";
import { markdownToBlocks, notionId } from "../src/integrations/notion";
import { fakeHttp, type HttpCall, json, type Route } from "./fake-http";
import { createHarness, type Harness, removeDir, waitFor } from "./helpers";

let h: Harness;

afterEach(async () => {
  await h?.close();
  if (h) removeDir(h.dataDir);
});

/**
 * Builds a one-stage workflow whose only action is the integration under test, runs a task
 * through it, and hands back the finished run plus every HTTP call the action made.
 */
async function runAction(
  routes: Record<string, Route>,
  connection: { type: "jira" | "linear" | "notion"; values: Record<string, string> },
  action: { actionType: string; config: Record<string, unknown> },
): Promise<{ run: RunView; calls: HttpCall[] }> {
  const { http, calls } = fakeHttp(routes);
  h = createHarness({ http });
  const created = h.connections.create({ name: "Test", type: connection.type, values: connection.values });

  const workflowId = h.addWorkflow({
    name: "Integration",
    description: "",
    stages: [
      {
        name: "Notify",
        bindings: [
          {
            key: "notify",
            label: "Notify",
            actionType: action.actionType,
            config: { ...action.config, connectionId: created.id },
          },
        ],
      },
    ],
  });

  const task = h.engine.createTask({ workflowId, title: "Add a login form", links: [{ type: "jira", value: "WM-42" }] });
  await h.runner.idle();
  const run = await waitFor(() => h.engine.getTaskDetail(task.id).visits[0]?.runs.find((r) => r.status !== "queued" && r.status !== "running"));
  return { run, calls };
}

describe("jira-transition", () => {
  const routes: Record<string, Route> = {
    "GET /rest/api/3/issue/*/transitions": () => ({ transitions: [{ id: "31", name: "In Progress", to: { name: "In Progress" } }] }),
    "POST /rest/api/3/issue/*/transitions": () => ({}),
    "POST /rest/api/3/issue/*/comment": () => ({}),
    "GET /rest/api/3/issue/*": () => ({ key: "WM-42", fields: { status: { name: "In Progress" } } }),
  };
  const connection = { type: "jira" as const, values: { baseUrl: "https://team.atlassian.net", email: "me@x.com", apiToken: "t" } };

  it("resolves the transition by name and reports the resulting status", async () => {
    const { run, calls } = await runAction(routes, connection, {
      actionType: "jira-transition",
      config: { issue: "{{task.links.jira}}", transition: "in progress", comment: "Started by {{stage.name}}" },
    });

    expect(run.status).toBe("succeeded");
    expect(run.outputs).toMatchObject({ issueKey: "WM-42", status: "In Progress", transitionId: "31" });

    const transition = calls.find((call) => call.method === "POST" && call.path.endsWith("/transitions"));
    expect(transition?.body).toEqual({ transition: { id: "31" } });
    expect(transition?.headers.authorization).toBe(`Basic ${Buffer.from("me@x.com:t").toString("base64")}`);

    // Comments are Atlassian Document Format, with the workflow already rendered.
    const comment = calls.find((call) => call.path.endsWith("/comment"));
    expect(comment?.body.body.content[0].content[0].text).toBe("Started by Notify");
  });

  it("lists the available transitions when the configured one doesn't exist", async () => {
    const { run } = await runAction(routes, connection, {
      actionType: "jira-transition",
      config: { issue: "WM-42", transition: "Done" },
    });
    expect(run.status).toBe("failed");
    expect(run.error).toContain("In Progress");
  });

  it("does nothing when the task has no Jira issue, but still rejects an unreadable one", async () => {
    const { run, calls } = await runAction(routes, connection, {
      actionType: "jira-transition",
      config: { issue: "{{task.links.linear}}", transition: "In Progress" },
    });
    // The task has a jira link but no linear one, so the reference renders empty.
    expect(run.status).toBe("succeeded");
    expect(calls).toEqual([]);

    const typo = await runAction(routes, connection, {
      actionType: "jira-transition",
      config: { issue: "the KAN board", transition: "In Progress" },
    });
    expect(typo.run.status).toBe("failed");
  });

  it("fails with Jira's own message when the API rejects the call", async () => {
    const { run } = await runAction(
      { "GET /rest/api/3/issue/*/transitions": () => json({ errorMessages: ["Issue does not exist"] }, 404) },
      connection,
      { actionType: "jira-transition", config: { issue: "WM-42", transition: "Done" } },
    );
    expect(run.error).toContain("Issue does not exist");
  });
});

describe("linear-update", () => {
  const issue = {
    id: "uuid-1",
    identifier: "ENG-7",
    title: "Fix login",
    url: "https://linear.app/acme/issue/ENG-7",
    state: { id: "s0", name: "Todo" },
    team: { id: "t1", key: "ENG", states: { nodes: [{ id: "s1", name: "In Progress" }] } },
  };

  const graphql = (call: HttpCall) => {
    const query = String(call.body.query);
    if (query.includes("issues(filter")) return { data: { issues: { nodes: [issue] } } };
    if (query.includes("issueUpdate")) return { data: { issueUpdate: { success: true } } };
    if (query.includes("commentCreate")) return { data: { commentCreate: { success: true } } };
    return { data: {} };
  };

  it("finds the issue by identifier and moves it to a state on its own team", async () => {
    const { run, calls } = await runAction({ "POST /graphql": graphql }, { type: "linear", values: { apiKey: "lin_key" } }, {
      actionType: "linear-update",
      config: { issue: "https://linear.app/acme/issue/ENG-7/fix-login", state: "in progress", comment: "on it" },
    });

    expect(run.status).toBe("succeeded");
    expect(run.outputs).toMatchObject({ identifier: "ENG-7", state: "In Progress" });
    expect(calls[0]?.body.variables).toEqual({ team: "ENG", number: 7 });
    expect(calls[0]?.headers.authorization).toBe("lin_key");
    expect(calls.some((call) => String(call.body.query).includes("commentCreate"))).toBe(true);
  });

  it("surfaces GraphQL errors, which arrive with a 200", async () => {
    const { run } = await runAction({ "POST /graphql": () => ({ errors: [{ message: "Authentication required" }] }) }, { type: "linear", values: { apiKey: "bad" } }, {
      actionType: "linear-update",
      config: { issue: "ENG-7", state: "Done" },
    });
    expect(run.status).toBe("failed");
    expect(run.error).toContain("Authentication required");
  });
});

describe("notion-append", () => {
  it("creates a page in a database under its own title property", async () => {
    const { run, calls } = await runAction(
      {
        "GET /v1/databases/*": () => ({ properties: { Notes: { type: "rich_text" }, Name: { type: "title" } } }),
        "POST /v1/pages": () => ({ id: "page-1", url: "https://notion.so/page-1" }),
      },
      { type: "notion", values: { token: "secret_x" } },
      {
        actionType: "notion-append",
        config: {
          mode: "create-page",
          target: "https://www.notion.so/team/1234567890abcdef1234567890abcdef?v=1",
          title: "{{task.title}}",
          content: "# Findings\n- one\n- two",
        },
      },
    );

    expect(run.status).toBe("succeeded");
    expect(run.outputs).toMatchObject({ pageId: "page-1", blocks: 3 });

    const page = calls.find((call) => call.path === "/v1/pages");
    expect(page?.headers["notion-version"]).toBe("2022-06-28");
    expect(page?.body.parent).toEqual({ database_id: "12345678-90ab-cdef-1234-567890abcdef" });
    expect(page?.body.properties.Name.title[0].text.content).toBe("Add a login form");
    expect(page?.body.children[0]).toMatchObject({ type: "heading_1" });
  });

  it("refuses to write nothing", async () => {
    const { run } = await runAction({}, { type: "notion", values: { token: "secret_x" } }, {
      actionType: "notion-append",
      config: { target: "1234567890abcdef1234567890abcdef", content: "   " },
    });
    expect(run.status).toBe("failed");
    expect(run.error).toContain("nothing to write");
  });
});

describe("parsing what users paste", () => {
  it("finds issue keys in keys, URLs and prose", () => {
    expect(issueKey("wm-42")).toBe("WM-42");
    expect(issueKey("https://team.atlassian.net/browse/WM-42")).toBe("WM-42");
    expect(() => issueKey("")).toThrow(/PROJ-123/);
    expect(splitIdentifier("https://linear.app/acme/issue/ENG-7/fix")).toEqual({ team: "ENG", number: 7 });
    // The title in a Notion URL can itself end in hex letters, so the id must stay bounded.
    expect(notionId("https://www.notion.so/team/Page-1234567890abcdef1234567890abcdef")).toBe(
      "12345678-90ab-cdef-1234-567890abcdef",
    );
    expect(notionId("12345678-90AB-cdef-1234-567890abcdef")).toBe("12345678-90ab-cdef-1234-567890abcdef");
    expect(() => notionId("not-an-id")).toThrow(/Notion id/);
  });

  it("maps the Markdown an agent writes onto Notion blocks", () => {
    const blocks = markdownToBlocks("# Title\n\nfirst\nsecond\n\n- a\n1. b\n> q\n\n```ts\ncode()\n```\n---");
    expect(blocks.map((block) => block.type)).toEqual([
      "heading_1",
      "paragraph",
      "bulleted_list_item",
      "numbered_list_item",
      "quote",
      "code",
      "divider",
    ]);
    // Consecutive plain lines stay one block, so paragraphs survive the trip.
    expect((blocks[1] as any)[String(blocks[1]?.type)].rich_text[0].text.content).toBe("first\nsecond");
    expect((blocks[5] as any).code.language).toBe("typescript");
  });
});
