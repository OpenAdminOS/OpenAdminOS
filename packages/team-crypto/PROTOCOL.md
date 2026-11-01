# Team cryptography protocol and API reference

Client-side primitives for future OpenAdminOS team approvals and audit sharing.
This package is not connected to the app or a hosted service yet. It uses Node's
built-in `node:crypto` only, has no dependencies, and performs no network,
storage, Electron, or UI operations. Node 22 or newer is required.

## Threat model

The service stores ciphertext. It can see routing headers, recipient device IDs,
public keys, certificate membership and roles, revocations, timestamps, and
payload sizes. It cannot read encrypted approval diffs or audit bodies, recover
private keys, or add a trusted device without an admin or recovery signature.
Keep tenant content and object names out of routing headers, especially `kind`.

The first admin's signing key is the team root. Joining clients must pin this key
through an authenticated channel outside the service's key directory. Admins
compare device fingerprints when enrolling a device. A root-signed configuration
also authenticates the recovery signing public key. A valid signature alone does
not establish trust: `verifyDeviceChain` must succeed first.

Each payload has a fresh random 32-byte content key. AES-256-GCM encrypts it, and
an ephemeral X25519 key exchange plus HKDF-SHA256 creates a separate wrapping key
for each recipient. Ed25519 signs the complete envelope, including authentication
tags and all routing and recipient information. An opening device checks the
sender signature before attempting any key agreement or decryption.

An admin signs a complete revocation list with a monotonically increasing
version. `verifyDeviceChain` checks both the device and every issuing admin
against that list. Clients must persist the highest accepted version and pass
it back on subsequent verifications. An equal version is accepted for repeated
verification. The signer must remain trusted under the list it signs, so it
cannot revoke itself or an ancestor in its own chain. Another trusted lineage
or a recovery-enrolled admin can revoke those devices.

Callers must verify every recipient with a current revocation list before
sealing, and the sender before opening. These two payload functions deliberately
accept already verified certificates. Revocation stops wrapping new payloads
to a device; it cannot erase plaintext or keys the device already obtained, or
prevent a device opening an old envelope addressed to it. Pending requests must
be reissued by the host. The package does not enforce approval roles or execute
any write operation.

The service can withhold, delay, replay, or fork messages and revocation history.
Persisted versions prevent rollback below a client's known version, but cannot
prove freshness on a new device, detect all same-version forks, or stop denial
of service. The host must authenticate joining state, retain accepted versions,
check freshness, and track payload IDs to reject replay. It must also match the
sender device ID to its own enrolled identity before sealing.

Compromised devices, compromised admins, and stolen recovery kits are outside
the confidentiality boundary. Authorized recipients can share plaintext. Device
key compromise exposes historical envelopes for that device, so this is not
forward secrecy against later device-key theft. JavaScript cannot guarantee
erasure of every secret copy; temporary key buffers are cleared where practical.

## Keys and recovery

Public keys are raw 32-byte coordinates encoded as unpadded base64url. Exported
private keys are unencrypted PKCS8 DER in unpadded base64url. The host must protect
exports with Electron `safeStorage`; never upload or log them. In-memory
`DeviceKeys` contains `KeyObject` private keys and must not be JSON-serialized.

The fingerprint is the first 128 bits of the SHA-256 digest of the domain-prefixed
canonical public-key object, rendered as eight uppercase hexadecimal groups of
four characters. Both encryption and signing keys are bound into it.

Team creation generates a printable recovery kit locally. Its 32 random secret
bytes plus a four-byte checksum are RFC 4648 base32 without padding: 58 uppercase
characters, grouped by four (the final group has two characters). The checksum
is the first four bytes of SHA-256 over UTF-8
`openadminos-team/v1/recovery/checksum`, a NUL byte, then the secret bytes.
Import accepts case, hyphens, and whitespace, validates padding bits and checksum,
and returns the canonical grouped code. The checksum catches accidental typos;
it does not authenticate a kit obtained from an untrusted person.

HKDF-SHA256 derives a 32-byte Ed25519 seed from the secret with salt
`openadminos-team/v1/recovery/salt` and info
`openadminos-team/v1/recovery/ed25519`, both UTF-8 without a terminator. The seed
is imported using PKCS8 DER prefix `302e020100300506032b657004220420`.
See [Node crypto](https://nodejs.org/docs/latest-v22.x/api/crypto.html) and
[RFC 8410](https://www.rfc-editor.org/rfc/rfc8410.html) for these built-in
operations and the Ed25519 key encoding.

Keep the kit offline. It can enroll a new admin even if the original root device
and all other admins are lost or revoked. A recovered admin signs a fresh
revocation list and enrolls replacement devices. The kit cannot decrypt earlier
payloads because it is only a signing authority. There is no server escrow.
Losing all admin keys and the kit means creating a new team. Creation produces
one kit, but stateless cryptography cannot enforce single-use redemption.

## Public API

All functions are synchronous. Verification throws on failure, never returns a
partially trusted result. Returned verification structures are defensive copies.

| Function | Purpose |
| --- | --- |
| `canonicalJson(value)` | Encode finite plain JSON with recursively sorted keys and no whitespace. |
| `generateDeviceKeys()` | Generate independent X25519 and Ed25519 key pairs. |
| `exportDeviceKeys(keys)` | Export a versioned public/private key bundle for protected host storage. |
| `importDeviceKeys(bundle)` | Import canonical PKCS8 keys and verify algorithms and public/private agreement. |
| `deviceFingerprint(publicKeys)` | Produce the readable fingerprint binding both public keys. |
| `createTeam(options, keys)` | Create a signed root configuration, self-signed root certificate, version-0 revocation list, and recovery kit. |
| `issueDeviceCertificate(claims, issuerKeys)` | Sign device enrollment claims; issuer authority is checked during verification. |
| `verifyDeviceChain(certificate, trust)` | Authenticate the root, revocation list, and admin chain; return leaf-to-anchor certificates. |
| `signRevocationList(claims, issuerKeys)` | Sign a sorted complete revocation list without mutating the input. |
| `verifyRevocationList(list, trust)` | Authenticate an admin-signed list and reject versions below the caller's accepted version. |
| `generateRecoveryKit()` | Generate an offline, checksummed recovery code and its signing public key. |
| `importRecoveryKit(code)` | Validate and normalize a code, deriving the same recovery signing public key. |
| `issueRecoveryDeviceCertificate(claims, kit, root)` | Sign enrollment for a new admin with the root's recovery authority. |
| `sealPayload(bytes, header, senderKeys, recipients)` | Encrypt bytes to the verified recipient certificates and sign the whole envelope. |
| `openPayload(envelope, senderCertificate, openingDeviceId, openingKeys)` | Verify the sender signature, unwrap the device's key, and return authenticated plaintext bytes. |

| Exported type | Meaning |
| --- | --- |
| `JsonValue` | Recursive finite JSON value shape. |
| `DeviceRole` | `"admin"` or `"member"`. |
| `DevicePublicKeys` | Version and both raw public keys. |
| `DeviceKeys` | Public keys plus two private `KeyObject` instances. |
| `SerializedDeviceKeys` | Public keys plus both PKCS8 private keys for host storage. |
| `DeviceCertificateClaims` | Versioned enrollment fields without a signature. |
| `DeviceCertificate` | Signed device enrollment claims. |
| `TeamRoot` | Signed root configuration authenticating recovery authority. |
| `RevocationListClaims` | Versioned full revocation state without a signature. |
| `RevocationList` | Signed revocation state. |
| `RecoveryKit` | Version, printable secret code, and derived signing public key. |
| `CreateTeamOptions` | Team, device, member identifiers and issuance time. |
| `CreatedTeam` | Versioned root, root certificate, initial revocations, and recovery kit. |
| `TeamTrust` | Root, independently pinned signing key, chain material, and last accepted revocation version. |
| `DeviceChainTrust` | `TeamTrust` plus the signed revocation list to apply. |
| `RecoveryCertificateClaims` | Device claims without issuer fields, for recovery enrollment. |
| `PayloadHeader` | Versioned plaintext routing header. |
| `WrappedContentKey` | One recipient's authenticated encrypted content key. |
| `PayloadEnvelope` | Signed ciphertext, authenticated header, audience, ephemeral key, and wraps. |

`TeamCryptoError` is the base error. Its exported subclasses are `FormatError`
(schema or encoding), `InvalidKeyError` (key import, agreement or mismatch),
`SignatureVerificationError` (failed signature), `CertificateChainError` (trust or
authority), `RevokedDeviceError` (revoked chain device, also a chain error),
`StaleRevocationListError` (version rollback), `NotRecipientError` (opening device
is absent), `DecryptionError` (unwrap or payload authentication), and
`RecoveryKitError` (invalid or wrong-team recovery kit).

## Exact version-1 wire formats

All objects below are JSON objects. Angle-bracket placeholders denote strings;
`DeviceCertificate`, `TeamRoot`, `RevocationList`, `RecoveryKit`, `PayloadHeader`
and `WrappedContentKey` denote the complete nested objects defined below.
Claim types use the same shape with `signature` omitted. Recovery claims also
omit `issuerType` and `issuerDeviceId`. Only `DeviceKeys` and the call-option
types are in-memory values rather than serialized protocol structures.

All binary fields use canonical unpadded base64url: public keys 32 bytes,
signatures 64 bytes, nonces 12 bytes, and GCM tags 16 bytes. Ciphertext is any
length, including zero; wrapped content-key ciphertext is exactly 32 bytes.
Times must use UTC ISO format with milliseconds, for example
`2026-11-01T10:00:00.000Z`. IDs and kind are nonempty strings without surrounding
whitespace. Revocation versions are nonnegative safe integers. Arrays of device
IDs use ascending UTF-16 string order and cannot contain duplicates. Unknown
fields and unsupported format versions are rejected.

```json
{"v":1,"encryptionPublicKey":"<X25519 public>","signingPublicKey":"<Ed25519 public>"}
```

```json
{"v":1,"encryptionPublicKey":"<X25519 public>","signingPublicKey":"<Ed25519 public>","encryptionPrivateKey":"<PKCS8 DER>","signingPrivateKey":"<PKCS8 DER>"}
```

```json
{"v":1,"teamId":"<team>","deviceId":"<device>","memberId":"<member>","role":"admin","encryptionPublicKey":"<X25519 public>","signingPublicKey":"<Ed25519 public>","issuedAt":"<ISO time>","issuerDeviceId":"<issuer>","issuerType":"device","signature":"<Ed25519 signature>"}
```

`role` is `"admin"` or `"member"`. `issuerType` is `"device"` or `"recovery"`.
A root certificate is an admin whose device and issuer IDs both equal
`TeamRoot.rootDeviceId`. A recovery certificate must enroll a new admin and uses
the logical root ID as `issuerDeviceId`, with `issuerType: "recovery"`.
Recovery is a separate trust anchor, so it can work after root-device revocation.

```json
{"v":1,"teamId":"<team>","rootDeviceId":"<first admin device>","signingPublicKey":"<pinned root public>","recoverySigningPublicKey":"<recovery public>","createdAt":"<ISO time>","signature":"<root signature>"}
```

```json
{"v":1,"teamId":"<team>","version":0,"revokedDeviceIds":["<sorted revoked device>"],"issuedAt":"<ISO time>","issuerDeviceId":"<admin device>","signature":"<admin signature>"}
```

The initial list has `version: 0` and `revokedDeviceIds: []`.

```json
{"v":1,"code":"<58 base32 characters in groups>","signingPublicKey":"<recovery Ed25519 public>"}
```

```text
CreatedTeam = {"v":1,"root":TeamRoot,"rootCertificate":DeviceCertificate,"revocationList":RevocationList,"recoveryKit":RecoveryKit}
```

`CreatedTeam` includes private recovery material and is never a service upload.

```json
{"v":1,"payloadId":"<payload>","teamId":"<team>","kind":"<routing kind>","senderDeviceId":"<sender>","createdAt":"<ISO time>"}
```

```json
{"v":1,"deviceId":"<recipient>","nonce":"<12 bytes>","ciphertext":"<32 bytes>","tag":"<16 bytes>"}
```

```text
PayloadEnvelope = {"v":1,"header":PayloadHeader,"recipientDeviceIds":["<sorted recipient>"],"ephemeralPublicKey":"<X25519 public>","wrappedKeys":[WrappedContentKey],"nonce":"<12 bytes>","ciphertext":"<encrypted bytes>","tag":"<16 bytes>","signature":"<sender signature>"}
```

There is exactly one wrap per recipient, in the same sorted order. The sender
can open its own envelope only if explicitly included as a recipient.

## Canonical encoding, signatures and AAD

`canonicalJson` recursively sorts object keys by UTF-16 code units, encodes
strings and finite numbers using JavaScript JSON primitive encoding, preserves
array order, and adds no whitespace. Integer-like keys are sorted lexically
too. There is no Unicode normalization. Unsupported values, custom prototypes,
accessors, sparse arrays, cycles, hidden or symbol properties, and nesting over
100 levels are rejected. This is this protocol's encoding, not a claim of a
general RFC 8785 implementation.

For a domain `D` and object `O`, authenticated bytes are
`UTF8("openadminos-team/v1/" + D + "\0" + canonicalJson(O))`. Here `\0` is one
NUL byte, not two printable characters. Signatures use Ed25519 with no prehash,
over every field except the top-level `signature` field. Domains are
`device-cert`, `team-root`, `revocation-list`, and `payload-envelope`.

Payload AES-GCM AAD uses domain `payload-aad` and this exact canonical object:

```text
{"v":1,"header":PayloadHeader,"recipientDeviceIds":["<sorted recipient>"]}
```

Each envelope generates one ephemeral X25519 pair. For each recipient, the
X25519 shared secret is HKDF-SHA256 input keying material; the salt is the raw
ephemeral public key concatenated with the raw recipient encryption public key;
info is UTF-8 `openadminos-team/v1/content-key-wrap` without a terminator; output
is 32 bytes. Wrapping uses a fresh 12-byte nonce and domain `wrap-aad` with:

```text
{"v":1,"header":PayloadHeader,"recipientDeviceIds":["<sorted recipient>"],"ephemeralPublicKey":"<X25519 public>","recipientDeviceId":"<this recipient>"}
```

## Host integration questions

- TODO(ugur): confirm package name.
- TODO(ugur): confirm the public API and version-1 wire formats before service or mobile integration.
- TODO(ugur): define authenticated join-state freshness, same-version revocation fork handling, and replay persistence in the host protocol.
- TODO(ugur): define recovery-kit retirement or rotation if recovery must be single-use; this stateless package cannot enforce redemption.

## Verification

From the repository root:

```sh
npm ci
npm run typecheck
npm run test -w @openadminos/team-crypto
npm test
```

Tests cover key import/export, canonical encoding, signed structures, chain
authority, revocations and rollback, recovery code typos, recovery after admin
loss, all envelope components, AAD, wrong keys, and independent wire decoding.
