import { withTemplateInterpolations, type TemplateInterpolation } from "./request-classification.js";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import { DATA_CLASSES_BY_SENSITIVITY, highestDataClass, maxDataClass, type AgentTemplate,
  type DataClass, type RunContext, type TemplateStep } from "@openadminos/agent-sdk";
import { ClassificationLedger, classificationDiagnostics, classifyData, hasGraphFieldClasses, registerGraphTenantData, registerRenderedFragment, registerTenantData, withClassificationScope, withRequestClassification, type RequestClassificationEvent } from "./data-classification.js";
import { GRAPH_FIELD_CLASSES, GRAPH_FIELD_CLASSES_VERSION, GRAPH_ROUTE_ALIASES } from "./graph-field-classes.js";
import { GRAPH_CLASSIFICATION_FIXTURES } from "./graph-classification.fixtures.js";
import { fenceTenantData } from "./tenant-data.js";
import { renderPromptTemplate } from "./template-engine.js";
import { REQUEST_CLASSIFICATION_MAX_SECTION } from "./request-classification.js";
import { CLASSIFICATION_QUEUE_MAX_BYTES, CLASSIFICATION_QUEUE_MAX_JOBS, ClassificationSlice, ClassificationWorker, reserveClassificationRequest } from "./classification-worker-client.js";
import { TenantValueIndex } from "./tenant-value-index.js";
import { agentTemplateToRegistrySummary, parseAgentTemplate, runAgentTemplate } from "./agent-template.js";

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

test("maps the documented encryption states and preserves the device and user classes", () => {
  const result = classifyData({
    id: "fixture-device",
    deviceName: "LAB-WIN01",
    userPrincipalName: "fixture@example.test",
    osVersion: "10.0",
    deviceType: "windowsRT",
    tpmSpecificationVersion: "2.0",
    encryptionReadinessState: "ready",
    encryptionState: "encrypted",
    encryptionPolicySettingState: "compliant",
    advancedBitLockerStates: "success",
    fileVaultStates: "success",
    policyDetails: [{ policyId: "bf2e884a-1aad-4d99-b32a-c795550c9990", policyName: "Disk policy" }],
  }, { graphPath: "/beta/deviceManagement/managedDeviceEncryptionStates/fixture-device" });
  assert.deepEqual(result.classes, {
    "/id": "device", "/deviceName": "device", "/userPrincipalName": "identity",
    "/osVersion": "configuration", "/deviceType": "configuration",
    "/tpmSpecificationVersion": "security", "/encryptionReadinessState": "security", "/encryptionState": "security",
    "/encryptionPolicySettingState": "security", "/advancedBitLockerStates": "security", "/fileVaultStates": "security",
    "/policyDetails/0/policyId": "security", "/policyDetails/0/policyName": "security",
  });
});

test("maps the full managed device attestation and posture families to security", () => {
  const attestationFields = `
    lastUpdateDateTime contentNamespaceUrl deviceHealthAttestationStatus contentVersion issuedDateTime
    attestationIdentityKey resetCount restartCount dataExcutionPolicy bitLockerStatus bootManagerVersion
    codeIntegrityCheckVersion secureBoot bootDebugging operatingSystemKernelDebugging codeIntegrity testSigning
    safeMode windowsPE earlyLaunchAntiMalwareDriverProtection virtualSecureMode pcrHashAlgorithm bootAppSecurityVersion
    bootManagerSecurityVersion tpmVersion pcr0 secureBootConfigurationPolicyFingerPrint codeIntegrityPolicy
    bootRevisionListInfo operatingSystemRevListInfo healthStatusMismatchInfo healthAttestationSupportedStatus
    memoryIntegrityProtection memoryAccessProtection virtualizationBasedSecurity firmwareProtection systemManagementMode securedCorePC
  `.trim().split(/\s+/);
  const row = {
    deviceName: "fixture-workstation", userDisplayName: "Fixture Person", operatingSystem: "Windows",
    isEncrypted: true, partnerReportedThreatState: "secured", windowsActiveMalwareCount: 2, windowsRemediatedMalwareCount: 5,
    complianceState: "noncompliant", complianceGracePeriodExpirationDateTime: "2027-01-31T00:00:00Z",
    jailBroken: "unknown", lostModeState: "disabled", exchangeAccessState: "quarantined", exchangeAccessStateReason: "policy",
    androidSecurityPatchLevel: "2026-10-01", securityPatchLevel: "2026-09-01", bootstrapTokenEscrowed: true,
    deviceFirmwareConfigurationInterfaceManaged: true, managementCertificateExpirationDate: "2027-01-15T00:00:00Z",
    hardwareInformation: { isEncrypted: true, tpmSpecificationVersion: "2.0", tpmManufacturer: "Fixture", tpmVersion: "2.3",
      systemManagementBIOSVersion: "1.1", deviceGuardVirtualizationBasedSecurityHardwareRequirementState: "meetsHardwareRequirements",
      deviceGuardVirtualizationBasedSecurityState: "running", deviceGuardLocalSystemAuthorityCredentialGuardState: "enabled" },
    deviceHealthAttestationState: Object.fromEntries(attestationFields.map(field => [field, "fixture"])),
    deviceIdentityAttestationDetail: { deviceIdentityAttestationStatus: "trusted" },
    configurationManagerClientHealthState: { state: "healthy", errorCode: 0 },
  };
  const { classes, securityMaskRoles } = classifyData(row, { graphPath: "/deviceManagement/managedDevices/fixture-device" });
  const other = { "/deviceName": "device", "/userDisplayName": "identity", "/operatingSystem": "configuration" };
  for (const field of attestationFields) assert.equal(classes[`/deviceHealthAttestationState/${field}`], "security", field);
  for (const [pointer, kind] of Object.entries(classes)) {
    assert.equal(kind, Object.hasOwn(other, pointer) ? other[pointer as keyof typeof other] : "security", pointer);
    if (kind === "security") {
      assert.equal(securityMaskRoles[pointer], /\/(?:secureBootConfigurationPolicyFingerPrint|codeIntegrityPolicy)$/.test(pointer)
        ? "nameOrIdentifier" : "setting", pointer);
    }
  }
});

test("keeps Windows protection and compliance posture roles through expansions and direct navigation", () => {
  const malware = { id: "malware-report", malwareDisplayName: "Fixture malware", malwareThreatState: "quarantined", detectionCount: 4,
    managedDeviceId: "fixture-device", initialDetectionDateTime: "2026-11-18T00:00:00Z" };
  const protection = { id: "protection-report", antiMalwareVersion: "2.5", engineVersion: "7.5", signatureVersion: "4.5",
    realTimeProtectionEnabled: true, networkInspectionSystemEnabled: true, malwareProtectionEnabled: false,
    managedDeviceHealthState: "unhealthy", quickScanOverdue: true, fullScanRequired: false, signatureUpdateOverdue: true,
    managedDeviceName: "fixture-workstation", lastReportedDateTime: "2026-11-18T00:00:00Z", detectedMalwareState: [malware] };
  const policy = { id: "compliance-policy", displayName: "Fixture compliance policy", state: "noncompliant", settingCount: 1,
    settingStates: [{ setting: "EncryptionRequired", settingName: "Encryption required", settingInstanceId: "instance-4", state: "error",
      currentValue: "disabled", errorCode: 7, userName: "Fixture Person", userEmail: "person@example.test",
      sources: [{ id: "source-policy", displayName: "Source policy", sourceType: "deviceCompliancePolicy" }] }] };
  const cases: Array<{ field: string; pointer: string; item: object; identifier: string[];
    device: string[]; activity: string[]; identity: string[] }> = [
    { field: "windowsProtectionState", pointer: "/windowsProtectionState", item: protection,
      identifier: ["/id", "/detectedMalwareState/0/id", "/detectedMalwareState/0/malwareDisplayName"],
      device: ["/managedDeviceName", "/detectedMalwareState/0/managedDeviceId"], identity: [],
      activity: ["/lastReportedDateTime", "/detectedMalwareState/0/initialDetectionDateTime"] },
    { field: "deviceCompliancePolicyStates", pointer: "/deviceCompliancePolicyStates/0", item: policy,
      identifier: ["/id", "/displayName", "/settingStates/0/setting", "/settingStates/0/settingName", "/settingStates/0/settingInstanceId",
        "/settingStates/0/sources/0/id", "/settingStates/0/sources/0/displayName"],
      identity: ["/settingStates/0/userName", "/settingStates/0/userEmail"], device: [], activity: [] },
  ];
  for (const base of ["/deviceManagement/managedDevices", "/deviceManagement/comanagedDevices", "/me/managedDevices", "/users/fixture-user/managedDevices"]) {
    for (const { field, pointer, item, identifier, identity, device, activity } of cases) {
      const graphPath = `/beta${base}/fixture-device`;
      const direct = classifyData(item, { graphPath: `${graphPath}/${field}` });
      for (const [key, kind] of Object.entries(direct.classes)) {
        assert.equal(kind, identity.includes(key) ? "identity" : device.includes(key) ? "device" : activity.includes(key) ? "activity" : "security", key);
        if (kind === "security") assert.equal(direct.securityMaskRoles[key], identifier.includes(key) ? "nameOrIdentifier" : "setting", key);
      }
      const expanded = classifyData({ [field]: field === "windowsProtectionState" ? item : [item] }, { graphPath: `${graphPath}?$expand=${field}` });
      assert.deepEqual(expanded.classes, Object.fromEntries(Object.entries(direct.classes).map(([key, kind]) => [pointer + key, kind])));
      assert.deepEqual(expanded.securityMaskRoles, Object.fromEntries(Object.entries(direct.securityMaskRoles).map(([key, role]) => [pointer + key, role])));
    }
    const directMalware = classifyData(malware, { graphPath: `${base}/fixture-device/windowsProtectionState/detectedMalwareState/malware-report` });
    assert.equal(directMalware.classes["/malwareThreatState"], "security");
    assert.equal(directMalware.securityMaskRoles["/id"], "nameOrIdentifier");
    assert.equal(directMalware.classes["/managedDeviceId"], "device");
  }
});

test("classifies posture and security object identifiers across mapped Graph resources", () => {
  const cases = [
    ["/devices", { isCompliant: false, isManaged: true, isRooted: false, isManagementRestricted: true, trustType: "AzureAd",
      complianceExpirationDateTime: "2027-01-01T00:00:00Z" }, []],
    ["/auditLogs/signIns", { deviceDetail: { isCompliant: true, isManaged: false, trustType: "AzureAd" } }, []],
    ["/deviceManagement/managedDeviceOverview", { deviceExchangeAccessStateSummary: { allowedDeviceCount: 2, quarantinedDeviceCount: 1 } }, []],
    ["/deviceManagement/deviceConfigurations", { omaSettings: [{ isEncrypted: true }], deviceGuardEnableSecureBootWithDMA: true,
      applicationGuardEnabled: true, applicationGuardCertificateThumbprints: ["fixture-fingerprint"], appLockerApplicationControl: "enforce",
      dmaGuardDeviceEnumerationPolicy: "block", gatekeeperBlockOverride: true, localSecurityOptionsDisableGuestAccount: true,
      lanManagerWorkstationDisableInsecureGuestLogons: true, smartScreenEnableInShell: true, allowSampleSharing: false,
      enableExpeditedTelemetryReporting: true }, ["/applicationGuardCertificateThumbprints/0"]],
    ["/deviceAppManagement/managedAppPolicies", { id: "policy", deviceComplianceRequired: true, maximumAllowedDeviceThreatLevel: "low" }, ["/id"]],
    ["/deviceAppManagement/iosManagedAppProtections", { displayName: "App policy", appDataEncryptionType: "whenDeviceLocked" }, ["/displayName"]],
    ["/deviceAppManagement/androidManagedAppProtections", { id: "policy", encryptAppData: true, requiredAndroidSafetyNetDeviceAttestationType: "basicIntegrity" }, ["/id"]],
    ["/security/alerts_v2", { id: "alert", alertPolicyId: "rule", detectorId: "fixture", incidentId: "incident", providerAlertId: "provider-alert",
      severity: "high", status: "active", investigationState: "running", classification: "truePositive", determination: "malware",
      evidence: [{ defenderAvStatus: "updated", healthStatus: "active", onboardingStatus: "onboarded", riskScore: "low", rbacGroupId: 3, rbacGroupName: "Endpoint group" }] },
      ["/id", "/alertPolicyId", "/detectorId", "/incidentId", "/providerAlertId", "/evidence/0/rbacGroupId", "/evidence/0/rbacGroupName"]],
    ["/security/incidents", { id: "incident", displayName: "Fixture incident", redirectIncidentId: "other-incident", severity: "high",
      status: "active", classification: "truePositive", determination: "malware", priorityScore: 26 }, ["/id", "/displayName", "/redirectIncidentId"]],
    ["/security/secureScores", { id: "report", currentScore: 50, maxScore: 100, enabledServices: ["Defender"], controlScores: [{ controlName: "Control",
      implementationStatus: "Enabled", on: true, score: 15, scoreInPercentage: 50, count: 4, total: 8 }] }, ["/id", "/controlScores/0/controlName"]],
    ["/security/secureScoreControlProfiles", { controlStateUpdates: [{ state: "ignored" }] }, []],
    ["/informationProtection/bitlocker/recoveryKeys", { id: "recovery-object", volumeType: "operatingSystemVolume" }, ["/id"]],
  ] as const;
  for (const [graphPath, data, identifiers] of cases) {
    const { classes, securityMaskRoles } = classifyData(data, { graphPath });
    for (const [pointer, kind] of Object.entries(classes)) {
      assert.equal(kind, "security", `${graphPath} ${pointer}`);
      assert.equal(securityMaskRoles[pointer], identifiers.some(identifier => identifier === pointer) ? "nameOrIdentifier" : "setting", `${graphPath} ${pointer}`);
    }
  }
  assert.deepEqual(classifyData({ id: "catalog-control", controlName: "Catalog control" },
    { graphPath: "/security/secureScoreControlProfiles" }).classes, { "/id": "public", "/controlName": "public" });
});

test("classifies endpoint protection settings in legacy policy and Settings Catalog responses", () => {
  const legacyPath = "/deviceManagement/deviceConfigurations";
  for (const [graphPath, payload, expected] of [
    [legacyPath, {
      "@odata.type": "#microsoft.graph.macOSEndpointProtectionConfiguration", displayName: "Mac policy",
      gatekeeperBlockOverride: true, fileVaultEnabled: true, firewallEnabled: true,
    }, { "/@odata.type": "security", "/displayName": "security", "/gatekeeperBlockOverride": "security",
      "/fileVaultEnabled": "security", "/firewallEnabled": "security" }],
    [legacyPath, {
      displayName: "Mixed settings", defenderRequireRealTimeMonitoring: true,
      defenderAttackSurfaceReductionExcludedPaths: ["fixture"], bitLockerFixedDrivePolicy: { requireEncryptionForWriteAccess: true },
    }, { "/displayName": "configuration", "/defenderRequireRealTimeMonitoring": "security",
      "/defenderAttackSurfaceReductionExcludedPaths/0": "security", "/bitLockerFixedDrivePolicy/requireEncryptionForWriteAccess": "security" }],
    ["/informationProtection/bitlocker/recoveryKeys", { deviceId: "fixture-device", volumeType: "operatingSystemVolume", key: "synthetic" },
      { "/deviceId": "device", "/volumeType": "security", "/key": "credential" }],
    ["/deviceManagement/managedDevices", { isEncrypted: true, windowsActiveMalwareCount: 1, hardwareInformation: { isEncrypted: true } },
      { "/isEncrypted": "security", "/windowsActiveMalwareCount": "security", "/hardwareInformation/isEncrypted": "security" }],
  ] as const) {
    assert.deepEqual(classifyData(payload, { graphPath }).classes, expected, graphPath);
  }
  for (const settingDefinitionId of [
    "device_vendor_msft_bitlocker_requiredeviceencryption",
    "com.apple.MCX.FileVault2_Enable",
    "device_vendor_msft_firewall_mdmstore_domainprofile_enablefirewall",
    "device_vendor_msft_policy_config_defender_allowrealtimemonitoring",
    "device_vendor_msft_policy_config_defender_attacksurfacereductionrules",
    "device_vendor_msft_policy_config_deviceguard_enablevirtualizationbasedsecurity",
    "device_vendor_msft_policy_config_dmaguard_deviceenumerationpolicy",
    "device_vendor_msft_policy_config_systemguard_configuresystemguardlaunch",
    "device_vendor_msft_policy_config_localpoliciessecurityoptions_networksecurity_lanmanagerauthenticationlevel",
  ]) {
    const result = classifyData({ id: "fixture", settingInstance: { settingDefinitionId, simpleSettingValue: { value: true } } },
      { graphPath: "/deviceManagement/configurationPolicies/fixture/settings" });
    assert.equal(result.classes["/settingInstance/simpleSettingValue/value"], "security", settingDefinitionId);
  }
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

test("rendering binds standalone booleans and adjacent scalars to their exact request offsets", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ledger = new ClassificationLedger();
  const policy = { passwordRequired: true, minimumPasswordLength: 8 };
  ledger.register("graph:/deviceManagement/deviceCompliancePolicies", policy,
    { graphPath: "/deviceManagement/deviceCompliancePolicies" });
  const promptEntries: TemplateInterpolation[] = [];
  const systemEntries: TemplateInterpolation[] = [];
  const ctx = { policy };
  const prompt = renderPromptTemplate("{{ policy.passwordRequired }}", ctx, span => promptEntries.push(span));
  const system = renderPromptTemplate("true \u{10400} {{ policy.passwordRequired }}{{ policy.minimumPasswordLength }} 8", ctx,
    span => systemEntries.push(span));
  assert.equal(prompt, "true");
  assert.equal(system, "true \u{10400} true8 8");
  const request = { prompt, system };
  try {
    const result = await withTemplateInterpolations({ prompt: promptEntries, system: systemEntries }, () =>
      ledger.classifyLargeRequest(request));
    assert.equal(result.coverageIncomplete, false);
    assert.deepEqual(result.spans.map(({ section, start, end, kind }) => [section, start, end, kind]),
      [["system", 8, 12, "security"], ["system", 12, 13, "security"], ["prompt", 0, 4, "security"]]);
  } finally { ledger.dispose(); }
});

test("template filters carry source field evidence to emitted scalar and array offsets", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ledger = new ClassificationLedger();
  const graphPath = "/identity/conditionalAccess/namedLocations";
  const location = { countriesAndRegions: ["DE", "US", ["İ<", true, 7]] };
  ledger.register("graph:locations", location, { graphPath });
  const ctx = { location, missing: null };
  const cases: Array<[string, string, string[]]> = [
    ['location.countriesAndRegions | sample(2) | join(", ")', "DE, US", ["DE", "US"]],
    ['location.countriesAndRegions | join(", ")', "DE, US, İ\\u003c,true,7", ["DE", "US", "İ\\u003c", "true", "7"]],
    ['location.countriesAndRegions | sample(1)', '["DE"]', ["DE"]],
    ['location.countriesAndRegions | sample(1) | lower', '["DE"]', ["DE"]],
    ['location.countriesAndRegions.2 | lower', '["İ\\u003c",true,7]', ["İ\\u003c", "true", "7"]],
    ['location.countriesAndRegions | join(", ") | lower', "de, us, i\u0307\\u003c,true,7",
      ["de", "us", "i\u0307\\u003c", "true", "7"]],
    ['location.countriesAndRegions | sample(2) | boundedJson(512) | lower',
      '{"totalrecords":2,"includedrecords":2,"omittedrecords":0,"coverage":"complete","records":["de","us"]}', ["de", "us"]],
    ['location.countriesAndRegions.0 | upper', "DE", ["DE"]],
    ['location.countriesAndRegions.0 | length', "2", ["2"]],
    ['location.countriesAndRegions.0 | size', "2", ["2"]],
    ['location.countriesAndRegions.0 | total', "2", ["2"]],
    ['location.countriesAndRegions.0 | type', "string", ["string"]],
    ['location.countriesAndRegions.0 | default("unused")', "DE", ["DE"]],
    ['missing | default("DE")', "DE", []],
  ];
  const promptEntries: TemplateInterpolation[] = [];
  const render = (expression: string, text: string) => {
    promptEntries.length = 0;
    const template = `literal DE {{ ${expression} }} literal US`;
    const prompt = renderPromptTemplate(template, ctx, entry => promptEntries.push(entry));
    const withoutNonces = (rendered: string) => rendered.replace(/nonce="[a-f0-9]+"/g, 'nonce="fixture"');
    assert.equal(withoutNonces(prompt), withoutNonces(renderPromptTemplate(template, ctx)), expression);
    assert.ok(prompt.includes(text), expression);
    return prompt;
  };
  try {
    for (const [expression, text, expectedSpans] of cases) {
      const prompt = render(expression, text);
      const result = withTemplateInterpolations({ prompt: promptEntries }, () => ledger.classifyRequest({ prompt }));
      assert.equal(result.coverageIncomplete, false, expression);
      assert.deepEqual(result.spans.filter(span => span.kind === "security")
        .map(span => prompt.slice(span.start, span.end)), expectedSpans, expression);
    }
    const prompt = render('location.countriesAndRegions | sample(2) | join(", ")', "DE, US");
    const result = await withTemplateInterpolations({ prompt: promptEntries }, () => ledger.classifyLargeRequest({ prompt }));
    assert.equal(result.coverageIncomplete, false);
    assert.deepEqual(result.spans.map(span => prompt.slice(span.start, span.end)), ["DE", "US"]);
  } finally {
    ledger.dispose();
  }
});

const transformStep = (kind: string, settings: Record<string, unknown>): TemplateStep => ({
  id: "transformed", format: "transform", label: kind, settings: { kind, source: "{{ load.output }}", ...settings },
});

const policyPath = "/identity/conditionalAccess/policies";
const policyRows = { value: [{ id: "policy-fixture", grantControls: { operator: "OR" } }] };
const date = "2000-01-01T00:00:00.000Z";
const expectedTransforms: Array<{
  name: string; path?: string; response?: unknown; steps: TemplateStep[];
  expressions: Array<{ expression: string; body: string; spans: string[][]; incomplete?: boolean }>;
}> = [
  {
    name: "count-by-field", steps: [transformStep("count-by-field", { field: "grantControls.operator" })],
    expressions: [
      { expression: "transformed.output", body: '{"OR":1}', spans: [["security", "OR"], ["security", "1"]] },
      { expression: "transformed.output.OR | type", body: "number", spans: [["security", "number"]] },
    ],
  },
  {
    name: "group-by-field", steps: [transformStep("group-by-field", { field: "grantControls.operator" })],
    expressions: [{ expression: "transformed.output", body: '{"OR":[', spans: [["security", "OR"], ["security", "policy-fixture"], ["security", "OR"]] }],
  },
  {
    name: "sort-by",
    response: { value: [{ grantControls: { operator: "AND" } }, ...policyRows.value] },
    steps: [transformStep("sort-by", { field: "grantControls.operator" })],
    expressions: [{ expression: "transformed.output | boundedJson(512) | lower", body: '"operator":"or"',
      spans: [["security", "policy-fixture"], ["security", "or"], ["security", "and"]] }],
  },
  {
    name: "group-by-age", path: "/devices",
    response: { value: [{ approximateLastSignInDateTime: date }] },
    steps: [transformStep("group-by-age", { timestampField: "approximateLastSignInDateTime",
      groups: [{ name: "stale", inactiveDaysAtLeast: 30 }] })],
    expressions: [{ expression: "transformed.output", body: '{"stale":[', spans: [["activity", date]] }],
  },
  {
    name: "filter-by-age", path: "/devices",
    response: { value: [{ approximateLastSignInDateTime: date },
      { approximateLastSignInDateTime: "9999-01-01T00:00:00.000Z" }] },
    steps: [transformStep("filter-by-age", { timestampField: "approximateLastSignInDateTime", inactiveDaysAtLeast: 30 })],
    expressions: [{ expression: "transformed.output", body: '[{"approximateLastSignInDateTime":', spans: [["activity", date]] }],
  },
  {
    name: "correlate-stale-devices", path: "/deviceManagement/managedDevices",
    response: { value: [{ id: "intune-fixture", azureADDeviceId: "join-fixture", lastSyncDateTime: date }] },
    steps: [
      { id: "entra", label: "entra", format: "graph", settings: { method: "GET", path: "/devices", scopes: [] } },
      transformStep("correlate-stale-devices", { intuneSource: "{{ load.output }}", entraSource: "{{ entra.output }}",
        staleDays: 30, strategy: "both" }),
    ],
    expressions: [
      { expression: "transformed.output.0.entraObjectId | upper", body: "ENTRA-FIXTURE", spans: [["device", "ENTRA-FIXTURE"]] },
      { expression: "transformed.output.0.entraAccountEnabled", body: "false", spans: [["configuration", "false"]] },
      { expression: "transformed.output.0.entraInactiveDays | type", body: "number", spans: [["activity", "number"]] },
      { expression: "transformed.output.0.intuneInactiveDays | type", body: "number", spans: [["activity", "number"]] },
    ],
  },
  {
    name: "count-by-field coerces scalars and knows when an object key lost evidence",
    response: { value: [{ grantControls: { operator: false } }, { grantControls: { operator: "false" } },
      { grantControls: { operator: { nested: "value" } } }] },
    steps: [transformStep("count-by-field", { field: "grantControls.operator" })],
    expressions: [{ expression: "transformed.output", body: '{"false":2,"[object Object]":1}',
      spans: [["security", "false"], ["security", "2"]], incomplete: true }],
  },
  {
    name: "derived JSON key offsets include escaping but exclude quotes",
    response: { value: [{ grantControls: { operator: 'A<"B' } }] },
    steps: [transformStep("count-by-field", { field: "grantControls.operator" })],
    expressions: [{ expression: "transformed.output", body: '{"A\\u003c\\"B":1}',
      spans: [["security", 'A\\u003c\\"B'], ["security", "1"]] }],
  },
  {
    name: "interpolated bucket names in transform settings",
    steps: [transformStep("count-by-field", { field: "grantControls.operator",
      buckets: ["Operator {{ load.output.0.grantControls.operator | lower }}"] })],
    expressions: [{ expression: "transformed.output", body: '{"Operator or":0,"OR":1}',
      spans: [["security", "Operator or"], ["security", "0"], ["security", "OR"], ["security", "1"]] }],
  },
  {
    name: "interpolated age bucket name", path: "/devices",
    response: { value: [{ approximateLastSignInDateTime: date }] },
    steps: [transformStep("group-by-age", { timestampField: "approximateLastSignInDateTime",
      groups: [{ name: "stale {{ load.output.0.approximateLastSignInDateTime | length }}", inactiveDaysAtLeast: 30 }] })],
    expressions: [{ expression: "transformed.output", body: '{"stale 24":[', spans: [["activity", "stale 24"], ["activity", date]] }],
  },
];

async function observeTemplatePipeline(
  path: string, response: unknown, steps: TemplateStep[], holdIngress = false,
): Promise<Array<{ prompt: string; event: RequestClassificationEvent }>> {
  const ledger = new ClassificationLedger(undefined, "fixture");
  const prompts: string[] = [];
  const events: RequestClassificationEvent[] = [];
  let releaseIngress!: () => void;
  const ingressGate = new Promise<void>(resolve => { releaseIngress = resolve; });
  const manifest = {
    descriptor: { id: "fixture", mode: "read" },
    skills: [{ id: "load", label: "load", format: "graph", settings: { method: "GET", path, query: {} } }, ...steps],
    definition: { result: { summary: "done" } },
  } as AgentTemplate;
  const run = async (observe: boolean) => {
    const received: string[] = [];
    const provider: RunContext["llm"] = {
      available: true, defaultModel: "fixture",
      async complete(options) { received.push(options.prompt); return { text: "done", model: "fixture" }; },
      async *stream() {},
    };
    const context = {
      agent: { id: "fixture", name: "Fixture" } as RunContext["agent"],
      settings: {}, providerId: "ollama", realWrites: false, log() {},
      graph: { async request({ path: requested }: { path: string }) {
        return requested === path ? response : { value: [{
          id: "entra-fixture", deviceId: "join-fixture", approximateLastSignInDateTime: date, accountEnabled: false,
        }] };
      } } as RunContext["graph"],
      llm: observe ? withRequestClassification(provider, "ollama", event => events.push(event)) : provider,
      async step<T>(label: string, _detail: string | undefined, work: () => T | Promise<T>) {
        const result = await work();
        if (observe && (label === "load" || label === "entra")) {
          if (holdIngress) void ledger.scheduleRegistration(1, () => ingressGate);
          else await ledger.waitForObservations();
        }
        return result;
      },
    } satisfies RunContext;
    await runAgentTemplate(manifest, context);
    return received;
  };
  try {
    const baseline = await run(false);
    prompts.push(...await withClassificationScope(ledger, () => run(true)));
    releaseIngress();
    await ledger.waitForObservations();
    const stablePrompt = (prompt: string) => prompt.replace(/nonce="[a-f0-9]+"/g, 'nonce="fixture"');
    assert.deepEqual(prompts.map(stablePrompt), baseline.map(stablePrompt));
    assert.equal(events.length, prompts.length);
    return events.sort((a, b) => a.requestSequence - b.requestSequence).map((event, i) => ({ prompt: prompts[i]!, event }));
  } finally {
    releaseIngress();
    ledger.dispose();
  }
}

for (const fixture of expectedTransforms) {
  test(`agent template preserves rendered provenance for ${fixture.name}`, async () => {
    const steps = fixture.expressions.map(({ expression }, index): TemplateStep => ({
      id: `llm_${index}`, label: `llm_${index}`, format: "llm",
      settings: { prompt: `Grant operator breakdown: OR {{ ${expression} }}` },
    }));
    const observations = await observeTemplatePipeline(fixture.path ?? policyPath, fixture.response ?? policyRows,
      [...fixture.steps, ...steps]);
    for (const [index, { prompt, event }] of observations.entries()) {
      const expected = fixture.expressions[index]!;
      assert.ok(prompt.includes(expected.body), prompt);
      assert.equal(event.classification.coverageIncomplete, expected.incomplete ?? false, expected.expression);
      assert.deepEqual(event.classification.spans.filter(span => span.section === "prompt")
        .map(span => [span.kind, prompt.slice(span.start, span.end)]), expected.spans, expected.expression);
      assert.ok(event.classification.spans.every(span => span.start >= "Grant operator breakdown: OR ".length));
    }
  });
}

test("agent template map keeps the Graph field of a scalar item bound to a new variable", async () => {
  const [observation] = await observeTemplatePipeline("/identity/conditionalAccess/namedLocations",
    { value: [{ countriesAndRegions: ["DE", "US"] }] }, [{
      id: "transformed", label: "map", format: "map",
      settings: { source: "{{ load.output.0.countriesAndRegions | sample(1) }}", as: "country", do: [
        { id: "llm", label: "Explain", format: "llm", settings: { prompt: "Literal de. {{ country | lower }}" } },
      ] },
    }]);
  assert.ok(observation);
  const { prompt, event } = observation;
  assert.equal(event.classification.coverageIncomplete, false);
  assert.deepEqual(event.classification.spans.map(span => [span.kind, prompt.slice(span.start, span.end)]), [["security", "de"]]);
  assert.ok(event.classification.spans[0]!.start > prompt.indexOf("de"));
});

test("agent template sends derived keys while evidence is still pending", async () => {
  const [observation] = await observeTemplatePipeline(policyPath, policyRows, [
    transformStep("count-by-field", { field: "grantControls.operator" }),
    { id: "llm", label: "Explain", format: "llm", settings: { prompt: "Grant operators: {{ transformed.output }}" } },
  ], true);
  assert.ok(observation);
  assert.ok(observation.prompt.includes('{"OR":1}'));
  assert.equal(observation.event.classification.coverageIncomplete, true);
  assert.equal(observation.event.classification.effectiveClass, "credential");
  assert.ok(observation.event.classification.unexamined.registrations > 0);
});

test("template coverage is incomplete when a filter loses provenance or source evidence is missing", () => {
  const ledger = new ClassificationLedger();
  const ctx = { location: { countriesAndRegions: ["DE", "US"], entries: [{ code: "DE" }] } };
  for (const expression of [
    "location.countriesAndRegions | size",
    "location.countriesAndRegions | total",
    "location.countriesAndRegions | type",
    "location.entries | join",
    "location.countriesAndRegions | join",
  ]) {
    const entries: TemplateInterpolation[] = [];
    const prompt = renderPromptTemplate(`{{ ${expression} }}`, ctx, entry => entries.push(entry));
    const result = withTemplateInterpolations({ prompt: entries }, () => ledger.classifyRequest({ prompt }));
    assert.equal(result.coverageIncomplete, true, expression);
    assert.equal(result.effectiveClass, "credential", expression);
  }
  ledger.dispose();
});

test("case normalization keeps matching unaffected offsets and applies word boundaries", () => {
  const ledger = new ClassificationLedger();
  ledger.register("directory", { displayName: "Ada Lovelace" }, { graphPath: "/users" });
  const prompt = "İ before ada lovelace after ADA LOVELACEX";
  const result = ledger.classifyRequest({ prompt });
  assert.deepEqual(result.spans.map(span => prompt.slice(span.start, span.end)), ["ada lovelace"]);
});

test("keeps provenance for a credential clipped inside a serialized preview", async t => {
  const ledger = new ClassificationLedger();
  t.after(() => ledger.dispose());
  ledger.register("tenant:fixture", { hint: "ab9-secret-fixture" }, { graphPath: "/applications/app/addPassword" });
  const original = '{"hint":"ab9-secret-fixture"}';
  const preview = withClassificationScope(ledger, () =>
    fenceTenantData({ excerpt: registerRenderedFragment(original, original.slice(0, 12), { jsonPrefix: true }) }, "preview"));
  const prompt = `General text ab9. ${preview}`;
  assert.equal(ledger.classifyRequest({ prompt }).coverageIncomplete, true);
  await ledger.waitForObservations();
  const result = ledger.classifyRequest({ prompt });
  assert.equal(result.coverageIncomplete, false);
  assert.deepEqual(result.spans.filter(span => span.kind === "credential").map(span => prompt.slice(span.start, span.end)), ["ab9"]);
});

test("recovers preview cuts in arrays and marks unresolved ranges", async t => {
  const id = "2e649073-17e6-4c99-bde9-70f77734caec";
  const fragment = id.slice(0, 13);
  const cases = [
    { data: { includeUsers: ["all", id] }, visible: fragment, evidence: true, kind: "identity" },
    { data: { includeUsers: [["all"], [[id]]] }, visible: fragment, evidence: true, kind: "identity", suffix: "\n[truncated locally]" },
    { data: { includeUsers: [[id]] }, visible: fragment, evidence: true, kind: "identity", pretty: true },
    { data: { includeUsers: ["prefix\\opaque"] }, visible: "prefix\\", evidence: true, kind: "identity" },
    { data: { operator: ["OR"] }, visible: 'OR"', evidence: true, kind: "security" },
    { data: { operator: [[987654321]] }, visible: "98765", evidence: true, kind: "security" },
    { data: { includeUsers: [[id]] }, visible: fragment, evidence: false },
    { data: { includeUsers: [id] }, visible: "includeUs", evidence: true },
  ] as const;
  for (const fixture of cases) {
    const ledger = new ClassificationLedger();
    t.after(() => ledger.dispose());
    const original = "pretty" in fixture ? JSON.stringify(fixture.data, null, 2).replaceAll('\":', '\" :') : JSON.stringify(fixture.data);
    const cut = original.indexOf(fixture.visible) + fixture.visible.length;
    assert.ok(cut >= fixture.visible.length);
    if (fixture.evidence) ledger.register("fixture", { conditions: { users: fixture.data }, grantControls: fixture.data }, {
      graphPath: "/identity/conditionalAccess/policies",
    });
    const prompt = withClassificationScope(ledger, () => {
      const preview = registerRenderedFragment(original, original.slice(0, cut) + ("suffix" in fixture ? fixture.suffix : ""), { jsonPrefix: true });
      return fenceTenantData({ excerpt: preview }, "preview");
    });
    await ledger.waitForObservations();
    const displayed = JSON.stringify(fixture.visible.replace(/"$/, "")).slice(1, -1);
    const start = prompt.indexOf(displayed);
    const end = start + displayed.length;
    assert.ok(start >= 0);
    const result = await ledger.classifyProviderRequest({ prompt: prompt + "Context. ".repeat(80) });
    assert.equal(result.coverageIncomplete, !("kind" in fixture), original);
    if ("kind" in fixture) assert.ok(result.spans.some(span => span.start === start && span.end === end && span.kind === fixture.kind), original);
    else assert.deepEqual(result.unexamined.ranges, [{ section: "prompt", start, end, reason: "clipped-provenance-unavailable" }]);
  }
});

test("keeps the last preview scalar's credential provenance until its delimiter is visible", async () => {
  const path = "/applications";
  const hint = "qxz";
  for (const [data, closingDelimiter] of [
    [{ passwordCredentials: [{ hint }] }, "}"],
    [{ passwordCredentials: [{ hint, displayName: "Fixture" }] }, ","],
    [{ passwordCredentials: [{ hint: [[hint]] }] }, "]"],
  ] as const) {
    for (const indent of [0, 2]) {
      const original = JSON.stringify(data, null, indent);
      const quote = original.indexOf(hint) + hint.length;
      const delimiter = original.indexOf(closingDelimiter, quote + 1);
      assert.match(original.slice(quote, delimiter), /^"\s*$/);
      for (let cut = quote; cut <= delimiter + 1; cut++) {
        for (const hasEvidence of cut <= delimiter ? [true, false] : [true]) {
          const ledger = new ClassificationLedger();
          try {
            if (hasEvidence) ledger.register(`graph:${path}`, data, { graphPath: path });
            const prompt = withClassificationScope(ledger, () => fenceTenantData({
              excerpt: registerRenderedFragment(original, original.slice(0, cut), { jsonPrefix: true }),
            }, "preview"));
            await ledger.waitForObservations();
            const result = await ledger.classifyProviderRequest({ prompt });
            const start = prompt.indexOf(hint);
            const end = start + hint.length;
            const detail = JSON.stringify({ closingDelimiter, indent, offset: cut - quote, hasEvidence });
            assert.ok(start >= 0, detail);
            assert.equal(result.effectiveClass, "credential", detail);
            assert.equal(result.coverageIncomplete, !hasEvidence, detail);
            if (hasEvidence) {
              assert.deepEqual(result.spans, [{ section: "prompt", start, end, kind: "credential", source: `graph:${path}` }], detail);
            } else {
              assert.deepEqual(result.unexamined.ranges, [{ section: "prompt", start, end, reason: "clipped-provenance-unavailable" }], detail);
            }
          } finally {
            ledger.dispose();
          }
        }
      }
    }
  }
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

test("a serialized field keeps the most sensitive competing origin and reports an unresolved range", async t => {
  const cases = [
    { value: "qxz", key: "displayName", low: "configuration", lowPath: "/applications",
      high: "credential", highPath: "/applications", data: { passwordCredentials: [{ hint: "qxz" }] } },
    { value: "ops", key: "displayName", low: "configuration", lowPath: "/applications",
      high: "identity", highPath: "/groups", data: { mailNickname: "ops" } },
    { value: "mfa", key: "deviceName", low: "device", lowPath: "/deviceManagement/managedDevices",
      high: "security", highPath: "/identity/conditionalAccess/policies", data: { grantControls: { builtInControls: ["mfa"] } } },
    { value: "same", key: "id", low: "device", lowPath: "/devices",
      high: "security", highPath: "/identity/conditionalAccess/policies", data: { id: "same" } },
    { value: true, key: "accountEnabled", low: "configuration", lowPath: "/devices",
      high: "security", highPath: "/deviceManagement/deviceCompliancePolicies", data: { passwordRequired: true } },
    { value: "qxz987654321", key: "displayName", low: "configuration", lowPath: "/applications",
      high: "credential", highPath: "/applications", data: { passwordCredentials: [{ hint: "qxz987654321" }] } },
  ] as const;
  for (const { value, key, low, lowPath, high, highPath, data } of cases) {
    for (const placement of ["forward", "reverse", "prior"] as const) {
      const ledger = new ClassificationLedger();
      const prior = new ClassificationLedger();
      t.after(() => { ledger.dispose(); prior.dispose(); });
      const registerLow = () => ledger.register("lower", { [key]: value }, { graphPath: lowPath });
      const registerHigh = () => (placement === "prior" ? prior : ledger).register("higher", data, { graphPath: highPath });
      if (placement === "reverse") { registerHigh(); registerLow(); }
      else { registerLow(); registerHigh(); }
      if (placement === "prior") ledger.include(prior);
      assert.equal(classifyData({ [key]: value }, { graphPath: lowPath }).classes[`/${key}`], low);
      const json = JSON.stringify({ [key]: [value] });
      const verify = (request: { prompt: string; system: string }, result: ReturnType<typeof ledger.classifyRequest>) => {
        assert.equal(result.coverageIncomplete, true);
        for (const section of ["system", "prompt"] as const) {
          const start = request[section].indexOf(String(value));
          const end = start + String(value).length;
          assert.deepEqual(result.spans.filter(span => span.section === section).map(span => [span.start, span.end, span.kind]), [[start, end, high]]);
          assert.deepEqual(result.unexamined.ranges.filter(range => range.section === section), [{ section, start, end, reason: "competing-provenance" }]);
        }
      };
      const request = { system: json, prompt: JSON.stringify({ nested: json }) };
      verify(request, ledger.classifyRequest(request));
      if (placement === "prior") {
        const large = { ...request, prompt: "Context. ".repeat(80) + request.prompt };
        verify(large, await ledger.classifyProviderRequest(large));
      }
      const proven = withTemplateInterpolations({ system: [{ key: key.toLowerCase(), value,
        start: json.indexOf(String(value)), end: json.indexOf(String(value)) + String(value).length }] }, () =>
        ledger.classifyRequest({ system: json, prompt: "Review tenant data." }));
      assert.equal(proven.coverageIncomplete, false);
      assert.equal(proven.spans[0]?.kind, high);
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

test("group mail fields and higher-sensitivity detectors classify identity with an empty index", () => {
  const index = new TenantValueIndex();
  const identityIndex = {
    matches: (text: string) => index.matches(text),
    spans: (text: string) => TenantValueIndex.spansFor(text, [index]),
  };
  const group = {
    mail: "admins@fictional.example",
    mailNickname: "ops",
    proxyAddresses: ["smtp:admins-alias@fictional.example", "X500:/o=Fictional/ou=Ops"],
  };
  const options = { graphPath: "/groups", identityIndex };
  assert.deepEqual(classifyData(group, options).classes, {
    "/mail": "identity", "/mailNickname": "identity",
    "/proxyAddresses/0": "identity", "/proxyAddresses/1": "identity",
  });
  const ledger = new ClassificationLedger(identityIndex);
  ledger.register("graph:groups", group, options);
  const prompt = JSON.stringify(group);
  const result = ledger.classifyRequest({ prompt });
  assert.equal(result.coverageIncomplete, false);
  for (const value of [group.mail, group.mailNickname, ...group.proxyAddresses]) {
    assert.ok(result.spans.some(span => span.kind === "identity" && prompt.slice(span.start, span.end) === value), value);
  }

  // Simulate older mapped evidence and verify the request detector raises it.
  const stale = new ClassificationLedger(identityIndex);
  stale.registerClassified("graph:groups", {
    fields: [{ key: "mail", value: group.mail, kind: "configuration" }], incomplete: false,
  });
  const staleResult = stale.classifyRequest({ prompt: JSON.stringify({ mail: group.mail }) });
  assert.equal(staleResult.coverageIncomplete, false);
  assert.equal(staleResult.spans[0]?.kind, "identity");
  assert.equal(staleResult.spans[0]?.source, "detector:email");
  assert.equal(classifyData({ displayName: group.mail }, options).classes["/displayName"], "identity");
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

test("worker synchronization cannot report complete coverage after evidence is evicted", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ledger = new ClassificationLedger();
  const setting = "known security setting";
  ledger.registerClassified("fixture:policy", { incomplete: false,
    fields: [{ value: setting, key: "setting", kind: "security" }] });
  for (let i = 0; i < 125; i++) {
    ledger.registerClassified("fixture:tenant", { incomplete: false,
      fields: [{ value: i + "-identity".padEnd(15_900, "x"), key: "displayName", kind: "identity" }] });
  }
  ledger.registerClassified("fixture:tenant", { incomplete: false,
    fields: [{ value: "identity filler".padEnd(4600, "y"), key: "displayName", kind: "identity" }] });
  const prompt = " ".repeat(600) + setting;
  assert.equal(ledger.classifyRequest({ prompt }).counts.security, 1);
  const post = ClassificationWorker.prototype.post;
  let synchronized = false;
  t.mock.method(ClassificationWorker.prototype, "post", function (
    this: ClassificationWorker, ...args: Parameters<ClassificationWorker["post"]>
  ) {
    post.apply(this, args);
    if (synchronized || args[0].type !== "values") return;
    synchronized = true;
    ledger.registerClassified("fixture:tenant", { incomplete: false,
      fields: [{ value: "new identity".padEnd(110, "z"), key: "displayName", kind: "identity" }] });
  });
  try {
    const result = await ledger.classifyLargeRequest({ prompt });
    assert.equal(synchronized, true);
    assert.equal(result.counts.security, 0);
    assert.equal(result.droppedValues, 1);
    assert.equal(result.coverageIncomplete, true);
    assert.equal(result.effectiveClass, "credential");
  } finally { ledger.dispose(); }
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
        registerGraphTenantData("/applications", payload);
        await ledger.waitForObservations();
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

test("provider dispatch preserves incomplete coverage while scoped ingress is pending", async t => {
  const ledger = new ClassificationLedger();
  const other = new ClassificationLedger();
  const events: RequestClassificationEvent[] = [];
  let resolveFinished!: () => void;
  const finished = new Promise<void>(resolve => { resolveFinished = resolve; });
  const pending = ledger.scheduleRegistration(1, () => finished);
  const request = { prompt: "A short request" };
  const model = withRequestClassification({
    available: true,
    async complete(options) {
      assert.equal(options, request);
      return { text: "done", model: "fixture" };
    },
    async *stream() {},
  }, "ollama", event => events.push(event));
  try {
    assert.equal((await withClassificationScope(ledger, () => model.complete(request))).text, "done");
    await withClassificationScope(other, () => model.complete(request));
    await other.waitForObservations();
    assert.equal(events.find(event => !event.classification.coverageIncomplete)?.classification.unexamined.registrations, 0);
    resolveFinished();
    await pending;
    await ledger.waitForObservations();
    const incomplete = events.find(event => event.classification.coverageIncomplete);
    assert.equal(incomplete?.classification.unexamined.registrations, 1);
    assert.equal(incomplete?.classification.effectiveClass, "credential");
  } finally {
    resolveFinished();
    ledger.dispose();
    other.dispose();
  }
});

test("Secure Score Graph ingress preserves field evidence across bounded worker batches", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const post = ClassificationWorker.prototype.post;
  const batches: number[] = [];
  t.mock.method(ClassificationWorker.prototype, "post", function (
    this: ClassificationWorker, ...args: Parameters<ClassificationWorker["post"]>
  ) {
    if (args[0].type === "graph-rows") batches.push(args[0].rows.length);
    post.apply(this, args);
  });
  const scores = Array.from({ length: 90 }, (_, i) => ({
    id: `score-${i}`,
    controlScores: Array.from({ length: 242 }, (_, j) => ({
      controlName: `Control${j}`,
      description: "A synthetic description for the control that applies to the organization. ".repeat(3),
    })),
    ...(i === 89 ? { secretText: "synthetic-score-secret-value" } : {}),
  }));
  const ledger = new ClassificationLedger();
  try {
    await ledger.registerGraph("/security/secureScores", { value: scores, "@odata.nextLink": "https://graph.invalid/continuation" });
    const result = ledger.classifyRequest({ prompt: 'synthetic-score-secret-value https://graph.invalid/continuation' });
    assert.equal(result.counts.credential, 1);
    assert.equal(result.counts.identity, 1);
    assert.equal(result.coverageIncomplete, false);
    assert.equal(batches.reduce((sum, batch) => sum + batch, 0), scores.length);
    assert.ok(batches.every(batch => batch <= 4));
  } finally {
    ledger.dispose();
  }
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
  assert.equal(events.length, 0);
  t.mock.timers.tick(2_750);
  await ledger.waitForObservations();
  clearTimeout(deadline);
  assert.equal(events[0]?.failed, true);
  assert.equal(events[0]?.classification.coverageIncomplete, true);
  assert.equal(events[0]?.classification.effectiveClass, "credential");
  assert.equal(events[0]?.classification.counts.credential, 0);
});

test("request observation reserves capacity before scheduling and cancels without starting the scan", async t => {
  const ledger = new ClassificationLedger();
  const events: RequestClassificationEvent[] = [];
  const schedule = t.mock.method(ledger, "observeRequest");
  const scan = t.mock.method(ledger, "classifyProviderRequest");
  const request = { prompt: "The original provider request", system: "Original system" };
  const llm = withRequestClassification({
    available: true,
    async complete(options) {
      assert.equal(options, request);
      return { text: "completed", model: "fixture" };
    },
    async *stream() {},
  }, "ollama", event => events.push(event));
  const dispatch = () => withClassificationScope(ledger, () => llm.complete(request));
  const jobs = Array.from({ length: CLASSIFICATION_QUEUE_MAX_JOBS }, () => reserveClassificationRequest(1)!);
  try {
    assert.equal((await dispatch()).text, "completed");
    await ledger.waitForObservations();
    assert.equal(schedule.mock.callCount(), 0);
    for (const job of jobs) job.release();

    const bytes = reserveClassificationRequest(CLASSIFICATION_QUEUE_MAX_BYTES)!;
    try {
      await dispatch();
      await ledger.waitForObservations();
      assert.equal(schedule.mock.callCount(), 0);
    } finally { bytes.release(); }

    const prior = Array.from({ length: CLASSIFICATION_QUEUE_MAX_JOBS - 1 }, () => reserveClassificationRequest(1)!);
    try {
      await dispatch();
      assert.equal(schedule.mock.callCount(), 1);
      assert.equal(reserveClassificationRequest(1), undefined);
      ledger.dispose();
      const reused = reserveClassificationRequest(1);
      assert.ok(reused);
      reused.release();
      await ledger.waitForObservations();
    } finally { for (const job of prior) job.release(); }
    assert.equal(scan.mock.callCount(), 0);
    assert.deepEqual(events.map(event => [
      event.failed, event.classification.effectiveClass, event.classification.unexamined.textCodeUnits,
    ]), Array.from({ length: 2 }, () => [true, "credential", request.system.length + request.prompt.length]));
  } finally {
    for (const job of jobs) job.release();
    ledger.dispose();
  }
});

test("pending ingress reserves capacity across ledgers before starting and shares one continuation per turn", async () => {
  const ledgers = Array.from({ length: 14 }, () => new ClassificationLedger());
  const entries: string[] = [];
  const cost = Math.floor(CLASSIFICATION_QUEUE_MAX_BYTES / 12);
  const jobs = ledgers.map((ledger, index) => ledger.scheduleRegistration(cost, async signal => {
    entries.push(`start ${index}`);
    await new ClassificationSlice(signal).yield();
    entries.push(`resume ${index}`);
  }));
  try {
    assert.equal(entries.length, 0);
    assert.equal(reserveClassificationRequest(32), undefined);
    assert.equal(ledgers[12]!.classifyRequest({ prompt: "fixture" }).coverageIncomplete, true);
    assert.equal(ledgers[13]!.classifyRequest({ prompt: "fixture" }).effectiveClass, "credential");
    await nextTick();
    assert.deepEqual(entries, ["start 0"]);
    await nextTick();
    assert.deepEqual(entries, ["start 0", "start 1"]);
    ledgers[11]!.dispose();
    const reused = reserveClassificationRequest(cost);
    assert.ok(reused);
    reused.release();
    await Promise.all(jobs);
    assert.equal(entries.length, 22);
    assert.ok(!entries.includes("start 11"));
    assert.equal(ledgers[12]!.classifyRequest({ prompt: "fixture" }).unexamined.registrations, 1);
  } finally {
    for (const ledger of ledgers) ledger.dispose();
    await Promise.all(jobs);
  }
});

test("the classification queue bounds job count and unlinks cancelled jobs before the active scan settles", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new ClassificationWorker();
  t.mock.method(client, "post", () => {});
  const stalled = async () => ({
    message: { type: "scan" as const, sections: { system: undefined, prompt: undefined }, ledgers: [], shards: [],
      state: { historyFences: new Map(), dropped: 0, registrations: 0, incomplete: false } },
  });
  const start = client.run<"scan">(1, stalled);
  const active = assert.rejects(start, /fixture shutdown/);
  const cancel = new AbortController();
  let prepared = 0;
  const queued = Array.from({ length: CLASSIFICATION_QUEUE_MAX_JOBS - 1 }, () =>
    assert.rejects(client.run<"scan">(1, () => { prepared++; return stalled(); }, cancel.signal), /cancelled/));
  await assert.rejects(client.run<"scan">(1, stalled), /queue is full/);
  cancel.abort();
  await Promise.all(queued);
  const next = assert.rejects(client.run<"scan">(1, stalled), /fixture shutdown/);
  await client.stop(new Error("fixture shutdown"));
  await Promise.all([active, next]);
  assert.equal(prepared, 0);
  await assert.rejects(client.run<"scan">(1, stalled), /fixture shutdown/);
});

test("cancelling a queued classification releases its byte budget promptly", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new ClassificationWorker();
  t.mock.method(client, "post", () => {});
  const stalled = async () => ({
    message: { type: "scan" as const, sections: { system: undefined, prompt: undefined }, ledgers: [], shards: [],
      state: { historyFences: new Map(), dropped: 0, registrations: 0, incomplete: false } },
  });
  const half = CLASSIFICATION_QUEUE_MAX_BYTES / 2;
  const active = assert.rejects(client.run<"scan">(half, stalled), /fixture shutdown/);
  const cancel = new AbortController();
  const pending = assert.rejects(client.run<"scan">(half, stalled, cancel.signal), /cancelled/);
  await assert.rejects(client.run<"scan">(1, stalled), /queue is full/);
  cancel.abort();
  await pending;
  const next = assert.rejects(client.run<"scan">(half, stalled), /fixture shutdown/);
  await client.stop(new Error("fixture shutdown"));
  await Promise.all([active, next]);
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

test("request sequence follows dispatch through an out-of-order failure and success", async t => {
  const ledger = new ClassificationLedger();
  const observed: RequestClassificationEvent[] = [];
  let release!: () => void;
  const stall = new Promise<void>(resolve => { release = resolve; });
  const classifier = ledger.classifyProviderRequest.bind(ledger);
  t.mock.method(ledger, "classifyProviderRequest", async (...args: Parameters<typeof classifier>) => {
    if (args[0].prompt === "first") {
      await stall;
      throw new Error("Fixture observation failure");
    }
    return classifier(...args);
  });
  let observeStream!: () => void;
  const streamObserved = new Promise<void>(resolve => { observeStream = resolve; });
  const llm = withRequestClassification({
    available: true,
    async complete() { return { text: "first result", model: "fixture" }; },
    async *stream() {},
  }, "ollama", event => {
    observed.push(event);
    if (event.method === "stream") observeStream();
  });
  try {
    await withClassificationScope(ledger, () => llm.complete({ prompt: "first" }));
    await withClassificationScope(ledger, () => llm.stream({ prompt: "second" })[Symbol.asyncIterator]().next());
    await streamObserved;
    release();
    await ledger.waitForObservations();
    assert.deepEqual(observed.map(event => [event.method, event.failed]), [["stream", false], ["complete", true]]);
    assert.equal(observed[0]!.requestSequence, observed[1]!.requestSequence + 1);
  } finally {
    release();
    ledger.dispose();
  }
});

test("a failed worker transport reports incomplete coverage and recovers on the next request", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
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
