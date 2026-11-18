import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TemplateStep } from "@openadminos/agent-sdk";

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assertSteps, manifestSha256, releaseAgentsRoot, resolveSandboxAgent } from "./agents.js";
import { SandboxRefusal } from "./refusal.js";
import { bundledHash, tempDir } from "./test-support.js";

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

  it("finds the agents folder from the host package, not the current directory", () => {
    const { dir, cleanup } = tempDir();
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      mkdirSync(join(dir, "agents", "find-inactive-devices"), { recursive: true });
      writeFileSync(join(dir, "agents", "find-inactive-devices", "manifest.yaml"), "not the bundled agent");
      const resolved = resolveSandboxAgent({ id: "find-inactive-devices", templateSha256: bundledHash("find-inactive-devices"), intervalSeconds: 3600 });
      assert.equal(resolved.agent.registryPath, "agents/find-inactive-devices");
      assert.throws(() => releaseAgentsRoot(dir), (error: unknown) => error instanceof SandboxRefusal && error.reason === "agent-not-found");
    } finally {
      process.chdir(cwd);
      cleanup();
    }
  });

  it("reports a changed manifest that no longer parses as a hash mismatch", () => {
    const { dir, cleanup } = tempDir();
    try {
      mkdirSync(join(dir, "broken-agent"));
      writeFileSync(join(dir, "broken-agent", "manifest.yaml"), "descriptor: [unclosed");
      assert.throws(
        () => resolveSandboxAgent({ id: "broken-agent", templateSha256: "0".repeat(64), intervalSeconds: 3600 }, { agentsRoot: dir }),
        (error: unknown) => error instanceof SandboxRefusal && error.reason === "agent-hash-mismatch",
      );
      const pinned = manifestSha256(Buffer.from("descriptor: [unclosed"));
      assert.throws(
        () => resolveSandboxAgent({ id: "broken-agent", templateSha256: pinned, intervalSeconds: 3600 }, { agentsRoot: dir }),
        (error: unknown) => error instanceof SandboxRefusal && error.reason === "agent-manifest-invalid",
      );
    } finally {
      cleanup();
    }
  });

  it("refuses write agents, script agents and unknown agents", () => {
    assert.equal(reasonOf("stale-guest-cleanup").reason, "agent-not-read");
    assert.equal(reasonOf("intune-device-posture-auditor").reason, "agent-not-template");
    assert.equal(reasonOf("no-such-agent", "0".repeat(64)).reason, "agent-not-found");
  });
});
