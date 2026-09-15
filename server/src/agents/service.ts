import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_IDS,
  type AgentId,
  type AgentModelList,
  type AgentStatus,
  type AgentTestResult,
  type AgentDefaults,
  effortsFor,
  NO_AGENT_DEFAULTS,
  resolveAgentChoice,
} from "@wm/shared";
import { EngineError } from "../engine/engine";
import type { SettingsStore } from "../services/settings";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { cursorAdapter } from "./cursor";
import { opencodeAdapter } from "./opencode";
import { resolveCli } from "./resolve";
import { runAgent } from "./run";
import type { AgentAdapter, ModelCatalog, ResolvedCli } from "./types";

export const DEFAULT_ADAPTERS: AgentAdapter[] = [claudeAdapter, codexAdapter, opencodeAdapter, cursorAdapter];

interface AgentSettings {
  paths: Partial<Record<AgentId, string>>;
  defaults?: Partial<Record<AgentId, AgentDefaults>>;
}

const SETTINGS_KEY = "agents";
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class AgentService {
  private readonly adapters: Map<AgentId, AgentAdapter>;
  private readonly modelCache = new Map<AgentId, AgentModelList>();
  /**
   * When each agent's usage limit lifts, as its last limited run reported. Kept in memory: after a
   * restart the next run just finds out again, and parked runs carry their own time.
   */
  private readonly quotaHolds = new Map<AgentId, number>();

  constructor(
    private readonly settings: SettingsStore,
    adapters: AgentAdapter[] = DEFAULT_ADAPTERS,
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }

  adapter(id: AgentId): AgentAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new EngineError(`Unknown agent "${id}"`, 404);
    return adapter;
  }

  pathOverride(id: AgentId): string | null {
    return this.settings.get<AgentSettings>(SETTINGS_KEY, { paths: {} }).paths[id] ?? null;
  }

  setPathOverride(id: AgentId, path: string | null): void {
    this.adapter(id);
    if (path !== null && !existsSync(path)) throw new EngineError(`${path} does not exist`);
    const current = this.settings.get<AgentSettings>(SETTINGS_KEY, { paths: {} });
    const paths = { ...current.paths };
    if (path === null) delete paths[id];
    else paths[id] = path;
    this.settings.set(SETTINGS_KEY, { ...current, paths });
    this.modelCache.delete(id); // A different executable may accept different models.
  }

  defaults(id: AgentId): AgentDefaults {
    return this.settings.get<AgentSettings>(SETTINGS_KEY, { paths: {} }).defaults?.[id] ?? NO_AGENT_DEFAULTS;
  }

  /** Checked like any other choice: a bad default would otherwise break every run that relies on it. */
  async setDefaults(id: AgentId, input: { model: string | null; effort: string | null }): Promise<void> {
    this.adapter(id);
    const model = input.model?.trim() || null;
    const effort = input.effort?.trim() || null;
    const error = await this.validateChoice(id, model, effort);
    if (error) throw new EngineError(error);
    const current = this.settings.get<AgentSettings>(SETTINGS_KEY, { paths: {} });
    const defaults = { ...current.defaults };
    if (model || effort) defaults[id] = { model, effort };
    else delete defaults[id];
    this.settings.set(SETTINGS_KEY, { ...current, defaults });
  }

  /** When this agent's usage limit lifts, or null when no run has hit one that is still in effect. */
  quotaHold(id: AgentId, now = Date.now()): number | null {
    const until = this.quotaHolds.get(id);
    if (until === undefined || until <= now) {
      this.quotaHolds.delete(id);
      return null;
    }
    return until;
  }

  setQuotaHold(id: AgentId, until: number): void {
    this.quotaHolds.set(id, until);
  }

  clearQuotaHold(id: AgentId): void {
    this.quotaHolds.delete(id);
  }

  /** Resolves the executable or throws an error that tells the user how to fix it. */
  resolve(id: AgentId): ResolvedCli {
    const adapter = this.adapter(id);
    const cli = resolveCli(adapter.binName, this.pathOverride(id), adapter.installLocations);
    if (!cli) {
      throw new Error(`${adapter.label} is not installed. Install it with \`${adapter.installCommand}\` or set its path in Agents settings.`);
    }
    return cli;
  }

  async status(id: AgentId): Promise<AgentStatus> {
    const adapter = this.adapter(id);
    const override = this.pathOverride(id);
    const base = {
      id,
      label: adapter.label,
      pathOverride: override,
      installCommand: adapter.installCommand,
      loginCommand: adapter.loginCommand,
      modelHints: adapter.modelHints,
      defaultModel: this.defaults(id).model,
      defaultEffort: this.defaults(id).effort,
    };
    let cli: ResolvedCli | null;
    try {
      cli = resolveCli(adapter.binName, override, adapter.installLocations);
    } catch (err) {
      return { ...base, installed: false, path: override, version: null, loggedIn: null, authDetail: null, error: errorMessage(err) };
    }
    if (!cli) return { ...base, installed: false, path: null, version: null, loggedIn: null, authDetail: null, error: null };

    const [version, auth] = await Promise.all([
      adapter.version(cli).catch(() => null),
      adapter.auth(cli).catch((err: unknown) => ({ loggedIn: null, detail: errorMessage(err) })),
    ]);
    return {
      ...base,
      installed: true,
      path: cli.path,
      version,
      loggedIn: auth.loggedIn,
      authDetail: auth.detail,
      error: version ? null : "Could not read the version. Is this the right executable?",
    };
  }

  statuses(): Promise<AgentStatus[]> {
    return Promise.all([...this.adapters.keys()].map((id) => this.status(id)));
  }

  /**
   * Models and effort levels each agent accepts. Codex and OpenCode enumerate their own (Codex's
   * catalog follows the account, OpenCode's the providers the user configured); Claude falls back
   * to its documented aliases. Cached for the process: the lookup spawns a CLI, and the answer
   * changes about as often as the CLI is upgraded.
   */
  async models(id: AgentId): Promise<AgentModelList> {
    const cached = this.modelCache.get(id);
    if (cached) return cached;

    const adapter = this.adapter(id);
    let catalog: ModelCatalog | null = null;
    if (adapter.listModels) {
      try {
        catalog = await adapter.listModels(resolveCli(adapter.binName, this.pathOverride(id), adapter.installLocations)!);
      } catch {
        catalog = null; // Not installed, or the CLI has no such command; the fallback still works.
      }
    }
    const list: AgentModelList = catalog
      ? { agent: id, models: catalog.models, modelEfforts: catalog.modelEfforts, efforts: catalog.efforts, source: "cli" }
      : { agent: id, models: adapter.modelHints, modelEfforts: {}, efforts: adapter.effortHints, source: "builtin" };
    this.modelCache.set(id, list);
    return list;
  }

  allModels(): Promise<AgentModelList[]> {
    return Promise.all([...this.adapters.keys()].map((id) => this.models(id)));
  }

  /**
   * Explains why a model is unusable, or returns null when it is fine. Blank means "the CLI's
   * own default". Checked when a workflow is saved and again before a run, so a typo can never
   * reach the CLI and fail halfway through a workflow.
   */
  async validateModel(id: AgentId, model: string | null | undefined): Promise<string | null> {
    const wanted = (model ?? "").trim();
    if (!wanted) return null;
    const adapter = this.adapter(id);
    const { models } = await this.models(id);
    if (models.includes(wanted) || adapter.modelPattern?.test(wanted)) return null;
    const suggestions = models.slice(0, 6).join(", ");
    return `“${wanted}” is not a ${adapter.label} model. Try ${suggestions}${models.length > 6 ? ", …" : ""}, or leave it blank for the CLI default.`;
  }

  /**
   * An effort level belongs to a model: Codex and OpenCode declare levels per model, so one that
   * suits the action's model can be wrong for an override's. Blank means the model's own default.
   */
  async validateEffort(id: AgentId, model: string | null | undefined, effort: string | null | undefined): Promise<string | null> {
    const wanted = (effort ?? "").trim();
    if (!wanted) return null;
    const adapter = this.adapter(id);
    const levels = effortsFor(await this.models(id), model);
    if (levels.includes(wanted)) return null;
    const chosen = (model ?? "").trim();
    if (levels.length === 0) {
      return chosen
        ? `“${chosen}” has no reasoning-effort levels to choose from, so leave effort blank.`
        : `${adapter.label} only knows effort levels per model. Choose a model, or leave effort blank.`;
    }
    const subject = chosen ? `“${chosen}”` : adapter.label;
    return `“${wanted}” is not a reasoning-effort level ${subject} supports. Try ${levels.join(", ")}, or leave it blank for the model's default.`;
  }

  /** The model, then the effort level for that model. */
  async validateChoice(id: AgentId, model: string | null | undefined, effort: string | null | undefined): Promise<string | null> {
    return (await this.validateModel(id, model)) ?? (await this.validateEffort(id, model, effort));
  }

  /**
   * Validates a model and effort when the agent may not be pinned down. A task-level override
   * applies to every coding-agent action, whose agents can differ, so with no agent chosen the
   * pair only has to be accepted by *some* agent — enough to catch a typo, without second-guessing
   * which action it was meant for.
   */
  async validateChoiceFor(
    agent: string | null | undefined,
    model: string | null | undefined,
    effort: string | null | undefined,
  ): Promise<string | null> {
    const wantedModel = (model ?? "").trim();
    const wantedEffort = (effort ?? "").trim();
    if (!wantedModel && !wantedEffort) return null;
    if (agent && AGENT_IDS.includes(agent as AgentId)) return this.validateChoice(agent as AgentId, wantedModel, wantedEffort);

    const ids = [...this.adapters.keys()];
    const errors = await Promise.all(ids.map((id) => this.validateChoice(id, wantedModel, wantedEffort)));
    if (errors.some((error) => error === null)) return null;
    const modelErrors = await Promise.all(ids.map((id) => this.validateModel(id, wantedModel)));
    if (modelErrors.every((error) => error !== null)) {
      const known = (await this.allModels()).flatMap((list) => list.models).slice(0, 6).join(", ");
      return `“${wantedModel}” is not a model any installed agent accepts. Try ${known}, or leave it blank.`;
    }
    return `No agent accepts reasoning effort “${wantedEffort}”${wantedModel ? ` with “${wantedModel}”` : ""}. Choose an agent, or leave effort blank.`;
  }

  /** Sends a tiny read-only prompt in a throwaway directory. A blank model or effort uses the saved default. */
  async test(id: AgentId, wanted: { model?: string; effort?: string } = {}): Promise<AgentTestResult> {
    const started = Date.now();
    const { model, effort } = resolveAgentChoice([{ agent: id, ...wanted }], (agent) => this.defaults(agent));
    const error = await this.validateChoice(id, model, effort);
    if (error) return { ok: false, text: "", error, durationMs: 0, usage: null };
    const dir = mkdtempSync(join(tmpdir(), "wm-agent-test-"));
    try {
      const result = await runAgent({
        adapter: this.adapter(id),
        cli: this.resolve(id),
        invocation: {
          prompt: "Reply with exactly the word pong and nothing else.",
          model,
          effort,
          autonomy: "read-only",
          resumeSessionId: null,
          cwd: dir,
          scratchDir: join(dir, ".wm"),
        },
        inactivityTimeoutMs: 90_000,
        timeoutMs: 180_000,
      });
      return { ok: result.ok, text: result.text, error: result.error, durationMs: Date.now() - started, usage: result.usage };
    } catch (err) {
      return { ok: false, text: "", error: errorMessage(err), durationMs: Date.now() - started, usage: null };
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
  }
}
