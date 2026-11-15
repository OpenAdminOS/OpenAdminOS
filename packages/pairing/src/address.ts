import { BlockList, isIP } from "node:net";

/**
 * Where a sandbox may listen and where a desktop may connect for pairing:
 * this machine, a private network, a link-local address, a tailnet or
 * fd00::/8. Never an address that is reachable from the internet. The
 * sandbox host and the desktop use the same rules.
 */
const PRIVATE = new BlockList();
PRIVATE.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE.addSubnet("169.254.0.0", 16, "ipv4");
// Carrier-grade NAT space, which tailnets such as Tailscale use.
PRIVATE.addSubnet("100.64.0.0", 10, "ipv4");
PRIVATE.addAddress("::1", "ipv6");
PRIVATE.addSubnet("fe80::", 10, "ipv6");
// Unique local addresses with the local bit set, which tailnets use too.
PRIVATE.addSubnet("fd00::", 8, "ipv6");

/** Loopback, 10/8, 172.16/12, 192.168/16, link-local, 100.64/10 or fd00::/8. Host names are not addresses. */
export function isPrivateAddress(host: string): boolean {
  const family = isIP(host);
  if (family === 0) return false;
  return PRIVATE.check(host, family === 4 ? "ipv4" : "ipv6");
}

export interface SandboxAddress {
  /** An IP address, lower case. */
  host: string;
  port: number;
}

/**
 * Reads `<IPv4>:<port>` or `[<IPv6>]:<port>`. Host names are refused, so
 * what is checked is what is reached. Returns undefined for anything
 * else; whether the address is private is checked separately.
 */
export function parseSandboxAddress(value: unknown): SandboxAddress | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const match = /^(?:\[([0-9A-Fa-f:.]+)\]|(\d{1,3}(?:\.\d{1,3}){3})):(\d{1,5})$/.exec(value.trim());
  const host = match?.[1] ?? match?.[2];
  const port = match ? Number(match[3]) : Number.NaN;
  if (!match || !host || isIP(host) === 0 || !Number.isInteger(port) || port < 0 || port > 65_535) return undefined;
  return { host: host.toLowerCase(), port };
}

/** `<host>:<port>` with IPv6 in brackets, as `parseSandboxAddress` reads it. */
export function formatSandboxAddress(address: SandboxAddress): string {
  return isIP(address.host) === 6 ? `[${address.host}]:${address.port}` : `${address.host}:${address.port}`;
}
