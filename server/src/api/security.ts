import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { admittedAccess } from "../remote/access";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
export const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

export function setSecurityHeaders(c: Context): void {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Content-Security-Policy", "frame-ancestors 'none'");
  c.header("Referrer-Policy", "no-referrer");
}

export function bodyLimiter(): MiddlewareHandler {
  return bodyLimit({
    maxSize: MAX_REQUEST_BYTES,
    onError: (c) => {
      // The oversized body may still be arriving. Do not reuse that HTTP/1 connection.
      c.header("Connection", "close");
      return c.json({ error: "Request body exceeds the 2 MiB limit" }, 413);
    },
  });
}

/** Whether a Host header names this machine. */
export const isLocalHost = (host: string | undefined): boolean => host !== undefined && LOCAL_HOSTNAMES.has(hostnameOf(host));

/**
 * The API can run arbitrary commands (shell actions), so only same-machine callers are accepted:
 * the Host header must be local (blocks DNS rebinding) and any browser Origin must be a known
 * local origin (blocks cross-site requests from other tabs).
 *
 * This guards a workspace's own app. Requests reach it through the server's gate (remote/guard.ts),
 * which has already checked them, paired devices included, and says so in the request's env; only a
 * request from anywhere else, like a test calling the app directly, is checked here.
 */
export function localOnly(options: { allowedOriginPorts: number[] }): MiddlewareHandler {
  const allowedPorts = new Set(options.allowedOriginPorts.map(String));
  const limitBody = bodyLimiter();
  return async (c, next) => {
    setSecurityHeaders(c);
    const access = admittedAccess(c.env);
    if (access) {
      // The gate only forwards an unpaired device's request to fetch the page it pairs from.
      if (access.kind === "none" && c.req.path.startsWith("/api/")) return c.json({ error: "This device isn't paired with Agentify." }, 401);
      return limitBody(c, next);
    }
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (!isLocalHost(host)) return c.json({ error: "Forbidden host" }, 403);

    if (c.req.header("sec-fetch-site") === "cross-site") return c.json({ error: "Forbidden origin" }, 403);
    const origin = c.req.header("origin");
    if (origin && !isAllowedLocalOrigin(origin, allowedPorts)) return c.json({ error: "Forbidden origin" }, 403);

    return limitBody(c, next);
  };
}

function hostnameOf(host: string): string {
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return (host.split(":")[0] ?? "").toLowerCase();
}

/** An Origin this machine's own browser sends: plain http, a local name, and one of the app's ports. */
export function isAllowedLocalOrigin(origin: string, allowedPorts: Set<string>): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && LOCAL_HOSTNAMES.has(url.hostname) && allowedPorts.has(url.port);
  } catch {
    return false;
  }
}
