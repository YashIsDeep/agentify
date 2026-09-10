/**
 * Model lists deliberately do not live here. They come from `GET /api/agent-models`, which asks
 * each CLI what it accepts — a second copy in the browser is what let an invalid model be typed
 * and only fail once the agent ran.
 */
export const AGENTS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "opencode", label: "OpenCode" },
] as const;

export const agentLabel = (id: string | null | undefined) => AGENTS.find((agent) => agent.id === id)?.label ?? id ?? "";
