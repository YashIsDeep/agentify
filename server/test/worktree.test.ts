import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, inspect, removeDir, waitFor } from "./helpers";

let h: Harness;
let repo: string;

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
  h = createHarness();
  repo = mkdtempSync(join(tmpdir(), "wm-repo-"));
  gitIn(repo, "init", "-b", "main");
  gitIn(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, "README.md"), "# test\n");
  gitIn(repo, "add", ".");
  gitIn(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init");
});

afterEach(async () => {
  await h.close();
  removeDir(h.dataDir);
  removeDir(repo);
});

function codeWorkflow() {
  return h.addWorkflow({
    name: "Code",
    description: "",
    stages: [
      {
        name: "Work",
        phases: [
          { name: "Setup", completion: "auto" },
          { name: "Hack", completion: "manual" },
        ],
        bindings: [
          { key: "worktree", label: "Worktree", trigger: "phase.started", phase: "Setup", actionType: "ensure-worktree", config: {} },
          { key: "archive", label: "Archive", trigger: "manual", actionType: "archive-task", config: {} },
        ],
      },
    ],
  });
}

describe("worktrees", () => {
  it("creates a worktree per task and removes it on archive, keeping the branch", async () => {
    const q = inspect(h);
    const workflowId = codeWorkflow();
    const task = h.engine.createTask({ workflowId, title: "Add login page", repoPath: repo });
    await waitFor(() => q.phase(task.id, "Hack").status === "running");

    const ready = h.engine.getTask(task.id);
    expect(ready.baseBranch).toBe("main");
    expect(ready.branch).toMatch(/^wm\/add-login-page-[0-9a-f]{8}$/);
    expect(existsSync(join(ready.worktreePath!, "README.md"))).toBe(true);

    const archive = h.engine.getWorkflow(workflowId).stages[0]!.bindings.find((b) => b.key === "archive")!;
    h.engine.triggerManual(task.id, archive.id);
    await waitFor(() => h.engine.getTask(task.id).status === "archived");
    await h.runner.idle();

    expect(existsSync(ready.worktreePath!)).toBe(false);
    expect(h.engine.getTask(task.id).worktreePath).toBeNull();
    expect(gitIn(repo, "branch", "--list", ready.branch!)).toContain(ready.branch!);
    expect(existsSync(h.paths.runsDir(task.id))).toBe(false);
  });

  it("refuses to remove a dirty worktree unless forced", async () => {
    const q = inspect(h);
    const task = h.engine.createTask({ workflowId: codeWorkflow(), title: "Dirty", repoPath: repo });
    await waitFor(() => q.phase(task.id, "Hack").status === "running");
    const { worktreePath } = h.engine.getTask(task.id);
    writeFileSync(join(worktreePath!, "wip.txt"), "unsaved work");

    await expect(h.archiveTask(task.id)).rejects.toThrow(/Could not remove the worktree/);
    expect(h.engine.getTask(task.id).status).toBe("active");

    await h.archiveTask(task.id, { force: true });
    expect(h.engine.getTask(task.id).status).toBe("archived");
    expect(existsSync(worktreePath!)).toBe(false);
  });

  it("skips worktree creation for tasks without a repository", async () => {
    const q = inspect(h);
    const task = h.engine.createTask({ workflowId: codeWorkflow(), title: "No repo" });
    await waitFor(() => q.phase(task.id, "Hack").status === "running");
    expect(q.runs(task.id, "worktree")[0]?.outputs).toEqual({ skipped: true });
  });
});
