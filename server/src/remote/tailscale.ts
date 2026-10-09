import { execCli, resolveCli } from "../agents/resolve";

export interface TailscaleInfo {
  /** This machine's MagicDNS name, e.g. "pc.tailnet-1234.ts.net". */
  dnsName: string;
  /** `tailscale serve`'s https address when it proxies to this server; null when it doesn't. */
  httpsUrl: string | null;
}

/** Runs `tailscale <args>` and returns its stdout, or null when it isn't installed, running or happy. */
export type TailscaleCli = (args: string[]) => Promise<string | null>;

const INSTALL_LOCATIONS = [
  "C:\\Program Files\\Tailscale\\tailscale.exe",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

export const runTailscale: TailscaleCli = async (args) => {
  try {
    const cli = resolveCli("tailscale", null, INSTALL_LOCATIONS);
    if (!cli) return null;
    const result = await execCli(cli, args, 3000);
    return result.code === 0 ? result.stdout : null;
  } catch {
    return null;
  }
};

const LOCAL_PROXY_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * What Tailscale offers this server: the tailnet name it can be opened on, and whether
 * `tailscale serve` already gives it an https address. Null without a running Tailscale.
 */
export async function detectTailscale(port: number, cli: TailscaleCli = runTailscale): Promise<TailscaleInfo | null> {
  const status = parse(await cli(["status", "--json"])) as { BackendState?: unknown; Self?: { DNSName?: unknown } } | null;
  if (status?.BackendState !== "Running" || typeof status.Self?.DNSName !== "string") return null;
  const dnsName = status.Self.DNSName.replace(/\.$/, "");
  if (!dnsName) return null;

  // { Web: { "pc.tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:2712" } } } } }
  const serve = parse(await cli(["serve", "status", "--json"])) as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }> } | null;
  let httpsUrl: string | null = null;
  for (const [hostPort, site] of Object.entries(serve?.Web ?? {})) {
    const [host, servedPort] = splitHostPort(hostPort);
    const root = site?.Handlers?.["/"]?.Proxy;
    if (host.toLowerCase() !== dnsName.toLowerCase() || typeof root !== "string" || !proxiesTo(root, port)) continue;
    httpsUrl = servedPort === "443" ? `https://${dnsName}` : `https://${dnsName}:${servedPort}`;
    break;
  }
  return { dnsName, httpsUrl };
}

function proxiesTo(target: string, port: number): boolean {
  try {
    const url = new URL(target.includes("://") ? target : `http://${target}`);
    return url.protocol === "http:" && LOCAL_PROXY_HOSTS.has(url.hostname) && url.port === String(port);
  } catch {
    return false;
  }
}

function splitHostPort(hostPort: string): [string, string] {
  const at = hostPort.lastIndexOf(":");
  return at < 0 ? [hostPort, "443"] : [hostPort.slice(0, at), hostPort.slice(at + 1)];
}

function parse(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
