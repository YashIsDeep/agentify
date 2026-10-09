import { join } from "node:path";
import type { NetworkInterfaceInfo } from "node:os";
import type { RemoteAccessStatus, RemoteAddress, SessionInfo } from "@wm/shared";
import type { ServerEvents } from "../server-events";
import type { Access } from "./access";
import type { NetworkListener } from "./listener";
import { reachableAddresses } from "./network";
import { RemoteAccessStore } from "./store";
import { detectTailscale, runTailscale, type TailscaleCli, type TailscaleInfo } from "./tailscale";

/** Tailscale's state changes rarely; the Devices page asks often. */
const TAILSCALE_CACHE_MS = 30_000;

export interface RemoteAccessOptions {
  dataDir: string;
  /** Where the app's page is served, which is where a device should go. */
  uiPort: number;
  events: ServerEvents;
  tailscale?: TailscaleCli;
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  now?: () => number;
}

/** Remote access as a whole: the switch and its listener, pairing, and where devices can connect. */
export class RemoteAccessService {
  readonly store: RemoteAccessStore;
  /** Per port, so two Agentify servers on one machine never overwrite each other's cookie. */
  readonly cookieName: string;
  private listener: NetworkListener | null = null;
  private tailscale: { at: number; info: Promise<TailscaleInfo | null> } | null = null;

  constructor(private readonly options: RemoteAccessOptions) {
    this.store = new RemoteAccessStore(join(options.dataDir, "remote-access.json"), options.now);
    this.cookieName = `agentify_device_${options.uiPort}`;
    this.store.on((event) => {
      if (event.type === "changed") options.events.publish({ type: "settings.changed", scope: "remote-access" });
      else options.events.publish({ type: "access.revoked", deviceId: event.deviceId });
    });
  }

  /** Opens the listener while the switch is on: now, and every time it flips. */
  useListener(listener: NetworkListener): Promise<void> {
    this.listener = listener;
    return listener.set(this.store.enabled);
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.store.setEnabled(enabled);
    await this.listener?.set(enabled);
    // Whether the listener opened is part of what open screens show.
    this.options.events.publish({ type: "settings.changed", scope: "remote-access" });
  }

  session(access: Access): SessionInfo {
    if (access.kind === "host") return { access: "host", remoteAccess: this.store.enabled };
    if (access.kind === "device") return { access: "device", remoteAccess: true, device: access.device };
    return { access: "none" };
  }

  async status(access: Access): Promise<RemoteAccessStatus> {
    const enabled = this.store.enabled;
    const tailscale = enabled ? await this.tailscaleInfo() : null;
    return {
      enabled,
      listenError: enabled ? (this.listener?.listenError ?? null) : null,
      addresses: enabled ? this.addresses(tailscale) : [],
      tailscaleServeCommand: tailscale && !tailscale.httpsUrl ? `tailscale serve --bg ${this.options.uiPort}` : null,
      pairing: access.kind === "host" ? this.store.pairing() : null,
      devices: this.store.devices(),
    };
  }

  /** Best first: tailscale serve's https address works anywhere, then the LAN, then the plain tailnet one. */
  private addresses(tailscale: TailscaleInfo | null): RemoteAddress[] {
    const port = this.options.uiPort;
    const interfaces = reachableAddresses(this.options.interfaces?.());
    const addresses: RemoteAddress[] = [];
    if (tailscale?.httpsUrl) addresses.push({ kind: "tailscale-https", url: tailscale.httpsUrl });
    for (const { address, tailnet } of interfaces) {
      if (!tailnet) addresses.push({ kind: "lan", url: `http://${address}:${port}` });
    }
    if (tailscale) addresses.push({ kind: "tailscale", url: `http://${tailscale.dnsName}:${port}` });
    else {
      for (const { address, tailnet } of interfaces) {
        if (tailnet) addresses.push({ kind: "tailscale", url: `http://${address}:${port}` });
      }
    }
    return addresses;
  }

  private tailscaleInfo(): Promise<TailscaleInfo | null> {
    const now = Date.now();
    if (!this.tailscale || now - this.tailscale.at > TAILSCALE_CACHE_MS) {
      this.tailscale = { at: now, info: detectTailscale(this.options.uiPort, this.options.tailscale ?? runTailscale) };
    }
    return this.tailscale.info;
  }
}
