export {
  createTlsCertificate,
  DEFAULT_TLS_VALIDITY_DAYS,
  isTlsSpkiPin,
  matchesTlsSpkiPin,
  tlsSpkiSha256,
  type TlsCertificate,
  type TlsCertificateOptions,
} from "./certificate.js";
export { CROCKFORD_ALPHABET, decodeBase32, encodeBase32, normalizeBase32 } from "./base32.js";
export {
  createPairingCode,
  createPairingProof,
  formatPairingCode,
  PAIRING_CODE_FINGERPRINT_LENGTH,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_LIFETIME_MS,
  PAIRING_CODE_MAX_ATTEMPTS,
  PAIRING_CODE_SECRET_LENGTH,
  PairingAttemptLimiter,
  pairingCodeFingerprint,
  pairingCodeMatchesSpki,
  pairingTranscript,
  parsePairingCode,
  verifyPairingProof,
  type PairingAttemptFailure,
  type PairingAttemptLimiterOptions,
  type PairingAttemptResult,
  type PairingCode,
  type PairingCodeParseResult,
  type PairingProofRole,
  type PairingTranscriptFields,
} from "./code.js";
export { PairingError, type PairingErrorReason } from "./errors.js";
export {
  deviceFingerprint,
  exportDevicePrivateKey,
  exportDevicePublicKey,
  exportDevicePublicKeySpki,
  generateDeviceIdentity,
  importDevicePrivateKey,
  importDevicePublicKey,
  isDevicePublicKey,
  type DeviceIdentity,
  type FingerprintFormat,
} from "./identity.js";
export { isSignatureDomain, sign, SIGNATURE_DOMAINS, signedMessage, verify, type SignatureDomain } from "./signatures.js";
