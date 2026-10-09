/**
 * Using Agentify from another device. The computer running it (the host) pairs your phone or
 * laptop once; the server tells each request apart by where it came from. See DESIGN.md §10.
 */
import { z } from "zod";

/** Who is asking: this computer's own browser, a paired device, or a device that hasn't paired. */
export type SessionInfo =
  | { access: "host"; remoteAccess: boolean }
  | { access: "device"; remoteAccess: true; device: DeviceInfo }
  | { access: "none" };

export interface DeviceInfo {
  id: string;
  /** From the browser that paired, e.g. "iPhone · Safari". */
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface PairingInfo {
  /** Eight characters, shown as XXXX-XXXX. Good for one device. */
  code: string;
  expiresAt: number;
}

/** `tailscale-https` is `tailscale serve`'s address; `tailscale` the plain tailnet one. */
export type RemoteAddressKind = "tailscale-https" | "lan" | "tailscale";

export interface RemoteAddress {
  kind: RemoteAddressKind;
  url: string;
}

export interface RemoteAccessStatus {
  enabled: boolean;
  /** Why the server couldn't listen on the network, e.g. another program holds the port there. */
  listenError: string | null;
  /** Where another device can open the app, best first. Empty while remote access is off. */
  addresses: RemoteAddress[];
  /** The command that gives this computer an https tailnet address, when Tailscale runs without one. */
  tailscaleServeCommand: string | null;
  /** The code waiting to be used. Only the host sees it. */
  pairing: PairingInfo | null;
  devices: DeviceInfo[];
}

export const remoteAccessUpdateSchema = z.object({ enabled: z.boolean() });
export const pairDeviceSchema = z.object({ code: z.string().trim().min(1).max(32) });

/** Settings that, changed on one device, are pushed to every open screen so none shows stale values. */
export const SETTINGS_SCOPES = ["workspaces", "concurrency", "remote-access", "agents", "connections", "ticket-draft"] as const;
export type SettingsScope = (typeof SETTINGS_SCOPES)[number];

/** Crockford's base32: no I, L, O or U, so a code read off a screen can't be mistyped as another. */
export const PAIRING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIRING_CODE_LENGTH = 8;

/** Forgives what people type: case, spaces, the dash, and O / I / L for 0 / 1 / 1. */
export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

export const formatPairingCode = (code: string): string =>
  code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;

/** A pairing link carries its code in the fragment, which browsers never send to the server. */
export const PAIR_LINK_KEY = "pair";
export const pairingLink = (address: string, code: string): string => `${address}/#${PAIR_LINK_KEY}=${formatPairingCode(code)}`;
