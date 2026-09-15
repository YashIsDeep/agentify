import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/client";
import { flattenPhases } from "../src/db/flatten-phases";
import { removeDir } from "./helpers";

const MIGRATIONS = fileURLToPath(new URL("../drizzle", import.meta.url));
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(removeDir));

/** A database migrated only as far as the last migration that still had phases. */
function oldDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), "wm-migrate-"));
  dirs.push(dir);
  const folder = join(dir, "drizzle");
  mkdirSync(join(folder, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const cut = journal.entries.findIndex((entry) => entry.tag.startsWith("0007_"));
  journal.entries = journal.entries.slice(0, cut);
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify(journal));
  for (const file of readdirSync(MIGRATIONS)) {
    if (journal.entries.some((entry) => file === `${entry.tag}.sql`)) copyFileSync(join(MIGRATIONS, file), join(folder, file));
  }

  const file = join(dir, "db.sqlite");
  const sqlite = new Database(file);
  sqlite.pragma("foreign_keys = ON");
  migrate(drizzle({ client: sqlite }), { migrationsFolder: folder });

  const run = (statement: string, ...params: unknown[]) => sqlite.prepare(statement).run(...params);
  const binding = (id: string, stage: string, key: string, trigger: string, type: string, config: object, extra: { phase?: string; after?: string; askFeedback?: boolean } = {}) =>
    run(
      "INSERT INTO action_bindings (id, workflow_id, stage_id, phase_id, after_binding_id, key, label, trigger, action_type, config, enabled, ask_feedback, position) VALUES (?, 'w', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0)",
      id, stage, extra.phase ?? null, extra.after ?? null, key, key, trigger, type, JSON.stringify(config), extra.askFeedback ? 1 : 0,
    );

  run("INSERT INTO workflows (id, name, description, created_at, updated_at) VALUES ('w', 'Old', '', 1, 1)");
  run("INSERT INTO stages (id, workflow_id, name, position) VALUES ('backlog', 'w', 'Backlog', 0), ('build', 'w', 'Build', 1)");
  run("INSERT INTO phases (id, stage_id, name, position, completion) VALUES ('generate', 'build', 'Generate', 0, 'auto'), ('check', 'build', 'Approve requirements', 1, 'manual')");
  binding("next", "backlog", "next", "stage.completed", "move-stage", { target: "next" });
  binding("exitHook", "build", "exitHook", "stage.exited", "shell", { command: "echo bye" });
  binding("compile", "build", "compile", "phase.started", "shell", { command: "make" }, { phase: "generate" });
  binding("notify", "build", "notify", "action.succeeded", "shell", { command: "echo built" }, { after: "compile" });
  binding("enter", "build", "enter", "stage.entered", "shell", { command: "echo hi" });
  binding("sendBack", "build", "sendBack", "manual", "move-stage", { target: "backlog" }, { askFeedback: true });
  binding("done", "build", "done", "stage.completed", "move-stage", { target: "next" });

  // A task mid-way through Build, with an action running and one left behind by an earlier failure.
  run("INSERT INTO tasks (id, workflow_id, title, description, links, tags, status, current_stage_id, current_visit_id, created_at, updated_at) VALUES ('t', 'w', 'Task', '', '[]', '[]', 'active', 'build', 'v1', 1, 1)");
  run("INSERT INTO stage_visits (id, task_id, stage_id, stage_name, attempt, entered_at) VALUES ('v1', 't', 'build', 'Build', 1, 1)");
  run("INSERT INTO phase_states (id, visit_id, phase_id, name, position, completion, status) VALUES ('ps1', 'v1', 'generate', 'Generate', 0, 'auto', 'running')");
  const runRow = (status: string) =>
    run(
      "INSERT INTO action_runs (task_id, visit_id, phase_state_id, binding_id, binding_key, label, action_type, trigger, config, batch_id, batch_position, status, created_at) VALUES ('t', 'v1', 'ps1', 'compile', 'compile', 'compile', 'shell', 'phase.started', '{}', 'b', ?, ?, 1)",
      status === "running" ? 0 : 1,
      status,
    );
  runRow("running");
  runRow("skipped");
  sqlite.close();
  return file;
}

describe("migrating phases to ordered actions", () => {
  it("flattens each stage into one list, keeps history, and restarts active tasks' stages", () => {
    const file = oldDatabase();
    const logs: string[] = [];
    const sqlite = new Database(file);
    sqlite.pragma("foreign_keys = ON");
    flattenPhases(sqlite, (message) => logs.push(message));
    sqlite.close();

    const { sqlite: migrated } = openDb(file);
    try {
      const list = (stage: string) =>
        migrated
          .prepare("SELECT key, action_type, enabled, config FROM action_bindings WHERE stage_id = ? ORDER BY position")
          .all(stage) as { key: string; action_type: string; enabled: number; config: string }[];

      expect(list("backlog").map((b) => [b.key, b.action_type])).toEqual([
        ["completeBacklog", "approval"],
        ["next", "move-stage"],
      ]);
      const build = list("build");
      expect(build.map((b) => [b.key, b.action_type, b.enabled])).toEqual([
        ["enter", "shell", 1],
        ["compile", "shell", 1],
        ["notify", "shell", 1],
        ["approveRequirements", "approval", 1],
        ["done", "move-stage", 1],
        ["exitHook", "shell", 0],
      ]);
      expect(JSON.parse(build[3]!.config)).toEqual({ instructions: "", sendBackTo: "backlog", askForNote: true });
      expect(logs.some((line) => line.includes('"sendBack" is now the Send back button of "Approve requirements"'))).toBe(true);
      expect(logs.some((line) => line.includes('"exitHook" ran on "stage.exited"'))).toBe(true);

      const tables = (migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
      expect(tables).not.toContain("phases");
      expect(tables).not.toContain("phase_states");

      const task = migrated.prepare("SELECT current_visit_id FROM tasks WHERE id = 't'").get() as { current_visit_id: string };
      expect(task.current_visit_id).not.toBe("v1");
      const visit = migrated.prepare("SELECT attempt FROM stage_visits WHERE id = ?").get(task.current_visit_id) as { attempt: number };
      expect(visit.attempt).toBe(2);
      const runs = migrated.prepare("SELECT status, continue_on_failure FROM action_runs WHERE visit_id = 'v1' ORDER BY id").all();
      expect(runs).toEqual([
        { status: "cancelled", continue_on_failure: 0 },
        { status: "cancelled", continue_on_failure: 0 },
      ]);
    } finally {
      migrated.close();
    }

    // Opening it again changes nothing.
    const { sqlite: again } = openDb(file);
    expect((again.prepare("SELECT count(*) AS n FROM action_bindings").get() as { n: number }).n).toBe(8);
    again.close();
  });
});
