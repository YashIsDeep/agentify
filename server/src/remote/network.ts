import { BlockList, isIP } from "node:net";
import { type NetworkInterfaceInfo, networkInterfaces } from "node:os";

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

const tailnet = new BlockList();
// Tailscale hands out CGNAT addresses, and IPv6 ones from its own ULA prefix.
tailnet.addSubnet("100.64.0.0", 10, "ipv4");
tailnet.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

const linkLocal = new BlockList();
linkLocal.addSubnet("169.254.0.0", 16, "ipv4");
linkLocal.addSubnet("fe80::", 10, "ipv6");

/** Addresses no one on the internet can have: this machine, the LAN, a tailnet. */
const privateNetworks = new BlockList();
for (const [network, prefix] of [["127.0.0.0", 8], ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10], ["169.254.0.0", 16]] as const) {
  privateNetworks.addSubnet(network, prefix, "ipv4");
}
privateNetworks.addAddress("::1", "ipv6");
privateNetworks.addSubnet("fc00::", 7, "ipv6");
privateNetworks.addSubnet("fe80::", 10, "ipv6");

const familyOf = (address: string) => (isIP(address) === 6 ? "ipv6" : "ipv4");

/**
 * An address as a socket or a proxy wrote it, reduced to the bare IP: no brackets, zone id or port,
 * and IPv4-mapped IPv6 (`::ffff:192.168.1.5`) as the IPv4 it is. Null when it isn't an IP at all.
 */
export function normalizeAddress(raw: string): string | null {
  let address = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  if (bracketed) address = bracketed[1]!;
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(address);
  if (withPort) address = withPort[1]!;
  const zone = address.indexOf("%");
  if (zone >= 0) address = address.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) address = mapped[1]!;
  return isIP(address) ? address.toLowerCase() : null;
}

export const isLoopbackAddress = (address: string): boolean => loopback.check(address, familyOf(address));
export const isTailnetAddress = (address: string): boolean => tailnet.check(address, familyOf(address));
export const isPrivateAddress = (address: string): boolean => privateNetworks.check(address, familyOf(address));

/**
 * Where a request really came from. A proxy on this machine (`tailscale serve`, the Vite dev server,
 * or one in front of the other) connects from loopback and appends who connected to it to
 * X-Forwarded-For, so the last hop that isn't this machine is the device; hops further left were
 * written by the device itself and prove nothing. A peer that isn't loopback is the device.
 *
 * Undefined when there is no socket (a request made in-process, as tests do); null when an address
 * can't be read, which callers treat as coming from somewhere unknown.
 */
export function clientAddress(peer: string | undefined, forwardedFor: string | undefined): string | null | undefined {
  if (peer === undefined) return undefined;
  const direct = normalizeAddress(peer);
  if (direct === null || !isLoopbackAddress(direct) || forwardedFor === undefined) return direct;
  const hops = forwardedFor.split(",");
  for (let index = hops.length - 1; index >= 0; index--) {
    const hop = normalizeAddress(hops[index]!);
    if (hop === null || !isLoopbackAddress(hop)) return hop;
  }
  return direct;
}

/** Virtual switches for VMs and containers: addresses no phone could reach. */
const VIRTUAL_ADAPTER = /vEthernet|VirtualBox|VMware|Hyper-V|Docker|WSL|vboxnet|vmnet|virbr|veth|^br-/i;

/**
 * IPv4 addresses another device could open this computer on: private, not link-local, and not on a
 * virtual adapter. Tailscale's own interface counts, marked as such.
 */
export function reachableAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): { address: string; tailnet: boolean }[] {
  const found: { address: string; tailnet: boolean }[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (VIRTUAL_ADAPTER.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (!isPrivateAddress(entry.address) || linkLocal.check(entry.address, "ipv4") || isLoopbackAddress(entry.address)) continue;
      found.push({ address: entry.address, tailnet: isTailnetAddress(entry.address) });
    }
  }
  return found;
}
