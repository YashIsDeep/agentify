import type { Server } from "node:http";
import { serve } from "@hono/node-server";

type Fetch = Parameters<typeof serve>[0]["fetch"];

/**
 * The listener remote access adds: every interface, on the app's own port. The 127.0.0.1 one never
 * closes, so flipping the switch never drops this computer's own tab; closing this one ends every
 * connection it accepted.
 */
export class NetworkListener {
  private server: Server | null = null;
  private error: string | null = null;
  /** Opens and closes run one after another, however fast the switch is flipped. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: { fetch: Fetch; port: number; hostname?: string }) {}

  /** Why the last attempt to listen failed, while the switch is on. */
  get listenError(): string | null {
    return this.error;
  }

  get listening(): boolean {
    return this.server !== null;
  }

  set(open: boolean): Promise<void> {
    this.queue = this.queue.then(() => (open ? this.open() : this.close()));
    return this.queue;
  }

  private async open(): Promise<void> {
    if (this.server) return;
    const hostname = this.options.hostname ?? "0.0.0.0";
    const server = serve({ fetch: this.options.fetch, hostname, port: this.options.port }) as Server;
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => {
          server.off("listening", listening);
          reject(error);
        };
        const listening = () => {
          server.off("error", failed);
          resolve();
        };
        server.once("error", failed);
        server.once("listening", listening);
      });
      server.on("error", (error) => console.error("Remote access listener:", error));
      this.server = server;
      this.error = null;
      console.log(`Remote access: listening on http://${hostname}:${this.options.port}`);
    } catch (error) {
      server.close();
      const code = (error as NodeJS.ErrnoException).code;
      this.error = code === "EADDRINUSE"
        ? `Another program is using port ${this.options.port} on this computer's network addresses.`
        : `Couldn't listen on the network: ${(error as Error).message}`;
      console.error(`Remote access: ${this.error}`);
    }
  }

  private async close(): Promise<void> {
    this.error = null;
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Open streams would otherwise keep a phone connected after the switch went off.
      server.closeAllConnections();
    });
  }
}
