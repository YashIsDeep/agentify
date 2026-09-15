import { z } from "zod";
import { type ActionDefinition, type AnyActionDefinition, UsageLimitError } from "../src/actions/types";

const gates = new Map<string, { promise: Promise<void>; release: () => void }>();

function gate(name: string) {
  let entry = gates.get(name);
  if (!entry) {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    entry = { promise, release };
    gates.set(name, entry);
  }
  return entry;
}

export const releaseGate = (name: string) => gate(name).release();
export const resetTestActions = () => {
  gates.clear();
  attempts.clear();
};

const attempts = new Map<string, number>();

const waitAction: ActionDefinition<{ gate: string }> = {
  type: "test-wait",
  label: "Wait for gate",
  description: "Resolves when the named gate is released; rejects when cancelled.",
  configSchema: z.object({ gate: z.string() }),
  fields: [{ name: "gate", label: "Gate", kind: "text", default: "" }],
  run: ({ config, signal }) =>
    new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      void gate(config.gate).promise.then(() => resolve({ outputs: { gate: config.gate } }));
    }),
};

const flakyAction: ActionDefinition<{ key: string; failures: number }> = {
  type: "test-flaky",
  label: "Flaky",
  description: "Fails the first `failures` attempts for a key, then succeeds.",
  configSchema: z.object({ key: z.string(), failures: z.number().int().default(1) }),
  fields: [
    { name: "key", label: "Key", kind: "text", default: "" },
    { name: "failures", label: "Failures", kind: "number", default: 1 },
  ],
  async run({ config }) {
    const attempt = (attempts.get(config.key) ?? 0) + 1;
    attempts.set(config.key, attempt);
    if (attempt <= config.failures) throw new Error(`flaky failure ${attempt}`);
    return { outputs: { attempt } };
  },
};

const quotaAction: ActionDefinition<{ key: string; limits: number; waitMs: number }> = {
  type: "test-quota",
  label: "Usage limited",
  description: "Hits a usage limit lifting in `waitMs` on the first `limits` attempts for a key, then succeeds.",
  configSchema: z.object({ key: z.string(), limits: z.number().int().default(1), waitMs: z.number().default(100) }),
  fields: [
    { name: "key", label: "Key", kind: "text", default: "" },
    { name: "limits", label: "Limits", kind: "number", default: 1 },
    { name: "waitMs", label: "Wait (ms)", kind: "number", default: 100 },
  ],
  async run({ config }) {
    const attempt = (attempts.get(config.key) ?? 0) + 1;
    attempts.set(config.key, attempt);
    if (attempt <= config.limits) {
      throw new UsageLimitError(`usage limit ${attempt}`, Date.now() + config.waitMs, { outputs: { agent: "claude" } });
    }
    return { outputs: { attempt } };
  },
};

export const testActions: AnyActionDefinition[] = [
  waitAction,
  { ...waitAction, type: "test-long-wait", longRunning: true },
  flakyAction,
  quotaAction,
];
