import type { AgentId, AgentUsage, Autonomy } from "@wm/shared";

/** How to launch a CLI without a shell: `command ...prefixArgs ...args`. */
export interface ResolvedCli {
  command: string;
  prefixArgs: string[];
  /** The file that was resolved (shown in settings). */
  path: string;
}

export interface AgentInvocation {
  prompt: string;
  model: string | null;
  /** Reasoning-effort level; null leaves it to the model. */
  effort: string | null;
  autonomy: Autonomy;
  resumeSessionId: string | null;
  cwd: string;
  /** Private directory for this run (result files etc.). */
  scratchDir: string;
  /** MCP endpoint offering the ask-the-user tool; null when the agent can't reach one. */
  askUserUrl?: string | null;
}

export interface ModelCatalog {
  models: string[];
  /** Levels per model; a model without any maps to an empty list. */
  modelEfforts: Record<string, string[]>;
  /** Levels to offer with no model chosen. */
  efforts: string[];
}

export interface SpawnSpec {
  args: string[];
  stdin?: string;
  /** File the CLI writes its final message to, if it supports one. */
  resultFile?: string;
}

export type AgentEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "message"; text: string }
  /** `id` pairs a completed/failed event with the started one, so the chat view can nest them. */
  | { kind: "tool"; name: string; status: "started" | "completed" | "failed"; detail?: string; id?: string }
  /** Cumulative usage so far. */
  | { kind: "usage"; usage: AgentUsage }
  | { kind: "error"; message: string }
  /** The subscription's usage limit refused a request; `resetAt` is null when the CLI didn't say when it lifts. */
  | { kind: "limit"; resetAt: number | null }
  | { kind: "final"; ok: boolean; text: string; error?: string }
  /** A line that wasn't a recognised event. */
  | { kind: "raw"; text: string };

export interface AgentParser {
  push(line: string): AgentEvent[];
  /** Called once the process exits, for CLIs without an explicit final event. */
  finish?(): AgentEvent[];
}

export interface AgentAdapter {
  id: AgentId;
  label: string;
  binName: string;
  /**
   * Where the official installer puts the CLI, tried when it isn't on PATH: a process started before
   * the install (the app, a dev server) still has the old PATH.
   */
  installLocations?: string[];
  installCommand: string;
  loginCommand: string;
  /** Known-good models, used for the dropdown when the CLI can't enumerate its own. */
  modelHints: string[];
  /**
   * Shape of a valid model name beyond the enumerated list. Without it a stale list would
   * reject a model the CLI has only just started accepting.
   */
  modelPattern?: RegExp;
  /**
   * Effort levels to offer when the CLI can't list them, or with no model chosen. Empty when
   * levels only exist per model and so can't be known without one.
   */
  effortHints: string[];
  /** Ask the CLI which models (and their effort levels) it accepts. Omitted, or null, when it has no way to say. */
  listModels?(cli: ResolvedCli): Promise<ModelCatalog | null>;
  /**
   * Whether the CLI can be pointed at an MCP server per invocation, which is what lets an agent
   * stop and ask a question mid-run. OpenCode registers MCP servers in persistent config with no
   * per-run flag, so it cannot without writing config into the user's repository.
   */
  supportsQuestions: boolean;
  /** Subscription-backed agents report notional cost. */
  usageEstimated: boolean;
  /**
   * Whether a failed run is checked for a usage limit, so it waits for the reset instead of failing.
   * Off for agents whose limit messages we haven't seen (OpenCode's "Insufficient balance" is
   * billing, not a limit that lifts).
   */
  reportsUsageLimits?: boolean;
  buildSpawn(invocation: AgentInvocation): SpawnSpec;
  createParser(): AgentParser;
  version(cli: ResolvedCli): Promise<string | null>;
  auth(cli: ResolvedCli): Promise<{ loggedIn: boolean | null; detail: string }>;
}

// CLI JSON events are loosely typed.
// biome-ignore lint: parsed JSON
export type JsonEvent = Record<string, any>;

export function parseJsonLine(line: string): JsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonEvent) : null;
  } catch {
    return null;
  }
}

export function truncate(text: string, max = 200): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/** Distinct levels from lowest to highest; ones we don't know keep their order at the end. */
export function orderEfforts(levels: Iterable<string>): string[] {
  const rank = (level: string) => {
    const index = EFFORT_ORDER.indexOf(level);
    return index === -1 ? EFFORT_ORDER.length : index;
  };
  return [...new Set(levels)].sort((a, b) => rank(a) - rank(b));
}

export const firstVersion =(text: string) => text.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] ?? null;
