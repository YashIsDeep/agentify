import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
export const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

/**
 * The API can run arbitrary commands (shell actions), so only same-machine callers are accepted:
 * the Host header must be local (blocks DNS rebinding) and any browser Origin must be a known
 * local origin (blocks cross-site requests from other tabs).
 */
export function localOnly(options: { allowedOriginPorts: number[] }): MiddlewareHandler {
  const allowedPorts = new Set(options.allowedOriginPorts.map(String));
  const limitBody = bodyLimit({
    maxSize: MAX_REQUEST_BYTES,
    onError: (c) => {
      // The oversized body may still be arriving. Do not reuse that HTTP/1 connection.
      c.header("Connection", "close");
      return c.json({ error: "Request body exceeds the 2 MiB limit" }, 413);
    },
  });
  return async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", "frame-ancestors 'none'");
    c.header("Referrer-Policy", "no-referrer");
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (!LOCAL_HOSTNAMES.has(hostnameOf(host))) return c.json({ error: "Forbidden host" }, 403);

    if (c.req.header("sec-fetch-site") === "cross-site") return c.json({ error: "Forbidden origin" }, 403);
    const origin = c.req.header("origin");
    if (origin && !isAllowedOrigin(origin, allowedPorts)) return c.json({ error: "Forbidden origin" }, 403);

    return limitBody(c, next);
  };
}

function hostnameOf(host: string): string {
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return (host.split(":")[0] ?? "").toLowerCase();
}

function isAllowedOrigin(origin: string, allowedPorts: Set<string>): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && LOCAL_HOSTNAMES.has(url.hostname) && allowedPorts.has(url.port);
  } catch {
    return false;
  }
}
