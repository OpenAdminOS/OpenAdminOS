# OpenAdminOS pairing

The public pairing protocol between an OpenAdminOS desktop and a sandbox host, and the verifier for what a sandbox reports. It is open so anyone can check how a sandbox and a desktop trust each other. This package holds the building blocks only; it opens no network connection.

Everything is built on `node:crypto`. There is no other dependency besides `@openadminos/runtime`, whose `canonicalJson` and `verifyAuditContinuation` it reuses.

## Formats

| Value | Format |
| --- | --- |
| Device key | Ed25519. Private key as PKCS #8 PEM. Public key as its 32 raw bytes in base64url without padding (43 characters). |
| Device fingerprint | SHA-256 of the public key's SubjectPublicKeyInfo DER: 64 lowercase hex characters, or 52 Crockford base32 characters for showing. |
| TLS certificate | Self-signed X.509 v3, ECDSA P-256 with SHA-256. Subject and issuer CN, a 16 byte random serial, basicConstraints CA false (critical), keyUsage digitalSignature (critical), optional subjectAltName with DNS names and IP addresses. Built with a small DER encoder in `src/der.ts`. |
| TLS pin | SHA-256 of the certificate's SubjectPublicKeyInfo DER, 64 lowercase hex characters. It stays the same when the certificate is reissued with the same key. |
| Signature | Ed25519 over `<domain>\n<canonical JSON of the payload>` in UTF-8, as base64url (86 characters). |

Signature domains are a closed list: `openadminos.pairing.record.v1`, `openadminos.audit.checkpoint.v1` and `openadminos.schedule.assignment.v1`. A signature never verifies in another domain. Payloads must be plain JSON; undefined, non-finite numbers, class instances and cycles are refused.

## Pairing code

The sandbox shows a code of 28 Crockford base32 characters (digits and letters without I, L, O and U), in seven groups of four, such as `7K3M-Q9X2-...`. Typed input may leave out the hyphens, use spaces and any case; O is read as 0, I and L as 1.

- Characters 1 to 16 are the first 80 bits of the sandbox's TLS pin. The desktop connects, compares the peer's pin with them in constant time, and stops when they differ.
- Characters 17 to 28 are 60 random bits, the secret. It is never sent.

A code is valid for 10 minutes and for 5 desktop proofs, right or wrong. After a successful pairing it cannot be used again.

## Proofs

Both proofs are HMAC-SHA256 over the transcript `openadminos.pairing.transcript.v1\n<canonical JSON>`, where the JSON holds the role (`desktop` or `sandbox`), the pairing id, organization id, tenant id (lower case), both public keys and the TLS pin. The HMAC key is scrypt of the secret (N = 2^15, r = 8, p = 1, 32 bytes), salted with `openadminos.pairing.key.v1\n<TLS pin>\n<pairing id>`.

The order is fixed. The desktop sends its proof first. The sandbox counts the attempt, checks the proof in constant time, and only after it verifies does it produce its own proof. `SandboxPairingSession.sandboxProof()` and `DesktopPairingSession.verifySandboxProof()` refuse with `proof-order` when called early.

A PAKE is not used in v1: the proofs travel only inside a TLS connection already pinned to the 80 bit fingerprint, the code allows 5 proofs and lives 10 minutes, and the scrypt derivation makes each offline guess memory-hard.

## Records

- `PairingRecord`: pairing id, sandbox id and name, organization id, tenant id, both public keys, TLS pin and creation time. `signPairingRecord` and `verifyPairingRecord`. One desktop per sandbox: a new pairing replaces the old one. After an integrity failure the recovery is pairing again.
- `AuditCheckpoint`: pairing id, sandbox id, the tip's seq and hash, the row count (at most seq) and the time. The sandbox signs it with its device key.
- `verifySignedContinuation(pin, rows, signedTip, sandboxPublicKey, expected?)` checks the checkpoint signature first (`checkpoint-signature-invalid`), then, with `expected`, the pairing and sandbox (`checkpoint-pairing-mismatch`), then the hash chain from the pin to the signed tip with the runtime's continuation verifier (`chain-gap`, `chain-fork`, `chain-rollback`, `chain-row-invalid`, `chain-position-invalid`).

A signed checkpoint shows what the sandbox reported. It is attested by the customer's sandbox, not by OpenAdminOS.
