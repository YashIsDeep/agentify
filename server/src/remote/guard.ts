import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { bodyLimiter, isAllowedLocalOrigin, isLocalHost, setSecurityHeaders } from "../api/security";
import { type Access, admit } from "./access";
import { clientAddress, isLoopbackAddress, isPrivateAddress, normalizeAddress } from "./network";
import type { RemoteAccessStore } from "./store";

export type GateVariables = { access: Access };

/** What a device may do before it has paired: load the page, ask who it is, and pair. */
const PAIRING_ROUTES = new Set(["GET /api/session", "POST /api/devices/pair"]);

/** An agent's channel for asking questions. Only agents this server started, on this machine, use it. */
const isAgentChannel = (path: string) => path.startsWith("/mcp/") || /^\/api\/workspaces\/[^/]+\/mcp\//.test(path);

/** The connecting socket's address. Missing for a request made in-process, as tests do. */
export function peerAddress(c: Context): string | undefined {
  return (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
}

/**
 * The server's gate, in front of every route.
 *
 * A request is this computer's own browser (the host) when it comes from loopback, names a local
 * Host, and wasn't relayed by a proxy for some other device. It is checked as it always was: a local
 * Origin, nothing cross-site. Pairing never applies to it.
 *
 * Anything else is another device. It gets in only while remote access is on, only from a private
 * network (a LAN or a tailnet; never the internet, even through a tunnel), only with a same-origin
 * request, and only with a paired device's cookie, apart from the page and the routes that pair it.
 * Agents' question channels are never open to it.
 */
export function gate(options: {
  store: RemoteAccessStore;
  cookieName: string;
  allowedOriginPorts: number[];
}): MiddlewareHandler<{ Variables: GateVariables }> {
  const { store, cookieName } = options;
  const allowedPorts = new Set(options.allowedOriginPorts.map(String));
  const limitBody = bodyLimiter();
  return async (c, next) => {
    setSecurityHeaders(c);
    if (c.req.header("sec-fetch-site") === "cross-site") return c.json({ error: "Forbidden origin" }, 403);
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    const origin = c.req.header("origin");
    const client = clientAddress(peerAddress(c), c.req.header("x-forwarded-for"));
    const forwardedHost = c.req.header("x-forwarded-host");
    // tailscale serve keeps the tailnet name as Host and adds these, so a relayed request never passes for local.
    const relayed =
      c.req.header("tailscale-user-login") !== undefined ||
      c.req.header("tailscale-funnel-request") !== undefined ||
      (forwardedHost !== undefined && !isLocalHost(forwardedHost));
    const fromThisMachine = (client === undefined || (client !== null && isLoopbackAddress(client))) && isLocalHost(host) && !relayed;

    if (fromThisMachine) {
      if (origin && !isAllowedLocalOrigin(origin, allowedPorts)) return c.json({ error: "Forbidden origin" }, 403);
      c.set("access", admit({ kind: "host" }));
      return limitBody(c, next);
    }

    if (isAgentChannel(c.req.path)) return c.json({ error: "Forbidden" }, 403);
    if (!store.enabled) return c.json({ error: "Remote access is off on the computer running Agentify." }, 403);
    // Funnel publishes a tailnet address on the internet; its requests say so.
    if (!client || !isPrivateAddress(client) || c.req.header("tailscale-funnel-request") !== undefined) {
      return c.json({ error: "Only devices on your own network or tailnet can connect." }, 403);
    }
    if (origin && !isSameOrigin(origin, host)) return c.json({ error: "Forbidden origin" }, 403);

    const device = store.authenticate(getCookie(c, cookieName));
    if (device) {
      c.set("access", admit({ kind: "device", device }));
      return limitBody(c, next);
    }
    const isPage = (c.req.method === "GET" || c.req.method === "HEAD") && !c.req.path.startsWith("/api/");
    if (!isPage && !PAIRING_ROUTES.has(`${c.req.method} ${c.req.path}`)) {
      return c.json({ error: "This device isn't paired with Agentify." }, 401);
    }
    c.set("access", admit({ kind: "none" }));
    return limitBody(c, next);
  };
}

/** A device's browser names the address it opened in both Origin and Host. */
function isSameOrigin(origin: string, host: string): boolean {
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/** Behind `tailscale serve` the device spoke https, so its cookie must only ever travel over https. */
export function isHttps(c: Context): boolean {
  if (new URL(c.req.url).protocol === "https:") return true;
  const peer = normalizeAddress(peerAddress(c) ?? "");
  return peer !== null && isLoopbackAddress(peer) && c.req.header("x-forwarded-proto") === "https";
}
