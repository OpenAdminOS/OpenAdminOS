import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadSandboxConfig, parseSandboxConfig } from "./config.js";
import { SandboxRefusal } from "./refusal.js";
import { CLIENT, TENANT, tempDir, writeConfig } from "./test-support.js";

const valid = {
  version: 1,
  sandbox: { id: "mini-pc", name: "Office mini PC" },
  organizationId: "org-1",
  tenantId: TENANT,
  clientId: CLIENT,
  certificates: [{ certificatePath: "sandbox.crt", privateKeyPath: "sandbox.key" }],
  model: { provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "llama3.1:8b" },
  dataDir: "data",
  agents: [{ id: "find-inactive-devices", templateSha256: "a".repeat(64), intervalSeconds: 3600 }],
};

function refusalMessage(value: unknown): string {
  try {
    parseSandboxConfig(value, "/etc/openadminos/sandbox.json");
  } catch (error) {
    assert.ok(error instanceof SandboxRefusal);
    assert.equal(error.reason, "config-invalid");
    return error.message;
  }
  assert.fail("expected a refusal");
}

describe("sandbox config", () => {
  it("accepts a valid config and resolves paths next to the config", () => {
    const config = parseSandboxConfig(valid, "/etc/openadminos/sandbox.json");
    assert.equal(config.certificates[0]?.privateKeyPath, "/etc/openadminos/sandbox.key");
    assert.equal(config.secretsPath, "/etc/openadminos/secrets.json");
    assert.equal(config.runDeadlineSeconds, 1800);
    assert.equal(config.agents[0]?.delivery, undefined);
  });

  it("names the field of every problem", () => {
    assert.match(refusalMessage({ ...valid, tenantId: "contoso" }), /"tenantId"/);
    assert.match(refusalMessage({ ...valid, organizationId: "" }), /"organizationId"/);
    assert.match(refusalMessage({ ...valid, agents: [{ ...valid.agents[0], intervalSeconds: 600 }] }), /"agents\[0\]\.intervalSeconds" must be at least 900 \(15 minutes\)/);
    assert.match(refusalMessage({ ...valid, agents: [{ ...valid.agents[0], templateSha256: "abc" }] }), /"agents\[0\]\.templateSha256"/);
    assert.match(refusalMessage({ ...valid, model: { ...valid.model, provider: "anthropic" } }), /"model\.provider"/);
    assert.match(refusalMessage({ ...valid, certificates: [] }), /"certificates"/);
    assert.match(refusalMessage({ ...valid, extra: true }), /"extra" is not a known setting/);
    assert.match(refusalMessage({ ...valid, agents: [valid.agents[0], valid.agents[0]] }), /"agents\[1\]\.id"/);
  });

  it("refuses a Unix socket model endpoint with its own reason", () => {
    assert.throws(
      () => parseSandboxConfig({ ...valid, model: { ...valid.model, endpoint: "unix:///var/run/ollama.sock" } }, "/etc/openadminos/sandbox.json"),
      (error: unknown) => error instanceof SandboxRefusal && error.reason === "model-endpoint-socket" && error.message.includes('"model.endpoint"'),
    );
  });

  it("refuses Teams and Outlook delivery with the reason", () => {
    const withDelivery = (delivery: unknown) => ({ ...valid, agents: [{ ...valid.agents[0], delivery }] });
    assert.match(refusalMessage(withDelivery({ connector: "teams" })), /"agents\[0\]\.delivery\.connector" is teams.*delegated sign-in/);
    assert.match(refusalMessage(withDelivery({ connector: "outlook" })), /Mail\.Send/);
    assert.match(refusalMessage(withDelivery({ connector: "signal" })), /must be "slack" or "discord"/);
    assert.match(refusalMessage(withDelivery({ connector: "slack", channel: "#general" })), /channel ID/);
  });

  it("refuses a config file other users can read", () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = writeConfig(dir);
      chmodSync(path, 0o644);
      assert.throws(() => loadSandboxConfig(path), (error: unknown) => error instanceof SandboxRefusal && error.reason === "file-permissions" && /chmod 600/.test(error.message));
      chmodSync(path, 0o600);
      assert.equal(loadSandboxConfig(path).dataDir, join(dir, "data"));
    } finally {
      cleanup();
    }
  });
});
