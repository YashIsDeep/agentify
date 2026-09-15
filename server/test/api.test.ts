import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionTypeInfo, ConnectionInfo, TaskDetail, TaskDiff, WorkflowDef } from "@wm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/api/app";
import { createHarness, type Harness, removeDir } from "./helpers";

let h: Harness;

beforeEach(() => {
  h = createHarness({ seed: true });
});

afterEach(async () => {
  await h.close();
  removeDir(h.dataDir);
});

const post = (path: string, body?: unknown) =>
  h.app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("api", () => {
  it("only accepts local hosts and origins", async () => {
    expect((await h.app.request("/api/health")).status).toBe(200);
    expect((await h.app.request("http://evil.example:2711/api/health")).status).toBe(403);
    expect((await h.app.request("/api/health", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await h.app.request("/api/health", { headers: { origin: "http://localhost:9999" } })).status).toBe(403);
    expect((await h.app.request("/api/health", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await h.app.request("/api/health", { headers: { origin: "http://localhost:2712" } })).status).toBe(200);
    expect((await h.app.request("/api/health", { headers: { origin: "http://127.0.0.1:2711" } })).status).toBe(200);
  });

  it("creates, lists and moves tasks", async () => {
    const [feature] = (await (await h.app.request("/api/workflows")).json()) as WorkflowDef[];
    const created = await post("/api/tasks", { workflowId: feature!.id, title: "From API", tags: ["ui"] });
    expect(created.status).toBe(201);
    const detail = (await created.json()) as TaskDetail;
    expect(detail.task).toMatchObject({ title: "From API", tags: ["ui"], badge: "idle" });
    expect(detail.visits[0]?.stageName).toBe("Backlog");

    const toPick = feature!.stages[1]!.id;
    const moved = await post(`/api/tasks/${detail.task.id}/move`, { stageId: toPick });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as TaskDetail).task.currentStageId).toBe(toPick);

    const listed = await h.app.request(`/api/tasks?workflowId=${feature!.id}&status=active`);
    expect(((await listed.json()) as unknown[]).length).toBe(1);
  });

  it("returns useful errors", async () => {
    expect((await post("/api/tasks", { title: "" })).status).toBe(400);
    expect((await h.app.request("/api/tasks/missing")).status).toBe(404);
    expect((await post("/api/runs/abc/retry")).status).toBe(400);
    const bad = await h.app.request("/api/tasks", { method: "POST", body: "{not json" });
    expect(bad.status).toBe(400);
  });

  it("archives tasks, honouring the force flag in the body", async () => {
    const [feature] = h.engine.listWorkflows();
    const task = h.engine.createTask({ workflowId: feature!.id, title: "Done" });
    const archived = await post(`/api/tasks/${task.id}/archive`, { force: true });
    expect(archived.status).toBe(200);
    expect(((await archived.json()) as TaskDetail).task.status).toBe("archived");
    expect((await post(`/api/tasks/${task.id}/archive`)).status).toBe(409);
  });

  it("serves the web app with a client-side routing fallback", async () => {
    const dist = mkdtempSync(join(tmpdir(), "wm-dist-"));
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>WM</title>");
    writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");
    const app = createApp({
      engine: h.engine,
      paths: h.paths,
      config: h.config,
      agents: h.agents,
      connections: h.connections,
      workflows: h.workflows,
      repos: h.repos,
      questions: h.questions,
      tickets: h.tickets,
      archiveTask: h.archiveTask,
      webDist: dist,
    });

    const index = await app.request("/");
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await index.text()).toContain("<title>WM</title>");
    const asset = await app.request("/assets/app.js");
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(await (await app.request("/tasks/some-client-route")).text()).toContain("<title>WM</title>");
    expect(await (await app.request("/..%2F..%2Fpackage.json")).text()).toContain("<title>WM</title>");
    expect((await app.request("/api/does-not-exist")).status).toBe(404);
    removeDir(dist);
  });

  it("creates, edits and deletes workflows", async () => {
    const created = await post("/api/workflows", { name: "From API" });
    expect(created.status).toBe(201);
    const workflow = (await created.json()) as WorkflowDef;

    const put = (body: unknown) =>
      h.app.request(`/api/workflows/${workflow.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const renamed = await put({
      name: "Renamed",
      description: "",
      updatedAt: workflow.updatedAt,
      stages: [
        {
          id: workflow.stages[0]!.id,
          name: "Todo",
          bindings: [{ id: crypto.randomUUID(), key: "doIt", label: "Do it", actionType: "approval", config: {} }],
        },
      ],
    });
    expect(renamed.status).toBe(200);
    const saved = (await renamed.json()) as WorkflowDef;
    expect(saved.name).toBe("Renamed");
    expect(saved.stages[0]!.bindings.map((binding) => [binding.label, binding.config])).toEqual([
      ["Do it", { instructions: "", sendBackTo: "", askForNote: true }],
    ]);

    // Same body again: the updatedAt it carries is now stale.
    expect((await put({ name: "Again", description: "", updatedAt: workflow.updatedAt, stages: [] })).status).toBe(400);

    expect((await h.app.request(`/api/workflows/${workflow.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await h.app.request(`/api/workflows/${workflow.id}`)).status).toBe(404);
  });

  it("deletes a workflow that tasks use only when forced", async () => {
    const workflow = (await (await post("/api/workflows", { name: "Busy" })).json()) as WorkflowDef;
    const task = h.engine.createTask({ workflowId: workflow.id, title: "In the way" });
    const remove = (query = "") => h.app.request(`/api/workflows/${workflow.id}${query}`, { method: "DELETE" });

    expect((await remove()).status).toBe(409);
    expect((await remove("?force=true")).status).toBe(204);
    expect(h.engine.findTask(task.id)).toBeUndefined();
  });

  it("publishes the action catalogue and workflow usage", async () => {
    const types = (await (await h.app.request("/api/action-types")).json()) as { type: string; fields: unknown[] }[];
    expect(types.map((type) => type.type)).toContain("shell");
    expect(types.every((type) => type.fields.length > 0)).toBe(true);

    const [feature] = h.engine.listWorkflows();
    h.engine.createTask({ workflowId: feature!.id, title: "Counted" });
    const usage = (await (await h.app.request(`/api/workflows/${feature!.id}/usage`)).json()) as {
      activeTasks: number;
      activeByStage: Record<string, number>;
    };
    expect(usage.activeTasks).toBe(1);
    expect(usage.activeByStage[feature!.stages[0]!.id]).toBe(1);
  });

  it("manages connections without ever returning a secret", async () => {
    const types = (await (await h.app.request("/api/connection-types")).json()) as { type: string }[];
    expect(types.map((type) => type.type)).toEqual(["jira", "linear", "notion"]);

    const created = await post("/api/connections", {
      name: "Work Jira",
      type: "jira",
      values: { baseUrl: "https://team.atlassian.net", email: "me@example.com", apiToken: "secret-token" },
    });
    expect(created.status).toBe(201);
    const connection = (await created.json()) as ConnectionInfo;
    expect(connection.secretsSet).toEqual(["apiToken"]);

    const listed = await (await h.app.request("/api/connections")).text();
    expect(listed).not.toContain("secret-token");
    expect(listed).toContain("me@example.com");

    const renamed = await h.app.request(`/api/connections/${connection.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed", values: {} }),
    });
    expect(((await renamed.json()) as ConnectionInfo)).toMatchObject({ name: "Renamed", secretsSet: ["apiToken"] });

    expect((await h.app.request(`/api/connections/${connection.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await (await h.app.request("/api/connections")).json()).toEqual([]);
  });

  it("labels which actions need a connection", async () => {
    const types = (await (await h.app.request("/api/action-types")).json()) as ActionTypeInfo[];
    const jira = types.find((type) => type.type === "jira-transition")!;
    expect(jira.connectionType).toBe("jira");
    expect(jira.fields[0]).toMatchObject({ name: "connectionId", kind: "connection" });
    expect(types.find((type) => type.type === "shell")?.connectionType).toBeNull();
  });

  it("diffs the task's branch, uncommitted and untracked work included", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wm-repo-"));
    const gitIn = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    const commit = (message: string) =>
      gitIn("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message);
    gitIn("init", "-b", "main");
    gitIn("config", "core.autocrlf", "false");
    writeFileSync(join(repo, "README.md"), "# test\n");
    gitIn("add", ".");
    commit("init");
    gitIn("checkout", "-b", "wm/feature");
    writeFileSync(join(repo, "app.ts"), "export const a = 1;\n");
    gitIn("add", ".");
    commit("add app");
    writeFileSync(join(repo, "README.md"), "# test\nnow with notes\n");
    writeFileSync(join(repo, "scratch.txt"), "not added\n");

    const [feature] = h.engine.listWorkflows();
    const task = h.engine.createTask({ workflowId: feature!.id, title: "Diff me", repoPath: repo });
    h.engine.setTaskGitInfo(task.id, { branch: "wm/feature", baseBranch: "main", worktreePath: repo });

    const response = await h.app.request(`/api/tasks/${task.id}/diff`);
    expect(response.status).toBe(200);
    const diff = (await response.json()) as TaskDiff;
    expect(diff).toMatchObject({ branch: "wm/feature", baseBranch: "main", uncommitted: true, truncated: false });
    expect(diff.files.map((file) => [file.path, file.status, file.untracked])).toEqual([
      ["README.md", "modified", false],
      ["app.ts", "added", false],
      ["scratch.txt", "added", true],
    ]);
    expect([diff.insertions, diff.deletions]).toEqual([2, 0]);
    expect(diff.patch).toContain("+export const a = 1;");
    expect(diff.patch).toContain("+now with notes");

    removeDir(repo);
  });

  it("says why a task has no diff to show", async () => {
    const [feature] = h.engine.listWorkflows();
    const task = h.engine.createTask({ workflowId: feature!.id, title: "Nothing to review" });
    const response = await h.app.request(`/api/tasks/${task.id}/diff`);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("no repository");
  });

  it("serves artifacts as plain text and blocks path traversal", async () => {
    const [feature] = h.engine.listWorkflows();
    const task = h.engine.createTask({ workflowId: feature!.id, title: "Artifacts" });
    const dir = h.paths.artifactDir(task.id);
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "nested", "page.html"), "<script>alert(1)</script>");

    const list = await h.app.request(`/api/tasks/${task.id}/artifacts`);
    expect(((await list.json()) as { name: string }[]).map((a) => a.name)).toEqual(["nested/page.html"]);

    const file = await h.app.request(`/api/tasks/${task.id}/artifact?name=nested/page.html`);
    expect(file.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await file.text()).toBe("<script>alert(1)</script>");

    const traversal = await h.app.request(`/api/tasks/${task.id}/artifact?name=${encodeURIComponent("../../../db.sqlite")}`);
    expect(traversal.status).toBe(400);
  });
});
