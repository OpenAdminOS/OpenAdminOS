import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { DATA_CLASSES_BY_SENSITIVITY } from "@openadminos/agent-sdk";
import { classifyData, countDataClasses, hasGraphFieldClasses } from "./data-classification.js";
import { GRAPH_FIELD_CLASSES } from "./graph-field-classes.js";
import { GRAPH_CLASSIFICATION_FIXTURES } from "./graph-classification.fixtures.js";
import { fenceTenantData } from "./tenant-data.js";
import { agentTemplateToRegistrySummary, parseAgentTemplate } from "./agent-template.js";

for (const [graphPath, [field, value, expected]] of Object.entries(GRAPH_CLASSIFICATION_FIXTURES)) {
  test(`classifies the fixture for ${graphPath}`, () => {
    for (const [payload, pointer] of [
      [{ [field]: value }, `/${field}`],
      [[{ [field]: value }], `/0/${field}`],
      [{ value: [{ [field]: value }] }, `/value/0/${field}`],
    ] as const) {
      const result = classifyData(payload, { graphPath });
      assert.deepEqual(result.classes, { [pointer]: expected });
      assert.equal(result.counts[expected], 1);
      assert.deepEqual(countDataClasses(payload, { graphPath }), result.counts);
    }
  });
}

test("every field map has a response fixture", () => {
  assert.deepEqual(Object.keys(GRAPH_FIELD_CLASSES).sort(), Object.keys(GRAPH_CLASSIFICATION_FIXTURES).sort());
});

const agentDir = new URL("../../../agents/", import.meta.url);
for (const entry of readdirSync(agentDir, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
  const manifest = parseAgentTemplate(readFileSync(new URL(`${entry.name}/manifest.yaml`, agentDir), "utf8"));
  test(`covers Graph reads declared by ${entry.name}`, () => {
    const paths = agentTemplateToRegistrySummary(manifest).graphOperations
      .filter(operation => operation.method === "GET")
      .map(operation => operation.path);
    if (manifest.execution?.kind === "script") {
      const source = readFileSync(new URL(`${entry.name}/${manifest.execution.entrypoint}`, agentDir), "utf8");
      const declaredPaths = [...source.matchAll(/brokerRequest\("graph\.request",\s*\{[^}]*?path:\s*"([^"]+)"/g)]
        .map(match => match[1]);
      assert.deepEqual(declaredPaths, paths);
    }
    for (const path of paths) {
      assert.ok(GRAPH_CLASSIFICATION_FIXTURES[path], path);
      assert.ok(hasGraphFieldClasses(path), path);
    }
  });
}

test("classifies returned credentials and nested values beyond the Graph projection", () => {
  const id = "00000000-0000-0000-0000-000000000001";
  const cases = [
    [`/v1.0/informationProtection/bitlocker/recoveryKeys/${id}?$select=key`, { key: "fixture" }, ["/key"]],
    [`/directory/deviceLocalCredentials/${id}`, { credentials: [{ passwordBase64: "c3ludGhldGlj" }] }, ["/credentials/0/passwordBase64"]],
    [`/deviceManagement/managedDevices/${id}/getFileVaultKey`, { value: "fixture" }, ["/value"]],
    ["/applications?$select=id", {
      passwordCredentials: [{ secretText: "fixture", hint: "fix" }, { secretText: null }],
      keyCredentials: [{ key: "fixture" }],
    }, ["/passwordCredentials/0/secretText", "/passwordCredentials/0/hint", "/passwordCredentials/1/secretText", "/keyCredentials/0/key"]],
    ["/deviceManagement/windowsAutopilotDeviceIdentities", {
      value: [{ productKey: "fixture", deviceAccountPassword: null }],
    }, ["/value/0/productKey", "/value/0/deviceAccountPassword"]],
    ["/deviceManagement/deviceConfigurations", {
      preSharedKey: "fixture", customData: [{ value: "fixture" }], omaSettings: [{ value: "fixture" }],
    }, ["/preSharedKey", "/customData/0/value", "/omaSettings/0/value"]],
  ] as const;
  for (const [graphPath, payload, pointers] of cases) {
    const result = classifyData(payload, { graphPath });
    assert.equal(result.counts.credential, pointers.length, graphPath);
    for (const pointer of pointers) assert.equal(result.classes[pointer], "credential", pointer);
  }
});

test("recognizes credentials in free text without classifying arbitrary words as secrets", () => {
  const cases = [
    "Recovery: 000000-000011-000022-000033-000044-000055-000066-000077",
    'The LAPS password: "Example!123"',
    "Client secret = opaque-fixture",
    "Client secret hint: fix",
    "Product key ABCDE-12345-FGHIJ-67890-KLMNO",
    "-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----",
    "Bearer opaque-fixture",
    `github_pat_${"a".repeat(30)}`,
    '{"access_token":"opaque-fixture"}',
  ];
  for (const value of cases) {
    assert.equal(classifyData(value).classes[""], "credential", value);
  }
  assert.equal(classifyData("Learn how to create a client secret", { publicReference: true }).classes[""], "public");
  assert.equal(classifyData('{"password": null}', { publicReference: true }).classes[""], "public");
});

test("uses the identity fallback for unknown fields, shapes and resources", () => {
  assert.deepEqual(classifyData({ unexpected: 42, "allowInvitesFrom/x": 0 }, { graphPath: "/users" }).classes, {
    "/unexpected": "identity",
    "/allowInvitesFrom~1x": "identity",
  });
  assert.equal(classifyData({ displayName: "Synthetic" }, { graphPath: "/users/unknownNavigation" }).classes["/displayName"], "identity");
  assert.equal(classifyData({ "deviceDetail.browser": "fixture" }, { graphPath: "/auditLogs/signIns" }).classes["/deviceDetail.browser"], "identity");
  assert.equal(classifyData({ threats: { "[]": "fixture" } }, { graphPath: "/security/secureScoreControlProfiles" }).classes["/threats/[]"], "identity");
});

test("classifies paging links, sign-in location and IDs nested in policies as identity", () => {
  assert.deepEqual(classifyData({
    value: [{ ipAddress: "10.20.30.40", location: { geoCoordinates: { latitude: 1.23 } } }],
    "@odata.nextLink": "opaque-next",
    "@odata.deltaLink": "opaque-delta",
  }, { graphPath: "/auditLogs/signIns" }).classes, {
    "/value/0/ipAddress": "identity",
    "/value/0/location/geoCoordinates/latitude": "identity",
    "/@odata.nextLink": "identity",
    "/@odata.deltaLink": "identity",
  });
  assert.deepEqual(classifyData({ conditions: { users: { includeUsers: ["opaque-id"], excludeUsers: ["opaque-id"] } } },
    { graphPath: "/identity/conditionalAccess/policies" }).classes, {
    "/conditions/users/includeUsers/0": "identity",
    "/conditions/users/excludeUsers/0": "identity",
  });
  assert.deepEqual(classifyData({ authenticationMethodConfigurations: [{
    featureSettings: { displayLocationInformationRequiredState: { includeTarget: { id: "opaque-id", targetType: "user" } } },
  }] }, { graphPath: "/policies/authenticationMethodsPolicy" }).classes, {
    "/authenticationMethodConfigurations/0/featureSettings/displayLocationInformationRequiredState/includeTarget/id": "identity",
    "/authenticationMethodConfigurations/0/featureSettings/displayLocationInformationRequiredState/includeTarget/targetType": "configuration",
  });
});

test("scans descriptive values and raises them to the most sensitive detected class", () => {
  const data = classifyData({
    description: "Named owner Synthetic Person",
    publicClient: { redirectUris: ["https://192.168.0.7:444/"] },
    notes: "Synthetic Person assigned clientSecret=opaque-fixture",
  }, {
    graphPath: "/applications",
    identityIndex: { matches: (text) => text.includes("Synthetic Person") },
  });
  assert.deepEqual(data.classes, {
    "/description": "identity",
    "/publicClient/redirectUris/0": "device",
    "/notes": "credential",
  });
  assert.deepEqual(DATA_CLASSES_BY_SENSITIVITY, ["credential", "identity", "device", "activity", "configuration", "public"]);
  const audit = classifyData({ targetResources: [
    { modifiedProperties: [{ displayName: "Client secret hint", newValue: "fix", oldValue: null }] },
  ] }, { graphPath: "/auditLogs/directoryAudits" });
  assert.equal(audit.classes["/targetResources/0/modifiedProperties/0/newValue"], "credential");
});

test("public results start public and use pattern and local identity detection", () => {
  assert.deepEqual(classifyData({
    public: "Microsoft Learn",
    contact: "user@example.invalid",
    indexed: "Synthetic Person",
    hardware: "AA:BB:CC:DD:EE:FF",
    nested: { "user@example.invalid": { details: "example" } },
  }, { publicReference: true, identityIndex: { matches: (text) => text === "Synthetic Person" } }).classes, {
    "/public": "public",
    "/contact": "identity",
    "/indexed": "identity",
    "/hardware": "device",
    "/nested/user@example.invalid/details": "identity",
  });
});

test("the classified fence preserves the original prompt bytes apart from its usual fresh nonce", () => {
  const payload = { notes: "<Reference>", passwordCredentials: [{ hint: "fix" }] };
  const source = "graph:/applications";
  const legacy = fenceTenantData(payload, source);
  const result = fenceTenantData(payload, source, { classification: { graphPath: "/applications" } });
  const normalizeNonce = (text: string) => text.replace(/nonce="[0-9a-f]{16}"/g, 'nonce="fixture"');
  assert.equal(normalizeNonce(result.text), normalizeNonce(legacy));
  assert.equal(result.classification.classes["/passwordCredentials/0/hint"], "credential");
});
