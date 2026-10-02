import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type Sqlite } from "../src/db/client";
import { convertLoopModes } from "../src/db/loop-modes";
import { removeDir } from "./helpers";

const dirs: string[] = [];
const open: Sqlite[] = [];
afterEach(() => {
  open.splice(0).forEach((sqlite) => sqlite.close());
  dirs.splice(0).forEach(removeDir);
});

function database(): { file: string; sqlite: Sqlite } {
  const dir = mkdtempSync(join(tmpdir(), "wm-loops-"));
  dirs.push(dir);
  const file = join(dir, "db.sqlite");
  const { sqlite } = openDb(file);
  open.push(sqlite);
  const run = (statement: string, ...params: unknown[]) => sqlite.prepare(statement).run(...params);
  run("INSERT INTO workflows (id, name, description, created_at, updated_at) VALUES ('w', 'Feature', '', 1, 1)");
  run("INSERT INTO stages (id, workflow_id, name, position) VALUES ('s', 'w', 'Build', 0)");
  return { file, sqlite };
}

const OLD_AGENTS: Record<string, Record<string, unknown>> = {
  requirements: { prompt: "p", autonomy: "read-only", saveResultAs: "requirements.md", requireApproval: true },
  readOnlyAnswer: { prompt: "p", autonomy: "read-only", saveResultAs: "", requireApproval: true, loopMode: "auto" },
  implement: { prompt: "p", autonomy: "autonomous", saveResultAs: "", requireApproval: true, reviewBeforeApproval: true },
  autonomousNotes: { prompt: "p", autonomy: "autonomous", saveResultAs: "notes.md", requireApproval: true },
  optedOut: { prompt: "p", autonomy: "autonomous", requireApproval: true, reviewBeforeApproval: false },
  unattended: { prompt: "p", autonomy: "read-only", saveResultAs: "summary.md" },
  ciLoop: { prompt: "p", loopMode: "ci", ciCheckCommand: "npm test", maxCorrections: 5, requireApproval: true },
};

function insertBindings(sqlite: Sqlite) {
  Object.entries(OLD_AGENTS).forEach(([key, config], position) =>
    sqlite
      .prepare("INSERT INTO action_bindings (id, workflow_id, stage_id, key, label, action_type, config, enabled, position) VALUES (?, 'w', 's', ?, ?, 'coding-agent', ?, 1, ?)")
      .run(key, key, key, JSON.stringify(config), position),
  );
}

const configOf = (sqlite: Sqlite, table: string, id: string | number) =>
  JSON.parse((sqlite.prepare(`SELECT config FROM ${table} WHERE id = ?`).get(id) as { config: string }).config) as Record<string, unknown>;

describe("converting coding agents to explicit loop modes", () => {
  it("gives each old agent the mode its review amounted to, and fills in every loop field", () => {
    const { sqlite } = database();
    insertBindings(sqlite);
    const logs: string[] = [];
    convertLoopModes(sqlite, (message) => logs.push(message));

    const mode = (key: string) => configOf(sqlite, "action_bindings", key).loopMode;
    expect(mode("requirements")).toBe("plan");
    expect(mode("readOnlyAnswer")).toBe("plan");
    expect(mode("implement")).toBe("implementation");
    expect(mode("autonomousNotes")).toBe("implementation");
    expect(mode("optedOut")).toBe("single");
    expect(mode("unattended")).toBe("single");
    expect(mode("ciLoop")).toBe("ci");

    // A plan converted from an agent that saved nothing still saves nothing.
    expect(configOf(sqlite, "action_bindings", "readOnlyAnswer").saveResultAs).toBe("");
    expect(configOf(sqlite, "action_bindings", "implement")).not.toHaveProperty("reviewBeforeApproval");
    expect(configOf(sqlite, "action_bindings", "unattended")).toMatchObject({
      requireApproval: false, maxCorrections: 3, ciCheckCommand: "", ciPublishCommand: "", ciShell: "default", ciTimeoutSec: 1800,
    });
    // What was already set is kept.
    expect(configOf(sqlite, "action_bindings", "ciLoop")).toMatchObject({ maxCorrections: 5, ciCheckCommand: "npm test" });

    // Only the agent whose review changes kind is worth a word.
    expect(logs).toEqual([expect.stringContaining("Feature → autonomousNotes")]);
  });

  it("converts runs' own copies and retry overrides, so an old run can still be retried", () => {
    const { sqlite } = database();
    insertBindings(sqlite);
    const run = (statement: string, ...params: unknown[]) => sqlite.prepare(statement).run(...params);
    run("INSERT INTO tasks (id, workflow_id, title, description, links, tags, status, current_stage_id, current_visit_id, created_at, updated_at) VALUES ('t', 'w', 'Task', '', '[]', '[]', 'active', 's', 'v', 1, 1)");
    run("INSERT INTO stage_visits (id, task_id, stage_id, stage_name, attempt, entered_at) VALUES ('v', 't', 's', 'Build', 1, 1)");
    const id = run(
      "INSERT INTO action_runs (task_id, visit_id, binding_id, binding_key, label, action_type, config, overrides, batch_id, batch_position, status, created_at) VALUES ('t', 'v', 'implement', 'implement', 'implement', 'coding-agent', ?, ?, 'b', 0, 'failed', 1)",
      JSON.stringify(OLD_AGENTS.implement), JSON.stringify({ model: "gpt-5", reviewBeforeApproval: false }),
    ).lastInsertRowid;

    convertLoopModes(sqlite, () => {});
    expect(configOf(sqlite, "action_runs", Number(id)).loopMode).toBe("implementation");
    const overrides = JSON.parse((sqlite.prepare("SELECT overrides FROM action_runs WHERE id = ?").get(id) as { overrides: string }).overrides);
    // The retry asked for no review, so it runs once.
    expect(overrides).toEqual({ model: "gpt-5", loopMode: "single" });
  });

  it("changes nothing on a database it has already converted", () => {
    const { file, sqlite } = database();
    insertBindings(sqlite);
    convertLoopModes(sqlite, () => {});
    const before = sqlite.prepare("SELECT id, config FROM action_bindings ORDER BY id").all();
    sqlite.close();
    open.pop();

    // Opening the database runs the conversion again.
    const { sqlite: reopened } = openDb(file);
    open.push(reopened);
    const logs: string[] = [];
    convertLoopModes(reopened, (message) => logs.push(message));
    expect(reopened.prepare("SELECT id, config FROM action_bindings ORDER BY id").all()).toEqual(before);
    expect(logs).toEqual([]);
  });
});
