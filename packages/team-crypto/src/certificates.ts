import { canonicalJson } from "./canonical.js";
import { CertificateChainError, FormatError, RecoveryKitError, RevokedDeviceError, StaleRevocationListError } from "./errors.js";
import { assertDeviceKeys, readPublicKey } from "./keys.js";
import { generateRecoveryKit, recoveryPrivateKey } from "./recovery.js";
import { signed, verifySigned } from "./signatures.js";
import type {
  CreatedTeam, CreateTeamOptions, DeviceCertificate, DeviceCertificateClaims, DeviceChainTrust,
  DeviceKeys, RecoveryCertificateClaims, RecoveryKit, RevocationList, RevocationListClaims, TeamRoot, TeamTrust,
} from "./types.js";
import { bytes, integer, record, sortedIds, text, timestamp } from "./validation.js";

const certificateFields = ["v", "teamId", "deviceId", "memberId", "role", "encryptionPublicKey", "signingPublicKey", "issuedAt", "issuerDeviceId", "issuerType"];
const revocationFields = ["v", "teamId", "version", "revokedDeviceIds", "issuedAt", "issuerDeviceId"];

function validateClaims(value: DeviceCertificateClaims, hasSignature: boolean): void {
  record(value, [...certificateFields, ...(hasSignature ? ["signature"] : [])], "Device certificate");
  for (const field of ["teamId", "deviceId", "memberId", "issuerDeviceId"] as const) text(value[field], field);
  if (value.role !== "admin" && value.role !== "member") throw new FormatError("Device role must be admin or member.");
  if (value.issuerType !== "device" && value.issuerType !== "recovery") throw new FormatError("Certificate issuer type must be device or recovery.");
  timestamp(value.issuedAt, "Certificate issuedAt");
  readPublicKey(value.encryptionPublicKey, "x25519");
  readPublicKey(value.signingPublicKey, "ed25519");
  if (hasSignature) bytes(value.signature, 64, "Certificate signature");
}

export function validateCertificate(value: DeviceCertificate): void {
  validateClaims(value, true);
}

export function issueDeviceCertificate(claims: DeviceCertificateClaims, issuerKeys: DeviceKeys): DeviceCertificate {
  validateClaims(claims, false);
  if (claims.issuerType !== "device") throw new CertificateChainError("Use the recovery kit to issue a recovery certificate.");
  assertDeviceKeys(issuerKeys);
  return signed("device-cert", { ...claims }, issuerKeys.signingPrivateKey);
}

function authenticateRoot(root: TeamRoot, pinnedKey: string): void {
  record(root, ["v", "teamId", "rootDeviceId", "signingPublicKey", "recoverySigningPublicKey", "createdAt", "signature"], "Team root");
  text(root.teamId, "Root teamId");
  text(root.rootDeviceId, "Root deviceId");
  timestamp(root.createdAt, "Root createdAt");
  readPublicKey(root.recoverySigningPublicKey, "ed25519");
  readPublicKey(pinnedKey, "ed25519");
  if (root.signingPublicKey !== pinnedKey) throw new CertificateChainError("Team root does not match the pinned signing key.");
  verifySigned("team-root", root, pinnedKey);
}

function certificateMap(certificates: readonly DeviceCertificate[], teamId: string): Map<string, DeviceCertificate> {
  if (!Array.isArray(certificates)) throw new FormatError("Chain certificates must be an array.");
  const result = new Map<string, DeviceCertificate>();
  for (const certificate of certificates) {
    validateCertificate(certificate);
    if (certificate.teamId !== teamId) throw new CertificateChainError("Chain certificate belongs to a different team.");
    if (result.has(certificate.deviceId)) throw new CertificateChainError("Chain contains duplicate device identifiers.");
    result.set(certificate.deviceId, certificate);
  }
  return result;
}

function chainToRoot(certificate: DeviceCertificate, certificates: Map<string, DeviceCertificate>, root: TeamRoot, revoked: Set<string>): DeviceCertificate[] {
  const chain: DeviceCertificate[] = [];
  const visited = new Set<string>();
  let current = certificate;
  while (true) {
    validateCertificate(current);
    if (current.teamId !== root.teamId) throw new CertificateChainError("Device certificate belongs to a different team.");
    if (revoked.has(current.deviceId)) throw new RevokedDeviceError(`Device ${current.deviceId} is revoked.`);
    if (visited.has(current.deviceId)) throw new CertificateChainError("Device certificate chain contains a cycle.");
    visited.add(current.deviceId);
    chain.push(current);
    if (current.issuerType === "recovery") {
      if (current.role !== "admin" || current.issuerDeviceId !== root.rootDeviceId || current.deviceId === root.rootDeviceId) throw new CertificateChainError("Recovery can only enroll a new admin device through the team root.");
      verifySigned("device-cert", current, root.recoverySigningPublicKey);
      return chain;
    }
    if (current.deviceId === root.rootDeviceId) {
      if (current.role !== "admin" || current.issuerDeviceId !== current.deviceId || current.signingPublicKey !== root.signingPublicKey) throw new CertificateChainError("Root certificate does not match the team root.");
      verifySigned("device-cert", current, root.signingPublicKey);
      return chain;
    }
    const issuer = certificates.get(current.issuerDeviceId);
    if (!issuer) throw new CertificateChainError(`Certificate issuer ${current.issuerDeviceId} is not in the chain.`);
    if (issuer.role !== "admin") throw new CertificateChainError(`Certificate issuer ${issuer.deviceId} is not an admin.`);
    verifySigned("device-cert", current, issuer.signingPublicKey);
    current = issuer;
  }
}

function validateRevocation(value: RevocationListClaims, hasSignature: boolean): void {
  record(value, [...revocationFields, ...(hasSignature ? ["signature"] : [])], "Revocation list");
  text(value.teamId, "Revocation teamId");
  text(value.issuerDeviceId, "Revocation issuerDeviceId");
  integer(value.version, "Revocation version");
  sortedIds(value.revokedDeviceIds, "Revoked device identifiers", true);
  timestamp(value.issuedAt, "Revocation issuedAt");
  if (hasSignature) bytes(value.signature, 64, "Revocation signature");
}

export function signRevocationList(claims: RevocationListClaims, issuerKeys: DeviceKeys): RevocationList {
  record(claims, revocationFields, "Revocation list");
  if (!Array.isArray(claims.revokedDeviceIds)) throw new FormatError("Revoked device identifiers must be an array.");
  // Copy before sorting so signing never mutates caller state.
  const body = { ...claims, revokedDeviceIds: [...claims.revokedDeviceIds].sort() };
  validateRevocation(body, false);
  assertDeviceKeys(issuerKeys);
  return signed("revocation-list", body, issuerKeys.signingPrivateKey);
}

function authenticateRevocations(list: RevocationList, trust: TeamTrust, certificates: Map<string, DeviceCertificate>): Set<string> {
  validateRevocation(list, true);
  integer(trust.lastAcceptedRevocationVersion, "Last accepted revocation version");
  if (list.teamId !== trust.root.teamId) throw new CertificateChainError("Revocation list belongs to a different team.");
  if (list.version < trust.lastAcceptedRevocationVersion) throw new StaleRevocationListError(`Revocation version ${list.version} is older than accepted version ${trust.lastAcceptedRevocationVersion}.`);
  const issuer = certificates.get(list.issuerDeviceId);
  if (!issuer || issuer.role !== "admin") throw new CertificateChainError("Revocation list must be signed by an admin in the certificate chain.");
  const revoked = new Set(list.revokedDeviceIds);
  chainToRoot(issuer, certificates, trust.root, revoked);
  verifySigned("revocation-list", list, issuer.signingPublicKey);
  return revoked;
}

/** Returns the authenticated list. Persist its version before accepting more team traffic. */
export function verifyRevocationList(list: RevocationList, trust: TeamTrust): RevocationList {
  authenticateRoot(trust.root, trust.pinnedRootSigningPublicKey);
  const certificates = certificateMap(trust.certificates, trust.root.teamId);
  authenticateRevocations(list, trust, certificates);
  return structuredClone(list);
}

/** Returns the chain in leaf-to-anchor order, or throws a typed error. */
export function verifyDeviceChain(certificate: DeviceCertificate, trust: DeviceChainTrust): DeviceCertificate[] {
  authenticateRoot(trust.root, trust.pinnedRootSigningPublicKey);
  validateCertificate(certificate);
  const certificates = certificateMap(trust.certificates, trust.root.teamId);
  const existing = certificates.get(certificate.deviceId);
  if (existing && canonicalJson(existing) !== canonicalJson(certificate)) throw new CertificateChainError("Device certificate conflicts with the supplied chain.");
  certificates.set(certificate.deviceId, certificate);
  const revoked = authenticateRevocations(trust.revocationList, trust, certificates);
  return structuredClone(chainToRoot(certificate, certificates, trust.root, revoked));
}

export function issueRecoveryDeviceCertificate(claims: RecoveryCertificateClaims, kit: RecoveryKit, root: TeamRoot): DeviceCertificate {
  authenticateRoot(root, root.signingPublicKey);
  const body: DeviceCertificateClaims = { ...claims, issuerType: "recovery", issuerDeviceId: root.rootDeviceId };
  validateClaims(body, false);
  if (claims.teamId !== root.teamId || claims.role !== "admin" || claims.deviceId === root.rootDeviceId) throw new CertificateChainError("Recovery must enroll a new admin device in the same team.");
  if (kit.signingPublicKey !== root.recoverySigningPublicKey) throw new RecoveryKitError("Recovery kit does not belong to this team root.");
  return signed("device-cert", body, recoveryPrivateKey(kit));
}

export function createTeam(options: CreateTeamOptions, keys: DeviceKeys): CreatedTeam {
  assertDeviceKeys(keys);
  const recoveryKit = generateRecoveryKit();
  const rootCertificate = issueDeviceCertificate({
    v: 1, ...options, role: "admin", issuerDeviceId: options.deviceId, issuerType: "device",
    encryptionPublicKey: keys.encryptionPublicKey, signingPublicKey: keys.signingPublicKey,
  }, keys);
  const root: TeamRoot = signed("team-root", {
    v: 1 as const, teamId: options.teamId, rootDeviceId: options.deviceId,
    signingPublicKey: keys.signingPublicKey, recoverySigningPublicKey: recoveryKit.signingPublicKey, createdAt: options.issuedAt,
  }, keys.signingPrivateKey);
  const revocationList = signRevocationList({
    v: 1, teamId: options.teamId, version: 0, revokedDeviceIds: [], issuedAt: options.issuedAt, issuerDeviceId: options.deviceId,
  }, keys);
  return { v: 1, root, rootCertificate, revocationList, recoveryKit };
}
