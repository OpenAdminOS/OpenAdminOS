import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

/**
 * Builds a self-signed RSA certificate in memory, for tests of the
 * certificate credential. Real sandboxes use a certificate the admin
 * creates and uploads to the app registration.
 */
export function createSelfSignedCertificate(input: {
  commonName?: string;
  notBefore: Date;
  notAfter: Date;
}): { certificatePem: string; privateKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sha256WithRsa = sequence(oid([1, 2, 840, 113549, 1, 1, 11]), Buffer.from([0x05, 0x00]));
  const name = sequence(set(sequence(oid([2, 5, 4, 3]), tlv(0x0c, Buffer.from(input.commonName ?? "OpenAdminOS test", "utf8")))));
  const serial = randomBytes(8);
  // Positive and minimally encoded: the first byte is neither 0 nor 0x80 or above.
  serial[0] = ((serial[0] as number) & 0x3f) | 0x40;
  const tbs = sequence(
    tlv(0xa0, tlv(0x02, Buffer.from([0x02]))),
    tlv(0x02, serial),
    sha256WithRsa,
    name,
    sequence(time(input.notBefore), time(input.notAfter)),
    name,
    publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = sign("sha256", tbs, privateKey);
  const der = sequence(tbs, sha256WithRsa, tlv(0x03, Buffer.concat([Buffer.from([0x00]), signature])));
  const base64 = der.toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  return {
    certificatePem: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function tlv(tag: number, value: Buffer): Buffer {
  let length: Buffer;
  if (value.length < 0x80) length = Buffer.from([value.length]);
  else {
    const bytes: number[] = [];
    for (let remaining = value.length; remaining > 0; remaining >>= 8) bytes.unshift(remaining & 0xff);
    length = Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), length, value]);
}

function sequence(...parts: Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(parts));
}

function set(...parts: Buffer[]): Buffer {
  return tlv(0x31, Buffer.concat(parts));
}

function oid(parts: number[]): Buffer {
  const [first = 0, second = 0, ...rest] = parts;
  const bytes = [first * 40 + second];
  for (const part of rest) {
    const chunk: number[] = [];
    let value = part;
    chunk.unshift(value & 0x7f);
    while ((value >>= 7) > 0) chunk.unshift(0x80 | (value & 0x7f));
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const year = date.getUTCFullYear();
  return year >= 1950 && year < 2050
    ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`, "ascii"))
    : tlv(0x18, Buffer.from(`${iso}Z`, "ascii"));
}
