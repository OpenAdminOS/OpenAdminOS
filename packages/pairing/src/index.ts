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
