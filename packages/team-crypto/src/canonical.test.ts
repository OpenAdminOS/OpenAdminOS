import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalJson, FormatError } from "./index.js";

describe("canonical JSON", () => {
  it("sorts every object recursively while preserving array order and UTF-8", () => {
    const expected = '{"a":[{"a":"雪\\n","z":false},null,1],"b":{"a":true,"z":0}}';
    assert.equal(canonicalJson({ b: { z: -0, a: true }, a: [{ z: false, a: "雪\n" }, null, 1] }), expected);
    assert.equal(canonicalJson(JSON.parse(expected)), expected);
    assert.equal(Buffer.from(canonicalJson(JSON.parse(expected))).toString("utf8"), expected);
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  });

  it("uses lexical order even for integer-like object keys", () => {
    assert.equal(canonicalJson({ 2: "two", 10: "ten", 1: "one" }), '{"1":"one","10":"ten","2":"two"}');
  });

  it("ignores insertion order across many permutations", () => {
    const entries = [["z", 0], ["a", "one"], ["雪", [1, true]], ["10", null]] as const;
    const expected = canonicalJson(Object.fromEntries(entries));
    for (let i = 0; i < entries.length; i++) {
      assert.equal(canonicalJson(Object.fromEntries([...entries.slice(i), ...entries.slice(0, i)])), expected);
    }
  });

  for (const [label, value] of [
    ["undefined", undefined], ["NaN", NaN], ["Infinity", Infinity], ["bigint", 1n],
    ["function", () => 1], ["symbol", Symbol("x")], ["date", new Date()],
    ["buffer", Buffer.alloc(1)], ["map", new Map()], ["undefined field", { a: undefined }],
    ["sparse array", Array(2)], ["accessor", { get a() { throw new Error("Getter must not run."); } }],
    ["symbol key", { [Symbol("x")]: 1 }], ["hidden property", Object.defineProperty({}, "a", { value: 1 })],
    ["array extra property", Object.assign([1], { extra: 2 })], ["toJSON", { toJSON: () => "hidden" }],
  ]) {
    it(`rejects ${label}`, () => assert.throws(() => canonicalJson(value), FormatError));
  }

  it("rejects cycles and excess nesting, but permits repeated references", () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    assert.throws(() => canonicalJson(cycle), FormatError);
    const child = { b: 1 };
    assert.equal(canonicalJson([child, child]), '[{"b":1},{"b":1}]');
    let deep: unknown = null;
    for (let i = 0; i < 102; i++) deep = [deep];
    assert.throws(() => canonicalJson(deep), FormatError);
  });

  it("preserves prototype-like property names without invoking them", () => {
    const value: unknown = JSON.parse('{"constructor":2,"__proto__":1}');
    assert.equal(canonicalJson(value), '{"__proto__":1,"constructor":2}');
  });
});
