export type PairingErrorReason =
  /** A key, certificate or value has the wrong type, size or encoding. */
  | "key-invalid"
  /** Certificate options are out of range. */
  | "certificate-options-invalid"
  /** A payload to sign is not plain JSON, or the domain is unknown. */
  | "payload-invalid"
  /** The TLS key reached is not the one the pairing code names. */
  | "fingerprint-mismatch"
  /** A pairing proof was asked for or checked out of order. */
  | "proof-order";

/** Thrown for input a caller should never pass; results use named failures instead. */
export class PairingError extends Error {
  readonly reason: PairingErrorReason;

  constructor(reason: PairingErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PairingError";
    this.reason = reason;
  }
}
