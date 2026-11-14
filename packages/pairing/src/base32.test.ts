import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { CROCKFORD_ALPHABET, decodeBase32, encodeBase32, normalizeBase32 } from "./base32.js";

describe("Crockford base32", () => {
  it("has no ambiguous symbols", () => {
    assert.equal(CROCKFORD_ALPHABET.length, 32);
    for (const character of "ILOU") assert.ok(!CROCKFORD_ALPHABET.includes(character));
  });

  it("encodes known vectors", () => {
    assert.equal(encodeBase32(new Uint8Array([])), "");
    assert.equal(encodeBase32(new Uint8Array([0xff])), "ZW");
    assert.equal(encodeBase32(new Uint8Array([0, 0, 0, 0, 0])), "00000000");
    assert.equal(encodeBase32(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff])), "ZZZZZZZZ");
    assert.equal(encodeBase32(Buffer.from("foobar")), "CSQPYRK1E8");
  });

  it("round-trips random bytes of every length", () => {
    for (let length = 0; length <= 40; length += 1) {
      const bytes = randomBytes(length);
      assert.deepEqual(Buffer.from(decodeBase32(encodeBase32(bytes), length) ?? []), bytes);
    }
  });

  it("accepts lower case and the O, I and L aliases", () => {
    assert.equal(normalizeBase32("oil0"), "0110");
    assert.deepEqual(decodeBase32("zw", 1), new Uint8Array([0xff]));
  });

  it("refuses U, punctuation, wrong lengths and stray padding bits", () => {
    assert.equal(normalizeBase32("AU"), undefined);
    assert.equal(normalizeBase32("A-B"), undefined);
    assert.equal(decodeBase32("ZW0", 1), undefined);
    assert.equal(decodeBase32("Z", 1), undefined);
    // "ZZ" sets the two padding bits after the eight data bits.
    assert.equal(decodeBase32("ZZ", 1), undefined);
  });
});
