import { linkSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceInfo } from "@wm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/actions/registry";
import { bootstrap } from "../src/bootstrap";
import type { AppConfig } from "../src/config";
import * as s from "../src/db/schema";
import { insertWorkflow } from "../src/seed/workflows";
import { bootstrapWorkspaces } from "../src/workspaces";
import { MAX_REQUEST_BYTES } from "../src/api/security";
import { removeDir, waitFor } from "./helpers";
import { releaseGate, resetTestActions, testActions } from "./test-actions";

let host: ReturnType<typeof bootstrapWorkspaces>;
let config: AppConfig;
const registry = createDefaultRegistry();
for (const action of testActions) registry.register(action);

beforeEach(() => {
  resetTestActions();
  config = {
    dataDir: mkdtempSync(join(tmpdir(), "wm-workspaces-")),
    host: "127.0.0.1", port: 2711, devOriginPorts: [2712], maxConcurrentLongRuns: 1,
  };
  host = bootstrapWorkspaces(config, { registry, seed: false });
  host.start();
});
afterEach(async () => {
  releaseGate("first");
  releaseGate("second");
  await host.close();
  removeDir(config.dataDir);
});

const scoped = (id: string, path: string) => `/api/workspaces/${id}${path}`;
const send = (path: string, method: string, body: unknown) => host.app.request(path, {
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

describe("workspaces", () => {
  it("does not overwrite an existing catalog temporary hard link", () => {
    const sentinel = join(config.dataDir, "sentinel.txt");
    writeFileSync(sentinel, "UNCHANGED");
    linkSync(sentinel, join(config.dataDir, "workspaces.json.tmp"));
    host.workspaces.rename("default", { name: "Renamed" });
    expect(readFileSync(sentinel, "utf8")).toBe("UNCHANGED");
    expect(JSON.parse(readFileSync(join(config.dataDir, "workspaces.json"), "utf8")).workspaces[0].name).toBe("Renamed");
  });

  it("limits bodies on catalog and forwarded workspace routes", async () => {
    for (const path of ["/api/workspaces", scoped("default", "/tasks")]) {
      const response = await host.app.request(path, { method: "POST", body: "x".repeat(MAX_REQUEST_BYTES + 1) });
      expect(response.status).toBe(413);
    }
  });

  it("keeps existing data and paths in the default workspace", async () => {
    await host.close();
    const legacy = bootstrap(config, { registry, seed: false });
    const workflow = legacy.workflows.create({ name: "Existing workflow" });
    const task = legacy.engine.createTask({ workflowId: workflow.id, title: "Existing task" });
    const connection = legacy.connections.create({ type: "linear", name: "Existing connection", values: { apiKey: "test-key" } });
    legacy.agents.setPathOverride("codex", process.execPath);
    mkdirSync(legacy.paths.artifactDir(task.id), { recursive: true });
    writeFileSync(join(legacy.paths.artifactDir(task.id), "notes.txt"), "existing artifact");
    await legacy.close();

    host = bootstrapWorkspaces(config, { registry });
    host.start();
    const current = host.workspaces.get("default");
    expect(current.paths.dataDir).toBe(config.dataDir);
    expect(current.engine.getTask(task.id).title).toBe("Existing task");
    expect(current.connections.get(connection.id).values.apiKey).toBe("test-key");
    expect(current.agents.pathOverride("codex")).toBe(process.execPath);
    expect(readFileSync(join(current.paths.artifactDir(task.id), "notes.txt"), "utf8")).toBe("existing artifact");
    const workflows = await (await host.app.request("/api/workflows")).json() as { name: string }[];
    expect(workflows.map((item) => item.name)).toEqual(["Existing workflow"]);
    expect((await host.app.request(scoped("default", `/tasks/${task.id}`))).status).toBe(200);
  });

  it("isolates workflows, tasks, archives, connections, agent settings and direct-ID access", async () => {
    const original = host.workspaces.get("default");
    const workflow = original.workflows.create({ name: "Private workflow" });
    const active = original.engine.createTask({ workflowId: workflow.id, title: "Active" });
    const archived = original.engine.createTask({ workflowId: workflow.id, title: "Archived" });
    await original.archiveTask(archived.id, { force: true });
    const connection = original.connections.create({ type: "linear", name: "Private", values: { apiKey: "source-secret" } });
    original.agents.setPathOverride("codex", process.execPath);
    original.settings.set("ticketDraft", { agent: "codex", model: "source-model", effort: null });

    const created = await send("/api/workspaces", "POST", { name: "Other workspace" });
    expect(created.status).toBe(201);
    const other = await created.json() as WorkspaceInfo;
    for (const path of ["/workflows", "/tasks?status=active", "/tasks?status=archived", "/connections", "/repos"]) {
      expect(await (await host.app.request(scoped(other.id, path))).json()).toEqual([]);
    }
    expect(host.workspaces.get(other.id).agents.pathOverride("codex")).toBeNull();
    expect(host.workspaces.get(other.id).tickets.getSettings().model).not.toBe("source-model");
    expect((await host.app.request(scoped(other.id, `/tasks/${active.id}`))).status).toBe(404);
    expect((await host.app.request(scoped(other.id, `/workflows/${workflow.id}`))).status).toBe(404);
    expect((await send(scoped(other.id, `/connections/${connection.id}`), "PUT", { name: "Changed" })).status).toBe(404);
    expect((await send(scoped(other.id, "/tasks"), "POST", { workflowId: workflow.id, title: "Wrong workspace" })).status).toBe(404);
    expect((await send(scoped(other.id, "/workflows"), "POST", { name: "Copy", copyFromWorkflowId: workflow.id })).status).toBe(404);
    expect(host.workspaces.get(other.id).engine.listWorkflows()).toEqual([]);
    expect(original.connections.get(connection.id).name).toBe("Private");
    expect(original.engine.listTasks({ status: "archived" }).map((task) => task.id)).toEqual([archived.id]);
  });

  it("clones only configuration, preserves references, and edits each copy independently", async () => {
    const original = host.workspaces.get("default");
    const connection = original.connections.create({ type: "linear", name: "Tracker", values: { apiKey: "clone-secret" } });
    const workflowId = insertWorkflow(original.db, {
      name: "Linked workflow", description: "Clone me",
      stages: [
        { name: "Backlog", agentDefaults: { agent: "codex", model: "model-a", effort: "high" } },
        { name: "Work", bindings: [
          { key: "tracker", label: "Update issue", actionType: "linear-update", enabled: false, config: { connectionId: connection.id } },
          { key: "move", label: "Move back", actionType: "move-to-stage", config: { stageId: "@stage:Backlog" } },
        ] },
      ],
    });
    original.settings.set("agents", { paths: { codex: "C:/source/codex.exe" }, defaults: { codex: { model: "model-a", effort: "high" } } });
    const task = original.engine.createTask({ workflowId, title: "History stays here" });
    await original.archiveTask(task.id, { force: true });

    const response = await send(scoped("default", "/clone"), "POST", { name: "Cloned" });
    expect(response.status).toBe(201);
    const workspace = await response.json() as WorkspaceInfo;
    expect(JSON.stringify(workspace)).not.toContain("clone-secret");
    const clone = host.workspaces.get(workspace.id);
    expect(clone.paths.dataDir).not.toBe(original.paths.dataDir);
    expect(clone.engine.getWorkflow(workflowId)).toEqual(original.engine.getWorkflow(workflowId));
    expect(clone.agents.pathOverride("codex")).toBe("C:/source/codex.exe");
    expect(clone.agents.defaults("codex")).toEqual({ model: "model-a", effort: "high" });
    expect(clone.connections.get(connection.id).values.apiKey).toBe("clone-secret");
    expect(clone.engine.listTasks({})).toEqual([]);
    expect(clone.db.select().from(s.actionRuns).all()).toEqual([]);
    expect(JSON.stringify(await (await host.app.request(scoped(workspace.id, "/connections"))).json())).not.toContain("clone-secret");

    clone.agents.setPathOverride("codex", null);
    clone.connections.update(connection.id, { name: "Clone tracker", values: { apiKey: "new-secret" } });
    await clone.workflows.remove(workflowId);
    expect(original.agents.pathOverride("codex")).toBe("C:/source/codex.exe");
    expect(original.connections.get(connection.id).values.apiKey).toBe("clone-secret");
    expect(original.engine.getWorkflow(workflowId).name).toBe("Linked workflow");
    expect(original.engine.getTask(task.id).status).toBe("archived");
  });

  it("persists workspace names and independent empty setups across restart", async () => {
    const blank = host.workspaces.create({ name: "Blank" });
    await send(scoped(blank.id, ""), "PATCH", { name: "Renamed" });
    host.workspaces.get(blank.id).settings.set("agents", { paths: { codex: "C:/renamed/codex.exe" } });
    await host.close();
    host = bootstrapWorkspaces(config, { registry });
    host.start();
    expect(host.workspaces.list().find((item) => item.id === blank.id)?.name).toBe("Renamed");
    expect(host.workspaces.get(blank.id).engine.listWorkflows()).toEqual([]);
    expect(host.workspaces.get(blank.id).agents.pathOverride("codex")).toBe("C:/renamed/codex.exe");
  });

  it("rejects invalid input and unknown workspaces without falling back to default", async () => {
    expect((await send("/api/workspaces", "POST", { name: " " })).status).toBe(400);
    expect((await host.app.request("/api/workspaces", { method: "POST", body: "broken" })).status).toBe(400);
    expect((await send(scoped("missing", "/clone"), "POST", { name: "Copy" })).status).toBe(404);
    expect((await host.app.request(scoped("missing", "/tasks"))).status).toBe(404);
    expect((await host.app.request("/api/workspaces", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect(host.workspaces.list()).toHaveLength(1);
  });

  it("shares the concurrency cap and wakes queued work in other workspaces", async () => {
    const other = host.workspaces.create({ name: "Other" });
    const first = host.workspaces.get("default");
    const second = host.workspaces.get(other.id);
    const waiting = (context: typeof first, gate: string) => {
      const workflowId = insertWorkflow(context.db, {
        name: gate, description: "", stages: [{ name: "Work", bindings: [
          { key: "wait", label: "Wait", actionType: "test-long-wait", config: { gate } },
        ] }],
      });
      const task = context.engine.createTask({ workflowId, title: gate });
      return () => context.engine.getTaskDetail(task.id).visits[0]!.runs[0]!;
    };
    const runA = waiting(first, "first");
    await waitFor(() => runA().status === "running");
    const runB = waiting(second, "second");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(runB().status).toBe("queued");
    releaseGate("first");
    await waitFor(() => runB().status === "running");
    expect(runA().status).toBe("succeeded");
    releaseGate("second");
    await waitFor(() => runB().status === "succeeded");
  });

  it("saves the shared agent limit and starts queued work when it rises", async () => {
    expect(await (await host.app.request("/api/settings/concurrency")).json()).toEqual({ maxConcurrentAgents: 1 });
    expect((await send("/api/settings/concurrency", "PUT", { maxConcurrentAgents: 0 })).status).toBe(400);
    const other = host.workspaces.create({ name: "Other" });
    const start = (context: ReturnType<typeof host.workspaces.get>, gate: string) => {
      const workflowId = insertWorkflow(context.db, {
        name: gate, description: "", stages: [{ name: "Work", bindings: [
          { key: "wait", label: "Wait", actionType: "test-long-wait", config: { gate } },
        ] }],
      });
      const task = context.engine.createTask({ workflowId, title: gate });
      return () => context.engine.getTaskDetail(task.id).visits[0]!.runs[0]!;
    };
    const runA = start(host.workspaces.get("default"), "first");
    await waitFor(() => runA().status === "running");
    const runB = start(host.workspaces.get(other.id), "second");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(runB().status).toBe("queued");
    const saved = await send("/api/settings/concurrency", "PUT", { maxConcurrentAgents: 2 });
    expect(await saved.json()).toEqual({ maxConcurrentAgents: 2 });
    await waitFor(() => runB().status === "running");
    expect(runA().status).toBe("running");
  });

  it("routes agent questions to their owning workspace, even with identical run IDs", async () => {
    const other = host.workspaces.create({ name: "Other" });
    const endpoints = ["default", other.id].map((id) => {
      const context = host.workspaces.get(id);
      const workflowId = insertWorkflow(context.db, {
        name: "Approval", description: "", stages: [{ name: "Review", bindings: [
          { key: "approve", label: "Approve", actionType: "approval", config: {} },
        ] }],
      });
      const task = context.engine.createTask({ workflowId, title: "Review" });
      const run = context.engine.getTaskDetail(task.id).visits[0]!.runs[0]!;
      return { id, run, endpoint: new URL(context.questions.endpointFor(run.id)).pathname };
    });
    expect(endpoints[0]!.run.id).toBe(endpoints[1]!.run.id);
    const endpoint = endpoints[1]!.endpoint;
    const rpc = (path: string) => host.app.request(path, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect((await rpc(endpoint)).status).toBe(200);
    expect((await rpc(endpoint.replace(other.id, "default"))).status).toBe(404);
  });

  it("does not send one workspace's live events to another", async () => {
    const other = host.workspaces.create({ name: "Other" });
    const abort = new AbortController();
    const response = await host.app.request(scoped(other.id, "/events"), { signal: abort.signal });
    const reader = response.body!.getReader();
    try {
      await reader.read(); // ready
      host.workspaces.get("default").engine.publish({ type: "task.changed", taskId: "foreign-task" });
      host.workspaces.get(other.id).engine.publish({ type: "task.changed", taskId: "own-task" });
      const next = new TextDecoder().decode((await reader.read()).value);
      expect(next).toContain("own-task");
      expect(next).not.toContain("foreign-task");
    } finally {
      abort.abort();
      await reader.cancel();
    }
  });
});
