import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual, X509Certificate, type KeyObject } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";

import {
  bitString,
  boolean,
  explicit,
  implicitPrimitive,
  objectIdentifier,
  octetString,
  sequence,
  set,
  smallInteger,
  time,
  unsignedInteger,
  utf8String,
} from "./der.js";
import { PairingError } from "./errors.js";

const OID = {
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  commonName: "2.5.4.3",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
} as const;

export const DEFAULT_TLS_VALIDITY_DAYS = 365;
const MAX_TLS_VALIDITY_DAYS = 3650;
/** notBefore is set this far back, so a peer whose clock runs slightly behind still accepts the certificate. */
const CLOCK_SKEW_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const HEX_PIN = /^[0-9a-f]{64}$/;
const DNS_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export interface TlsCertificateOptions {
  /** Subject and issuer common name, 1 to 64 characters. */
  commonName: string;
  /** subjectAltName dNSName entries. */
  dnsNames?: readonly string[];
  /** subjectAltName iPAddress entries, IPv4 or IPv6. */
  ipAddresses?: readonly string[];
  /** Whole days from `now`, 1 to 3650; 365 when left out. */
  validityDays?: number;
  now?: Date;
  /**
   * An existing P-256 private key (KeyObject or PKCS #8 or SEC 1 PEM), to
   * reissue the certificate with the same key so the SPKI pin stays the
   * same. A new key is generated when left out.
   */
  privateKey?: KeyObject | string;
}

export interface TlsCertificate {
  certificatePem: string;
  /** PKCS #8 PEM of the P-256 key. */
  privateKeyPem: string;
  /** The pin of this certificate: see `tlsSpkiSha256`. */
  spkiSha256: string;
}

/**
 * Creates a self-signed ECDSA P-256 certificate for the sandbox's TLS
 * listener. Peers trust it by its SPKI pin, never by a CA, so it carries
 * only what TLS stacks check: CA false, digitalSignature, and the names
 * it answers on.
 */
export function createTlsCertificate(options: TlsCertificateOptions): TlsCertificate {
  const now = options.now ?? new Date();
  const validityDays = options.validityDays ?? DEFAULT_TLS_VALIDITY_DAYS;
  if (!Number.isSafeInteger(validityDays) || validityDays < 1 || validityDays > MAX_TLS_VALIDITY_DAYS) {
    throw new PairingError("certificate-options-invalid", `validityDays must be a whole number from 1 to ${MAX_TLS_VALIDITY_DAYS}.`);
  }
  if (Number.isNaN(now.getTime())) {
    throw new PairingError("certificate-options-invalid", "now is not a valid date.");
  }
  const commonName = options.commonName;
  if (typeof commonName !== "string" || commonName.length < 1 || commonName.length > 64 || /[\u0000-\u001f\u007f]/.test(commonName)) {
    throw new PairingError("certificate-options-invalid", "commonName must be 1 to 64 characters without control characters.");
  }
  const altNames = subjectAltNames(options.dnsNames ?? [], options.ipAddresses ?? []);

  const { privateKey, publicKey } = options.privateKey === undefined ? generateKeyPairSync("ec", { namedCurve: "prime256v1" }) : existingKeyPair(options.privateKey);
  const spki = publicKey.export({ type: "spki", format: "der" });
  const name = sequence(set(sequence(objectIdentifier(OID.commonName), utf8String(commonName))));
  const signatureAlgorithm = sequence(objectIdentifier(OID.ecdsaWithSha256));
  const seconds = Math.floor(now.getTime() / 1000) * 1000;
  const notBefore = new Date(seconds - CLOCK_SKEW_MS);
  const notAfter = new Date(seconds + validityDays * DAY_MS);

  const extensions = [
    // CA false is the default, so DER leaves the cA field out.
    extension(OID.basicConstraints, true, sequence()),
    // digitalSignature is bit 0: one byte 0x80 with seven unused bits.
    extension(OID.keyUsage, true, bitString(Buffer.from([0x80]), 7)),
  ];
  if (altNames.length > 0) extensions.push(extension(OID.subjectAltName, false, sequence(...altNames)));

  const tbsCertificate = sequence(
    explicit(0, smallInteger(2)),
    unsignedInteger(serialNumber()),
    signatureAlgorithm,
    name,
    sequence(time(notBefore), time(notAfter)),
    name,
    spki,
    explicit(3, sequence(...extensions)),
  );
  const signature = sign("sha256", tbsCertificate, { key: privateKey, dsaEncoding: "der" });
  const certificate = sequence(tbsCertificate, signatureAlgorithm, bitString(signature));

  return {
    certificatePem: toPem("CERTIFICATE", certificate),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    spkiSha256: spkiDigest(spki),
  };
}

/**
 * The pin of a TLS peer: SHA-256 of its SubjectPublicKeyInfo DER, as 64
 * lowercase hex characters. It survives re-issuing the certificate with
 * the same key and changes with the key. Takes a certificate (PEM or
 * X509Certificate, such as `socket.getPeerX509Certificate()`) or a public key.
 */
export function tlsSpkiSha256(source: X509Certificate | KeyObject | string): string {
  let publicKey: KeyObject;
  try {
    publicKey = typeof source === "string" ? new X509Certificate(source).publicKey : source instanceof X509Certificate ? source.publicKey : source;
  } catch (error) {
    throw new PairingError("key-invalid", "The TLS certificate is not a readable X.509 certificate.", { cause: error });
  }
  if (publicKey.type !== "public") {
    throw new PairingError("key-invalid", "A TLS pin is taken from a certificate or a public key.");
  }
  return spkiDigest(publicKey.export({ type: "spki", format: "der" }));
}

/** Constant-time check of a peer against a stored pin; false for a malformed pin. */
export function matchesTlsSpkiPin(source: X509Certificate | KeyObject | string, pin: string): boolean {
  if (typeof pin !== "string" || !HEX_PIN.test(pin)) return false;
  let actual: string;
  try {
    actual = tlsSpkiSha256(source);
  } catch {
    return false;
  }
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(pin, "hex"));
}

export function isTlsSpkiPin(value: unknown): value is string {
  return typeof value === "string" && HEX_PIN.test(value);
}

function existingKeyPair(source: KeyObject | string): { privateKey: KeyObject; publicKey: KeyObject } {
  let privateKey: KeyObject;
  try {
    privateKey = typeof source === "string" ? createPrivateKey({ key: source, format: "pem" }) : source;
  } catch (error) {
    throw new PairingError("key-invalid", "The TLS private key is not a readable PEM key.", { cause: error });
  }
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new PairingError("key-invalid", "The TLS private key is not an ECDSA P-256 private key.");
  }
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

function spkiDigest(spki: Buffer): string {
  return createHash("sha256").update(spki).digest("hex");
}

function extension(oid: string, critical: boolean, value: Buffer): Buffer {
  return critical
    ? sequence(objectIdentifier(oid), boolean(true), octetString(value))
    : sequence(objectIdentifier(oid), octetString(value));
}

/** 16 random bytes, positive and without a leading zero byte, as RFC 5280 asks (at most 20 octets). */
function serialNumber(): Buffer {
  const serial = randomBytes(16);
  serial[0] = ((serial[0] as number) & 0x7f) | 0x40;
  return serial;
}

function subjectAltNames(dnsNames: readonly string[], ipAddresses: readonly string[]): Buffer[] {
  const names: Buffer[] = [];
  for (const dnsName of dnsNames) {
    const normalized = typeof dnsName === "string" ? dnsName.toLowerCase() : "";
    if (!DNS_NAME.test(normalized)) {
      throw new PairingError("certificate-options-invalid", `${JSON.stringify(dnsName)} is not a DNS name.`);
    }
    names.push(implicitPrimitive(2, Buffer.from(normalized, "ascii")));
  }
  for (const address of ipAddresses) {
    const bytes = typeof address === "string" ? ipBytes(address) : undefined;
    if (!bytes) {
      throw new PairingError("certificate-options-invalid", `${JSON.stringify(address)} is not an IPv4 or IPv6 address.`);
    }
    names.push(implicitPrimitive(7, bytes));
  }
  return names;
}

function ipBytes(address: string): Buffer | undefined {
  if (isIPv4(address)) return Buffer.from(address.split(".").map(Number));
  if (!isIPv6(address) || address.includes("%")) return undefined;
  let text = address;
  // An embedded IPv4 tail, such as ::ffff:192.0.2.1, becomes two groups.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (isIPv4(tail)) {
    const [a, b, c, d] = tail.split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split("::") as [string, string | undefined];
  const headGroups = head === "" ? [] : head.split(":");
  const restGroups = rest === undefined || rest === "" ? [] : rest.split(":");
  const missing = 8 - headGroups.length - restGroups.length;
  const groups = rest === undefined ? headGroups : [...headGroups, ...Array<string>(missing).fill("0"), ...restGroups];
  if (groups.length !== 8) return undefined;
  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => bytes.writeUInt16BE(Number.parseInt(group, 16), index * 2));
  return bytes;
}

function toPem(label: string, der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}
