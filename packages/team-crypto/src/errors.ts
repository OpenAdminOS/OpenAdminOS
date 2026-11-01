export class TeamCryptoError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class FormatError extends TeamCryptoError {}
export class InvalidKeyError extends TeamCryptoError {}
export class SignatureVerificationError extends TeamCryptoError {}
export class CertificateChainError extends TeamCryptoError {}
export class RevokedDeviceError extends CertificateChainError {}
export class StaleRevocationListError extends TeamCryptoError {}
export class NotRecipientError extends TeamCryptoError {}
export class DecryptionError extends TeamCryptoError {}
export class RecoveryKitError extends TeamCryptoError {}
