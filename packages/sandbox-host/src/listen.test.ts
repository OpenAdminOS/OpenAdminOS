import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parseSandboxConfig } from "./config.js";
import { isPrivateListenHost, parseListenAddress } from "./listen.js";
import { SandboxRefusal } from "./refusal.js";
import { tempDir, writeConfig } from "./test-support.js";

function reasonOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof SandboxRefusal);
    return error.reason;
  }
  return "accepted";
}

describe("pairing listen address", () => {
  it("accepts loopback, private, link-local, tailnet and fd00::/8 addresses", () => {
    for (const host of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.10", "169.254.10.1", "100.64.0.1", "100.127.255.254", "::1", "fe80::1", "fd7a:115c:a1e0::1"]) {
      assert.ok(isPrivateListenHost(host), host);
    }
    assert.deepEqual(parseListenAddress("100.64.0.10:7443"), { host: "100.64.0.10", port: 7443 });
    assert.deepEqual(parseListenAddress("[FD7A:115C:A1E0::10]:0"), { host: "fd7a:115c:a1e0::10", port: 0 });
  });

  it("refuses a public or unspecified address with listen-address-not-private", () => {
    for (const value of ["8.8.8.8:7443", "0.0.0.0:7443", "172.32.0.1:7443", "100.128.0.1:7443", "[::]:7443", "[2001:db8::1]:7443", "[fc00::1]:7443"]) {
      assert.equal(reasonOf(() => parseListenAddress(value)), "listen-address-not-private", value);
    }
  });

  it("refuses host names and malformed values as config-invalid", () => {
    for (const value of ["localhost:7443", "sandbox.local:7443", "127.0.0.1", "127.0.0.1:70000", "::1:7443", "[::1]", "300.1.1.1:1"]) {
      assert.equal(reasonOf(() => parseListenAddress(value)), "config-invalid", value);
    }
  });

  it("is optional in the config and checked when present", () => {
    const { dir, cleanup } = tempDir();
    try {
      const base = JSON.parse(readFileSync(writeConfig(dir), "utf8")) as Record<string, unknown>;
      assert.equal(parseSandboxConfig(base, `${dir}/sandbox.json`).pairing, undefined);
      assert.deepEqual(parseSandboxConfig({ ...base, pairing: { listen: "127.0.0.1:7443" } }, `${dir}/sandbox.json`).pairing, { listen: { host: "127.0.0.1", port: 7443 } });
      assert.equal(reasonOf(() => parseSandboxConfig({ ...base, pairing: { listen: "8.8.8.8:7443" } }, `${dir}/sandbox.json`)), "listen-address-not-private");
      assert.equal(reasonOf(() => parseSandboxConfig({ ...base, pairing: { listen: "127.0.0.1:7443", open: true } }, `${dir}/sandbox.json`)), "config-invalid");
      // A paired sandbox may run assigned schedules only; without pairing, no agent is refused by name.
      assert.deepEqual(parseSandboxConfig({ ...base, agents: [], pairing: { listen: "127.0.0.1:7443" } }, `${dir}/sandbox.json`).agents, []);
      assert.equal(reasonOf(() => parseSandboxConfig({ ...base, agents: [] }, `${dir}/sandbox.json`)), "config-no-agents");
      assert.equal(reasonOf(() => parseSandboxConfig({ ...base, agents: "all" }, `${dir}/sandbox.json`)), "config-invalid");
    } finally {
      cleanup();
    }
  });
});
