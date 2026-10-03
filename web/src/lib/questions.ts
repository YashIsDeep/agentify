import type { AgentQuestionField } from "@wm/shared";

/** A picked option and a typed note go together; either one alone is the answer. */
export function combineAnswer(choice: string | undefined, note: string | undefined): string {
  const picked = choice?.trim() ?? "";
  const typed = note?.trim() ?? "";
  if (picked && typed) return `${picked} — ${typed}`;
  return picked || typed;
}

/**
 * Agents are told to list their recommendation first, so "use recommended" picks each choice's first
 * option. Only for the choices you haven't made yet: a pick of your own is never overwritten.
 */
export function withRecommended(fields: AgentQuestionField[], answers: Record<string, string>): Record<string, string> {
  const next = { ...answers };
  for (const field of fields) {
    const first = field.options?.[0];
    if (field.kind === "choice" && first && !next[field.id]) next[field.id] = first;
  }
  return next;
}
