import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatSandboxAddress, isPrivateAddress, parseSandboxAddress } from "./address.js";

describe("sandbox addresses", () => {
  it("accepts loopback, private, link-local, tailnet and fd00::/8 addresses only", () => {
    for (const host of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.10", "169.254.10.1", "100.64.0.1", "::1", "fe80::1", "fd7a:115c:a1e0::1"]) {
      assert.ok(isPrivateAddress(host), host);
    }
    for (const host of ["8.8.8.8", "0.0.0.0", "172.32.0.1", "100.128.0.1", "::", "2001:db8::1", "fc00::1", "localhost", "sandbox.example"]) {
      assert.ok(!isPrivateAddress(host), host);
    }
  });

  it("reads IP addresses with a port and refuses host names", () => {
    assert.deepEqual(parseSandboxAddress("100.64.0.10:7443"), { host: "100.64.0.10", port: 7443 });
    assert.deepEqual(parseSandboxAddress(" [FD7A:115C:A1E0::10]:7443 "), { host: "fd7a:115c:a1e0::10", port: 7443 });
    for (const value of ["sandbox.local:7443", "10.0.0.1", "10.0.0.1:70000", "[fd00::1]", 7443, undefined, "1".repeat(70) + ":1"]) {
      assert.equal(parseSandboxAddress(value), undefined, String(value));
    }
    assert.equal(formatSandboxAddress({ host: "fd00::1", port: 7443 }), "[fd00::1]:7443");
    assert.equal(formatSandboxAddress({ host: "10.0.0.1", port: 7443 }), "10.0.0.1:7443");
  });
});
