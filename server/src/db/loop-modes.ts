import { CODING_AGENT_ACTION, isLoopMode } from "@wm/shared";
import type { Sqlite } from "./client";

/**
 * Fields every coding agent's config holds explicitly once converted, so the editor never guesses.
 * `requireApproval` is written as the schema's default, which a new action's field default (on) would
 * otherwise contradict.
 */
const LOOP_FIELDS: Record<string, unknown> = {
  requireApproval: false,
  maxCorrections: 3,
  ciCheckCommand: "",
  ciPublishCommand: "",
  ciShell: "default",
  ciTimeoutSec: 1800,
};

type Config = Record<string, unknown>;

/**
 * Before loop modes were explicit, a coding agent's `auto` mode (or no mode at all) inferred its
 * review from other fields: an agent that waited for your approval with "review first" on had a
 * document review if it was read-only or saved an artifact, and a code review otherwise. Each
 * becomes the explicit mode that amounted to; one without that review becomes a single run.
 *
 * The one case that changes is an autonomous agent that saved an artifact: it had a document
 * review of work that edits the repository, and becomes an Implement loop with a code review. That
 * is logged. Runs carry their own copy of the config, so they are converted too and a retry still
 * parses. Converting a converted database changes nothing.
 */
export function convertLoopModes(sqlite: Sqlite, log: (message: string) => void = console.warn): void {
  const pending = (table: string, extra = "") =>
    sqlite
      .prepare(
        `SELECT * FROM ${table} WHERE action_type = ? AND (
          coalesce(json_extract(config, '$.loopMode'), '') NOT IN ('single', 'plan', 'implementation', 'ci')
          OR json_type(config, '$.reviewBeforeApproval') IS NOT NULL
          ${Object.keys(LOOP_FIELDS).map((field) => `OR json_type(config, '$.${field}') IS NULL`).join(" ")}
          ${extra})`,
      )
      .all(CODING_AGENT_ACTION) as { id: string | number; config: string; overrides?: string | null; label: string; workflow_id?: string }[];

  sqlite.transaction(() => {
    const workflowName = sqlite.prepare("SELECT name FROM workflows WHERE id = ?");
    const updateBinding = sqlite.prepare("UPDATE action_bindings SET config = ? WHERE id = ?");
    for (const row of pending("action_bindings")) {
      const { config, documentToCode } = convertLoopConfig(JSON.parse(row.config) as Config);
      updateBinding.run(JSON.stringify(config), row.id);
      if (documentToCode) {
        const workflow = (workflowName.get(row.workflow_id) as { name: string } | undefined)?.name ?? "A workflow";
        log(`${workflow} → ${row.label}: an autonomous agent that saved ${String(config.saveResultAs)} had its work reviewed as a document; it is now an Implement loop, whose reviewer checks and fixes the code`);
      }
    }

    const updateRun = sqlite.prepare("UPDATE action_runs SET config = ?, overrides = ? WHERE id = ?");
    const overridesPending = `OR json_type(overrides, '$.reviewBeforeApproval') IS NOT NULL
      OR (json_type(overrides, '$.loopMode') IS NOT NULL AND json_extract(overrides, '$.loopMode') NOT IN ('single', 'plan', 'implementation', 'ci'))`;
    for (const row of pending("action_runs", overridesPending)) {
      const original = JSON.parse(row.config) as Config;
      const overrides = row.overrides ? (JSON.parse(row.overrides) as Config) : null;
      const config = convertLoopConfig(original).config;
      let convertedOverrides = overrides;
      if (overrides && ("reviewBeforeApproval" in overrides || ("loopMode" in overrides && !isLoopMode(overrides.loopMode)))) {
        const { reviewBeforeApproval: _dropped, ...rest } = overrides;
        convertedOverrides = { ...rest, loopMode: convertLoopConfig({ ...original, ...overrides }).config.loopMode };
      }
      updateRun.run(JSON.stringify(config), convertedOverrides ? JSON.stringify(convertedOverrides) : null, row.id);
    }
  })();
}

/** One coding agent's config with an explicit loop mode, every loop field set, and no `reviewBeforeApproval`. */
export function convertLoopConfig(original: Config): { config: Config; documentToCode: boolean } {
  const { reviewBeforeApproval, ...config } = original;
  let documentToCode = false;
  if (!isLoopMode(config.loopMode)) {
    const autonomous = config.autonomy === "autonomous";
    const reviewed = config.requireApproval === true && reviewBeforeApproval !== false;
    config.loopMode = !reviewed ? "single" : autonomous ? "implementation" : "plan";
    documentToCode = reviewed && autonomous && typeof config.saveResultAs === "string" && config.saveResultAs !== "";
  }
  for (const [field, value] of Object.entries(LOOP_FIELDS)) config[field] ??= value;
  return { config, documentToCode };
}
