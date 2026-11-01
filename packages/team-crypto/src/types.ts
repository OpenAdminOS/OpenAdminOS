import type { KeyObject } from "node:crypto";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type DeviceRole = "admin" | "member";

export interface DevicePublicKeys {
  v: 1;
  encryptionPublicKey: string;
  signingPublicKey: string;
}

/** In-memory only. Use exportDeviceKeys for a serializable private key bundle. */
export interface DeviceKeys extends DevicePublicKeys {
  encryptionPrivateKey: KeyObject;
  signingPrivateKey: KeyObject;
}

/** Private keys are unencrypted PKCS8 DER, encoded as unpadded base64url. */
export interface SerializedDeviceKeys extends DevicePublicKeys {
  encryptionPrivateKey: string;
  signingPrivateKey: string;
}

export interface DeviceCertificateClaims extends DevicePublicKeys {
  teamId: string;
  deviceId: string;
  memberId: string;
  role: DeviceRole;
  issuedAt: string;
  issuerDeviceId: string;
  issuerType: "device" | "recovery";
}

export interface DeviceCertificate extends DeviceCertificateClaims {
  signature: string;
}

/** Authenticated by the separately pinned root signing key. */
export interface TeamRoot {
  v: 1;
  teamId: string;
  rootDeviceId: string;
  signingPublicKey: string;
  recoverySigningPublicKey: string;
  createdAt: string;
  signature: string;
}

export interface RevocationListClaims {
  v: 1;
  teamId: string;
  version: number;
  revokedDeviceIds: string[];
  issuedAt: string;
  issuerDeviceId: string;
}

export interface RevocationList extends RevocationListClaims {
  signature: string;
}

export interface RecoveryKit {
  v: 1;
  code: string;
  signingPublicKey: string;
}

export interface CreateTeamOptions {
  teamId: string;
  deviceId: string;
  memberId: string;
  issuedAt: string;
}

export interface CreatedTeam {
  v: 1;
  root: TeamRoot;
  rootCertificate: DeviceCertificate;
  revocationList: RevocationList;
  recoveryKit: RecoveryKit;
}

/** Certificates are untrusted chain material. The root key must be pinned out of band. */
export interface TeamTrust {
  root: TeamRoot;
  pinnedRootSigningPublicKey: string;
  certificates: readonly DeviceCertificate[];
  lastAcceptedRevocationVersion: number;
}

export interface DeviceChainTrust extends TeamTrust {
  revocationList: RevocationList;
}

export type RecoveryCertificateClaims = Omit<DeviceCertificateClaims, "issuerDeviceId" | "issuerType">;

export interface PayloadHeader {
  v: 1;
  payloadId: string;
  teamId: string;
  kind: string;
  senderDeviceId: string;
  createdAt: string;
}

export interface WrappedContentKey {
  v: 1;
  deviceId: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export interface PayloadEnvelope {
  v: 1;
  header: PayloadHeader;
  recipientDeviceIds: string[];
  ephemeralPublicKey: string;
  wrappedKeys: WrappedContentKey[];
  nonce: string;
  ciphertext: string;
  tag: string;
  signature: string;
}
