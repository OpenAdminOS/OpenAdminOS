import assert from "node:assert/strict";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { exportDevicePublicKey, generateDeviceIdentity, signPairingRecord, signScheduleAssignment } from "@openadminos/pairing";

import {
  loadOrCreateDeviceIdentity,
  loadOrCreateTlsCertificate,
  PAIRING_FILES,
  readAssignments,
  readPairing,
  removePairingFiles,
  writeAssignments,
  writePairing,
} from "./pairing-files.js";
import { SandboxRefusal } from "./refusal.js";
import { tempDir, TENANT } from "./test-support.js";

const DAY = 86_400_000;

function reasonOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof SandboxRefusal);
    return error.reason;
  }
  return "accepted";
}

describe("pairing files", () => {
  it("creates the device key once, private, and reads it back", () => {
    const { dir, cleanup } = tempDir();
    try {
      const first = loadOrCreateDeviceIdentity(dir);
      assert.equal(statSync(join(dir, PAIRING_FILES.identity)).mode & 0o777, 0o600);
      assert.equal(exportDevicePublicKey(loadOrCreateDeviceIdentity(dir).publicKey), exportDevicePublicKey(first.publicKey));
      writeFileSync(join(dir, PAIRING_FILES.identity), "not a key", { mode: 0o600 });
      assert.equal(reasonOf(() => loadOrCreateDeviceIdentity(dir)), "pairing-files-invalid");
    } finally {
      cleanup();
    }
  });

  it("keeps the TLS certificate until 30 days before expiry, then reissues it with the same key", () => {
    const { dir, cleanup } = tempDir();
    try {
      const start = new Date("2026-11-15T00:00:00Z");
      const first = loadOrCreateTlsCertificate(dir, "mini-pc", start);
      assert.equal(first.reissued, false);
      for (const name of [PAIRING_FILES.tlsKey, PAIRING_FILES.tlsCertificate]) {
        assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600, name);
      }
      const later = loadOrCreateTlsCertificate(dir, "mini-pc", new Date(start.getTime() + 300 * DAY));
      assert.equal(later.certificatePem, first.certificatePem, "not yet due");
      const renewed = loadOrCreateTlsCertificate(dir, "mini-pc", new Date(start.getTime() + 340 * DAY));
      assert.equal(renewed.reissued, true);
      assert.notEqual(renewed.certificatePem, first.certificatePem);
      assert.equal(renewed.spkiSha256, first.spkiSha256, "the pin stays the same");
      // A removed certificate is reissued with the kept key as well.
      writeFileSync(join(dir, PAIRING_FILES.tlsCertificate), "garbage", { mode: 0o600 });
      assert.equal(loadOrCreateTlsCertificate(dir, "mini-pc", new Date(start.getTime() + 341 * DAY)).spkiSha256, first.spkiSha256);
    } finally {
      cleanup();
    }
  });

  it("reads back a pairing the sandbox signed and refuses one it did not", () => {
    const { dir, cleanup } = tempDir();
    try {
      const sandbox = loadOrCreateDeviceIdentity(dir);
      const desktop = generateDeviceIdentity();
      const tls = loadOrCreateTlsCertificate(dir, "mini-pc", new Date());
      const record = {
        pairingId: "pairing-1",
        sandboxId: "mini-pc",
        sandboxName: "Office mini PC",
        organizationId: "org-1",
        tenantId: TENANT,
        sandboxPublicKey: exportDevicePublicKey(sandbox.publicKey),
        tlsSpkiSha256: tls.spkiSha256,
        desktopPublicKey: exportDevicePublicKey(desktop.publicKey),
        createdAt: new Date(0).toISOString(),
      };
      assert.equal(readPairing(dir, sandbox), undefined);
      const signed = signPairingRecord(record, sandbox.privateKey);
      writePairing(dir, { ...signed, desktopTlsSpkiSha256: "a".repeat(64) });
      assert.equal(statSync(join(dir, PAIRING_FILES.pairing)).mode & 0o777, 0o600);
      assert.deepEqual(readPairing(dir, sandbox)?.record, record);

      writePairing(dir, { ...signPairingRecord(record, desktop.privateKey), desktopTlsSpkiSha256: "a".repeat(64) });
      assert.equal(reasonOf(() => readPairing(dir, sandbox)), "pairing-files-invalid");

      const assignment = { pairingId: "pairing-1", version: 1, organizationId: "org-1", tenantId: TENANT, entries: [], issuedAt: new Date(0).toISOString() };
      writeAssignments(dir, signScheduleAssignment(assignment, desktop.privateKey));
      assert.deepEqual(readAssignments(dir, exportDevicePublicKey(desktop.publicKey))?.assignment, assignment);
      assert.equal(reasonOf(() => readAssignments(dir, exportDevicePublicKey(sandbox.publicKey))), "pairing-files-invalid");

      assert.deepEqual(removePairingFiles(dir), [PAIRING_FILES.assignments, PAIRING_FILES.pairing]);
      assert.deepEqual(removePairingFiles(dir), []);
      assert.equal(readPairing(dir, sandbox), undefined);
    } finally {
      cleanup();
    }
  });
});
