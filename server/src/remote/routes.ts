import { pairDeviceSchema, remoteAccessUpdateSchema, type SessionInfo } from "@wm/shared";
import type { Context, Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { EngineError } from "../engine/engine";
import { type GateVariables, isHttps } from "./guard";
import type { RemoteAccessService } from "./service";

/** As long as browsers keep a cookie (Chrome caps it at 400 days); a device unused for 30 days is forgotten sooner. */
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;

type GateContext = Context<{ Variables: GateVariables }>;

/** Turning remote access on or off and pairing or removing devices belong to the computer itself. */
function refuseUnlessHost(c: GateContext): Response | null {
  if (c.get("access").kind === "host") return null;
  return c.json({ error: "Only the computer running Agentify can change this. A device can sign itself out." }, 403);
}

export function mountRemoteAccess(app: Hono<{ Variables: GateVariables }>, remote: RemoteAccessService, readBody: (c: GateContext) => Promise<unknown>): void {
  app.get("/api/session", (c) => c.json(remote.session(c.get("access"))));

  app.post("/api/devices/pair", async (c) => {
    const access = c.get("access");
    if (access.kind === "host") throw new EngineError("This computer doesn't need pairing.", 400);
    if (access.kind === "device") throw new EngineError("This device is already paired.", 400);
    const { code } = pairDeviceSchema.parse(await readBody(c));
    const { device, token } = remote.store.redeem(code, c.req.header("user-agent"));
    setCookie(c, remote.cookieName, token, { path: "/", httpOnly: true, sameSite: "Strict", secure: isHttps(c), maxAge: COOKIE_MAX_AGE_S });
    return c.json({ access: "device", remoteAccess: true, device } satisfies SessionInfo);
  });

  app.post("/api/devices/sign-out", (c) => {
    const access = c.get("access");
    if (access.kind !== "device") throw new EngineError("Only a paired device can sign out.", 400);
    remote.store.remove(access.device.id);
    deleteCookie(c, remote.cookieName, { path: "/" });
    return c.body(null, 204);
  });

  app.delete("/api/devices/:id", (c) => {
    const refused = refuseUnlessHost(c);
    if (refused) return refused;
    remote.store.remove(c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/api/remote-access", async (c) => c.json(await remote.status(c.get("access"))));

  app.put("/api/remote-access", async (c) => {
    const refused = refuseUnlessHost(c);
    if (refused) return refused;
    await remote.setEnabled(remoteAccessUpdateSchema.parse(await readBody(c)).enabled);
    return c.json(await remote.status(c.get("access")));
  });

  app.post("/api/remote-access/pairing", async (c) => {
    const refused = refuseUnlessHost(c);
    if (refused) return refused;
    remote.store.startPairing();
    return c.json(await remote.status(c.get("access")));
  });

  app.delete("/api/remote-access/pairing", (c) => {
    const refused = refuseUnlessHost(c);
    if (refused) return refused;
    remote.store.cancelPairing(c.req.query("code"));
    return c.body(null, 204);
  });
}
