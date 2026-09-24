import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

function codeWorkflow(worktreeConfig: Record<string, unknown> = {}) {
  return h.addWorkflow({
    name: "Code",
    description: "",
    stages: [
      {
        name: "Work",
        bindings: [
          { key: "worktree", label: "Worktree", actionType: "ensure-worktree", config: worktreeConfig },
          { key: "hack", label: "Hack", actionType: "approval", config: {} },
          { key: "archive", label: "Archive", actionType: "archive-task", config: {} },
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
    await waitFor(() => q.latest(task.id, "hack")?.status === "awaiting-approval");

    const ready = h.engine.getTask(task.id);
    expect(ready.baseBranch).toBe("main");
    expect(ready.branch).toMatch(/^wm\/add-login-page-[0-9a-f]{8}$/);
    expect(existsSync(join(ready.worktreePath!, "README.md"))).toBe(true);
    expect(() => h.engine.updateTask(task.id, { useWorktree: false })).toThrow(/already has a worktree/);

    // Approving lets the list carry on to Archive.
    h.engine.approveRun(q.latest(task.id, "hack")!.id);
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
    await waitFor(() => q.latest(task.id, "hack")?.status === "awaiting-approval");
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
    await waitFor(() => q.latest(task.id, "hack")?.status === "awaiting-approval");
    expect(q.runs(task.id, "worktree")[0]?.outputs).toEqual({ skipped: true });
  });

  it("works in the repository checkout when the task turns worktrees off", async () => {
    const q = inspect(h);
    const task = h.engine.createTask({ workflowId: codeWorkflow(), title: "In place", repoPath: repo, useWorktree: false });
    await waitFor(() => q.latest(task.id, "hack")?.status === "awaiting-approval");
    expect(q.runs(task.id, "worktree")[0]?.outputs).toEqual({ skipped: true });
    const after = h.engine.getTask(task.id);
    expect(after).toMatchObject({ useWorktree: false, worktreePath: null, branch: null });

    await h.archiveTask(task.id);
    expect(h.engine.getTask(task.id).status).toBe("archived");
    expect(existsSync(join(repo, "README.md"))).toBe(true);
  });

  it("copies gitignored files and links gitignored directories into a new worktree", async () => {
    writeFileSync(join(repo, ".env"), "TOKEN=local\n");
    mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "dep", "index.js"), "module.exports = 1;\n");

    const q = inspect(h);
    // "config/absent.json" isn't in the repository at all; it should be skipped, not fatal.
    const workflowId = codeWorkflow({ carryOver: ".env, node_modules\nconfig/absent.json" });
    const task = h.engine.createTask({ workflowId, title: "Carry over", repoPath: repo });
    await waitFor(() => q.latest(task.id, "hack")?.status === "awaiting-approval");
    const { worktreePath } = h.engine.getTask(task.id);

    expect(readFileSync(join(worktreePath!, ".env"), "utf8")).toBe("TOKEN=local\n");
    expect(existsSync(join(worktreePath!, "node_modules", "dep", "index.js"))).toBe(true);
    expect(lstatSync(join(worktreePath!, "node_modules")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(worktreePath!, "config"))).toBe(false);
    expect(q.runs(task.id, "worktree")[0]?.status).toBe("succeeded");

    // The copy is the worktree's own, so a task editing it leaves the repository's alone.
    writeFileSync(join(worktreePath!, ".env"), "TOKEN=task\n");
    expect(readFileSync(join(repo, ".env"), "utf8")).toBe("TOKEN=local\n");
  });

  it("archiving removes the worktree folder with its carried-over links, leaving their targets alone", async () => {
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    gitIn(repo, "add", ".gitignore");
    gitIn(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "ignore");
    mkdirSync(join(repo, "client", "node_modules", "dep"), { recursive: true });
    writeFileSync(join(repo, "client", "node_modules", "dep", "index.js"), "module.exports = 1;\n");

    const q = inspect(h);
    const workflowId = codeWorkflow({ carryOver: "client/node_modules" });
    const task = h.engine.createTask({ workflowId, title: "Linked", repoPath: repo });
    const hack = await waitFor(() => (q.latest(task.id, "hack")?.status === "awaiting-approval" ? q.latest(task.id, "hack") : undefined));
    const { worktreePath } = h.engine.getTask(task.id);
    expect(lstatSync(join(worktreePath!, "client", "node_modules")).isSymbolicLink()).toBe(true);

    h.engine.approveRun(hack.id);
    await waitFor(() => h.engine.getTask(task.id).status === "archived");
    // git alone leaves client/node_modules behind as a live link to the repository's copy.
    expect(existsSync(worktreePath!)).toBe(false);
    expect(readFileSync(join(repo, "client", "node_modules", "dep", "index.js"), "utf8")).toBe("module.exports = 1;\n");
  });

  it("refuses to carry over a path that leaves the repository", async () => {
    const q = inspect(h);
    const workflowId = codeWorkflow({ carryOver: "../secrets" });
    const task = h.engine.createTask({ workflowId, title: "Escape", repoPath: repo });
    const run = await waitFor(() => {
      const latest = q.runs(task.id, "worktree")[0];
      return latest?.status === "failed" ? latest : undefined;
    });
    expect(run.error).toContain("outside the repository");
  });

  it("force-deleting a workflow removes its tasks' worktrees, dirty or not, and keeps the branches", async () => {
    const q = inspect(h);
    const workflowId = codeWorkflow();
    const task = h.engine.createTask({ workflowId, title: "Abandoned", repoPath: repo });
    await waitFor(() => q.latest(task.id, "hack")?.status === "awaiting-approval");
    const { worktreePath, branch } = h.engine.getTask(task.id);
    writeFileSync(join(worktreePath!, "wip.txt"), "unsaved work");

    await h.workflows.remove(workflowId, { force: true });

    expect(existsSync(worktreePath!)).toBe(false);
    expect(gitIn(repo, "branch", "--list", branch!)).toContain(branch!);
    expect(h.engine.findTask(task.id)).toBeUndefined();
  });
});
