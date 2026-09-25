import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shellAction } from "../src/actions/shell";
import { MAX_REQUEST_BYTES } from "../src/api/security";
import { serveWeb } from "../src/api/static";
import { JiraClient } from "../src/integrations/jira";
import { requestJson } from "../src/integrations/http";
import { createHarness, type Harness, removeDir } from "./helpers";

let h: Harness;
let junction: string | undefined;
beforeEach(() => { h = createHarness(); });
afterEach(async () => {
  await h.close();
  // Remove the link itself before recursively cleaning up the temporary harness.
  if (junction) unlinkSync(junction);
  junction = undefined;
  removeDir(h.dataDir);
});

describe("security boundaries", () => {
  it("does not overwrite or disclose credentials through a pre-existing temporary hard link", () => {
    const sentinel = join(h.dataDir, "sentinel.txt");
    writeFileSync(sentinel, "UNCHANGED");
    linkSync(sentinel, `${h.paths.secretsFile}.tmp`);
    h.connections.create({ name: "Test", type: "linear", values: { apiKey: "PRIVATE_TOKEN" } });
    expect(readFileSync(sentinel, "utf8")).toBe("UNCHANGED");
    expect(h.connections.list()).toHaveLength(1);
    expect(readFileSync(h.paths.secretsFile, "utf8")).toContain("PRIVATE_TOKEN");
  });

  it.each(["source", "destination"])("rejects carry-over through a %s junction", async (side) => {
    const repo = join(h.dataDir, "repo");
    const worktree = join(h.dataDir, "worktree");
    const outside = join(h.dataDir, "outside");
    for (const dir of [repo, worktree, outside]) mkdirSync(dir);
    if (side === "source") {
      writeFileSync(join(outside, "secret.txt"), "PRIVATE_SENTINEL");
      junction = join(repo, "config");
    } else {
      mkdirSync(join(repo, "config"));
      writeFileSync(join(repo, "config", "secret.txt"), "PRIVATE_SENTINEL");
      junction = join(worktree, "config");
    }
    symlinkSync(outside, junction, process.platform === "win32" ? "junction" : "dir");
    const workflowId = h.addWorkflow({ name: "Carry-over", description: "", stages: [
      { name: "Idle" }, { name: "Copy", bindings: [
        { key: "copy", label: "Copy", actionType: "ensure-worktree", config: { carryOver: "config/secret.txt" } },
      ] },
    ] });
    const task = h.engine.createTask({ workflowId, title: "Carry-over", repoPath: repo });
    h.engine.setTaskGitInfo(task.id, { branch: "feature", baseBranch: "main", worktreePath: worktree });
    h.engine.moveTask(task.id, h.stageId(workflowId, "Copy"));
    await h.runner.idle();
    const run = h.engine.getTaskDetail(task.id).visits.flatMap(v => v.runs).find(r => r.bindingKey === "copy");
    expect(run?.status).toBe("failed");
    const unexpectedCopy = side === "source" ? join(worktree, "config", "secret.txt") : join(outside, "secret.txt");
    expect(existsSync(unexpectedCopy)).toBe(false);
  });

  it("does not list files through a linked artifact root", async () => {
    const workflowId = h.addWorkflow({ name: "Artifacts", description: "", stages: [{ name: "Idle" }] });
    const task = h.engine.createTask({ workflowId, title: "Linked artifacts" });
    const outside = join(h.dataDir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "private-filename.txt"), "PRIVATE_SENTINEL");
    mkdirSync(h.paths.taskDir(task.id), { recursive: true });
    junction = h.paths.artifactDir(task.id);
    symlinkSync(outside, junction, process.platform === "win32" ? "junction" : "dir");
    const response = await h.app.request(`/api/tasks/${task.id}/artifacts`);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private-filename");
  });

  it("does not serve static files through junctions", async () => {
    const dist = join(h.dataDir, "dist");
    const outside = join(h.dataDir, "outside");
    mkdirSync(dist);
    mkdirSync(outside);
    writeFileSync(join(dist, "index.html"), "APP");
    writeFileSync(join(outside, "secret.txt"), "PRIVATE_SENTINEL");
    junction = join(dist, "assets");
    symlinkSync(outside, junction, process.platform === "win32" ? "junction" : "dir");
    const app = new Hono();
    serveWeb(app, dist);
    const response = await app.request("/assets/secret.txt");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("PRIVATE_SENTINEL");
  });

  it("rejects oversized bodies with and without Content-Length", async () => {
    for (const headers of [{}, { "content-length": String(MAX_REQUEST_BYTES + 1) }]) {
      const response = await h.app.request("/api/tasks", {
        method: "POST", headers, body: "x".repeat(MAX_REQUEST_BYTES + 1),
      });
      expect(response.status).toBe(413);
    }
  });

  it("blocks framing even from another local port", async () => {
    const response = await h.app.request("/api/health", { headers: { "sec-fetch-site": "same-site" } });
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("rejects interpolated shell source when saved", () => {
    expect(shellAction.configSchema.safeParse({ command: 'echo "{{task.title}}"' }).success).toBe(false);
  });

  it("blocks interpolation in stored shell snapshots and retry overrides before rendering", async () => {
    const workflowId = h.addWorkflow({ name: "Shell", description: "", stages: [{ name: "Run", bindings: [
      { key: "shell", label: "Shell", actionType: "shell", config: { command: 'echo "{{task.title}}"', cwd: "artifacts" } },
    ] }] });
    const task = h.engine.createTask({ workflowId, title: 'ordinary" & echo SECURITY_REVIEW_INJECTION & echo "' });
    await h.runner.idle();
    let run = h.engine.getTaskDetail(task.id).visits[0]!.runs[0]!;
    expect(run.status).toBe("failed");
    expect(run.error).toContain("WM_");
    h.engine.retryRun(run.id, { command: 'echo "{{task.description}}"' });
    await h.runner.idle();
    run = h.engine.getTaskDetail(task.id).visits[0]!.runs.at(-1)!;
    expect(run.status).toBe("failed");
    expect(run.error).toContain("WM_");
  });

  it("passes hostile task text to a command as environment data", async () => {
    const workflowId = h.addWorkflow({ name: "Shell", description: "", stages: [{ name: "Run", bindings: [
      { key: "shell", label: "Shell", actionType: "shell", config: {
        command: `node -e "require('fs').writeFileSync(process.env.WM_OUTPUT_FILE,JSON.stringify({title:process.env.WM_TASK_TITLE}))"`, cwd: "artifacts",
      } },
    ] }] });
    const title = 'ordinary" & echo INJECTION & echo "';
    const task = h.engine.createTask({ workflowId, title });
    await h.runner.idle();
    expect(h.engine.getTaskDetail(task.id).visits[0]!.runs[0]).toMatchObject({ status: "succeeded", outputs: { title } });
  });

  it("refuses artifact reads and writes through a directory junction", async () => {
    const workflowId = h.addWorkflow({ name: "Artifacts", description: "", stages: [
      { name: "Idle" }, { name: "Write", bindings: [
        { key: "write", label: "Write", actionType: "write-artifact", config: { name: "escape/sentinel.txt", content: "OVERWRITTEN" } },
      ] },
    ] });
    const task = h.engine.createTask({ workflowId, title: "Junction" });
    const outside = join(h.dataDir, "outside-artifacts");
    mkdirSync(outside);
    writeFileSync(join(outside, "sentinel.txt"), "PRIVATE_SENTINEL");
    mkdirSync(h.paths.artifactDir(task.id), { recursive: true });
    junction = join(h.paths.artifactDir(task.id), "escape");
    symlinkSync(outside, junction, process.platform === "win32" ? "junction" : "dir");
    const response = await h.app.request(`/api/tasks/${task.id}/artifact?name=escape/sentinel.txt`);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("PRIVATE_SENTINEL");
    h.engine.moveTask(task.id, h.stageId(workflowId, "Write"));
    await h.runner.idle();
    expect(readFileSync(join(outside, "sentinel.txt"), "utf8")).toBe("PRIVATE_SENTINEL");
    expect(h.engine.getTaskDetail(task.id).visits.flatMap(v => v.runs).find(r => r.bindingKey === "write")?.status).toBe("failed");
  });

  it.each(["http://team.atlassian.net", "https://user:password@team.atlassian.net", "ftp://team.atlassian.net"])("rejects unsafe Jira URL %s before sending credentials", (baseUrl) => {
    const http = vi.fn<typeof fetch>();
    expect(() => new JiraClient({ baseUrl, email: "test@example.test", apiToken: "dummy" }, http)).toThrow();
    expect(http).not.toHaveBeenCalled();
  });

  it("keeps bare Jira hostnames working over HTTPS", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ displayName: "Test" }));
    await new JiraClient({ baseUrl: "team.atlassian.net/", email: "test@example.test", apiToken: "dummy" }, http).me();
    expect(http.mock.calls[0]?.[0]).toBe("https://team.atlassian.net/rest/api/3/myself");
  });

  it("rejects insecure connection saves without storing their token", async () => {
    const response = await h.app.request("/api/connections", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Unsafe", type: "jira", values: {
        baseUrl: "http://team.atlassian.net", email: "test@example.test", apiToken: "dummy",
      } }),
    });
    expect(response.status).toBe(400);
    expect(h.connections.list()).toEqual([]);
  });

  it("does not follow integration redirects with credentials or request bodies", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 307, headers: { location: "http://untrusted.test" } }));
    await expect(requestJson("https://team.atlassian.net/api", { service: "Jira", http, headers: { authorization: "dummy" } })).rejects.toThrow();
    expect(http.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
});
