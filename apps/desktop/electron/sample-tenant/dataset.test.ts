import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSampleTenantDataset } from "./dataset.js";

const NOW = new Date("2026-10-26T12:00:00.000Z");

describe("sample tenant dataset", () => {
  it("is deterministic for a fixed load time and materializes relative timestamps", () => {
    const first = createSampleTenantDataset(NOW);
    const second = createSampleTenantDataset(NOW);
    assert.deepEqual(first, second);

    const nextDay = createSampleTenantDataset(
      new Date("2026-10-27T12:00:00.000Z"),
    );
    const firstDevice = first.resources["/deviceManagement/managedDevices"]![0]!;
    const nextDevice = nextDay.resources["/deviceManagement/managedDevices"]![0]!;
    assert.equal(
      Date.parse(String(nextDevice.lastSyncDateTime)) -
        Date.parse(String(firstDevice.lastSyncDateTime)),
      24 * 60 * 60 * 1000,
    );
  });

  it("contains the curated inventory and planted findings", () => {
    const dataset = createSampleTenantDataset(NOW);
    const resources = dataset.resources;
    const devices = resources["/deviceManagement/managedDevices"]!;
    const entraDevices = resources["/devices"]!;
    const users = resources["/users"]!;
    const policies = resources["/identity/conditionalAccess/policies"]!;
    const applications = resources["/applications"]!;
    const mobileApps = resources["/deviceAppManagement/mobileApps"]!;
    const signIns = resources["/auditLogs/signIns"]!;

    assert.equal(devices.length, 120);
    assert.equal(users.length, 80);
    assert.equal(resources["/groups"]!.length, 25);
    assert.equal(resources["/deviceAppManagement/mobileApps"]!.length, 15);
    assert.equal(applications.length, 10);
    assert.equal(policies.length, 8);
    assert.equal(users.filter((user) => user.userType === "Guest").length, 8);
    assert.ok(users.some((user) => user.accountEnabled === false));

    const staleDevices = devices.filter(
      (device) =>
        Date.parse(String(device.lastSyncDateTime)) <
        NOW.getTime() - 7 * 24 * 60 * 60 * 1000,
    );
    assert.ok(staleDevices.length > 0);
    assert.ok(
      staleDevices.some((device) => {
        const entra = entraDevices.find(
          (entry) => entry.id === device.azureADDeviceId,
        );
        return (
          entra &&
          Date.parse(String(entra.approximateLastSignInDateTime)) >
            NOW.getTime() - 7 * 24 * 60 * 60 * 1000
        );
      }),
    );
    assert.ok(
      devices.some(
        (device) =>
          device.complianceState === "noncompliant" &&
          Array.isArray(device.complianceReasons) &&
          device.complianceReasons.length > 0,
      ),
    );
    assert.ok(
      devices.some(
        (device) =>
          device.operatingSystem === "Windows" && device.isEncrypted === false,
      ),
    );
    assert.ok(
      users.some(
        (user) =>
          user.userType === "Guest" &&
          Date.parse(String((user.signInActivity as Record<string, unknown>).lastSignInDateTime)) <
            NOW.getTime() - 90 * 24 * 60 * 60 * 1000,
      ),
    );
    assert.ok(policies.some((policy) => policy.state === "disabled"));
    assert.ok(
      policies.some(
        (policy) => policy.state === "enabledForReportingButNotEnforced",
      ),
    );
    assert.ok(
      policies.some((policy) => {
        const conditions = policy.conditions as {
          users?: { excludeUsers?: unknown[] };
        };
        return (conditions.users?.excludeUsers?.length ?? 0) >= 3;
      }),
    );
    assert.ok(
      applications.some((application) =>
        (application.passwordCredentials as Array<Record<string, unknown>>).some(
          (secret) =>
            Date.parse(String(secret.endDateTime)) > NOW.getTime() &&
            Date.parse(String(secret.endDateTime)) <
              NOW.getTime() + 7 * 24 * 60 * 60 * 1000,
        ),
      ),
    );
    assert.ok(
      applications.some((application) =>
        (application.passwordCredentials as Array<Record<string, unknown>>).some(
          (secret) => Date.parse(String(secret.endDateTime)) < NOW.getTime(),
        ),
      ),
    );
    assert.ok(
      mobileApps.some((app) => {
        const summary = app.installSummary as Record<string, unknown>;
        return app.isRequired === true && Number(summary.failedDeviceCount) > 0;
      }),
    );
    assert.ok(signIns.some((signIn) => Number((signIn.status as Record<string, unknown>).errorCode) !== 0));
    assert.ok(resources["/identityProtection/riskyUsers"]!.some((user) => user.riskState === "atRisk"));
    assert.equal(entraDevices.filter((device) => device.isManaged === false).length, 8);
    assert.ok(entraDevices.every((device) => typeof device.operatingSystemVersion === "string"));
    assert.equal(
      signIns.filter(
        (signIn) =>
          Number((signIn.status as Record<string, unknown>).errorCode) === 53003,
      ).length,
      12,
    );
    assert.equal(
      signIns.filter((signIn) => signIn.riskState === "atRisk").length,
      4,
    );
    assert.equal(resources["/security/incidents"]!.filter(
      (incident) => incident.severity === "high" && incident.status !== "resolved",
    ).length, 2);
    assert.equal(resources["/security/alerts_v2"]!.filter(
      (alert) => Date.parse(String(alert.createdDateTime)) >= NOW.getTime() - 7 * 24 * 60 * 60 * 1000,
    ).length, 5);
    assert.equal(resources["/security/secureScores"]!.length, 14);
    assert.equal(resources["/security/secureScoreControlProfiles"]!.length, 12);
    assert.equal(resources["/directoryRoles"]!.filter((role) =>
      ["Global Administrator", "Intune Administrator", "Privileged Role Administrator"].includes(String(role.displayName)),
    ).length, 3);
  });

  it("uses only reserved .invalid email domains", () => {
    const dataset = createSampleTenantDataset(NOW);
    const emails = collectStrings(dataset).filter((value) => value.includes("@"));
    assert.ok(emails.length > 0);
    for (const value of emails) {
      const addresses = value.match(/[A-Z0-9._%+#-]+@[A-Z0-9.-]+/gi) ?? [];
      for (const address of addresses) {
        assert.ok(
          address.toLowerCase().endsWith(".invalid"),
          `Unexpected sample email domain: ${address}`,
        );
      }
    }
  });
});

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(collectStrings);
}
