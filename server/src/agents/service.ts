import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_IDS, type AgentId, type AgentModelList, type AgentStatus, type AgentTestResult } from "@wm/shared";
import { EngineError } from "../engine/engine";
import type { SettingsStore } from "../services/settings";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { opencodeAdapter } from "./opencode";
import { resolveCli } from "./resolve";
import { runAgent } from "./run";
import type { AgentAdapter, ResolvedCli } from "./types";

export const DEFAULT_ADAPTERS: AgentAdapter[] = [claudeAdapter, codexAdapter, opencodeAdapter];

interface AgentSettings {
  paths: Partial<Record<AgentId, string>>;
}

const SETTINGS_KEY = "agents";
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class AgentService {
  private readonly adapters: Map<AgentId, AgentAdapter>;
  private readonly modelCache = new Map<AgentId, AgentModelList>();

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

  /** Resolves the executable or throws an error that tells the user how to fix it. */
  resolve(id: AgentId): ResolvedCli {
    const adapter = this.adapter(id);
    const cli = resolveCli(adapter.binName, this.pathOverride(id));
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
    };
    let cli: ResolvedCli | null;
    try {
      cli = resolveCli(adapter.binName, override);
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
   * Models each agent accepts. OpenCode can enumerate its own (the provider set is whatever the
   * user configured), the others fall back to their known aliases. Cached for the process: the
   * lookup spawns a CLI, and the answer changes about as often as the CLI is upgraded.
   */
  async models(id: AgentId): Promise<AgentModelList> {
    const cached = this.modelCache.get(id);
    if (cached) return cached;

    const adapter = this.adapter(id);
    let models: string[] | null = null;
    if (adapter.listModels) {
      try {
        models = await adapter.listModels(resolveCli(adapter.binName, this.pathOverride(id))!);
      } catch {
        models = null; // Not installed, or the CLI has no such command; the fallback still works.
      }
    }
    const list: AgentModelList = models
      ? { agent: id, models, source: "cli" }
      : { agent: id, models: adapter.modelHints, source: "builtin" };
    this.modelCache.set(id, list);
    return list;
  }

  allModels(): Promise<AgentModelList[]> {
    return Promise.all([...this.adapters.keys()].map((id) => this.models(id)));
  }

  /**
   * Explains why a model is unusable, or returns null when it is fine. Blank means "the CLI's
   * own default". Checked when a template is saved and again before a run, so a typo can never
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
   * Validates a model when the agent may not be pinned down. A task-level override applies to
   * every coding-agent action, whose agents can differ, so with no agent chosen the model only
   * has to be accepted by *some* agent — enough to catch a typo, without second-guessing which
   * action it was meant for.
   */
  async validateModelFor(agent: string | null | undefined, model: string | null | undefined): Promise<string | null> {
    const wanted = (model ?? "").trim();
    if (!wanted) return null;
    if (agent && AGENT_IDS.includes(agent as AgentId)) return this.validateModel(agent as AgentId, wanted);

    const errors = await Promise.all([...this.adapters.keys()].map((id) => this.validateModel(id, wanted)));
    if (errors.some((error) => error === null)) return null;
    const known = (await this.allModels()).flatMap((list) => list.models).slice(0, 6).join(", ");
    return `“${wanted}” is not a model any installed agent accepts. Try ${known}, or leave it blank.`;
  }

  /** Sends a tiny read-only prompt in a throwaway directory. */
  async test(id: AgentId, model?: string): Promise<AgentTestResult> {
    const started = Date.now();
    const dir = mkdtempSync(join(tmpdir(), "wm-agent-test-"));
    try {
      const result = await runAgent({
        adapter: this.adapter(id),
        cli: this.resolve(id),
        invocation: {
          prompt: "Reply with exactly the word pong and nothing else.",
          model: model?.trim() || null,
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
