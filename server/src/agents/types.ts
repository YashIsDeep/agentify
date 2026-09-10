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
  autonomy: Autonomy;
  resumeSessionId: string | null;
  cwd: string;
  /** Private directory for this run (result files etc.). */
  scratchDir: string;
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
  | { kind: "tool"; name: string; status: "started" | "completed" | "failed"; detail?: string }
  /** Cumulative usage so far. */
  | { kind: "usage"; usage: AgentUsage }
  | { kind: "error"; message: string }
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
  installCommand: string;
  loginCommand: string;
  /** Known-good models, used for the dropdown when the CLI can't enumerate its own. */
  modelHints: string[];
  /**
   * Shape of a valid model name beyond the enumerated list. Without it a stale list would
   * reject a model the CLI has only just started accepting.
   */
  modelPattern?: RegExp;
  /** Ask the CLI which models it accepts. Omitted, or null, when it has no way to say. */
  listModels?(cli: ResolvedCli): Promise<string[] | null>;
  /** Subscription-backed agents report notional cost. */
  usageEstimated: boolean;
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

export const firstVersion = (text: string) => text.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] ?? null;
