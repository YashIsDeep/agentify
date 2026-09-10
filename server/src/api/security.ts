import type { MiddlewareHandler } from "hono";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The API can run arbitrary commands (shell actions), so only same-machine callers are accepted:
 * the Host header must be local (blocks DNS rebinding) and any browser Origin must be a known
 * local origin (blocks cross-site requests from other tabs).
 */
export function localOnly(options: { allowedOriginPorts: number[] }): MiddlewareHandler {
  const allowedPorts = new Set(options.allowedOriginPorts.map(String));
  return async (c, next) => {
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (!LOCAL_HOSTNAMES.has(hostnameOf(host))) return c.json({ error: "Forbidden host" }, 403);

    if (c.req.header("sec-fetch-site") === "cross-site") return c.json({ error: "Forbidden origin" }, 403);
    const origin = c.req.header("origin");
    if (origin && !isAllowedOrigin(origin, allowedPorts)) return c.json({ error: "Forbidden origin" }, 403);

    await next();
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
