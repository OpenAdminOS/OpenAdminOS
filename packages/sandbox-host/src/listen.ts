import { isPrivateAddress, parseSandboxAddress } from "@openadminos/pairing";

import { SandboxRefusal } from "./refusal.js";

export interface ListenAddress {
  host: string;
  port: number;
}

/** The address rules are in `@openadminos/pairing`, shared with the desktop. */
export function isPrivateListenHost(host: string): boolean {
  return isPrivateAddress(host);
}

/**
 * Reads `<IPv4>:<port>` or `[<IPv6>]:<port>`. Host names are refused, so
 * what is checked is what is bound. Port 0 picks a free port.
 */
export function parseListenAddress(value: string, field = "pairing.listen"): ListenAddress {
  const address = parseSandboxAddress(value);
  if (!address) {
    throw new SandboxRefusal(
      "config-invalid",
      `Sandbox config field "${field}" must be an IP address and port, such as 100.64.0.10:7443 or [fd7a:115c:a1e0::10]:7443.`,
    );
  }
  assertPrivateListenAddress(address.host, field);
  return address;
}

export function assertPrivateListenAddress(host: string, field = "pairing.listen"): void {
  if (!isPrivateListenHost(host)) {
    throw new SandboxRefusal(
      "listen-address-not-private",
      `Sandbox config field "${field}" is ${host}, which is not a private address. The pairing API listens only on loopback, a private network (10/8, 172.16/12, 192.168/16), link-local, a tailnet (100.64/10) or fd00::/8.`,
    );
  }
}
