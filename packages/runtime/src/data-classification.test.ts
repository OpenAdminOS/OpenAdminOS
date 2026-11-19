import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { DATA_CLASSES_BY_SENSITIVITY, highestDataClass, maxDataClass, type DataClass } from "@openadminos/agent-sdk";
import { ClassificationLedger, classifyData, countDataClasses, hasGraphFieldClasses, withClassificationScope, withRequestClassification, type RequestClassificationEvent } from "./data-classification.js";
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
  assert.equal(options.prompt.slice(credential.start, credential.end), '"fix"');
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

test("reports unvisited Graph fields conservatively when traversal runs out of budget", () => {
  const data = { first: "safe", second: "x".repeat(100), password: "unvisited" };
  const options = { workBudget: 40, publicReference: true };
  const result = classifyData(data, options);
  assert.deepEqual(result.remainder, { from: "/second", kind: "credential" });
  assert.equal(result.budgetExhausted, true);
  const ledger = new ClassificationLedger();
  ledger.register("fixture", data, options);
  const request = ledger.classifyRequest({ prompt: '"unvisited"' });
  assert.equal(request.budgetExhausted, true);
  assert.equal(request.counts.credential, 1);
});

test("marks a section as credential when its text or candidate match budget is exhausted", () => {
  const ledger = new ClassificationLedger();
  ledger.register("fixture", { code: "abc" }, { publicReference: true });
  for (const prefix of ["x".repeat(4_000_000), 'x"abc"'.repeat(200_001)]) {
    const prompt = `${prefix}\npassword=opaque`;
    const result = ledger.classifyRequest({ system: "Fixture instructions", prompt });
    assert.equal(result.budgetExhausted, true);
    assert.deepEqual(result.spans, [{ section: "prompt", start: 0, end: prompt.length,
      kind: "credential", source: "detector:work-budget" }]);
    assert.equal(result.counts.credential, 1);
  }
});

test("short ledger values match complete JSON string values across the request only", () => {
  const ledger = new ClassificationLedger();
  ledger.register("graph:/applications", { passwordCredentials: [{ hint: "abc" }] }, { graphPath: "/applications" });
  const result = ledger.classifyRequest({ system: '{"hint":"abc"}', prompt: 'abc xabcx "abc" is prose. {"abc":false,"hint":"abcx"}' });
  const credential = result.spans.filter(span => span.kind === "credential");
  assert.deepEqual(credential, [{ section: "system", start: 8, end: 13, kind: "credential", source: "graph:/applications" }]);
  const escaped = JSON.stringify({ excerpt: JSON.stringify({ hint: "abc" }, null, 2) });
  assert.equal(ledger.classifyRequest({ prompt: escaped }).counts.credential, 1);
  const fenced = fenceTenantData(JSON.stringify("abc"), "fixture");
  assert.equal(ledger.classifyRequest({ prompt: `Example:\n${fenced}\nExplain.` }).counts.credential, 1);
  assert.equal(ledger.classifyRequest({ prompt: fenced.replace(/nonce="[0-9a-f]+">$/, 'nonce="wrong">') }).counts.credential, 0);
  const shortName = "\u{10400}\u{10401}\u{10402}";
  ledger.register("fixture-user", { displayName: shortName }, { graphPath: "/users" });
  assert.equal(ledger.classifyRequest({ prompt: shortName }).counts.identity, 0);
  assert.equal(ledger.classifyRequest({ prompt: JSON.stringify(shortName) }).counts.identity, 1);
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
  await Promise.all([
    withClassificationScope(run, async () => {
      await Promise.resolve();
      await model.complete(request);
    }),
    withClassificationScope(new ClassificationLedger(), async () => {
      for await (const item of model.stream(request)) assert.equal(item.accumulated, "Done");
    }),
  ]);
  assert.equal(seen.length, 2);
  const complete = seen.find(event => event.method === "complete")!;
  const stream = seen.find(event => event.method === "stream")!;
  assert.equal(complete.classification.counts.credential, 1);
  assert.equal(complete.classification.spans.find(span => span.kind === "credential")?.section, "system");
  assert.equal(stream.classification.counts.credential, 0);
  assert.equal(stream.classification.counts.identity, 1);
});
