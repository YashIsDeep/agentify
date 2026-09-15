/**
 * Mustache-style interpolation without logic: `{{task.title}}`, `{{artifacts["requirements.md"]}}`,
 * `{{outputs.openMr.mrUrl}}`. Missing values render as an empty string; pass an `onMiss` collector
 * to learn which references those were.
 */

export type Scope = Record<string, unknown>;

/** Called with the expression of every reference that rendered empty, e.g. `artifacts["requirements.md"]`. */
export type MissCollector = (expression: string) => void;

export class TemplateError extends Error {
  override name = "TemplateError";
}

const TAG = /\{\{\s*(.+?)\s*\}\}/g;
const FIRST_SEGMENT = /[A-Za-z_$][\w$]*/y;
const NEXT_SEGMENT = /\.([A-Za-z_$][\w$-]*)|\[\s*(?:"([^"]*)"|'([^']*)'|(\d+))\s*\]/y;
const BLOCKED_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export function parsePath(expression: string): string[] {
  const source = expression.trim();
  FIRST_SEGMENT.lastIndex = 0;
  const first = FIRST_SEGMENT.exec(source);
  if (!first) throw new TemplateError(`Invalid template expression "{{${expression}}}"`);

  const segments = [first[0]];
  let index = FIRST_SEGMENT.lastIndex;
  while (index < source.length) {
    NEXT_SEGMENT.lastIndex = index;
    const match = NEXT_SEGMENT.exec(source);
    if (!match) throw new TemplateError(`Invalid template expression "{{${expression}}}"`);
    segments.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? "");
    index = NEXT_SEGMENT.lastIndex;
  }
  return segments;
}

export function lookup(scope: unknown, segments: string[]): unknown {
  let current = scope;
  for (const segment of segments) {
    if (current === null || current === undefined || BLOCKED_SEGMENTS.has(segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function renderString(template: string, scope: Scope, onMiss?: MissCollector): string {
  return template.replace(TAG, (_match, expression: string) => {
    const value = lookup(scope, parsePath(expression));
    if (value === null || value === undefined) onMiss?.(expression);
    return stringify(value);
  });
}

/** Renders every string inside a JSON-like value. Non-string leaves are left untouched. */
export function renderDeep<T>(value: T, scope: Scope, onMiss?: MissCollector): T {
  if (typeof value === "string") return renderString(value, scope, onMiss) as T;
  if (Array.isArray(value)) return value.map((item) => renderDeep(item, scope, onMiss)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, renderDeep(item, scope, onMiss)]),
    ) as T;
  }
  return value;
}
