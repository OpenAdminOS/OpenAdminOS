/**
 * The few DER encodings a self-signed X.509 certificate needs (X.690).
 * Encoding only: certificates are parsed back with node:crypto's
 * X509Certificate, never here.
 */

const TAG = {
  boolean: 0x01,
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  objectIdentifier: 0x06,
  utf8String: 0x0c,
  utcTime: 0x17,
  generalizedTime: 0x18,
  sequence: 0x30,
  set: 0x31,
} as const;

export function tlv(tag: number, content: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) {
    bytes.unshift(remaining % 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function sequence(...items: Uint8Array[]): Buffer {
  return tlv(TAG.sequence, Buffer.concat(items));
}

export function set(...items: Uint8Array[]): Buffer {
  return tlv(TAG.set, Buffer.concat(items));
}

export function boolean(value: boolean): Buffer {
  return tlv(TAG.boolean, Buffer.from([value ? 0xff : 0x00]));
}

/** A non-negative INTEGER from big-endian magnitude bytes, in its minimal form. */
export function unsignedInteger(magnitude: Uint8Array): Buffer {
  let start = 0;
  while (start < magnitude.length - 1 && magnitude[start] === 0) start += 1;
  let bytes = Buffer.from(magnitude.subarray(start));
  if (bytes.length === 0) bytes = Buffer.from([0]);
  if ((bytes[0] as number) & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(TAG.integer, bytes);
}

export function smallInteger(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) throw new RangeError("smallInteger takes 0 to 65535.");
  return unsignedInteger(Buffer.from([value >> 8, value & 0xff]));
}

export function objectIdentifier(dotted: string): Buffer {
  const parts = dotted.split(".").map((part) => Number(part));
  if (parts.length < 2 || parts.some((part) => !Number.isSafeInteger(part) || part < 0)) {
    throw new RangeError(`${dotted} is not an object identifier.`);
  }
  const [first, second, ...rest] = parts as [number, number, ...number[]];
  const bytes: number[] = [];
  for (const arc of [first * 40 + second, ...rest]) {
    const group: number[] = [arc % 128];
    for (let remaining = Math.floor(arc / 128); remaining > 0; remaining = Math.floor(remaining / 128)) {
      group.unshift((remaining % 128) | 0x80);
    }
    bytes.push(...group);
  }
  return tlv(TAG.objectIdentifier, Buffer.from(bytes));
}

export function utf8String(value: string): Buffer {
  return tlv(TAG.utf8String, Buffer.from(value, "utf8"));
}

export function octetString(content: Uint8Array): Buffer {
  return tlv(TAG.octetString, content);
}

/** A BIT STRING of whole bytes, or with `unusedBits` trailing zero bits in the last byte. */
export function bitString(content: Uint8Array, unusedBits = 0): Buffer {
  return tlv(TAG.bitString, Buffer.concat([Buffer.from([unusedBits]), content]));
}

/** RFC 5280 4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050, always in UTC to the second. */
export function time(date: Date): Buffer {
  const iso = date.toISOString();
  const year = date.getUTCFullYear();
  const digits = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  if (year >= 1950 && year < 2050) return tlv(TAG.utcTime, Buffer.from(digits.slice(2), "ascii"));
  return tlv(TAG.generalizedTime, Buffer.from(digits, "ascii"));
}

/** `[n] EXPLICIT`: a constructed context tag around one encoded value. */
export function explicit(tagNumber: number, content: Uint8Array): Buffer {
  return tlv(0xa0 | tagNumber, content);
}

/** `[n] IMPLICIT` for a primitive value, such as a GeneralName. */
export function implicitPrimitive(tagNumber: number, content: Uint8Array): Buffer {
  return tlv(0x80 | tagNumber, content);
}
