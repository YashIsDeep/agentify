import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import {
  type DeviceInfo,
  normalizePairingCode,
  PAIRING_ALPHABET,
  PAIRING_CODE_LENGTH,
  type PairingInfo,
} from "@wm/shared";
import { z } from "zod";
import { EngineError } from "../engine/engine";
import { writePrivateFile } from "../lib/atomic-file";

/** How long a pairing code waits to be used. */
export const PAIRING_TTL_MS = 10 * 60_000;
/** Wrong codes allowed before the waiting one is thrown away; guessing 1 in 32⁸ five times gets nowhere. */
export const PAIRING_MAX_FAILURES = 5;
/** A device unused for this long has to pair again. */
export const DEVICE_IDLE_MS = 30 * 24 * 60 * 60_000;
/** Last-seen times change on every request; the file only needs them this fresh. */
const LAST_SEEN_WRITE_MS = 10 * 60_000;

const deviceSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  /** SHA-256 of the cookie's token. The token itself is never stored. */
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.number(),
  lastSeenAt: z.number(),
});
type DeviceRecord = z.infer<typeof deviceSchema>;
const fileSchema = z.object({ version: z.literal(1), enabled: z.boolean(), devices: z.array(deviceSchema) });

export type RemoteAccessEvent =
  /** The switch, the waiting code or the device list changed. */
  | { type: "changed" }
  /** Requests from this device (null: from every device) must stop, open streams included. */
  | { type: "revoked"; deviceId: string | null };

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Whether other devices may connect, which ones have paired, and the one pairing code that may be
 * waiting. Kept in `remote-access.json` beside the workspace catalog: it belongs to the server, not
 * to a workspace, so cloning a workspace never copies a device.
 */
export class RemoteAccessStore {
  private enabledFlag = false;
  private records: DeviceRecord[] = [];
  /** When each device's last-seen time was last written, so busy devices don't rewrite the file. */
  private readonly written = new Map<string, number>();
  private waiting: { code: string; expiresAt: number; failures: number } | null = null;
  private readonly emitter = new EventEmitter();

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    this.emitter.setMaxListeners(0);
    if (!existsSync(file)) return;
    try {
      const saved = fileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      this.enabledFlag = saved.enabled;
      this.records = saved.devices;
      for (const record of this.records) this.written.set(record.id, record.lastSeenAt);
    } catch (error) {
      // Fail closed: nothing gets in until the switch is turned on again, which rewrites the file.
      console.warn(`Ignoring unreadable ${file}; remote access stays off.`, error);
    }
  }

  get enabled(): boolean {
    return this.enabledFlag;
  }

  on(listener: (event: RemoteAccessEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabledFlag) return;
    this.enabledFlag = enabled;
    if (!enabled) this.waiting = null;
    this.persist();
    this.emit({ type: "changed" });
    // Paired devices stay paired, but nothing of theirs may keep running while the switch is off.
    if (!enabled) this.emit({ type: "revoked", deviceId: null });
  }

  devices(): DeviceInfo[] {
    this.forgetIdle();
    return [...this.records].sort((a, b) => b.lastSeenAt - a.lastSeenAt).map(toInfo);
  }

  /** The code waiting to be used, if it hasn't expired. */
  pairing(): PairingInfo | null {
    if (this.waiting && this.waiting.expiresAt <= this.now()) this.waiting = null;
    return this.waiting && { code: this.waiting.code, expiresAt: this.waiting.expiresAt };
  }

  /** A fresh code replaces any code still waiting, so only one is ever valid. */
  startPairing(): PairingInfo {
    if (!this.enabledFlag) throw new EngineError("Turn on remote access before pairing a device", 409);
    const code = Array.from({ length: PAIRING_CODE_LENGTH }, () => PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)]).join("");
    this.waiting = { code, expiresAt: this.now() + PAIRING_TTL_MS, failures: 0 };
    this.emit({ type: "changed" });
    return { code, expiresAt: this.waiting.expiresAt };
  }

  /** With a code, only that code: a dialog closing late must not cancel the one a newer dialog shows. */
  cancelPairing(code?: string): void {
    if (!this.waiting || (code !== undefined && normalizePairingCode(code) !== this.waiting.code)) return;
    this.waiting = null;
    this.emit({ type: "changed" });
  }

  /** Trades the waiting code for a device and the token its cookie will carry. */
  redeem(typed: string, userAgent: string | undefined): { device: DeviceInfo; token: string } {
    const waiting = this.pairing() && this.waiting;
    if (!this.enabledFlag || !waiting) {
      throw new EngineError("No pairing code is waiting. Start pairing again on the computer running Agentify.", 409);
    }
    const expected = Buffer.from(waiting.code);
    const given = Buffer.from(normalizePairingCode(typed));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      waiting.failures += 1;
      if (waiting.failures >= PAIRING_MAX_FAILURES) {
        this.waiting = null;
        this.emit({ type: "changed" });
        throw new EngineError("Too many wrong codes. Start pairing again on the computer running Agentify.", 409);
      }
      throw new EngineError("That code doesn't match. Check it and try again.", 400);
    }
    this.waiting = null;
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const record: DeviceRecord = { id: randomUUID(), name: deviceName(userAgent), tokenHash: hashToken(token), createdAt: now, lastSeenAt: now };
    this.records.push(record);
    this.persist();
    this.emit({ type: "changed" });
    return { device: toInfo(record), token };
  }

  /** The device a cookie's token belongs to. Using it counts as being seen. */
  authenticate(token: string | undefined): DeviceInfo | null {
    if (!this.enabledFlag || !token) return null;
    const hash = hashToken(token);
    const record = this.records.find((candidate) => candidate.tokenHash === hash);
    if (!record) return null;
    const now = this.now();
    if (now - record.lastSeenAt > DEVICE_IDLE_MS) {
      this.forgetIdle();
      return null;
    }
    record.lastSeenAt = now;
    if (now - (this.written.get(record.id) ?? 0) >= LAST_SEEN_WRITE_MS) this.persist();
    return toInfo(record);
  }

  remove(id: string): void {
    const index = this.records.findIndex((record) => record.id === id);
    if (index < 0) throw new EngineError("Device not found", 404);
    this.records.splice(index, 1);
    this.written.delete(id);
    this.persist();
    this.emit({ type: "changed" });
    this.emit({ type: "revoked", deviceId: id });
  }

  private forgetIdle(): void {
    const cutoff = this.now() - DEVICE_IDLE_MS;
    const idle = this.records.filter((record) => record.lastSeenAt < cutoff);
    if (!idle.length) return;
    this.records = this.records.filter((record) => record.lastSeenAt >= cutoff);
    for (const record of idle) this.written.delete(record.id);
    this.persist();
    this.emit({ type: "changed" });
    for (const record of idle) this.emit({ type: "revoked", deviceId: record.id });
  }

  private persist(): void {
    writePrivateFile(this.file, JSON.stringify({ version: 1, enabled: this.enabledFlag, devices: this.records }, null, 2));
    for (const record of this.records) this.written.set(record.id, record.lastSeenAt);
  }

  private emit(event: RemoteAccessEvent): void {
    this.emitter.emit("event", event);
  }
}

const toInfo = ({ id, name, createdAt, lastSeenAt }: DeviceRecord): DeviceInfo => ({ id, name, createdAt, lastSeenAt });

/** "iPhone · Safari" from a User-Agent: what you'd call the device when deciding which to remove. */
export function deviceName(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  // Order matters: an iPhone claims to be "like Mac OS X", Android is Linux, and most browsers say Chrome and Safari.
  const os = /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) ? "iPad"
    : /Android/.test(ua) ? "Android"
    : /CrOS/.test(ua) ? "Chromebook"
    : /Windows/.test(ua) ? "Windows"
    : /Macintosh|Mac OS X/.test(ua) ? "Mac"
    : /Linux/.test(ua) ? "Linux"
    : null;
  const browser = /Edg(?:A|iOS)?\//.test(ua) ? "Edge"
    : /OPR\/|OPT\//.test(ua) ? "Opera"
    : /SamsungBrowser\//.test(ua) ? "Samsung Internet"
    : /Firefox\/|FxiOS\//.test(ua) ? "Firefox"
    : /Chrome\/|CriOS\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : null;
  return [os, browser].filter(Boolean).join(" · ") || "Unknown device";
}
