# OpenAdminOS pairing

The public pairing protocol between an OpenAdminOS desktop and a sandbox host, and the verifier for what a sandbox reports. It is open so anyone can check how a sandbox and a desktop trust each other. This package holds the building blocks only; it opens no network connection.

Everything is built on `node:crypto`. There is no other dependency besides `@openadminos/runtime`, whose `canonicalJson` and `verifyAuditContinuation` it reuses.

## Formats

| Value | Format |
| --- | --- |
| Device key | Ed25519. Private key as PKCS #8 PEM. Public key as its 32 raw bytes in base64url without padding (43 characters), in canonical base64url, and not one of the eight small-order encodings (the identity and the points of order 2, 4 and 8), which are refused. |
| Device fingerprint | SHA-256 of the public key's SubjectPublicKeyInfo DER: 64 lowercase hex characters, or 52 Crockford base32 characters for showing. |
| TLS certificate | Self-signed X.509 v3, ECDSA P-256 with SHA-256. Subject and issuer CN, a 16 byte random serial, basicConstraints CA false (critical), keyUsage digitalSignature (critical), extendedKeyUsage serverAuth and clientAuth, optional subjectAltName with DNS names and IP addresses. Built with a small DER encoder in `src/der.ts`. |
| TLS pin | SHA-256 of the certificate's SubjectPublicKeyInfo DER, 64 lowercase hex characters. It stays the same when the certificate is reissued with the same key. |
| Signature | Ed25519 over `<domain>\n<canonical JSON of the payload>` in UTF-8, as base64url (86 characters). |

Signature domains are a closed list: `openadminos.pairing.record.v1`, `openadminos.audit.checkpoint.v1` and `openadminos.schedule.assignment.v1`. A signature never verifies in another domain.

### Canonical JSON

Signed payloads, proof transcripts and audit rows use the runtime's `canonicalJson`:

- Object keys are sorted by UTF-16 code units (JavaScript's default sort), at every level.
- Strings and numbers are written as `JSON.stringify` writes them.
- Object fields whose value is undefined are left out. Signing refuses them, so a signed payload never relies on this.
- No whitespace anywhere.

An audit row is accepted only when its stored text is already canonical, and its hash is taken over that stored text, as the writer does. Text that parses to the same value but is spelled differently, such as `1e400` or a duplicate key, is refused.

## Addresses

`parseSandboxAddress` reads `<IPv4>:<port>` or `[<IPv6>]:<port>`; host names are refused, so what is checked is what is reached. `isPrivateAddress` accepts loopback, 10/8, 172.16/12, 192.168/16, link-local, 100.64/10 and fd00::/8 only. The sandbox host listens and the desktop connects under the same rules.

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
- `AuditCheckpoint`: pairing id, sandbox id, a seq and hash, the row count (at most seq) and the time, signed by the sandbox with its device key. The position is the last row of the batch it comes with, not the log's newest row; for an empty batch it is the reader's pin. `rowCount` and `at` are what the sandbox attests; they are checked for shape only, not against the rows.
- `verifySignedContinuation(pin, rows, signedCheckpoint, sandboxPublicKey, expected)` checks `expected` first (`expectation-invalid`), then the checkpoint signature (`checkpoint-signature-invalid`), then the pairing and sandbox ids from the stored pairing record (`checkpoint-pairing-mismatch`), then the hash chain from the pin to the signed position with the runtime's continuation verifier (`chain-gap`, `chain-fork`, `chain-rollback`, `chain-row-invalid`, `chain-position-invalid`). A batch is accepted only when its last row is the signed position; a batch that ends before it fails with `checkpoint-not-reached` and the pin does not move, because rows short of a signature are not covered by one.

- `ScheduleAssignment`: pairing id, a version, organization id, tenant id, a list of at most 50 entries (`agentId`, `templateSha256`, `intervalSeconds`, one per agent) and the time, signed by the paired desktop's device key. A sandbox accepts it only with a version higher than the one it holds, so an old record cannot be replayed; an empty list removes every assigned schedule.

### Run digests

`runRecordDigest(run)` is SHA-256 hex of the run record's canonical JSON. The sandbox puts it in `sandbox.run.finished` as `runDigest`, and each time it changes a finished record (a delivery step, a failure the audit log could not close) it records `sandbox.run.rewritten` with the new `runDigest` and status before writing the record. A reader trusts a record only when its digest is the one in the newest verified event for that run.

### Reading a sandbox's audit log

1. First sync: the sandbox sends a signed checkpoint for the position its oldest kept row is chained to. For a log that was never pruned that is seq 0 and the chain start hash; after a prune it is the newest pruned row (seq of the oldest kept row minus 1, and that row's previous hash), and for a log that a prune emptied, `AuditLogStore.tip()`. The desktop checks it with `verifyAuditCheckpoint` against the key and ids in the pairing record and adopts its seq and hash as the first pin. Rows pruned before pairing are not part of what the desktop can check.
2. Each sync: the desktop asks for the rows after its pin. The sandbox reads a batch with `readRange(pin.seq, limit)` and signs a checkpoint at the batch's last row (at the pin when there are none). The desktop runs `verifySignedContinuation` and moves its pin only on ok, then asks again until a batch is empty.

A signed checkpoint shows what the sandbox reported. It is attested by the customer's sandbox, not by OpenAdminOS.
