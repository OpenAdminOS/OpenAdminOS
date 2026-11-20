import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { DATA_CLASSES_BY_SENSITIVITY, highestDataClass, maxDataClass, type DataClass } from "@openadminos/agent-sdk";
import { ClassificationLedger, classificationDiagnostics, classifyData, hasGraphFieldClasses, registerGraphTenantData, registerRenderedFragment, registerTenantData, withClassificationScope, withRequestClassification, type RequestClassificationEvent } from "./data-classification.js";
import { GRAPH_FIELD_CLASSES, GRAPH_FIELD_CLASSES_VERSION, GRAPH_ROUTE_ALIASES } from "./graph-field-classes.js";
import { GRAPH_CLASSIFICATION_FIXTURES } from "./graph-classification.fixtures.js";
import { fenceTenantData } from "./tenant-data.js";
import { renderPromptTemplate } from "./template-engine.js";
import { REQUEST_CLASSIFICATION_MAX_SECTION } from "./request-classification.js";
import { ClassificationWorker } from "./classification-worker-client.js";
import { TenantValueIndex } from "./tenant-value-index.js";
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
    }, ["/passwordCredentials/0/secretText", "/passwordCredentials/0/hint", "/keyCredentials/0/key"]],
    ["/deviceManagement/windowsAutopilotDeviceIdentities", {
      value: [{ productKey: "fixture", deviceAccountPassword: null }],
    }, ["/value/0/productKey"]],
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
  assert.equal(classifyData({ threats: { "[]": "fixture" } }, { graphPath: "/security/secureScoreControlProfiles" }).classes["/threats/[]"], "public");
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
    "/authenticationMethodConfigurations/0/featureSettings/displayLocationInformationRequiredState/includeTarget/targetType": "security",
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
  assert.deepEqual(DATA_CLASSES_BY_SENSITIVITY, ["credential", "identity", "security", "device", "activity", "configuration", "public"]);
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

test("classifying a fenced request leaves its bytes and options unchanged", () => {
  const source = "graph:/applications";
  const payload = { notes: "<Reference>", passwordCredentials: [{ hint: "fix" }] };
  const ledger = new ClassificationLedger();
  ledger.register(source, payload, { graphPath: "/applications" });
  const options = { prompt: fenceTenantData(payload, source), system: "Reference instructions" };
  const expected = structuredClone(options);
  const result = ledger.classifyRequest(options);
  assert.deepEqual(options, expected);
  assert.equal(result.counts.credential, 1);
  const credential = result.spans.find(({ kind }) => kind === "credential")!;
  assert.equal(credential.source, source);
  assert.equal(options.prompt.slice(credential.start, credential.end), "fix");
});

for (const [graphPath, groups] of Object.entries(GRAPH_FIELD_CLASSES)) {
  for (const [kind, fields] of Object.entries(groups)) {
    for (const token of fields.trim().split(/\s+/)) {
      test(`maps ${graphPath} ${token} to ${kind}`, () => {
        const parts = token.split(/(?<!@odata)\./).flatMap(part =>
          part.endsWith("[]") ? [part.slice(0, -2), "0"] : [part === "*" ? "syntheticFeature" : part]);
        const shape = parts.reduceRight<unknown>((child, part) => part === "0" ? [child] : { [part]: child }, "fixture-value");
        assert.equal(classifyData(shape, { graphPath }).classes["/" + parts.join("/")], kind);
      });
    }
  }
}

test("application nulls, empty hints, and absent secrets leave only metadata", () => {
  const application = {
    id: "5073d555-8111-4a73-a41d-931823bbddf5",
    appId: "8bdd9e58-aa93-4032-b2cf-2d0bf207005c",
    displayName: "Fixture application",
    passwordCredentials: [
      { customKeyIdentifier: null, displayName: "Rotation 1", endDateTime: "2027-01-01T00:00:00Z",
        hint: "", keyId: "de1287db-1cc6-4ceb-91cf-cdd36daecc9c", secretText: null, startDateTime: "2026-01-01T00:00:00Z" },
      { displayName: "Rotation 2" },
    ],
    keyCredentials: [{ key: null, type: "AsymmetricX509Cert", usage: "Verify" }],
    api: { requestedAccessTokenVersion: 2 }, web: { redirectUris: ["https://example.invalid/callback"] },
  };
  const result = classifyData(application, { graphPath: "/applications" });
  assert.equal(result.counts.credential, 0);
  assert.equal(result.counts.configuration, Object.keys(result.classes).length);
  assert.equal(highestDataClass(result.counts), "configuration");
  assert.equal(maxDataClass("configuration", "security"), "security");
});

test("Graph versions, alternate keys, encoded IDs, casing and wrappers retain source pointers", () => {
  for (const version of ["beta", "v1.0"]) {
    for (const key of ["(appId='abc')", "('abc')", "(id=guid'8bdd9e58-aa93-4032-b2cf-2d0bf207005c')", "/%61%62%63"]) {
      const result = classifyData({ AdditionalData: { PasswordCredentials: [{ AdditionalData: { Hint: "fix" } }] } },
        { graphPath: `/${version}/Applications${key}` });
      assert.equal(result.classes["/AdditionalData/PasswordCredentials/0/AdditionalData/Hint"], "credential");
    }
    const setting = { value: [{ id: "0", settingInstance: { groupSettingCollectionValue: [{ children: [
      { settingDefinitionId: "device_vendor_msft_fixture", simpleSettingValue: { value: "setting" } },
      { simpleSettingValue: { "@ODATA.TYPE": "#Microsoft.Graph.DeviceManagementConfigurationSecretSettingValue", value: "opaque" } },
    ] }] } }] };
    const result = classifyData(setting, { graphPath: `/${version}/deviceManagement/configurationPolicies/policy%2Fkey/settings` });
    const root = "/value/0/settingInstance/groupSettingCollectionValue/0/children";
    assert.equal(result.classes[root + "/0/simpleSettingValue/value"], "configuration");
    assert.equal(result.classes[root + "/1/simpleSettingValue/value"], "credential");
    const intent = classifyData({ value: [{ definitionId: "device_policy_password", valueJson: '"opaque"' }] },
      { graphPath: `/${version}/deviceManagement/intents/%31/settings` });
    assert.equal(intent.classes["/value/0/valueJson"], "credential");
    const group = classifyData({ value: [{ "@odata.type": "microsoft.graph.groupPolicyPresentationValuePassword", value: "opaque" }] },
      { graphPath: `/${version}/deviceManagement/groupPolicyConfigurations/p%31/definitionValues/d%31/presentationValues` });
    assert.equal(group.classes["/value/0/value"], "credential");
  }
});

test("security objects classify principal and credential values at their higher class", () => {
  const tests: readonly [string, unknown, Record<string, DataClass>][] = [
    ["/identity/conditionalAccess/namedLocations", { ipRanges: [{ cidrAddress: "203.0.113.8/24" }], countriesAndRegions: ["DE"] },
      { "/ipRanges/0/cidrAddress": "security", "/countriesAndRegions/0": "security" }],
    ["/roleManagement/directory/roleAssignments", { principalId: "opaque-id", roleDefinitionId: "role-1" },
      { "/principalId": "identity", "/roleDefinitionId": "security" }],
    ["/v1.0/identityGovernance/privilegedAccess/group/eligibilityScheduleRequests?$filter=groupId", {
      value: [{ principalId: "fixture-principal", groupId: "fixture-group", accessId: "member", status: "Provisioned" }],
    }, { "/value/0/principalId": "identity", "/value/0/groupId": "identity", "/value/0/accessId": "security", "/value/0/status": "security" }],
    ["/deviceManagement/configurationPolicies", { name: "Firewall policy", templateReference: { templateFamily: "endpointSecurityFirewall" }, futureField: true },
      { "/name": "security", "/templateReference/templateFamily": "security", "/futureField": "security" }],
    ["/deviceManagement/deviceConfigurations", { "@odata.type": "microsoft.graph.windows10EndpointProtectionConfiguration", displayName: "Security posture", preSharedKey: "fixture" },
      { "/@odata.type": "security", "/displayName": "security", "/preSharedKey": "credential" }],
  ];
  for (const [graphPath, payload, expected] of tests) assert.deepEqual(classifyData(payload, { graphPath }).classes, expected);
});

test("classifies expanded settings and applies secret metadata from additionalData to sibling values", () => {
  const catalog = classifyData({ settings: [
    { settingInstance: { simpleSettingValue: { value: "plain setting" } } },
    { settingInstance: { AdditionalData: { SettingDefinitionId: "device_policy_password" },
      simpleSettingValue: { value: "opaque" } } },
    { settingInstance: { simpleSettingValue: { AdditionalData: { ValueState: "EncryptedValueToken" }, StringValue: "opaque" } } },
  ] }, { graphPath: "/deviceManagement/configurationPolicies?$expand=settings" });
  assert.equal(catalog.classes["/settings/0/settingInstance/simpleSettingValue/value"], "configuration");
  assert.equal(catalog.classes["/settings/1/settingInstance/simpleSettingValue/value"], "credential");
  assert.equal(catalog.classes["/settings/2/settingInstance/simpleSettingValue/StringValue"], "credential");

  const group = classifyData({ definitionValues: [{ presentationValues: [
    { "@odata.type": "#microsoft.graph.groupPolicyPresentationValueText", value: "plain setting" },
    { AdditionalData: { IsSecret: true }, value: "opaque" },
  ] }] }, { graphPath: "/deviceManagement/groupPolicyConfigurations?$expand=definitionValues" });
  assert.equal(group.classes["/definitionValues/0/presentationValues/0/value"], "configuration");
  assert.equal(group.classes["/definitionValues/0/presentationValues/1/value"], "credential");
});

test("audit actor IPs and all device naming paths classify consistently", () => {
  assert.equal(classifyData({ initiatedBy: { user: { ipAddress: "10.0.0.3" } } }, { graphPath: "/auditLogs/directoryAudits" }).classes["/initiatedBy/user/ipAddress"], "identity");
  assert.equal(classifyData({ actor: { ipAddress: "10.0.0.3" } }, { graphPath: "/deviceManagement/auditEvents" }).classes["/actor/ipAddress"], "identity");
  for (const [graphPath, key] of [["/devices", "displayName"], ["/deviceManagement/managedDevices", "deviceName"], ["/deviceManagement/managedDevices", "managedDeviceName"]] as const) {
    const options = { graphPath, identityIndex: { matches: (text: string) => text.includes("Synthetic Person") } };
    assert.equal(classifyData({ [key]: "LAB-WIN01" }, options).classes["/" + key], "device");
    assert.equal(classifyData({ [key]: "Synthetic Person's laptop" }, options).classes["/" + key], "identity");
  }
});

test("bounded detectors handle whitespace runs, encoded PEM, labeled values and varied JWT headers", () => {
  const pem = "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----";
  const header = Buffer.from(' { "alg": "HS256" }').toString("base64url");
  for (const value of [encodeURIComponent(pem), Buffer.from(pem).toString("base64"),
    `${header}.eyJzdWIiOiJmaXh0dXJlIn0.signature`, 'clientSecret' + " ".repeat(100_000) + ': "opaque"',
    "password%3Dopaque", "AccountKey=opaque"]) {
    assert.equal(classifyData(value, { publicReference: true }).counts.credential, 1);
  }
  const whitespace = 'password :' + " ".repeat(350_000) + '"' + " ".repeat(350_000) + '"';
  assert.equal(classifyData(whitespace, { publicReference: true }).counts.credential, 0);
  for (const key of ["connectionString", "accountKey", "sasToken", "temporaryAccessPass", "certificatePassword"]) {
    assert.equal(classifyData({ [key]: "opaque", [key + "IsSet"]: true }).counts.credential, 1);
  }
});

test("unexamined evidence stays separate from observed credentials and expires after one turn", () => {
  const data = { first: "safe", second: "x".repeat(100), password: "unvisited" };
  const options = { workBudget: 40, publicReference: true };
  const result = classifyData(data, options);
  assert.deepEqual(result.remainder, { from: "/second", kind: "credential" });
  assert.equal(result.budgetExhausted, true);
  assert.equal(result.counts.credential, 0);
  const ledger = new ClassificationLedger();
  ledger.register("fixture", data, options);
  const request = ledger.classifyRequest({ prompt: '"unvisited"' });
  assert.equal(request.coverageIncomplete, true);
  assert.equal(request.effectiveClass, "credential");
  assert.equal(request.unexamined.registrations, 1);
  assert.equal(request.unexamined.textCodeUnits, 0);
  assert.equal(request.counts.credential, 0);
  assert.deepEqual(request.spans, []);
  const next = new ClassificationLedger();
  next.include(ledger);
  assert.equal(next.classifyRequest({ prompt: "unvisited" }).coverageIncomplete, false);
});

test("ledger value budget prioritizes credentials and does not invent prompt spans", () => {
  const ledger = new ClassificationLedger();
  ledger.register("public", ["a".repeat(950_000), "b".repeat(950_000)], { publicReference: true });
  const secret = "different opaque material".repeat(10_000);
  ledger.register("private", { secretText: secret });
  const result = ledger.classifyRequest({ prompt: "Question with no credential" });
  assert.equal(result.coverageIncomplete, true);
  assert.equal(result.retainedValues, 2);
  assert.equal(result.droppedValues, 1);
  assert.equal(result.unexamined.values, 1);
  assert.equal(result.counts.credential, 0);
  assert.equal(ledger.classifyRequest({ prompt: secret }).counts.credential, 1);
  const next = new ClassificationLedger();
  next.include(ledger);
  const followUp = next.classifyRequest({ prompt: secret });
  assert.equal(followUp.coverageIncomplete, false);
  assert.equal(followUp.droppedValues, 0);
  assert.deepEqual(followUp.unexamined, { values: 0, registrations: 0, textCodeUnits: 0, ranges: [] });
  assert.equal(followUp.counts.credential, 1);
});

test("chunked request scanning preserves offsets across a chunk boundary", async () => {
  const secret = "opaque-fixture-material";
  const ledger = new ClassificationLedger();
  ledger.register("fixture", { secretText: secret });
  const start = 127_996;
  const request = { prompt: `${" ".repeat(start)}${secret}\n` };
  const result = await ledger.classifyLargeRequest(request);
  assert.deepEqual(result, ledger.classifyRequest(request));
  assert.equal(result.coverageIncomplete, false);
  assert.deepEqual(result.spans, [{ section: "prompt", start, end: start + secret.length, kind: "credential", source: "fixture" }]);
});

test("reports the unexamined tail without counting it as a credential", () => {
  const ledger = new ClassificationLedger();
  ledger.register("fixture", { code: "abc" }, { publicReference: true });
  const prompt = `password=opaque
${"z".repeat(REQUEST_CLASSIFICATION_MAX_SECTION)}`;
  const result = ledger.classifyRequest({ system: "Fixture instructions", prompt });
  assert.equal(result.coverageIncomplete, true);
  assert.equal(result.counts.credential, 1);
  assert.deepEqual(result.unexamined.ranges, [{ section: "prompt", start: REQUEST_CLASSIFICATION_MAX_SECTION,
    end: prompt.length, reason: "text-limit" }]);
  const busy = ledger.classifyRequest({ prompt: 'x"abc"'.repeat(200_001) });
  assert.equal(busy.coverageIncomplete, true);
  assert.deepEqual(busy.unexamined.ranges[0], {
    section: "prompt", start: 0, end: 'x"abc"'.length * 200_001, reason: "match-limit",
  });
  assert.equal(busy.counts.credential, 0);
});

test("short values use key or rendering provenance and scalars do not match on their own", () => {
  const ledger = new ClassificationLedger();
  ledger.register("graph:/applications", { passwordCredentials: [{ hint: "abc", secretText: 2 }], accountEnabled: true }, { graphPath: "/applications" });
  const system = '{"hint":"abc","secretText":2}';
  const result = ledger.classifyRequest({ system, prompt: 'abc xabcx "abc" is prose. true 2 {"wrong":"abc","other":2}' });
  const credential = result.spans.filter(span => span.kind === "credential");
  assert.deepEqual(credential.map(span => [span.section, system.slice(span.start, span.end)]), [["system", "abc"], ["system", "2"]]);
  assert.equal(result.counts.identity, 0);
  const escaped = JSON.stringify({ excerpt: JSON.stringify({ hint: "abc" }, null, 2) });
  assert.equal(ledger.classifyRequest({ prompt: escaped }).counts.credential, 1);
  const unscoped = renderPromptTemplate("{{ fixture.hint }}", { fixture: { hint: "abc" } });
  const scoped = withClassificationScope(ledger, () => renderPromptTemplate("{{ fixture.hint }}", { fixture: { hint: "abc" } }));
  assert.equal(scoped.replace(/nonce="[0-9a-f]+"/g, 'nonce="fixture"'), unscoped.replace(/nonce="[0-9a-f]+"/g, 'nonce="fixture"'));
  assert.equal(ledger.classifyRequest({ prompt: scoped }).counts.credential, 1);
  assert.equal(ledger.classifyRequest({ prompt: unscoped }).counts.credential, 0);
  const scalar = withClassificationScope(ledger, () => renderPromptTemplate("Matching secret code: {{ fixture.secretText }} units.", { fixture: { secretText: 2 } }));
  assert.equal(scalar, "Matching secret code: 2 units.");
  assert.equal(ledger.classifyRequest({ prompt: scalar + " 2 more." }).counts.credential, 1);
  const shortName = "\u{10400}\u{10401}\u{10402}";
  ledger.register("fixture-user", { contactLabel: shortName }, { graphPath: "/users" });
  assert.equal(ledger.classifyRequest({ prompt: shortName }).counts.identity, 0);
  assert.equal(ledger.classifyRequest({ prompt: JSON.stringify({ contactLabel: shortName }) }).counts.identity, 1);
});

test("case normalization keeps matching unaffected offsets and applies word boundaries", () => {
  const ledger = new ClassificationLedger();
  ledger.register("directory", { displayName: "Ada Lovelace" }, { graphPath: "/users" });
  const prompt = "İ before ada lovelace after ADA LOVELACEX";
  const result = ledger.classifyRequest({ prompt });
  assert.deepEqual(result.spans.map(span => prompt.slice(span.start, span.end)), ["ada lovelace"]);
});

test("keeps provenance for a credential clipped inside a serialized preview", () => {
  const ledger = new ClassificationLedger();
  ledger.register("tenant:fixture", { hint: "ab9-secret-fixture" }, { graphPath: "/applications/app/addPassword" });
  const original = '{"hint":"ab9-secret-fixture"}';
  const preview = withClassificationScope(ledger, () =>
    fenceTenantData({ excerpt: registerRenderedFragment(original, original.slice(0, 12), { jsonPrefix: true }) }, "preview"));
  const prompt = `General text ab9. ${preview}`;
  const result = ledger.classifyRequest({ prompt });
  assert.deepEqual(result.spans.filter(span => span.kind === "credential").map(span => prompt.slice(span.start, span.end)), ["ab9"]);
});

test("request detectors see identifier spans without registration", () => {
  const pieces = ["8bdd9e58-aa93-4032-b2cf-2d0bf207005c", "192.168.1.50", "AA:BB:CC:DD:EE:FF", "C02XL0ABJ1H0", "bob%40example.com", "+1 206-555-0134"];
  const prompt = `Device ${pieces[0]} at ${pieces[1]} MAC ${pieces[2]} serial ${pieces[3]} user ${pieces[4]} phone ${pieces[5]}`;
  const result = new ClassificationLedger().classifyRequest({ prompt });
  for (const piece of pieces) assert.ok(result.spans.some(span => prompt.slice(span.start, span.end) === piece), piece);
  const indexed = new ClassificationLedger({ matches: () => true });
  assert.deepEqual(indexed.classifyRequest({ prompt: "123 true False" }).spans, []);
});

test("absent Graph leaves do not add counts", () => {
  const { classes, counts } = classifyData({ secretText: null, empty: [], user: {}, email: "", whitespace: "  ", enabled: false });
  assert.deepEqual(classes, { "/enabled": "identity" });
  assert.equal(counts.identity, 1);
  assert.equal(counts.credential, 0);
});

test("Graph credential route aliases preserve response classes", () => {
  for (const [path, canonical] of Object.entries(GRAPH_ROUTE_ALIASES)) {
    const graphPath = "/beta" + path.replaceAll("{id}", "fixture%2Dopaque");
    if (canonical.endsWith("getFileVaultKey")) {
      assert.equal(classifyData({ value: "opaque" }, { graphPath: graphPath + "()" }).classes["/value"], "credential");
    } else if (canonical.endsWith("recoveryKeys")) {
      for (const suffix of ["", "/opaque-key-id?$select=key"]) {
        assert.equal(classifyData({ key: "opaque" }, { graphPath: graphPath + suffix }).classes["/key"], "credential");
      }
    } else if (canonical.endsWith("addPassword")) {
      assert.equal(classifyData({ hint: "xyz" }, { graphPath }).classes["/hint"], "credential");
    }
  }
  for (const graphPath of ["/directory/deviceLocalCredentials", "/beta/directory/deviceLocalCredentials(opaque-id)"]) {
    assert.equal(classifyData({ credentials: [{ passwordBase64: "opaque" }] }, { graphPath }).classes["/credentials/0/passwordBase64"], "credential");
  }
});

for (const path of ["/deviceManagement/comanagedDevices", "/me/managedDevices", "/users/fixture-user/managedDevices"]) {
  test(`classifies managed device fields through ${path}`, () => {
    const row = { activationLockBypassCode: "opaque", deviceName: "workstation", operatingSystem: "Windows" };
    const expected = { "/activationLockBypassCode": "credential", "/deviceName": "device", "/operatingSystem": "configuration" };
    const graphPath = `/beta${path}`;
    assert.deepEqual(classifyData({ value: [row] }, { graphPath }).classes,
      Object.fromEntries(Object.entries(expected).map(([key, kind]) => [`/value/0${key}`, kind])));
    assert.deepEqual(classifyData(row, { graphPath: `${graphPath}/fixture-device?$select=deviceName` }).classes, expected);
  });
}

test("security fields retain distinct mask roles and principals retain identity", () => {
  for (const graphPath of ["/policies/authorizationPolicy", "/deviceManagement/deviceCompliancePolicies"]) {
    const result = classifyData({ displayName: "Tenant policy", blocked: true, groupId: "group-1" }, { graphPath });
    assert.deepEqual(result.classes, { "/displayName": "security", "/blocked": "security", "/groupId": "identity" });
    assert.deepEqual(result.securityMaskRoles, { "/displayName": "nameOrIdentifier", "/blocked": "setting" });
  }
  for (const graphPath of ["/applications", "/servicePrincipals"]) {
    const result = classifyData({ requiredResourceAccess: [{ resourceAppId: "fixture" }],
      appRoles: [{ displayName: "Reader", isEnabled: true }], oauth2PermissionScopes: [{ id: "fixture-id" }],
      appRoleAssignments: [{ principalId: "group-1" }] }, { graphPath });
    assert.equal(result.securityMaskRoles["/requiredResourceAccess/0/resourceAppId"], "nameOrIdentifier");
    assert.equal(result.securityMaskRoles["/appRoles/0/isEnabled"], "setting");
    assert.equal(result.securityMaskRoles["/oauth2PermissionScopes/0/id"], "nameOrIdentifier");
    assert.equal(result.classes["/appRoleAssignments/0/principalId"], "identity");
  }
  for (const graphPath of ["/oauth2PermissionGrants", "/servicePrincipals/app-id/oauth2PermissionGrants/grant-id",
    "/appRoleAssignments", "/users/user-id/appRoleAssignments"]) {
    const result = classifyData({ id: "assignment", principalId: "group-id" }, { graphPath });
    assert.equal(result.securityMaskRoles["/id"], "nameOrIdentifier");
    assert.equal(result.classes["/principalId"], "identity");
  }
});

test("nested application evidence keeps credential shapes without an original Graph route", () => {
  const ledger = new ClassificationLedger();
  ledger.register("office:evidence", [{ result: { oldestApps: [{ passwordCredentials: [{ hint: "q7z" }] }] } }]);
  assert.equal(ledger.classifyRequest({ prompt: '{"hint":"q7z"}' }).counts.credential, 1);
});

test("the provider observer receives each method's scoped result without extending its options", async () => {
  const request = { system: "Follow the procedure for server-side-value", prompt: "Contact user@example.invalid" };
  const seen: RequestClassificationEvent[] = [];
  const model = withRequestClassification({
    available: true,
    async complete(options) {
      assert.equal(options, request);
      return { text: "Done", model: "fixture" };
    },
    async *stream(options) {
      assert.equal(options, request);
      yield { delta: "Done", accumulated: "Done", model: "fixture", done: true };
    },
  }, "ollama", event => seen.push(event));
  const run = new ClassificationLedger();
  run.register("graph:/applications", { secretText: "server-side-value" }, { graphPath: "/applications" });
  const other = new ClassificationLedger();
  await Promise.all([
    withClassificationScope(run, async () => {
      await Promise.resolve();
      await model.complete(request);
    }),
    withClassificationScope(other, async () => {
      for await (const item of model.stream(request)) assert.equal(item.accumulated, "Done");
    }),
  ]);
  await Promise.all([run.waitForObservations(), other.waitForObservations()]);
  assert.equal(seen.length, 2);
  const complete = seen.find(event => event.method === "complete")!;
  const stream = seen.find(event => event.method === "stream")!;
  assert.equal(complete.classification.counts.credential, 1);
  assert.equal(complete.classification.spans.find(span => span.kind === "credential")?.section, "system");
  assert.equal(stream.classification.counts.credential, 0);
  assert.equal(stream.classification.counts.identity, 1);
});


test("stream captures the call scope and failed classification still calls the provider", async () => {
  const events: RequestClassificationEvent[] = [];
  let observedUnscoped!: () => void;
  const unscoped = new Promise<void>(resolve => { observedUnscoped = resolve; });
  const request = { prompt: '{"hint":"abc"}' };
  const scoped = new ClassificationLedger(undefined, "fixture-run");
  scoped.register("graph:/applications", { passwordCredentials: [{ hint: "abc" }] }, { graphPath: "/applications" });
  const model = withRequestClassification({
    available: true,
    async complete(options) {
      assert.equal(options, request);
      return { text: "complete", model: "fixture" };
    },
    async *stream(options) {
      assert.equal(options, request);
      yield { delta: "stream", accumulated: "stream", model: "fixture", done: true };
    },
  }, "ollama", event => {
    events.push(event);
    if (!event.scopePresent) observedUnscoped();
    throw new Error("observer fixture");
  });
  const iterator = withClassificationScope(scoped, () => model.stream(request));
  for await (const chunk of iterator) assert.equal(chunk.accumulated, "stream");
  await scoped.waitForObservations();
  assert.equal(events[0]?.scopeId, "fixture-run");
  assert.equal(events[0]?.scopePresent, true);
  assert.equal(events[0]?.fieldMapVersion, GRAPH_FIELD_CLASSES_VERSION);
  assert.ok(Number.isFinite(Date.parse(events[0]!.timestamp)));
  assert.equal(events[0]?.classification.counts.credential, 1);
  const broken = new ClassificationLedger({ matches() { throw new Error("index fixture"); } }, "broken-run");
  assert.equal((await withClassificationScope(broken, () => model.complete(request))).text, "complete");
  await broken.waitForObservations();
  assert.equal(events[1]?.failed, true);
  assert.equal(events[1]?.classification.coverageIncomplete, true);
  assert.equal(events[1]?.classification.counts.credential, 0);

  const diagnostics = classificationDiagnostics();
  registerTenantData("unscoped fixture", "value");
  await model.complete(request);
  await unscoped;
  assert.equal(events[2]?.scopeId, undefined);
  assert.equal(events[2]?.scopePresent, false);
  assert.deepEqual(classificationDiagnostics(), {
    unscopedRegistrations: diagnostics.unscopedRegistrations + 1,
    unscopedRequests: diagnostics.unscopedRequests + 1,
  });
});

test("serialized field provenance follows every array element across nesting and formatting", () => {
  const ledger = new ClassificationLedger();
  const countries = { countriesAndRegions: ["US", "DE", "FR"] };
  ledger.register("graph:locations", countries, { graphPath: "/identity/conditionalAccess/namedLocations" });
  const nested = { outer: [{ countriesAndRegions: [["US"], ["DE", ["FR"]]] }] };
  for (const data of [countries, nested]) {
    for (const indent of [undefined, 2]) {
      const json = JSON.stringify(data, null, indent);
      for (const prompt of [json, JSON.stringify({ serialized: json })]) {
        const result = ledger.classifyRequest({ prompt });
        assert.equal(result.counts.security, 3, prompt);
        assert.deepEqual(result.spans.filter(span => span.kind === "security").map(span => prompt.slice(span.start, span.end)), ["US", "DE", "FR"]);
      }
    }
  }
});

test("Conditional Access references and delegated permissions distinguish identifiers from settings", () => {
  const ids = ["aaaaaaaa-1111-2222-3333-444444444444", "bbbbbbbb-1111-2222-3333-444444444444"];
  const graphPath = "/identity/conditionalAccess/policies";
  const data = {
    conditions: {
      locations: { includeLocations: [...ids, "All"], excludeLocations: ["AllTrusted", ...ids] },
      users: { includeRoles: ids, excludeRoles: ids },
    },
    grantControls: { builtInControls: ["mfa"], termsOfUse: [ids[0]], customAuthenticationFactors: [ids[1]] },
  };
  const classified = classifyData(data, { graphPath });
  assert.deepEqual(Object.values(classified.securityMaskRoles).sort(), [
    ...Array(10).fill("nameOrIdentifier"), ...Array(3).fill("setting"),
  ]);
  const ledger = new ClassificationLedger();
  ledger.register("graph:policies", data, { graphPath });
  for (const prompt of [JSON.stringify(data), JSON.stringify({ data: JSON.stringify(data, null, 2) })]) {
    const { spans } = ledger.classifyRequest({ prompt });
    for (const value of [...ids, "All", "AllTrusted", "mfa"]) {
      const matches = spans.filter(span => prompt.slice(span.start, span.end) === value);
      assert.equal(matches.length, ids.includes(value) ? 5 : 1);
      assert.ok(matches.every(span => span.kind === "security" && span.maskRole === (ids.includes(value) ? "nameOrIdentifier" : "setting")));
    }
  }
  const application = classifyData({
    api: { preAuthorizedApplications: [{ delegatedPermissionIds: ids }] },
  }, { graphPath: "/applications" });
  assert.equal(application.counts.security, 2);
  assert.deepEqual(Object.values(application.securityMaskRoles), ["nameOrIdentifier", "nameOrIdentifier"]);
});

test("confirmed tenant identity raises stale device provenance while a generic GUID keeps its field class", () => {
  const index = new TenantValueIndex();
  const ledger = new ClassificationLedger({
    matches: text => index.matches(text),
    spans: text => TenantValueIndex.spansFor(text, [index]),
    workerShards: () => [index],
  });
  const guid = "aaaaaaaa-1111-2222-3333-444444444444";
  const device = { deviceName: "Yelena", id: guid };
  ledger.register("graph:managedDevices", device, { graphPath: "/deviceManagement/managedDevices" });
  const prompt = JSON.stringify(device);
  assert.deepEqual(ledger.classifyRequest({ prompt }).spans.map(span => span.kind), ["device", "device"]);
  index.add("Yelena", "name");
  const { spans } = ledger.classifyRequest({ prompt });
  assert.deepEqual(spans.map(span => [prompt.slice(span.start, span.end), span.kind]), [
    ["Yelena", "identity"], [guid, "device"],
  ]);
  ledger.dispose();
});

test("generic phrases match only at word boundaries", () => {
  const ledger = new ClassificationLedger();
  ledger.register("fixture", { status: "not configured" });
  const prompt = 'isnot configured; not configuredsuffix; (not configured); {"status":"not configured"}';
  const { spans } = ledger.classifyRequest({ prompt });
  assert.deepEqual(spans.map(span => span.start), [
    prompt.indexOf("(not configured)") + 1, prompt.lastIndexOf("not configured"),
  ]);
});

test("credential labels and values can be separated by whitespace across scan chunks", () => {
  const value = "q7z";
  const prompt = "Client secret" + " ".repeat(140_000) + "=" + " ".repeat(140_000) + value;
  const result = new ClassificationLedger().classifyRequest({ prompt });
  assert.equal(result.coverageIncomplete, false);
  assert.equal(result.counts.credential, 1);
  assert.equal(result.spans[0]?.start, prompt.length - value.length);
  assert.equal(result.spans[0]?.end, prompt.length);
});

test("section detectors preserve full spans beyond the former chunk overlap", () => {
  const gap = " ".repeat(43_000);
  const fixtures = [
    ["Bearer" + gap + "opaque_fixture_token", "credential"],
    ["-----BEGIN PRIVATE KEY-----\n" + gap + "\n-----END PRIVATE KEY-----", "credential"],
    ["serial:" + gap + "AT998822", "device"],
    ["sk-proj-" + "q".repeat(45_000), "credential"],
  ] as const;
  for (const [fixture, kind] of fixtures) {
    const prompt = " ".repeat(127_990) + fixture;
    const result = new ClassificationLedger().classifyRequest({ prompt });
    assert.equal(result.coverageIncomplete, false);
    const expected = kind === "device" ? "AT998822" : fixture;
    assert.ok(result.spans.some(span => span.kind === kind && prompt.slice(span.start, span.end) === expected), fixture.slice(0, 30));
  }
});

test("worker keeps scoped matcher changes and returns offsets for the unchanged UTF-16 request", async () => {
  const shard = new TenantValueIndex();
  shard.add("Aymeric Ouellet", "name");
  const identityIndex = {
    matches: (text: string) => shard.matches(text),
    spans: (text: string) => TenantValueIndex.spansFor(text, [shard]),
    workerShards: () => [shard],
  };
  const previous = new ClassificationLedger();
  previous.register("fixture:prior", { hint: "q7z" }, { graphPath: "/applications/app/addPassword" });
  const current = new ClassificationLedger(identityIndex);
  current.include(previous);
  const request = { system: "\ud800\n", prompt: " ".repeat(4000) +
    '😀 Aymeric Ouellet {"hint":"q7z","name":"display-fixture"}' };
  try {
    assert.deepEqual(await current.classifyLargeRequest(request), current.classifyRequest(request));
    current.register("fixture:current", { name: "display-fixture" });
    assert.deepEqual(await current.classifyLargeRequest(request), current.classifyRequest(request));
    previous.dispose();
    const updated = await current.classifyLargeRequest(request);
    assert.deepEqual(updated, current.classifyRequest(request));
    assert.equal(updated.counts.credential, 0);
    assert.ok(updated.spans.some(span => span.source === "detector:tenant-index" &&
      request.prompt.slice(span.start, span.end) === "Aymeric Ouellet"));
  } finally {
    current.dispose();
    previous.dispose();
  }
});

test("Graph ingress sends field classification to the worker and a worker failure leaves provider options intact", async t => {
  const post = ClassificationWorker.prototype.post;
  const sent: string[] = [];
  let rejectGraph = false;
  t.mock.method(ClassificationWorker.prototype, "post", function (
    this: ClassificationWorker, ...args: Parameters<ClassificationWorker["post"]>
  ) {
    sent.push(args[0].type);
    if (args[0].type === "graph" && rejectGraph) throw new Error("fixture Graph worker failure");
    post.apply(this, args);
  });
  const payload = { value: [{ passwordCredentials: [{ hint: "q7z" }] }] };
  const request = { prompt: JSON.stringify(payload) };
  for (const fails of [false, true]) {
    rejectGraph = fails;
    const ledger = new ClassificationLedger();
    const events: RequestClassificationEvent[] = [];
    const llm = withRequestClassification({
      available: true,
      async complete(options) {
        assert.equal(options, request);
        return { text: "reviewed", model: "fixture" };
      },
      async *stream() { throw new Error("Unused"); },
    }, "ollama", event => events.push(event));
    try {
      await withClassificationScope(ledger, async () => {
        await registerGraphTenantData("/applications", payload);
        assert.equal((await llm.complete(request)).text, "reviewed");
      });
      await ledger.waitForObservations();
      assert.equal(events[0]?.classification.counts.credential, fails ? 0 : 1);
      assert.equal(events[0]?.classification.coverageIncomplete, fails);
      if (fails) assert.equal(events[0]?.classification.unexamined.registrations, 1);
    } finally { ledger.dispose(); }
  }
  assert.equal(sent.filter(type => type === "graph").length, 2);
});

test("a stalled classifier cannot consume the provider deadline or replace its signal", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let markSent!: () => void;
  const sent = new Promise<void>(resolve => { markSent = resolve; });
  const post = ClassificationWorker.prototype.post;
  t.mock.method(ClassificationWorker.prototype, "post", function (
    this: ClassificationWorker, ...args: Parameters<ClassificationWorker["post"]>
  ) {
    if (args[0].type === "scan") markSent();
    else post.apply(this, args);
  });
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 250);
  const request = { prompt: " ".repeat(4000) + "password=q7z", signal: controller.signal };
  const ledger = new ClassificationLedger();
  const events: RequestClassificationEvent[] = [];
  const model = withRequestClassification({
    available: true,
    async complete(options) {
      assert.equal(options, request);
      assert.equal(options.signal, controller.signal);
      options.signal?.throwIfAborted();
      return { text: "complete", model: "fixture" };
    },
    async *stream() { throw new Error("Unused"); },
  }, "ollama", event => events.push(event));
  const completion = withClassificationScope(ledger, () => model.complete(request));
  assert.equal((await completion).text, "complete");
  await sent;
  t.mock.timers.tick(250);
  assert.equal(request.signal.aborted, true);
  await ledger.waitForObservations();
  clearTimeout(deadline);
  assert.equal(events[0]?.failed, true);
  assert.equal(events[0]?.classification.coverageIncomplete, true);
  assert.equal(events[0]?.classification.effectiveClass, "credential");
  assert.equal(events[0]?.classification.counts.credential, 0);
});

test("worker preserves long fenced evidence and can remove its mirror", async () => {
  const ledger = new ClassificationLedger();
  const value = "q".repeat(24_000) + " 17";
  ledger.register("fixture:long", { secretText: value });
  const body = withClassificationScope(ledger, () => fenceTenantData(value, "fixture:long"));
  const request = { prompt: body };
  try {
    const result = await ledger.classifyLargeRequest(request);
    assert.deepEqual(result, ledger.classifyRequest(request));
    assert.ok(result.spans.some(span => span.kind === "credential" && body.slice(span.start, span.end) === value));
  } finally {
    ledger.dispose();
  }
  assert.equal((await ledger.classifyLargeRequest(request)).counts.credential, 0);
});

test("a failed worker transport reports incomplete coverage and recovers on the next request", async t => {
  const post = ClassificationWorker.prototype.post;
  const transport = t.mock.method(ClassificationWorker.prototype, "post", function (
    this: ClassificationWorker, ...args: Parameters<ClassificationWorker["post"]>
  ) {
    if (args[0].type === "scan") throw new Error("fixture transport failure");
    post.apply(this, args);
  });
  const request = { prompt: " ".repeat(4000) + "password=q7z" };
  const events: RequestClassificationEvent[] = [];
  const ledger = new ClassificationLedger();
  const model = withRequestClassification({
    available: true,
    async complete(options) {
      assert.equal(options, request);
      return { text: "complete", model: "fixture" };
    },
    async *stream() { throw new Error("Unused"); },
  }, "ollama", event => events.push(event));
  assert.equal((await withClassificationScope(ledger, () => model.complete(request))).text, "complete");
  await ledger.waitForObservations();
  assert.equal(events[0]?.failed, true);
  assert.equal(events[0]?.classification.effectiveClass, "credential");
  transport.mock.restore();
  assert.equal((await withClassificationScope(ledger, () => model.complete(request))).text, "complete");
  await ledger.waitForObservations();
  assert.equal(events[1]?.failed, false);
  assert.equal(events[1]?.classification.counts.credential, 1);
});
