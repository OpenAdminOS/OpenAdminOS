/**
 * Crockford base32: digits and capital letters without I, L, O and U, so
 * a code read aloud or typed from a screen has no look-alike characters.
 * Bits are taken most significant first; a final partial group is padded
 * with zero bits. There is no padding character and no check symbol.
 */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const DECODE = new Map<string, number>();
for (let index = 0; index < CROCKFORD_ALPHABET.length; index += 1) {
  DECODE.set(CROCKFORD_ALPHABET[index] as string, index);
}
// Crockford's decoding aliases: what a person may type for 0 and 1.
DECODE.set("O", 0);
DECODE.set("I", 1);
DECODE.set("L", 1);

export function encodeBase32(bytes: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += CROCKFORD_ALPHABET[(buffer >>> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) {
    output += CROCKFORD_ALPHABET[(buffer << (5 - bits)) & 31];
  }
  return output;
}

/**
 * Normalizes typed input to canonical symbols: upper case, O as 0, I and
 * L as 1. Returns undefined when a character is not a base32 symbol
 * (U, punctuation, spaces). Callers strip separators first.
 */
export function normalizeBase32(input: string): string | undefined {
  let output = "";
  for (const character of input.toUpperCase()) {
    const value = DECODE.get(character);
    if (value === undefined) return undefined;
    output += CROCKFORD_ALPHABET[value];
  }
  return output;
}

/**
 * Decodes canonical or aliased symbols into `byteLength` bytes. Returns
 * undefined when the length does not fit or the padding bits are not zero,
 * so every byte string has exactly one accepted encoding.
 */
export function decodeBase32(input: string, byteLength: number): Uint8Array | undefined {
  const normalized = normalizeBase32(input);
  if (normalized === undefined || normalized.length !== Math.ceil((byteLength * 8) / 5)) return undefined;
  const output = new Uint8Array(byteLength);
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const character of normalized) {
    buffer = (buffer << 5) | (DECODE.get(character) as number);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output[index] = (buffer >>> bits) & 0xff;
      index += 1;
    }
    buffer &= (1 << bits) - 1;
  }
  if (buffer !== 0) return undefined;
  return output;
}
