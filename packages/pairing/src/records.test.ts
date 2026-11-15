import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTlsCertificate } from "./certificate.js";
import { PairingError } from "./errors.js";
import { exportDevicePublicKey, generateDeviceIdentity } from "./identity.js";
import {
  parseAuditCheckpoint,
  parsePairingRecord,
  parseScheduleAssignment,
  signAuditCheckpoint,
  signPairingRecord,
  signScheduleAssignment,
  verifyAuditCheckpoint,
  verifyPairingRecord,
  verifyScheduleAssignment,
  type AuditCheckpoint,
  type PairingRecord,
  type ScheduleAssignment,
} from "./records.js";
import { sign } from "./signatures.js";

const sandbox = generateDeviceIdentity();
const desktop = generateDeviceIdentity();

function record(overrides: Record<string, unknown> = {}): PairingRecord {
  return {
    pairingId: "pairing-1",
    sandboxId: "office-mini-pc",
    sandboxName: "Office mini PC",
    organizationId: "org-1",
    tenantId: "11111111-2222-3333-4444-555555555555",
    sandboxPublicKey: exportDevicePublicKey(sandbox.publicKey),
    tlsSpkiSha256: createTlsCertificate({ commonName: "openadminos-sandbox" }).spkiSha256,
    desktopPublicKey: exportDevicePublicKey(desktop.publicKey),
    createdAt: "2026-11-14T12:00:00.000Z",
    ...overrides,
  } as PairingRecord;
}

function checkpoint(overrides: Record<string, unknown> = {}): AuditCheckpoint {
  return { pairingId: "pairing-1", sandboxId: "office-mini-pc", seq: 12, sha256: "a".repeat(64), rowCount: 12, at: "2026-11-14T13:00:00.000Z", ...overrides } as AuditCheckpoint;
}

describe("PairingRecord", () => {
  it("accepts a complete record and returns a copy", () => {
    const input = record();
    const parsed = parsePairingRecord(input);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.value, input);
    assert.notEqual(parsed.value, input);
  });

  it("refuses each malformed field", () => {
    const cases: Record<string, unknown>[] = [
      { pairingId: "" },
      { sandboxId: "a\u0000b" },
      { sandboxName: " padded" },
      { organizationId: "x".repeat(201) },
      { tenantId: "11111111-2222-3333-4444-55555555555A" },
      { tenantId: "tenant" },
      { sandboxPublicKey: "short" },
      { desktopPublicKey: exportDevicePublicKey(sandbox.publicKey) },
      { tlsSpkiSha256: "A".repeat(64) },
      { createdAt: "2026-11-14" },
      { createdAt: "2026-11-14T12:00:00Z" },
      { extra: true },
    ];
    for (const change of cases) {
      assert.equal(parsePairingRecord(record(change)).ok, false, JSON.stringify(change));
    }
    const { createdAt: _createdAt, ...missing } = record();
    assert.equal(parsePairingRecord(missing).ok, false);
    assert.equal(parsePairingRecord(null).ok, false);
    assert.equal(parsePairingRecord([]).ok, false);
    assert.equal(parsePairingRecord(Object.assign(Object.create({ inherited: 1 }), record())).ok, false);
  });

  it("verifies a signed record with the signer's key only", () => {
    const signed = signPairingRecord(record(), sandbox.privateKey);
    assert.ok(verifyPairingRecord(signed, sandbox.publicKey).ok);
    assert.ok(verifyPairingRecord(JSON.parse(JSON.stringify(signed)), exportDevicePublicKey(sandbox.publicKey)).ok);
    assert.equal(verifyPairingRecord(signed, desktop.publicKey).ok, false);
  });

  it("detects tampering and a signature from another domain", () => {
    const signed = signPairingRecord(record(), sandbox.privateKey);
    assert.equal(verifyPairingRecord({ ...signed, record: { ...signed.record, organizationId: "org-2" } }, sandbox.publicKey).ok, false);
    assert.equal(verifyPairingRecord({ ...signed, extra: 1 }, sandbox.publicKey).ok, false);
    assert.equal(verifyPairingRecord({ record: signed.record }, sandbox.publicKey).ok, false);
    const crossDomain = { record: signed.record, signature: sign("openadminos.audit.checkpoint.v1", signed.record, sandbox.privateKey) };
    assert.equal(verifyPairingRecord(crossDomain, sandbox.publicKey).ok, false);
    assert.equal(verifyPairingRecord("signed", sandbox.publicKey).ok, false);
  });

  it("refuses to sign a malformed record", () => {
    assert.throws(() => signPairingRecord(record({ tenantId: "x" }), sandbox.privateKey), (error) => error instanceof PairingError && error.reason === "payload-invalid");
  });
});

describe("AuditCheckpoint", () => {
  it("accepts a checkpoint, including the empty log", () => {
    assert.ok(parseAuditCheckpoint(checkpoint()).ok);
    assert.ok(parseAuditCheckpoint(checkpoint({ seq: 0, rowCount: 0, sha256: "0".repeat(64) })).ok);
    assert.ok(parseAuditCheckpoint(checkpoint({ seq: 40, rowCount: 3 })).ok);
  });

  it("refuses each malformed field", () => {
    const cases: Record<string, unknown>[] = [
      { seq: -1 },
      { seq: 1.5 },
      { seq: Number.NaN },
      { seq: "12" },
      { sha256: "a".repeat(63) },
      { rowCount: 13 },
      { rowCount: -1 },
      { at: "yesterday" },
      { pairingId: "" },
      { sandboxId: 7 },
      { extra: 1 },
    ];
    for (const change of cases) {
      assert.equal(parseAuditCheckpoint(checkpoint(change)).ok, false, JSON.stringify(change));
    }
  });

  it("verifies only with the sandbox key and untampered", () => {
    const signed = signAuditCheckpoint(checkpoint(), sandbox.privateKey);
    assert.ok(verifyAuditCheckpoint(signed, sandbox.publicKey).ok);
    assert.equal(verifyAuditCheckpoint(signed, desktop.publicKey).ok, false);
    assert.equal(verifyAuditCheckpoint({ ...signed, checkpoint: { ...signed.checkpoint, seq: 13, rowCount: 13 } }, sandbox.publicKey).ok, false);
    const crossDomain = { checkpoint: signed.checkpoint, signature: sign("openadminos.pairing.record.v1", signed.checkpoint, sandbox.privateKey) };
    assert.equal(verifyAuditCheckpoint(crossDomain, sandbox.publicKey).ok, false);
    assert.throws(() => signAuditCheckpoint(checkpoint({ rowCount: 99 }), sandbox.privateKey), PairingError);
  });
});

describe("ScheduleAssignment", () => {
  const assignment = (overrides: Record<string, unknown> = {}): ScheduleAssignment => ({
    pairingId: "pairing-1",
    version: 1,
    organizationId: "org-1",
    tenantId: "11111111-2222-3333-4444-555555555555",
    entries: [{ agentId: "compliance-overview", templateSha256: "b".repeat(64), intervalSeconds: 3600 }],
    issuedAt: "2026-11-15T10:00:00.000Z",
    ...overrides,
  }) as ScheduleAssignment;

  it("accepts an assignment, including an empty one", () => {
    assert.ok(parseScheduleAssignment(assignment()).ok);
    assert.ok(parseScheduleAssignment(assignment({ entries: [] })).ok);
  });

  it("refuses each malformed field", () => {
    const entry = { agentId: "compliance-overview", templateSha256: "b".repeat(64), intervalSeconds: 3600 };
    const cases: Record<string, unknown>[] = [
      { version: 0 },
      { version: 1.5 },
      { tenantId: "TENANT" },
      { organizationId: "" },
      { issuedAt: "today" },
      { entries: "all" },
      { entries: Array.from({ length: 51 }, (_, index) => ({ ...entry, agentId: `agent-${index}` })) },
      { entries: [entry, entry] },
      { entries: [{ ...entry, agentId: "Bad Id" }] },
      { entries: [{ ...entry, templateSha256: "B".repeat(64) }] },
      { entries: [{ ...entry, intervalSeconds: 0 }] },
      { entries: [{ ...entry, delivery: {} }] },
      { extra: 1 },
    ];
    for (const change of cases) {
      assert.equal(parseScheduleAssignment(assignment(change)).ok, false, JSON.stringify(change).slice(0, 80));
    }
  });

  it("verifies only with the desktop key, untampered and in its own domain", () => {
    const signed = signScheduleAssignment(assignment(), desktop.privateKey);
    assert.ok(verifyScheduleAssignment(signed, desktop.publicKey).ok);
    assert.equal(verifyScheduleAssignment(signed, sandbox.publicKey).ok, false);
    assert.equal(verifyScheduleAssignment({ ...signed, assignment: { ...signed.assignment, version: 2 } }, desktop.publicKey).ok, false);
    const crossDomain = { assignment: signed.assignment, signature: sign("openadminos.pairing.record.v1", signed.assignment, desktop.privateKey) };
    assert.equal(verifyScheduleAssignment(crossDomain, desktop.publicKey).ok, false);
    assert.throws(() => signScheduleAssignment(assignment({ version: 0 }), desktop.privateKey), PairingError);
  });
});
