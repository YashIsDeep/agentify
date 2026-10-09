import type { DeviceInfo } from "@wm/shared";

/** Who a request is from, as the server's gate decided: this computer, a paired device, or neither. */
export type Access = { kind: "host" } | { kind: "device"; device: DeviceInfo } | { kind: "none" };

const admitted = new WeakSet<Access>();

/** Marks a verdict as the gate's own. */
export function admit(access: Access): Access {
  admitted.add(access);
  return access;
}

/**
 * The gate's verdict on a request it forwarded to a workspace. It travels in the request's env,
 * which nothing in an HTTP request can reach, and only objects the gate created count.
 */
export function admittedAccess(env: unknown): Access | undefined {
  const access = (env as { access?: unknown } | undefined)?.access;
  return typeof access === "object" && access !== null && admitted.has(access as Access) ? (access as Access) : undefined;
}
