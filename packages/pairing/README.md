# OpenAdminOS pairing

The public pairing protocol between an OpenAdminOS desktop and a sandbox host, and the verifier for what a sandbox reports. It is open so anyone can check how a sandbox and a desktop trust each other. This package holds the building blocks only; it opens no network connection.

Everything is built on `node:crypto`. There is no other dependency besides `@openadminos/runtime`, whose `canonicalJson` and `verifyAuditContinuation` it reuses.

## Formats

| Value | Format |
| --- | --- |
| Device key | Ed25519. Private key as PKCS #8 PEM. Public key as its 32 raw bytes in base64url without padding (43 characters), in canonical base64url, and not one of the eight small-order encodings (the identity and the points of order 2, 4 and 8), which are refused. |
| Device fingerprint | SHA-256 of the public key's SubjectPublicKeyInfo DER: 64 lowercase hex characters, or 52 Crockford base32 characters for showing. |
| TLS certificate | Self-signed X.509 v3, ECDSA P-256 with SHA-256. Subject and issuer CN, a 16 byte random serial, basicConstraints CA false (critical), keyUsage digitalSignature (critical), optional subjectAltName with DNS names and IP addresses. Built with a small DER encoder in `src/der.ts`. |
| TLS pin | SHA-256 of the certificate's SubjectPublicKeyInfo DER, 64 lowercase hex characters. It stays the same when the certificate is reissued with the same key. |
| Signature | Ed25519 over `<domain>\n<canonical JSON of the payload>` in UTF-8, as base64url (86 characters). |

Signature domains are a closed list: `openadminos.pairing.record.v1` and `openadminos.audit.checkpoint.v1`. A signature never verifies in another domain. `openadminos.schedule.assignment.v1` is reserved for signed schedule assignments; it is added to the list, and becomes signable, only when that record exists.

### Canonical JSON

Signed payloads, proof transcripts and audit rows use the runtime's `canonicalJson`:

- Object keys are sorted by UTF-16 code units (JavaScript's default sort), at every level.
- Strings and numbers are written as `JSON.stringify` writes them.
- Object fields whose value is undefined are left out. Signing refuses them, so a signed payload never relies on this.
- No whitespace anywhere.

An audit row is accepted only when its stored text is already canonical, and its hash is taken over that stored text, as the writer does. Text that parses to the same value but is spelled differently, such as `1e400` or a duplicate key, is refused.

## Pairing code

The sandbox shows a code of 28 Crockford base32 characters (digits and letters without I, L, O and U), in seven groups of four, such as `7K3M-Q9X2-...`. Typed input may leave out the hyphens, use spaces and any case; O is read as 0, I and L as 1.

- Characters 1 to 16 are the first 80 bits of the sandbox's TLS pin. The desktop connects, compares the peer's pin with them in constant time, and stops when they differ.
- Characters 17 to 28 are 60 random bits, the secret. It is never sent.

A code is valid for 10 minutes and for 5 desktop proofs, right or wrong; a host may set tighter limits, never looser ones. The sandbox creates one `SandboxPairingSession` per shown code and shares it across every connection that tries the code, so the limits hold per code. After a desktop proof verifies the code cannot be used again: when the connection drops after that, pairing needs a new code.

The sandbox session holds the organization and tenant from the sandbox's config. A desktop that offers another one is refused with `binding-mismatch` before any sandbox proof, and the try counts as an attempt.

## Proofs

Both proofs are HMAC-SHA256 over the transcript `openadminos.pairing.transcript.v1\n<canonical JSON>`, where the JSON holds the role (`desktop` or `sandbox`), the pairing id, organization id, tenant id (lower case), both public keys and the TLS pin. The HMAC key is scrypt of the secret (N = 2^15, r = 8, p = 1, 32 bytes), salted with `openadminos.pairing.key.v1\n<TLS pin>\n<pairing id>`.

The order is fixed. The desktop sends its proof first. The sandbox counts the attempt, checks the proof in constant time, and only after it verifies does it produce its own proof. `SandboxPairingSession.sandboxProof()` and `DesktopPairingSession.verifySandboxProof()` refuse with `proof-order` when called early.

### What the fingerprint protects, and what it does not

The TLS pin is not secret: anyone who reaches the sandbox sees its certificate, and the pin stays the same for the life of the key. The 16 fingerprint characters therefore say nothing an attacker cannot learn. What they give is binding: to stand in for the sandbox, an attacker needs a P-256 key whose SPKI hash starts with the same 80 bits, a second preimage found by generating keys, at about 2^80 work. The scrypt step adds a second cost: an attacker who captures a desktop proof (only possible inside the pinned connection) must search the 60 bit secret offline, with one 32 MiB scrypt derivation per guess.

A PAKE is not used in v1, for those reasons together with the 5 attempt limit and the 10 minute lifetime. CPace may replace the HMAC proofs in a later version of the protocol.

## Records

- `PairingRecord`: pairing id, sandbox id and name, organization id, tenant id, both public keys, TLS pin and creation time. `signPairingRecord` and `verifyPairingRecord`. One desktop per sandbox: a new pairing replaces the old one. After an integrity failure the recovery is pairing again.
- `AuditCheckpoint`: pairing id, sandbox id, the tip's seq and hash, the row count (at most seq) and the time. The sandbox signs it with its device key at the end of each batch it sends. `rowCount` and `at` are what the sandbox attests; they are checked for shape only, not against the rows.
- `verifySignedContinuation(pin, rows, signedTip, sandboxPublicKey, expected)` checks the checkpoint signature first (`checkpoint-signature-invalid`), then the pairing and sandbox ids from the stored pairing record (`checkpoint-pairing-mismatch`), then the hash chain from the pin to the signed tip with the runtime's continuation verifier (`chain-gap`, `chain-fork`, `chain-rollback`, `chain-row-invalid`, `chain-position-invalid`). A batch is accepted only when its last row is the signed checkpoint; a batch that ends before it fails with `checkpoint-not-reached` and the pin does not move, because rows short of a signature are not covered by one.

A signed checkpoint shows what the sandbox reported. It is attested by the customer's sandbox, not by OpenAdminOS.
