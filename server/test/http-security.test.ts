import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { expect, it } from "vitest";
import { MAX_REQUEST_BYTES } from "../src/api/security";
import { bootstrapWorkspaces } from "../src/workspaces";
import { removeDir } from "./helpers";

it("enforces security on real HTTP requests through the workspace router", async () => {
  const parent = resolve(tmpdir());
  const dataDir = mkdtempSync(join(parent, "wm-security-http-"));
  let context: ReturnType<typeof bootstrapWorkspaces> | undefined;
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => context!.app.fetch(req) });
  try {
    await new Promise<void>((done, fail) => { server.once("listening", done); server.once("error", fail); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
    const port = address.port;
    context = bootstrapWorkspaces({ dataDir, host: "127.0.0.1", port, devOriginPorts: [], maxConcurrentLongRuns: 1 }, { seed: false });
    context.start();
    const base = `http://127.0.0.1:${port}`;
    const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body) });

    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get("x-frame-options")).toBe("DENY");
    expect(health.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    await health.arrayBuffer();
    const crossSite = await fetch(`${base}/api/health`, { headers: { origin: "https://attacker.invalid", "sec-fetch-site": "cross-site" } });
    expect(crossSite.status).toBe(403);
    await crossSite.arrayBuffer();
    // Node's fetch ignores a supplied Host; use the HTTP client to actually transmit it.
    const hostileHost = await new Promise<number | undefined>((done, fail) => {
      const req = request({ hostname: "127.0.0.1", port, path: "/api/health", headers: { host: "attacker.invalid" } }, (res) => {
        res.resume();
        res.once("end", () => done(res.statusCode));
      });
      req.once("error", fail);
      req.end();
    });
    expect(hostileHost).toBe(403);
    const large = await fetch(`${base}/api/workspaces`, { method: "POST", body: "x".repeat(MAX_REQUEST_BYTES + 1) });
    expect(large.status).toBe(413);
    await large.arrayBuffer();
    const created = await fetch(`${base}/api/workspaces`, json({ name: "HTTP test" }));
    expect(created.status).toBe(201);
    const workspace = await created.json() as { id: string };
    const unsafe = await fetch(`${base}/api/workspaces/${workspace.id}/connections`, json({
      type: "jira", name: "Unsafe", values: { baseUrl: "http://example.invalid", email: "test@example.invalid", apiToken: "dummy" },
    }));
    expect(unsafe.status).toBe(400);
    await unsafe.arrayBuffer();
    const connections = await fetch(`${base}/api/workspaces/${workspace.id}/connections`);
    expect(await connections.json()).toEqual([]);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await context?.close();
    expect(dirname(dataDir)).toBe(parent);
    removeDir(dataDir);
  }
});
