import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { type NetworkInterfaceInfo, tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteAccessStatus, SessionInfo } from "@wm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config";
import { NetworkListener } from "../src/remote/listener";
import { clientAddress, isPrivateAddress, normalizeAddress, reachableAddresses } from "../src/remote/network";
import { DEVICE_IDLE_MS, deviceName, PAIRING_MAX_FAILURES, PAIRING_TTL_MS, RemoteAccessStore, type RemoteAccessEvent } from "../src/remote/store";
import { detectTailscale } from "../src/remote/tailscale";
import { bootstrapWorkspaces } from "../src/workspaces";
import { removeDir } from "./helpers";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const iface = (address: string, family: "IPv4" | "IPv6" = "IPv4", internal = false): NetworkInterfaceInfo =>
  family === "IPv4"
    ? { address, family, internal, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null }
    : { address, family, internal, netmask: "ffff:ffff:ffff:ffff::", mac: "00:00:00:00:00:00", cidr: null, scopeid: 0 };

describe("network addresses", () => {
  it("reads addresses the way sockets and proxies write them", () => {
    expect(normalizeAddress("::ffff:192.168.1.5")).toBe("192.168.1.5");
    expect(normalizeAddress("[::1]:443")).toBe("::1");
    expect(normalizeAddress(" 192.168.1.5:5000 ")).toBe("192.168.1.5");
    expect(normalizeAddress("fe80::1%eth0")).toBe("fe80::1");
    expect(normalizeAddress("FD7A:115C:A1E0::1")).toBe("fd7a:115c:a1e0::1");
    expect(normalizeAddress("unknown")).toBeNull();
  });

  it("counts LANs, tailnets and this machine as private, and nothing on the internet", () => {
    for (const address of ["192.168.1.5", "10.1.2.3", "172.20.0.1", "100.101.102.103", "127.0.0.1", "169.254.3.4", "::1", "fd7a:115c:a1e0::1", "fe80::1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "203.0.113.5", "2001:db8::1"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("believes X-Forwarded-For only when a proxy on this machine wrote it", () => {
    expect(clientAddress(undefined, "203.0.113.5")).toBeUndefined();
    // A device can't vouch for itself.
    expect(clientAddress("192.168.1.50", "127.0.0.1")).toBe("192.168.1.50");
    expect(clientAddress("127.0.0.1", undefined)).toBe("127.0.0.1");
    // tailscale serve, relaying a tailnet device.
    expect(clientAddress("127.0.0.1", "100.64.1.2")).toBe("100.64.1.2");
    // ngrok in front of the Vite dev server: the last hop that isn't this machine is the device.
    expect(clientAddress("::ffff:127.0.0.1", "203.0.113.5, 127.0.0.1")).toBe("203.0.113.5");
    // A device that wrote "127.0.0.1" itself, relayed by a proxy that appended who really connected.
    expect(clientAddress("127.0.0.1", "127.0.0.1, 192.168.1.50")).toBe("192.168.1.50");
    expect(clientAddress("127.0.0.1", "::1")).toBe("127.0.0.1");
    expect(clientAddress("127.0.0.1", "unknown")).toBeNull();
  });

  it("offers private addresses that aren't virtual adapters, marking the tailnet's", () => {
    expect(reachableAddresses({
      Ethernet: [iface("192.168.1.44"), iface("fe80::1", "IPv6")],
      "vEthernet (WSL)": [iface("172.25.0.1")],
      Tailscale: [iface("100.101.102.103")],
      "Public NIC": [iface("203.0.113.9")],
      "Loopback Pseudo-Interface 1": [iface("127.0.0.1", "IPv4", true)],
      "Wi-Fi": [iface("169.254.10.10")],
    })).toEqual([
      { address: "192.168.1.44", tailnet: false },
      { address: "100.101.102.103", tailnet: true },
    ]);
  });
});

describe("tailscale", () => {
  const cli = (serve: unknown) => async (args: string[]) =>
    args[0] === "status"
      ? JSON.stringify({ BackendState: "Running", Self: { DNSName: "pc.tailnet-1234.ts.net.", TailscaleIPs: ["100.101.102.103"] } })
      : JSON.stringify(serve);

  it("finds the tailnet name, and serve's https address when it proxies to this port", async () => {
    expect(await detectTailscale(2712, cli({}))).toEqual({ dnsName: "pc.tailnet-1234.ts.net", httpsUrl: null });
    expect(await detectTailscale(2712, cli({ Web: { "pc.tailnet-1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:2712" } } } } })))
      .toEqual({ dnsName: "pc.tailnet-1234.ts.net", httpsUrl: "https://pc.tailnet-1234.ts.net" });
    expect(await detectTailscale(2712, cli({ Web: { "pc.tailnet-1234.ts.net:8443": { Handlers: { "/": { Proxy: "localhost:2712" } } } } })))
      .toEqual({ dnsName: "pc.tailnet-1234.ts.net", httpsUrl: "https://pc.tailnet-1234.ts.net:8443" });
    // Serving something else isn't serving Agentify.
    expect((await detectTailscale(2712, cli({ Web: { "pc.tailnet-1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } })))?.httpsUrl).toBeNull();
  });

  it("is absent when Tailscale isn't installed or isn't connected", async () => {
    expect(await detectTailscale(2712, async () => null)).toBeNull();
    expect(await detectTailscale(2712, async () => JSON.stringify({ BackendState: "Stopped", Self: { DNSName: "pc.ts.net." } }))).toBeNull();
  });
});

describe("device store", () => {
  let dir: string;
  let now: number;
  let store: RemoteAccessStore;
  let events: RemoteAccessEvent[];
  const file = () => join(dir, "remote-access.json");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wm-remote-store-"));
    now = 1_000_000;
    store = new RemoteAccessStore(file(), () => now);
    events = [];
    store.on((event) => events.push(event));
  });
  afterEach(() => removeDir(dir));

  it("names devices after their browser", () => {
    expect(deviceName(IPHONE)).toBe("iPhone · Safari");
    expect(deviceName("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36")).toBe("Android · Chrome");
    expect(deviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0")).toBe("Windows · Edge");
    expect(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1")).toBe("iPhone · Chrome");
    expect(deviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe("Mac · Firefox");
    expect(deviceName(undefined)).toBe("Unknown device");
  });

  it("pairs one device per code, forgiving how the code is typed", () => {
    expect(() => store.startPairing()).toThrow(/Turn on remote access/);
    store.setEnabled(true);
    const { code } = store.startPairing();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase().replace(/0/g, "o").replace(/1/g, "l");
    const { device, token } = store.redeem(typed, IPHONE);
    expect(device.name).toBe("iPhone · Safari");
    expect(store.authenticate(token)).toMatchObject({ id: device.id });
    expect(store.pairing()).toBeNull();
    expect(() => store.redeem(code, IPHONE)).toThrow(/No pairing code is waiting/);
    // Only the token's hash is written down.
    expect(readFileSync(file(), "utf8")).not.toContain(token);
  });

  it("lets a code expire, and throws it away after too many wrong guesses", () => {
    store.setEnabled(true);
    const first = store.startPairing();
    now += PAIRING_TTL_MS + 1;
    expect(() => store.redeem(first.code, IPHONE)).toThrow(/No pairing code is waiting/);

    const second = store.startPairing();
    const wrong = second.code.startsWith("2") ? "3".repeat(8) : "2".repeat(8);
    for (let attempt = 1; attempt < PAIRING_MAX_FAILURES; attempt++) expect(() => store.redeem(wrong, IPHONE)).toThrow(/doesn't match/);
    expect(() => store.redeem(wrong, IPHONE)).toThrow(/Too many wrong codes/);
    expect(() => store.redeem(second.code, IPHONE)).toThrow(/No pairing code is waiting/);
  });

  it("forgets a device unused for 30 days, and keeps the rest across restarts", () => {
    store.setEnabled(true);
    store.startPairing();
    const idle = store.redeem(store.pairing()!.code, IPHONE);
    store.startPairing();
    const busy = store.redeem(store.pairing()!.code, "Mozilla/5.0 (Windows NT 10.0) Firefox/140.0");
    now += DEVICE_IDLE_MS - 1000;
    expect(store.authenticate(busy.token)).not.toBeNull();
    now += 2000;
    expect(store.authenticate(idle.token)).toBeNull();
    expect(events).toContainEqual({ type: "revoked", deviceId: idle.device.id });
    expect(store.devices().map((device) => device.id)).toEqual([busy.device.id]);

    const reopened = new RemoteAccessStore(file(), () => now);
    expect(reopened.enabled).toBe(true);
    expect(reopened.authenticate(busy.token)).toMatchObject({ id: busy.device.id });
    expect(reopened.authenticate(idle.token)).toBeNull();
  });

  it("revokes every device's access while the switch is off, without unpairing them", () => {
    store.setEnabled(true);
    store.startPairing();
    const { token } = store.redeem(store.pairing()!.code, IPHONE);
    store.startPairing();
    store.setEnabled(false);
    expect(events).toContainEqual({ type: "revoked", deviceId: null });
    expect(store.authenticate(token)).toBeNull();
    expect(store.pairing()).toBeNull();
    store.setEnabled(true);
    expect(store.authenticate(token)).not.toBeNull();
  });

  it("starts switched off when its file can't be read", () => {
    writeFileSync(file(), "{ not json");
    const unreadable = new RemoteAccessStore(file(), () => now);
    expect(unreadable.enabled).toBe(false);
    expect(unreadable.devices()).toEqual([]);
  });
});

describe("the gate", () => {
  let config: AppConfig;
  let ctx: ReturnType<typeof bootstrapWorkspaces>;
  const PC = "http://192.168.1.44:2712";

  beforeEach(() => {
    config = {
      dataDir: mkdtempSync(join(tmpdir(), "wm-remote-gate-")),
      host: "127.0.0.1", port: 2712, uiPort: 2712, devOriginPorts: [], maxConcurrentLongRuns: 1,
    };
    ctx = bootstrapWorkspaces(config, {
      seed: false,
      remote: { tailscale: async () => null, interfaces: () => ({ Ethernet: [iface("192.168.1.44")] }) },
    });
    ctx.start();
  });
  afterEach(async () => {
    await ctx.close();
    removeDir(config.dataDir);
  });

  /** This computer's own browser. */
  const local = (path: string, init: RequestInit = {}) => ctx.app.request(`http://localhost:2712${path}`, init, peer("127.0.0.1"));
  /** A phone on the Wi-Fi, opening the PC's LAN address. */
  const phone = (path: string, init: RequestInit = {}, cookie?: string, from = "192.168.1.50") =>
    ctx.app.request(`${PC}${path}`, { ...init, headers: { ...(cookie ? { cookie } : {}), ...init.headers } }, peer(from));
  const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const peer = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });

  async function pairPhone(userAgent = IPHONE): Promise<{ cookie: string; deviceId: string; setCookie: string }> {
    const status = await (await local("/api/remote-access/pairing", { method: "POST" })).json() as RemoteAccessStatus;
    const response = await phone("/api/devices/pair", { ...json("POST", { code: status.pairing!.code }), headers: { "content-type": "application/json", "user-agent": userAgent } });
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    const session = await response.json() as Extract<SessionInfo, { access: "device" }>;
    return { cookie: setCookie.split(";")[0]!, deviceId: session.device.id, setCookie };
  }

  it("keeps other devices out while remote access is off", async () => {
    expect((await local("/api/session")).status).toBe(200);
    expect(await (await local("/api/session")).json()).toEqual({ access: "host", remoteAccess: false });
    const refused = await phone("/api/session");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "Remote access is off on the computer running Agentify." });
  });

  it("pairs a phone on the LAN, which can then use everything but the device settings", async () => {
    const turnedOn = await local("/api/remote-access", json("PUT", { enabled: true }));
    expect(((await turnedOn.json()) as RemoteAccessStatus).addresses).toEqual([{ kind: "lan", url: "http://192.168.1.44:2712" }]);

    // Unpaired: the page and pairing only.
    expect(await (await phone("/api/session")).json()).toEqual({ access: "none" });
    expect((await phone("/api/workflows")).status).toBe(401);
    expect((await phone("/api/workspaces/default/tasks")).status).toBe(401);
    expect((await phone("/api/workspaces")).status).toBe(401);
    expect((await phone("/")).status).not.toBe(401);

    const { cookie, deviceId, setCookie } = await pairPhone();
    expect(setCookie).toMatch(/^agentify_device_2712=[\w-]{43};/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("Secure");

    expect(await (await phone("/api/session", {}, cookie)).json()).toMatchObject({ access: "device", device: { id: deviceId, name: "iPhone · Safari" } });
    expect((await phone("/api/workspaces/default/workflows", {}, cookie)).status).toBe(200);
    expect((await phone("/api/workflows", {}, cookie)).status).toBe(200);
    expect((await phone("/api/settings/concurrency", json("PUT", { maxConcurrentAgents: 4 }), cookie)).status).toBe(200);
    const seen = await (await phone("/api/remote-access", {}, cookie)).json() as RemoteAccessStatus;
    expect(seen.devices.map((device) => device.id)).toEqual([deviceId]);
    expect(seen.pairing).toBeNull();

    // The device settings stay with the computer.
    expect((await phone("/api/remote-access", json("PUT", { enabled: false }), cookie)).status).toBe(403);
    expect((await phone("/api/remote-access/pairing", { method: "POST" }, cookie)).status).toBe(403);
    expect((await phone(`/api/devices/${deviceId}`, { method: "DELETE" }, cookie)).status).toBe(403);
    expect((await phone("/api/devices/pair", json("POST", { code: "ABCDEFGH" }), cookie)).status).toBe(400);
  });

  it("refuses the internet, other sites and agents' question channels, paired or not", async () => {
    await local("/api/remote-access", json("PUT", { enabled: true }));
    const { cookie } = await pairPhone();
    expect((await phone("/api/workflows", {}, cookie, "203.0.113.5")).status).toBe(403);
    expect((await phone("/api/workflows", { headers: { origin: "http://evil.example" } }, cookie)).status).toBe(403);
    expect((await phone("/api/workflows", { headers: { origin: PC } }, cookie)).status).toBe(200);
    expect((await phone("/api/workflows", { headers: { "sec-fetch-site": "cross-site" } }, cookie)).status).toBe(403);
    expect((await phone("/mcp/some-token", { method: "POST" }, cookie)).status).toBe(403);
    expect((await phone("/api/workspaces/default/mcp/some-token", { method: "POST" }, cookie)).status).toBe(403);
    // This computer's own rules haven't changed.
    expect((await local("/api/workflows", { headers: { origin: "https://evil.example" } })).status).toBe(403);
  });

  it("treats a request relayed by a local proxy as the device it relays", async () => {
    await local("/api/remote-access", json("PUT", { enabled: true }));
    const viaServe = (path: string, init: RequestInit = {}, from = "100.101.102.103") =>
      ctx.app.request(`http://pc.tailnet-1234.ts.net${path}`, {
        ...init,
        headers: { "x-forwarded-for": from, "x-forwarded-host": "pc.tailnet-1234.ts.net", "x-forwarded-proto": "https", "tailscale-user-login": "me@example.com", ...init.headers },
      }, peer("127.0.0.1"));

    expect((await viaServe("/api/workflows")).status).toBe(401);
    const { pairing } = await (await local("/api/remote-access/pairing", { method: "POST" })).json() as RemoteAccessStatus;
    const paired = await viaServe("/api/devices/pair", json("POST", { code: pairing!.code }));
    expect(paired.status).toBe(200);
    // It spoke https to tailscale serve, so its cookie never goes over plain http.
    expect(paired.headers.get("set-cookie")).toContain("Secure");
    const cookie = paired.headers.get("set-cookie")!.split(";")[0]!;
    expect((await viaServe("/api/workflows", { headers: { cookie } })).status).toBe(200);
    // Funnel puts the address on the internet.
    expect((await viaServe("/api/workflows", { headers: { cookie, "tailscale-funnel-request": "?1" } })).status).toBe(403);

    // A proxy that passes a LAN device's "Host: localhost" along still names the device it relays.
    const spoofed = await ctx.app.request("http://localhost:2712/api/workflows", { headers: { "x-forwarded-for": "192.168.1.50" } }, peer("127.0.0.1"));
    expect(spoofed.status).toBe(401);
  });

  it("ends a device's access when it signs out or is removed, streams included", async () => {
    await local("/api/remote-access", json("PUT", { enabled: true }));
    const first = await pairPhone();
    const signedOut = await phone("/api/devices/sign-out", { method: "POST" }, first.cookie);
    expect(signedOut.status).toBe(204);
    expect(signedOut.headers.get("set-cookie")).toMatch(/agentify_device_2712=;.*Max-Age=0/);
    expect((await phone("/api/workflows", {}, first.cookie)).status).toBe(401);

    const second = await pairPhone();
    const stream = await phone("/api/workspaces/default/events", {}, second.cookie);
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: ready");
    expect((await local(`/api/devices/${second.deviceId}`, { method: "DELETE" })).status).toBe(204);
    await expect(readToEnd(reader)).resolves.toBeUndefined();
    expect((await phone("/api/workflows", {}, second.cookie)).status).toBe(401);
  });

  it("ends every device's stream when remote access is switched off", async () => {
    await local("/api/remote-access", json("PUT", { enabled: true }));
    const { cookie } = await pairPhone();
    const stream = await phone("/api/events", {}, cookie);
    const reader = stream.body!.getReader();
    await reader.read();
    await local("/api/remote-access", json("PUT", { enabled: false }));
    await expect(readToEnd(reader)).resolves.toBeUndefined();
    expect((await phone("/api/workflows", {}, cookie)).status).toBe(403);
    // Still paired: switching back on lets it straight back in.
    await local("/api/remote-access", json("PUT", { enabled: true }));
    expect((await phone("/api/workflows", {}, cookie)).status).toBe(200);
  });

  it("tells every open screen when settings change", async () => {
    const stream = await local("/api/events");
    const reader = stream.body!.getReader();
    await reader.read();
    await local("/api/settings/concurrency", json("PUT", { maxConcurrentAgents: 3 }));
    await local("/api/connections", json("POST", { type: "linear", name: "Tracker", values: { apiKey: "lin_api_dummy" } }));
    await local("/api/remote-access", json("PUT", { enabled: true }));
    await local("/api/workspaces", json("POST", { name: "Second" }));
    const text = await readUntil(reader, ["\"scope\":\"concurrency\"", "\"scope\":\"connections\"", "\"scope\":\"remote-access\"", "\"scope\":\"workspaces\""]);
    expect(text).toContain("event: settings.changed");
    await reader.cancel();
  });
});

describe("network listener", () => {
  it("opens and closes on the switch, ending the connections it accepted", async () => {
    const port = await freePort();
    const listener = new NetworkListener({
      port,
      hostname: "127.0.0.1",
      fetch: (request) =>
        new URL(request.url).pathname === "/hang" ? new Response(new ReadableStream({ start() {} })) : new Response("ok"),
    });
    await listener.set(true);
    expect(listener.listening).toBe(true);
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");
    const hanging = await fetch(`http://127.0.0.1:${port}/hang`);
    const pending = hanging.body!.getReader().read().then(() => "ended", () => "ended");

    await listener.set(false);
    expect(listener.listening).toBe(false);
    expect(await pending).toBe("ended");
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it("says why it couldn't listen", async () => {
    const port = await freePort();
    const holder = await listen(port);
    try {
      const listener = new NetworkListener({ port, hostname: "127.0.0.1", fetch: () => new Response("ok") });
      await listener.set(true);
      expect(listener.listening).toBe(false);
      expect(listener.listenError).toMatch(/Another program is using port/);
    } finally {
      holder.close();
    }
  });
});

async function readToEnd(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  const deadline = setTimeout(() => void reader.cancel(), 5000);
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) return;
    }
  } finally {
    clearTimeout(deadline);
  }
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needles: string[]): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Stream never said ${needles.join(", ")}:\n${text}`)), 5000));
  while (!needles.every((needle) => text.includes(needle))) {
    const { value, done } = await Promise.race([reader.read(), timeout]);
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function freePort(): Promise<number> {
  const server = await listen(0);
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("Expected a TCP address");
  return address.port;
}
