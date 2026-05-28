import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createRegistryInstallCountPayload } from "./install-stats.js";

describe("createRegistryInstallCountPayload", () => {
  it("sends only registry install count fields", () => {
    const rawInstallId = "123e4567-e89b-12d3-a456-426614174000";
    const payload = createRegistryInstallCountPayload({
      slug: "offboarding-agent",
      rawInstallId,
      version: "0.2.0",
      platform: "darwin",
      now: new Date("2026-05-28T12:00:00.000Z"),
    });

    assert.deepEqual(Object.keys(payload).sort(), [
      "installId",
      "platform",
      "slug",
      "version",
    ]);
    assert.match(payload.installId, /^[0-9a-f]{64}$/);
    assert.notEqual(payload.installId, rawInstallId);

    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes(rawInstallId), false);
    assert.equal(serialized.includes("tenant"), false);
    assert.equal(serialized.includes("prompt"), false);
    assert.equal(serialized.includes("run"), false);
    assert.equal(serialized.includes("graph"), false);
    assert.equal(serialized.includes("user"), false);
  });

  it("rotates dedupe ids by calendar year and agent slug", () => {
    const base = {
      rawInstallId: "123e4567-e89b-12d3-a456-426614174000",
      version: "0.2.0",
      platform: "darwin" as const,
    };

    const first = createRegistryInstallCountPayload({
      ...base,
      slug: "offboarding-agent",
      now: new Date("2026-05-28T12:00:00.000Z"),
    });
    const sameYear = createRegistryInstallCountPayload({
      ...base,
      slug: "offboarding-agent",
      now: new Date("2026-12-31T23:59:59.000Z"),
    });
    const nextYear = createRegistryInstallCountPayload({
      ...base,
      slug: "offboarding-agent",
      now: new Date("2027-01-01T00:00:00.000Z"),
    });
    const otherAgent = createRegistryInstallCountPayload({
      ...base,
      slug: "find-inactive-devices",
      now: new Date("2026-05-28T12:00:00.000Z"),
    });

    assert.equal(first.installId, sameYear.installId);
    assert.notEqual(first.installId, nextYear.installId);
    assert.notEqual(first.installId, otherAgent.installId);
  });
});
