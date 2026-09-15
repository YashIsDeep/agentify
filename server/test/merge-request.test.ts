import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, inspect, removeDir, waitFor } from "./helpers";

let h: Harness;
let repo: string;
let remote: string;

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
  h = createHarness();
  // A plain bare repository stands in for the remote that isn't GitLab: with push options advertised
  // it accepts `-o merge_request.create` and quietly ignores it, exactly as such a remote does.
  remote = mkdtempSync(join(tmpdir(), "wm-remote-"));
  gitIn(remote, "init", "--bare", "-b", "main", ".");
  gitIn(remote, "config", "receive.advertisePushOptions", "true");

  repo = mkdtempSync(join(tmpdir(), "wm-repo-"));
  gitIn(repo, "init", "-b", "main");
  gitIn(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, "README.md"), "# test\n");
  gitIn(repo, "add", ".");
  gitIn(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init");
  gitIn(repo, "remote", "add", "origin", remote);
});

afterEach(async () => {
  await h.close();
  removeDir(h.dataDir);
  removeDir(repo);
  removeDir(remote);
});

function shipWorkflow(config: Record<string, unknown> = {}) {
  return h.addWorkflow({
    name: "Ship",
    description: "",
    stages: [
      {
        name: "Submit MR",
        bindings: [
          { key: "worktree", label: "Worktree", actionType: "ensure-worktree", config: {} },
          {
            key: "openMr",
            label: "Push & open MR",
            actionType: "open-merge-request",
            config: { remote: "origin", host: "gitlab", title: "{{task.title}}", ...config },
          },
        ],
      },
    ],
  });
}

/** The newest attempt at openMr, once it has stopped moving. */
const settledMr = (taskId: string) =>
  waitFor(() => {
    const run = inspect(h).latest(taskId, "openMr");
    return run && (run.status === "failed" || run.status === "succeeded") ? run : undefined;
  });

describe("open merge request", () => {
  it("fails when the push worked but no merge request came back", async () => {
    const task = h.engine.createTask({ workflowId: shipWorkflow(), title: "Ship it", repoPath: repo });
    const run = await settledMr(task.id);

    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/no merge request URL came back/);
    expect(run.error).toMatch(/push options turned off server-side/);
    // The retry advice has to be true: the branch is on the remote even though the run failed.
    expect(run.error).toMatch(/retrying this step is safe/);
    const { branch } = h.engine.getTask(task.id);
    expect(gitIn(remote, "branch", "--list", branch!)).toContain(branch!);
  });

  it("accepts a push without a merge request when requireMrUrl is off", async () => {
    const workflowId = shipWorkflow({ requireMrUrl: false });
    const task = h.engine.createTask({ workflowId, title: "No link", repoPath: repo });
    const run = await settledMr(task.id);

    expect(run.status).toBe("succeeded");
    expect(run.outputs).toMatchObject({ mrUrl: null, host: "gitlab" });
  });
});
