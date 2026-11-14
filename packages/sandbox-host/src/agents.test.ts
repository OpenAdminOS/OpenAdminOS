import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TemplateStep } from "@openadminos/agent-sdk";

import { assertSteps, resolveSandboxAgent } from "./agents.js";
import { SandboxRefusal } from "./refusal.js";
import { bundledHash } from "./test-support.js";

function reasonOf(id: string, templateSha256 = bundledHash(id)): { reason: string; message: string } {
  try {
    resolveSandboxAgent({ id, templateSha256, intervalSeconds: 3600 });
  } catch (error) {
    assert.ok(error instanceof SandboxRefusal);
    return { reason: error.reason, message: error.message };
  }
  return { reason: "accepted", message: "" };
}

describe("resolveSandboxAgent", () => {
  it("accepts a bundled read template agent with its pinned hash", () => {
    const resolved = resolveSandboxAgent({ id: "find-inactive-devices", templateSha256: bundledHash("find-inactive-devices"), intervalSeconds: 3600 });
    assert.equal(resolved.agent.mode, "read");
    assert.deepEqual(resolved.agent.scopes, ["DeviceManagementManagedDevices.Read.All"]);
    assert.equal(resolved.module.mode, "read", "the module is built from the hashed text");
  });

  it("refuses a changed manifest and shows both hashes", () => {
    const pinned = "0".repeat(64);
    const { reason, message } = reasonOf("find-inactive-devices", pinned);
    assert.equal(reason, "agent-hash-mismatch");
    assert.ok(message.includes(pinned));
    assert.ok(message.includes(bundledHash("find-inactive-devices")));
  });

  it("requires a literal first path segment in every Graph step", () => {
    const graphStep = (path: string, method = "GET") => [{ id: "s", format: "graph", label: "", settings: { method, path, scopes: [] } }] as unknown as TemplateStep[];
    for (const path of ["/{{ x }}", "{{ x }}", "/ {{ x }}", "/$batch", "/me", "/me/messages", "/{{x}}/users"]) {
      assert.throws(() => assertSteps("Agent", graphStep(path)), (error: unknown) => error instanceof SandboxRefusal && error.reason === "agent-step-not-allowed", path);
    }
    assert.throws(() => assertSteps("Agent", graphStep("/users", "POST")), SandboxRefusal);
    for (const path of ["/users", "/users/{{ item.id }}", "/deviceManagement/managedDevices", "/servicePrincipals?$top=5", "/identity/conditionalAccess/policies"]) {
      assertSteps("Agent", graphStep(path));
    }
  });

  it("refuses write agents, script agents and unknown agents", () => {
    assert.equal(reasonOf("stale-guest-cleanup").reason, "agent-not-read");
    assert.equal(reasonOf("intune-device-posture-auditor").reason, "agent-not-template");
    assert.equal(reasonOf("no-such-agent", "0".repeat(64)).reason, "agent-not-found");
  });
});
