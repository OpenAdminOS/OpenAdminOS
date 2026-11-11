import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { judge, locate, mutate, REGISTER, REPO_ROOT, tapTotals } from "./mutation-register.mjs";

const entry = { path: "a.ts", find: "x > limit", replace: "x > limit + 1" };

test("a mutation applies only where its text occurs exactly once", () => {
  assert.equal(mutate("if (x > limit) stop();", entry), "if (x > limit + 1) stop();");
  assert.match(locate("if (y) stop();", entry).error, /no longer contains/);
  assert.match(locate("x > limit; x > limit;", entry).error, /2 times\. Give the entry an anchor/);
  assert.throws(() => mutate("", entry), /no longer contains/);
});

test("an anchor picks the first occurrence after it, within the window", () => {
  const anchored = { ...entry, anchor: "function b" };
  assert.equal(mutate("function a x > limit; function b x > limit;", anchored), "function a x > limit; function b x > limit + 1;");
  assert.match(locate("function b x > limit; function b", anchored).error, /anchor .* 2 times/);
  assert.match(locate(`function b ${" ".repeat(700)} x > limit`, anchored).error, /within 600 characters/);
});

test("a survivor fails the register unless a finding owns it, and a paid debt fails too", () => {
  assert.equal(judge({}, "killed", "").ok, true);
  assert.equal(judge({}, "survived", "").ok, false);
  assert.equal(judge({ survivesUntil: "F-1" }, "survived", "").ok, true);
  assert.equal(judge({ survivesUntil: "F-1" }, "killed", "").ok, false);
  for (const verdict of ["stale", "not-reached", "broken", "control-red"]) assert.equal(judge({}, verdict, "").ok, false);
});

test("TAP totals count cancelled tests as failed", () => {
  assert.deepEqual(tapTotals("# tests 7\n# pass 5\n# fail 1\n# cancelled 1\n"), { tests: 7, failed: 2 });
});

test("every register entry has a unique id and still locates in the tree", () => {
  assert.equal(new Set(REGISTER.map((e) => e.id)).size, REGISTER.length);
  for (const e of REGISTER) {
    const found = locate(readFileSync(join(REPO_ROOT, e.path), "utf8"), e);
    assert.ok(!("error" in found), `${e.id}: ${found.error}`);
    assert.notEqual(e.find, e.replace, e.id);
    for (const t of e.tests) assert.ok(existsSync(join(REPO_ROOT, t)), `${e.id}: ${t} is missing`);
  }
});
