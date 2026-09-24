/** A picked option and a typed note go together; either one alone is the answer. */
export function combineAnswer(choice: string | undefined, note: string | undefined): string {
  const picked = choice?.trim() ?? "";
  const typed = note?.trim() ?? "";
  if (picked && typed) return `${picked} — ${typed}`;
  return picked || typed;
}
