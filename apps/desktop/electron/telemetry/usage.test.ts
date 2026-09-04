import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { bucketCount, buildUsageTelemetryPayload } from "./usage.js";

describe("usage telemetry payload", () => {
  it("buckets counts into coarse ranges", () => {
    assert.equal(bucketCount(0), "0");
    assert.equal(bucketCount(1), "1");
    assert.equal(bucketCount(2), "2");
    assert.equal(bucketCount(4), "3-5");
    assert.equal(bucketCount(9), "6-10");
    assert.equal(bucketCount(40), "26-50");
    assert.equal(bucketCount(500), "100+");
  });

  it("carries only counts, versions, and coarse class fields", () => {
    const payload = buildUsageTelemetryPayload({
      installId: "anon-123",
      appVersion: "0.5.0",
      platform: "darwin",
      arch: "arm64",
      providerIsLocal: false,
      tenantCount: 3,
      installedAgentCount: 12,
      runCount: 400,
      retrievalIndexInstalled: true,
    });
    assert.deepEqual(payload, {
      schema: "openadminos-usage-1",
      installId: "anon-123",
      appVersion: "0.5.0",
      os: "darwin",
      arch: "arm64",
      providerClass: "hosted",
      tenants: "3-5",
      agents: "11-25",
      runs: "100+",
      retrievalIndex: true,
    });
    // Guard: the payload must never grow tenant-identifying keys.
    const keys = Object.keys(payload).sort();
    assert.deepEqual(keys, [
      "agents",
      "appVersion",
      "arch",
      "installId",
      "os",
      "providerClass",
      "retrievalIndex",
      "runs",
      "schema",
      "tenants",
    ]);
  });

  it("reports a local provider class when the active provider is local", () => {
    const payload = buildUsageTelemetryPayload({
      installId: "anon-1",
      appVersion: "0.5.0",
      platform: "linux",
      arch: "x64",
      providerIsLocal: true,
      tenantCount: 0,
      installedAgentCount: 0,
      runCount: 0,
      retrievalIndexInstalled: false,
    });
    assert.equal(payload.providerClass, "local");
    assert.equal(payload.tenants, "0");
  });
});
