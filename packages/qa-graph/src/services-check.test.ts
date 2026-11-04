import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkServicesCoverScopes } from "./checks.js";
import { loadAgentManifests } from "./load-agents.js";

describe("services-cover-scopes", () => {
  it("passes when the declared services cover every scope, agent-only scopes included", () => {
    const result = checkServicesCoverScopes({
      scopes: ["DeviceManagementManagedDevices.Read.All", "Device.Read.All", "DeviceManagementManagedDevices.PrivilegedOperations.All"],
      services: ["intune"],
    });
    assert.equal(result.name, "services-cover-scopes");
    assert.equal(result.severity, "pass");
  });

  it("fails and names the scope a declared service does not cover", () => {
    const result = checkServicesCoverScopes({
      scopes: ["AuditLog.Read.All", "SecurityAlert.Read.All"],
      services: ["entra"],
    });
    assert.equal(result.severity, "fail");
    assert.deepEqual(result.details, ["SecurityAlert.Read.All"]);
    assert.match(result.message, /Scopes suggest: \[entra, defender\]/);
  });

  it("fails when services is missing or names an unknown service", () => {
    const missing = checkServicesCoverScopes({ scopes: ["Policy.Read.All"] });
    assert.equal(missing.severity, "fail");
    assert.match(missing.message, /descriptor\.services is missing\. .*Scopes suggest: \[entra\]/);
    const unknown = checkServicesCoverScopes({ scopes: [], services: ["exchange-online", "exchange"] });
    assert.equal(unknown.severity, "fail");
    assert.deepEqual(unknown.details, ["exchange-online", "exchange"]);
  });

  it("passes for every bundled agent", () => {
    for (const agent of loadAgentManifests()) {
      const result = checkServicesCoverScopes(agent);
      assert.equal(result.severity, "pass", `${agent.slug}: ${result.message}`);
    }
  });
});

describe("agent template schema services", () => {
  it("requires services and accepts only available service IDs", async () => {
    const { readFileSync } = await import("node:fs");
    const { Ajv2020 } = await import("ajv/dist/2020.js");
    const schema = JSON.parse(
      readFileSync(new URL("../../../schemas/agent-template.schema.json", import.meta.url), "utf8"),
    ) as { $defs: { descriptor: object } };
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile({ ...schema.$defs.descriptor, $defs: schema.$defs });
    const descriptor = {
      id: "schema-check",
      name: "Schema check",
      description: "Checks services.",
      version: "1.0.0",
      author: { name: "OpenAdminOS" },
      category: "policies",
      mode: "read",
    };
    assert.equal(validate(descriptor), false);
    assert.equal(validate({ ...descriptor, services: ["entra"] }), true);
    assert.equal(validate({ ...descriptor, services: [] }), false);
    assert.equal(validate({ ...descriptor, services: ["exchange"] }), false);
    assert.equal(validate({ ...descriptor, services: ["entra", "entra"] }), false);
  });
});
