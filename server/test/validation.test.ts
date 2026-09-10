import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/actions/registry";
import { git } from "../src/lib/git";
import { createHarness, type Harness, removeDir, waitFor } from "./helpers";

let h: Harness;

beforeEach(() => {
  h = createHarness({ seed: true });
});

afterEach(async () => {
  await h.close();
  removeDir(h.dataDir);
});

const registry = createDefaultRegistry();
const parse = (type: string, config: Record<string, unknown>) => registry.get(type)!.configSchema.safeParse(config);

/** These used to parse happily and blow up only once the action ran. */
describe("config that is now rejected when the template is saved", () => {
  it("rejects a shell output regex that does not compile", () => {
    expect(parse("shell", { command: "x", extract: { url: "https?://[" } }).success).toBe(false);
    expect(parse("shell", { command: "x", extract: { url: "(https?://\\S+)" } }).success).toBe(true);
    // A templated pattern is only knowable at run time, so it is left alone.
    expect(parse("shell", { command: "x", extract: { url: "{{task.title}}" } }).success).toBe(true);
  });

  it("rejects artifact names that escape the task's folder", () => {
    expect(parse("write-artifact", { name: "../../etc/passwd", content: "" }).success).toBe(false);
    expect(parse("write-artifact", { name: "C:\\windows\\system32\\x", content: "" }).success).toBe(false);
    expect(parse("write-artifact", { name: "notes/day-1.md", content: "" }).success).toBe(true);
    expect(parse("write-artifact", { name: "{{task.title}}.md", content: "" }).success).toBe(true);
  });

  it("rejects a coding agent result artifact that escapes, but allows blank", () => {
    const base = { prompt: "x", agent: "claude" };
    expect(parse("coding-agent", { ...base, saveResultAs: "../out.md" }).success).toBe(false);
    expect(parse("coding-agent", { ...base, saveResultAs: "" }).success).toBe(true);
    expect(parse("coding-agent", { ...base, saveResultAs: "requirements.md" }).success).toBe(true);
  });

  it("rejects a Notion target that cannot contain an id", () => {
    expect(parse("notion-append", { target: "my page" }).success).toBe(false);
    expect(parse("notion-append", { target: "https://notion.so/x-1234567890abcdef1234567890abcdef" }).success).toBe(true);
    expect(parse("notion-append", { target: "" }).success).toBe(true);
  });
});

describe("task links", () => {
  it("lower-cases the type so template lookups match", () => {
    const [feature] = h.engine.listWorkflows();
    const task = h.engine.createTask({
      workflowId: feature!.id,
      title: "Linked",
      links: [{ type: "JIRA", value: "KAN-1" }],
    });
    // `{{task.links.jira}}` is an exact lookup; "JIRA" would render empty and skip silently.
    expect(h.engine.getTask(task.id).links).toEqual([{ type: "jira", value: "KAN-1" }]);
  });
});

describe("an autonomous agent with nowhere to work", () => {
  it("refuses to run rather than quietly editing the artifacts folder", async () => {
    const workflowId = h.addWorkflow({
      name: "Autonomous",
      description: "",
      stages: [
        {
          name: "Work",
          phases: [{ name: "Agent", completion: "auto" }],
          bindings: [
            {
              key: "agent",
              label: "Agent",
              trigger: "phase.started",
              phase: "Agent",
              actionType: "coding-agent",
              // ensure-worktree treats "no repository" as nothing to do, so this used to reach the CLI.
              config: { agent: "claude", prompt: "Do the thing", autonomy: "autonomous" },
            },
          ],
        },
      ],
    });
    const task = h.engine.createTask({ workflowId, title: "No repo here" });
    const run = await waitFor(() => h.engine.getTaskDetail(task.id).visits[0]?.runs.find((r) => r.status === "failed"));
    expect(run.error).toContain("no repository");
  });
});

describe("repository validation", () => {
  it("rejects a path that is missing or not a git repository, and lists real branches", async () => {
    const notGit = mkdtempSync(join(tmpdir(), "wm-plain-"));
    try {
      await expect(h.repos.validate(join(notGit, "nope"))).rejects.toThrow(/does not exist/);
      await expect(h.repos.validate(notGit)).rejects.toThrow(/not a git repository/);

      await git(["init", "-b", "main"], { cwd: notGit });
      // A repo with no commits has no branches at all, which needs its own explanation.
      await expect(h.repos.validate(notGit, "main")).rejects.toThrow(/no branches yet/);

      await git(["-c", "user.email=t@t", "-c", "user.name=T", "commit", "--allow-empty", "-m", "first"], { cwd: notGit });
      await expect(h.repos.validate(notGit)).resolves.toBeTruthy();
      expect(await h.repos.branches(notGit)).toEqual(["main"]);

      await expect(h.repos.validate(notGit, "nonexistent")).rejects.toThrow(/is not a branch in that repository/);
      await expect(h.repos.validate(notGit, "main")).resolves.toBeTruthy();
    } finally {
      removeDir(notGit);
    }
  });

  it("offers the repositories tasks already use, flagging any that have gone", () => {
    const [feature] = h.engine.listWorkflows();
    expect(h.repos.list()).toEqual([]);
    h.engine.createTask({ workflowId: feature!.id, title: "One", repoPath: "C:\\code\\gone" });
    h.engine.createTask({ workflowId: feature!.id, title: "Two", repoPath: "C:\\code\\gone" });
    expect(h.repos.list()).toEqual([{ path: "C:\\code\\gone", exists: false }]);
  });
});
