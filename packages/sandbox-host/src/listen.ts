import { BlockList, isIP } from "node:net";

import { SandboxRefusal } from "./refusal.js";

/**
 * Where the pairing API may listen: this machine, a private network, a
 * link-local address or a tailnet. Never an address that is reachable
 * from the internet.
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

export interface ListenAddress {
  host: string;
  port: number;
}

export function isPrivateListenHost(host: string): boolean {
  const family = isIP(host);
  if (family === 0) return false;
  return PRIVATE.check(host, family === 4 ? "ipv4" : "ipv6");
}

/**
 * Reads `<IPv4>:<port>` or `[<IPv6>]:<port>`. Host names are refused, so
 * what is checked is what is bound. Port 0 picks a free port.
 */
export function parseListenAddress(value: string, field = "pairing.listen"): ListenAddress {
  const match = /^(?:\[([0-9A-Fa-f:.]+)\]|(\d{1,3}(?:\.\d{1,3}){3})):(\d{1,5})$/.exec(value.trim());
  const host = match?.[1] ?? match?.[2];
  const port = match ? Number(match[3]) : Number.NaN;
  if (!match || !host || isIP(host) === 0 || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new SandboxRefusal(
      "config-invalid",
      `Sandbox config field "${field}" must be an IP address and port, such as 100.64.0.10:7443 or [fd7a:115c:a1e0::10]:7443.`,
    );
  }
  assertPrivateListenAddress(host, field);
  return { host: host.toLowerCase(), port };
}

export function assertPrivateListenAddress(host: string, field = "pairing.listen"): void {
  if (!isPrivateListenHost(host)) {
    throw new SandboxRefusal(
      "listen-address-not-private",
      `Sandbox config field "${field}" is ${host}, which is not a private address. The pairing API listens only on loopback, a private network (10/8, 172.16/12, 192.168/16), link-local, a tailnet (100.64/10) or fd00::/8.`,
    );
  }
}
