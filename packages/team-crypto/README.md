# Team cryptography

`@openadminos/team-crypto` is the client-side cryptography foundation for future
team approvals and audit sharing. It is not connected to the app yet. It uses
Node's built-in `node:crypto` only, with no dependencies, network, storage,
Electron, or UI operations. Node 22 or newer is required.

## What the service can see

The service stores encrypted payloads and sees routing headers, recipient IDs,
public keys, membership certificates, revocations, timestamps, and payload sizes.
Approval diffs and audit bodies stay encrypted. Keep tenant content and object
names out of routing headers.

Each device has X25519 encryption keys and Ed25519 signing keys. An admin signs
device enrollment; clients verify the admin chain back to an independently
pinned team root. Admins compare device fingerprints during enrollment. A
compromised service cannot insert its own trusted key, but can delay, withhold,
replay, or fork messages. Clients must authenticate join state, persist accepted
revocation versions, enforce freshness, and reject replay in the host protocol.

Every payload has a fresh content key encrypted with AES-256-GCM. Ephemeral
X25519 and HKDF-SHA256 wrap that key for each eligible device. The sender signs
the entire envelope, and opening verifies the signature before decrypting.
Callers must verify recipient and sender certificates with a current signed
revocation list before using `sealPayload` and `openPayload`.

## Revocation and recovery

Revocation stops new payloads being encrypted to a removed device. It cannot
recall already-decrypted data or stop a device opening old envelopes addressed
to it. Pending approvals must be reissued by the host. A stolen device key can
decrypt historical envelopes for that device. Compromised admins, devices, and
authorized recipients sharing plaintext are outside this package's protection.

Team creation produces an offline recovery kit: a grouped base32 secret with a
checksum to catch typos. It derives a signing key whose public key is bound into
the signed root configuration. The kit can enroll a new admin if every admin
device is lost or revoked. It cannot decrypt earlier payloads. There is no server
escrow; losing every admin key and the kit means creating a new team. Stateless
cryptography does not make the kit single-use.

Private keys export as unencrypted PKCS8 DER in base64url. The host must protect
them with Electron `safeStorage` and keep the recovery kit offline. This package
does not persist secrets or enforce approval policy.

See [the protocol and API reference](./PROTOCOL.md) for every exported function
and type, exact JSON formats, canonical signatures, AAD, recovery derivation,
trust constraints, and integration questions.

From the repository root:

```sh
npm ci
npm run typecheck
npm run test -w @openadminos/team-crypto
npm test
```

TODO(ugur): confirm package name and API/wire formats before integration.

TODO(ugur): define authenticated join-state freshness, revocation fork handling,
replay persistence, and recovery-kit retirement or rotation in the host protocol.
