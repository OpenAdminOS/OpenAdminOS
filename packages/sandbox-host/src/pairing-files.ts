import { createPrivateKey, X509Certificate } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  createTlsCertificate,
  exportDevicePrivateKey,
  generateDeviceIdentity,
  importDevicePrivateKey,
  isTlsSpkiPin,
  tlsSpkiSha256,
  verifyPairingRecord,
  verifyScheduleAssignment,
  type DeviceIdentity,
  type PairingRecord,
  type ScheduleAssignment,
  type SignedScheduleAssignment,
  type TlsCertificate,
} from "@openadminos/pairing";

import { describe, readPrivateFile } from "./files.js";
import { SandboxRefusal } from "./refusal.js";
import { writeFileAtomic } from "./store.js";

/** File names in the data folder, all mode 0600. */
export const PAIRING_FILES = {
  identity: "device-identity.pem",
  tlsKey: "tls-key.pem",
  tlsCertificate: "tls-certificate.pem",
  pairing: "pairing.json",
  assignments: "assignments.json",
} as const;

/** The TLS certificate is valid this long and reissued with the same key when this close to expiry. */
export const TLS_VALIDITY_DAYS = 365;
export const TLS_REISSUE_DAYS = 30;
const DAY_MS = 86_400_000;

/** The sandbox's Ed25519 device key: read from the data folder, or created on first start. */
export function loadOrCreateDeviceIdentity(dataDir: string): DeviceIdentity {
  const path = join(dataDir, PAIRING_FILES.identity);
  if (!existsSync(path)) {
    const identity = generateDeviceIdentity();
    writeFileAtomic(path, exportDevicePrivateKey(identity));
    return identity;
  }
  const pem = readPrivateFile(path, "sandbox device key");
  try {
    return importDevicePrivateKey(pem);
  } catch (error) {
    throw invalidFile(PAIRING_FILES.identity, `is not an Ed25519 private key (${describe(error)})`, KEY_RECOVERY);
  }
}

/**
 * The TLS certificate of the pairing API. Created with a new P-256 key on
 * first start; reissued with the same key, so the pin the desktop holds
 * stays valid, when it is missing, unreadable, does not match the key, or
 * expires within 30 days.
 */
export function loadOrCreateTlsCertificate(dataDir: string, commonName: string, now: Date): TlsCertificate & { reissued: boolean } {
  const keyPath = join(dataDir, PAIRING_FILES.tlsKey);
  const certificatePath = join(dataDir, PAIRING_FILES.tlsCertificate);
  const privateKeyPem = existsSync(keyPath) ? readPrivateFile(keyPath, "pairing TLS key") : undefined;
  if (privateKeyPem && existsSync(certificatePath)) {
    const certificatePem = readPrivateFile(certificatePath, "pairing TLS certificate");
    const current = currentCertificate(certificatePem, privateKeyPem, now);
    if (current) return { ...current, reissued: false };
  }
  let created: TlsCertificate;
  try {
    created = createTlsCertificate({ commonName, validityDays: TLS_VALIDITY_DAYS, now, ...(privateKeyPem ? { privateKey: privateKeyPem } : {}) });
  } catch (error) {
    throw invalidFile(PAIRING_FILES.tlsKey, `cannot be used for the pairing certificate (${describe(error)})`, KEY_RECOVERY);
  }
  if (!privateKeyPem) writeFileAtomic(keyPath, created.privateKeyPem);
  writeFileAtomic(certificatePath, created.certificatePem);
  return { ...created, reissued: privateKeyPem !== undefined };
}

function currentCertificate(certificatePem: string, privateKeyPem: string, now: Date): TlsCertificate | undefined {
  try {
    const certificate = new X509Certificate(certificatePem);
    if (!certificate.checkPrivateKey(createPrivateKey(privateKeyPem))) return undefined;
    if (certificate.validToDate.getTime() - now.getTime() < TLS_REISSUE_DAYS * DAY_MS) return undefined;
    if (certificate.validFromDate.getTime() > now.getTime()) return undefined;
    return { certificatePem, privateKeyPem, spkiSha256: tlsSpkiSha256(certificate) };
  } catch {
    return undefined;
  }
}

/** What pairing.json holds: the record the sandbox signed, and the desktop's TLS client pin. */
export interface StoredPairing {
  record: PairingRecord;
  signature: string;
  /** SHA-256 of the desktop's client certificate SubjectPublicKeyInfo. */
  desktopTlsSpkiSha256: string;
}

/** pairing.json, checked against the sandbox's own key, or undefined when unpaired. */
export function readPairing(dataDir: string, identity: DeviceIdentity): StoredPairing | undefined {
  const path = join(dataDir, PAIRING_FILES.pairing);
  if (!existsSync(path)) return undefined;
  const value = parseJson(readPrivateFile(path, "pairing file"), PAIRING_FILES.pairing);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidFile(PAIRING_FILES.pairing, "is not an object");
  const { version, record, signature, desktopTlsSpkiSha256 } = value as Record<string, unknown>;
  if (version !== 1) throw invalidFile(PAIRING_FILES.pairing, "has an unknown version");
  const verified = verifyPairingRecord({ record, signature }, identity.publicKey);
  if (!verified.ok) throw invalidFile(PAIRING_FILES.pairing, `does not hold a pairing record this sandbox signed (${verified.detail})`);
  if (!isTlsSpkiPin(desktopTlsSpkiSha256)) throw invalidFile(PAIRING_FILES.pairing, "has no valid desktop TLS pin");
  return { record: verified.value, signature: signature as string, desktopTlsSpkiSha256 };
}

export function writePairing(dataDir: string, pairing: StoredPairing): void {
  writeFileAtomic(join(dataDir, PAIRING_FILES.pairing), `${JSON.stringify({ version: 1, ...pairing }, null, 2)}\n`);
}

/** assignments.json, checked against the paired desktop's key, or undefined when none was applied. */
export function readAssignments(dataDir: string, desktopPublicKey: string): { signed: SignedScheduleAssignment; assignment: ScheduleAssignment } | undefined {
  const path = join(dataDir, PAIRING_FILES.assignments);
  if (!existsSync(path)) return undefined;
  const value = parseJson(readPrivateFile(path, "assignments file"), PAIRING_FILES.assignments);
  const verified = verifyScheduleAssignment(value, desktopPublicKey);
  if (!verified.ok) throw invalidFile(PAIRING_FILES.assignments, `does not hold an assignment the paired desktop signed (${verified.detail})`);
  return { signed: value as SignedScheduleAssignment, assignment: verified.value };
}

export function writeAssignments(dataDir: string, signed: SignedScheduleAssignment): void {
  writeFileAtomic(join(dataDir, PAIRING_FILES.assignments), `${JSON.stringify(signed, null, 2)}\n`);
}

/** Removes one pairing file; true when it existed. */
export function removePairingFile(dataDir: string, name: (typeof PAIRING_FILES)["pairing" | "assignments"]): boolean {
  const path = join(dataDir, name);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** Removes pairing.json and assignments.json; returns the names of the files that existed. */
export function removePairingFiles(dataDir: string): string[] {
  const removed: string[] = [];
  for (const name of [PAIRING_FILES.assignments, PAIRING_FILES.pairing]) {
    const path = join(dataDir, name);
    if (!existsSync(path)) continue;
    rmSync(path, { force: true });
    removed.push(name);
  }
  return removed;
}

function parseJson(text: string, name: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidFile(name, "is not valid JSON");
  }
}

const UNPAIR_RECOVERY = "Run openadminos-sandbox --config <path> --unpair to remove the pairing, then pair the desktop again.";
const KEY_RECOVERY = "Restore it from a backup, or remove it so the host creates a new one; a new key needs the desktop to pair again.";

function invalidFile(name: string, problem: string, recovery = UNPAIR_RECOVERY): SandboxRefusal {
  return new SandboxRefusal("pairing-files-invalid", `${name} in the sandbox data folder ${problem}. ${recovery}`);
}
