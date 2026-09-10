import type { HttpFetch } from "./types";

export interface JsonRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  /** Named in error messages, e.g. "Jira". */
  service: string;
  http: HttpFetch;
}

const TIMEOUT_MS = 30_000;

/**
 * A JSON request against a third-party API.
 *
 * Every service reports failures differently, so `describeError` looks for the shapes Jira,
 * Linear and Notion actually use and falls back to the raw body — a wrong token should say
 * so rather than "request failed".
 */
export async function requestJson<T>(url: string, { method = "GET", headers, body, signal, service, http }: JsonRequest): Promise<T> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await http(url, {
    method,
    headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }).catch((err: unknown) => {
    if (signal?.aborted) throw new Error("Cancelled");
    if (err instanceof Error && err.name === "TimeoutError") throw new Error(`${service} did not respond within ${TIMEOUT_MS / 1000}s`);
    throw new Error(`Could not reach ${service}: ${err instanceof Error ? err.message : String(err)}`);
  });

  const text = await response.text();
  const parsed = text.trim() ? safeParse(text) : null;

  if (!response.ok) {
    const detail = describeError(parsed) ?? truncate(text);
    throw new Error(`${service} returned ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return parsed as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeError(body: unknown): string | null {
  if (typeof body === "string") return truncate(body);
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;

  // Jira: { errorMessages: [...], errors: { field: "..." } }
  const messages = record.errorMessages;
  if (Array.isArray(messages) && messages.length > 0) return messages.map(String).join("; ");
  const fields = record.errors;
  if (fields && typeof fields === "object" && !Array.isArray(fields)) {
    const pairs = Object.entries(fields).map(([key, value]) => `${key}: ${String(value)}`);
    if (pairs.length > 0) return pairs.join("; ");
  }
  // GraphQL: { errors: [{ message }] }
  if (Array.isArray(fields) && fields.length > 0) return graphqlMessages(fields);
  // Notion: { message }
  for (const key of ["message", "errorMessage", "error_description", "error"]) {
    const value = record[key];
    if (typeof value === "string" && value) return truncate(value);
  }
  return null;
}

export function graphqlMessages(errors: unknown[]): string {
  return errors
    .map((error) => (error && typeof error === "object" ? String((error as { message?: unknown }).message ?? "") : String(error)))
    .filter(Boolean)
    .join("; ");
}

const truncate = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max)}…` : text).trim();

/** Reports a missing required connection field the way the Connections tab names it. */
export function requireValue(values: Record<string, string>, name: string, label: string, service: string): string {
  const value = values[name]?.trim();
  if (!value) throw new Error(`This ${service} connection has no ${label}. Fill it in on the Connections tab.`);
  return value;
}
