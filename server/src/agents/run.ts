import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type { AgentUsage } from "@wm/shared";
import { runProcess, tail } from "../lib/process";
import type { AgentAdapter, AgentEvent, AgentInvocation, ResolvedCli } from "./types";

/** Removed from the agent's environment so the CLIs use their subscription logins, not API billing. */
export const STRIPPED_ENV_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];

export function agentEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra, NO_COLOR: "1" };
  for (const key of Object.keys(env)) {
    if (STRIPPED_ENV_VARS.includes(key.toUpperCase())) delete env[key];
  }
  return env;
}

export interface AgentRunOptions {
  adapter: AgentAdapter;
  cli: ResolvedCli;
  invocation: AgentInvocation;
  env?: Record<string, string>;
  signal?: AbortSignal;
  inactivityTimeoutMs: number;
  timeoutMs?: number;
  onEvent?: (event: AgentEvent) => void;
  onStderr?: (line: string) => void;
}

export interface AgentRunResult {
  ok: boolean;
  aborted: boolean;
  /** The agent's final message. */
  text: string;
  sessionId: string | null;
  usage: AgentUsage | null;
  error: string | null;
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const { adapter, cli, invocation } = options;
  mkdirSync(invocation.scratchDir, { recursive: true });
  const spec = adapter.buildSpawn(invocation);
  const parser = adapter.createParser();

  let sessionId: string | null = null;
  let usage: AgentUsage | null = null;
  let final: Extract<AgentEvent, { kind: "final" }> | null = null;
  let lastError: string | null = null;
  let lastMessage = "";

  const handle = (event: AgentEvent) => {
    if (event.kind === "session") sessionId = event.sessionId;
    else if (event.kind === "usage") usage = { ...event.usage, estimated: adapter.usageEstimated };
    else if (event.kind === "final") final = event;
    else if (event.kind === "error") lastError = event.message;
    else if (event.kind === "message") lastMessage = event.text;
    options.onEvent?.(event);
  };

  const result = await runProcess({
    command: cli.command,
    args: [...cli.prefixArgs, ...spec.args],
    cwd: invocation.cwd,
    env: agentEnv(options.env),
    stdin: spec.stdin,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    inactivityTimeoutMs: options.inactivityTimeoutMs,
    onLine: (line, stream) => {
      if (stream === "stdout") for (const event of parser.push(line)) handle(event);
      else if (line.trim()) options.onStderr?.(line);
    },
  }).catch((err: NodeJS.ErrnoException) => {
    throw err.code === "ENOENT" ? new Error(`${adapter.label} executable not found at ${cli.path}`) : err;
  });
  for (const event of parser.finish?.() ?? []) handle(event);

  const finalEvent = final as Extract<AgentEvent, { kind: "final" }> | null;
  const text = finalEvent?.text || readResultFile(spec.resultFile) || lastMessage;
  const base = { text, sessionId, usage };
  if (result.aborted) return { ...base, ok: false, aborted: true, error: "Cancelled" };

  let error: string | null = null;
  if (result.inactive) {
    error = `No output for ${Math.round(options.inactivityTimeoutMs / 1000)}s, so the agent was stopped`;
  } else if (result.timedOut) {
    error = `Timed out after ${Math.round((options.timeoutMs ?? 0) / 1000)}s`;
  } else if (finalEvent && !finalEvent.ok) {
    error = finalEvent.error ?? "The agent reported a failure";
  } else if (result.code !== 0) {
    error = lastError ?? (tail(result.stderr, 5) || `${adapter.label} exited with code ${result.code}`);
  } else if (!finalEvent && lastError) {
    error = lastError;
  }
  return { ...base, ok: error === null, aborted: false, error };
}

function readResultFile(file: string | undefined): string {
  if (!file || !existsSync(file)) return "";
  return readFileSync(file, "utf8");
}
