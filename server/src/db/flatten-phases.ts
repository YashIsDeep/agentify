import { randomUUID } from "node:crypto";
import { APPROVAL_ACTION, BINDING_KEY_PATTERN } from "@wm/shared";
import type { Sqlite } from "./client";

/** Written to `action_bindings.trigger` once a row has been placed in its stage's list. */
const FLATTENED = "sequence";

interface OldBinding {
  id: string;
  workflow_id: string;
  stage_id: string;
  phase_id: string | null;
  after_binding_id: string | null;
  key: string;
  label: string;
  trigger: string;
  action_type: string;
  config: string;
  enabled: number;
  ask_feedback: number;
  position: number;
}

interface OldPhase {
  id: string;
  stage_id: string;
  name: string;
  completion: "auto" | "manual";
}

type Item =
  | { kind: "existing"; row: OldBinding; enabled: boolean }
  | { kind: "approval"; id: string; key: string; label: string; config: { instructions: string; sendBackTo: string; askForNote: boolean } };

/**
 * The data half of migration 0007, which replaced phases and triggers with one ordered list of
 * actions per stage. It runs before the schema migration because that migration drops the tables
 * and columns it reads; on a database that never had phases (or was already converted) it does nothing.
 *
 * Each stage's list is built in the order things used to happen: entry actions, then per phase its
 * start actions, an Approval where the phase waited for you, and its completion actions, then the
 * stage's completion actions. An `action.succeeded` chain goes straight after the action it followed,
 * a manual Send back becomes the preceding approval's Send back, and anything left over (exit hooks,
 * failure chains, other buttons) is kept at the end of the list switched off, and logged.
 *
 * Active tasks restart their current stage as a new attempt with nothing started, since their old
 * runs belonged to phases that no longer exist.
 */
export function flattenPhases(sqlite: Sqlite, log: (message: string) => void = console.warn): void {
  const hasTable = (name: string) =>
    sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  if (!hasTable("phases") || !hasTable("action_bindings")) return;
  const bindingColumns = (sqlite.prepare("PRAGMA table_info(action_bindings)").all() as { name: string }[]).map((c) => c.name);
  if (!bindingColumns.includes("trigger")) return;

  sqlite.transaction(() => {
    flattenWorkflows(sqlite, log);
    restartActiveTasks(sqlite, log);
  })();
}

function flattenWorkflows(sqlite: Sqlite, log: (message: string) => void): void {
  const pending = sqlite.prepare("SELECT count(*) AS n FROM action_bindings WHERE trigger <> ?").get(FLATTENED) as { n: number };
  const phaseCount = sqlite.prepare("SELECT count(*) AS n FROM phases").get() as { n: number };
  if (pending.n === 0 && phaseCount.n === 0) return;

  const workflows = sqlite.prepare("SELECT id, name FROM workflows").all() as { id: string; name: string }[];
  const insert = sqlite.prepare(
    `INSERT INTO action_bindings (id, workflow_id, stage_id, phase_id, after_binding_id, key, label, trigger, action_type, config, enabled, ask_feedback, position)
     VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, 1, 0, ?)`,
  );
  const place = sqlite.prepare(
    "UPDATE action_bindings SET position = ?, trigger = ?, phase_id = NULL, after_binding_id = NULL, enabled = ?, config = ? WHERE id = ?",
  );

  for (const workflow of workflows) {
    const stages = sqlite.prepare("SELECT id, name FROM stages WHERE workflow_id = ? ORDER BY position").all(workflow.id) as {
      id: string;
      name: string;
    }[];
    const bindings = sqlite
      .prepare("SELECT * FROM action_bindings WHERE workflow_id = ? ORDER BY position")
      .all(workflow.id) as OldBinding[];
    const keys = new Set(bindings.map((binding) => binding.key));
    const stageIds = new Set(stages.map((stage) => stage.id));

    // Chains are rebuilt from memory; clear them first so deleting a folded row can't cascade to its followers.
    sqlite.prepare("UPDATE action_bindings SET after_binding_id = NULL WHERE workflow_id = ?").run(workflow.id);

    for (const stage of stages) {
      const where = `${workflow.name} → ${stage.name}`;
      const own = bindings.filter((binding) => binding.stage_id === stage.id && binding.trigger !== FLATTENED);
      const phases = sqlite.prepare("SELECT id, stage_id, name, completion FROM phases WHERE stage_id = ? ORDER BY position").all(stage.id) as OldPhase[];
      if (own.length === 0 && phases.length === 0) continue;

      const on = (trigger: string, phaseId?: string) =>
        own.filter((binding) => binding.trigger === trigger && (phaseId === undefined || binding.phase_id === phaseId));
      const existing = (row: OldBinding): Item => ({ kind: "existing", row, enabled: row.enabled === 1 });
      const approval = (name: string): Extract<Item, { kind: "approval" }> => ({
        kind: "approval",
        id: randomUUID(),
        key: uniqueKey(keys, name),
        label: name,
        config: { instructions: "", sendBackTo: "", askForNote: true },
      });

      // Already-flattened rows (a rerun after a partial conversion) keep their place at the top.
      const list: Item[] = bindings.filter((b) => b.stage_id === stage.id && b.trigger === FLATTENED).map(existing);
      const approvalOfPhase = new Map<string, Extract<Item, { kind: "approval" }>>();

      list.push(...on("stage.entered").map(existing));
      for (const phase of phases) {
        const started = on("phase.started", phase.id);
        list.push(...started.map(existing));
        // An auto phase with nothing enabled to run never finished on its own either.
        if (phase.completion === "manual" || !started.some((binding) => binding.enabled === 1)) {
          const gate = approval(phase.name);
          approvalOfPhase.set(phase.id, gate);
          list.push(gate);
        }
        list.push(...on("phase.completed", phase.id).map(existing));
      }
      const completed = on("stage.completed");
      // A stage without phases only ran these when you pressed Complete stage.
      if (phases.length === 0 && completed.length > 0) list.push(approval(`Complete ${stage.name}`));
      list.push(...completed.map(existing));

      const leftovers: OldBinding[] = [...on("stage.exited"), ...on("action.failed")];

      for (const button of on("manual")) {
        const target = typeof parseConfig(button.config).target === "string" ? (parseConfig(button.config).target as string) : "";
        const gate =
          (button.phase_id ? approvalOfPhase.get(button.phase_id) : undefined) ??
          [...list].reverse().find((item): item is Extract<Item, { kind: "approval" }> => item.kind === "approval");
        const foldable = button.action_type === "move-stage" && stageIds.has(target) && gate && !gate.config.sendBackTo;
        if (foldable) {
          gate.config.sendBackTo = target;
          gate.config.askForNote = button.ask_feedback === 1;
          sqlite.prepare("DELETE FROM action_bindings WHERE id = ?").run(button.id);
          log(`${where}: "${button.label}" is now the Send back button of "${gate.label}".`);
        } else {
          leftovers.push(button);
        }
      }

      // A success chain ran right after the action it followed, which is exactly the next place in the list.
      let chains = on("action.succeeded");
      for (let progress = true; progress && chains.length > 0; ) {
        progress = false;
        for (const chain of [...chains]) {
          const parent = list.findIndex((item) => item.kind === "existing" && item.row.id === chain.after_binding_id);
          if (parent < 0) continue;
          let at = parent + 1;
          while (at < list.length && isChildOf(list[at]!, chain.after_binding_id)) at++;
          list.splice(at, 0, existing(chain));
          chains = chains.filter((candidate) => candidate !== chain);
          progress = true;
        }
      }
      leftovers.push(...chains);

      for (const row of leftovers) {
        list.push({ kind: "existing", row, enabled: false });
        log(`${where}: "${row.label}" ran on "${row.trigger}", which no longer exists; kept at the end of the list, switched off.`);
      }

      list.forEach((item, position) => {
        if (item.kind === "approval") {
          insert.run(item.id, workflow.id, stage.id, item.key, item.label, FLATTENED, APPROVAL_ACTION, JSON.stringify(item.config), position);
        } else {
          place.run(position, FLATTENED, item.enabled ? 1 : 0, item.row.config, item.row.id);
        }
      });
    }
  }

  // Nothing references phases any more; emptying the table keeps a rerun from adding approvals twice.
  sqlite.prepare("UPDATE action_bindings SET phase_id = NULL").run();
  sqlite.prepare("DELETE FROM phases").run();
}

function restartActiveTasks(sqlite: Sqlite, log: (message: string) => void): void {
  const now = Date.now();
  // "skipped" used to mean "not run because an earlier action failed"; it now means you skipped past a failure.
  sqlite
    .prepare("UPDATE action_runs SET status = 'cancelled', error = coalesce(error, 'Skipped after an earlier action failed') WHERE status = 'skipped'")
    .run();

  const tasks = sqlite
    .prepare("SELECT id, current_stage_id, current_visit_id FROM tasks WHERE status = 'active' AND current_visit_id IS NOT NULL")
    .all() as { id: string; current_stage_id: string; current_visit_id: string }[];
  for (const task of tasks) {
    const visit = sqlite.prepare("SELECT * FROM stage_visits WHERE id = ?").get(task.current_visit_id) as
      | { id: string; stage_id: string; stage_name: string }
      | undefined;
    if (!visit) continue;
    const touched =
      sqlite.prepare("SELECT 1 FROM phase_states WHERE visit_id = ? LIMIT 1").get(visit.id) !== undefined ||
      sqlite.prepare("SELECT 1 FROM action_runs WHERE visit_id = ? LIMIT 1").get(visit.id) !== undefined;
    if (!touched) continue;

    sqlite
      .prepare(
        `UPDATE action_runs SET status = 'cancelled', ended_at = ?, error = 'Stopped when phases were replaced by a list of actions'
         WHERE visit_id = ? AND status IN ('waiting', 'queued', 'running', 'quota-wait')`,
      )
      .run(now, visit.id);
    sqlite.prepare("UPDATE stage_visits SET exited_at = ? WHERE id = ? AND exited_at IS NULL").run(now, visit.id);
    const { n } = sqlite.prepare("SELECT count(*) AS n FROM stage_visits WHERE task_id = ? AND stage_id = ?").get(task.id, visit.stage_id) as {
      n: number;
    };
    const visitId = randomUUID();
    sqlite
      .prepare("INSERT INTO stage_visits (id, task_id, stage_id, stage_name, attempt, entered_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(visitId, task.id, visit.stage_id, visit.stage_name, n + 1, now);
    sqlite.prepare("UPDATE tasks SET current_visit_id = ?, updated_at = ? WHERE id = ?").run(visitId, now, task.id);
    sqlite
      .prepare("INSERT INTO timeline_events (task_id, visit_id, run_id, type, message, data, at) VALUES (?, ?, NULL, 'stage.entered', ?, NULL, ?)")
      .run(task.id, visitId, `Restarted ${visit.stage_name}: its phases are now a list of actions. Press Start to run them.`, now);
    log(`Task ${task.id}: restarted ${visit.stage_name} with its actions not started.`);
  }
}

function isChildOf(item: Item, parentId: string | null): boolean {
  return item.kind === "existing" && item.row.trigger === "action.succeeded" && item.row.after_binding_id === parentId;
}

function parseConfig(config: string): Record<string, unknown> {
  try {
    const value = JSON.parse(config) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** "Approve requirements" → "approveRequirements", made unique among the workflow's keys. */
function uniqueKey(taken: Set<string>, name: string): string {
  const camel = name
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word, index) => (index === 0 ? word.toLowerCase() : word[0]!.toUpperCase() + word.slice(1)))
    .join("");
  const base = BINDING_KEY_PATTERN.test(camel) ? camel : `approval${camel}`;
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}${n}`;
  taken.add(key);
  return key;
}
