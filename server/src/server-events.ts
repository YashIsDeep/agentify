import { EventEmitter } from "node:events";
import type { SettingsScope } from "@wm/shared";

/** Events about the server as a whole rather than one workspace's engine. Every open stream gets them. */
export type ServerWideEvent =
  | { type: "settings.changed"; scope: SettingsScope }
  /** A paired device lost access (null: every device did), so its open streams must end. */
  | { type: "access.revoked"; deviceId: string | null };

export class ServerEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  on(listener: (event: ServerWideEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  publish(event: ServerWideEvent): void {
    this.emitter.emit("event", event);
  }
}
