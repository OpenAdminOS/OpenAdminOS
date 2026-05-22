import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { compareSemver } from "./index.js";

describe("compareSemver", () => {
  it("returns 0 for identical versions", () => {
    assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
    assert.equal(compareSemver("0.1.4", "0.1.4"), 0);
    assert.equal(compareSemver("12.34.56", "12.34.56"), 0);
  });

  it("returns 1 when the left side is newer", () => {
    assert.equal(compareSemver("1.0.1", "1.0.0"), 1);
    assert.equal(compareSemver("1.1.0", "1.0.99"), 1);
    assert.equal(compareSemver("2.0.0", "1.99.99"), 1);
  });

  it("returns -1 when the left side is older", () => {
    assert.equal(compareSemver("1.0.0", "1.0.1"), -1);
    assert.equal(compareSemver("0.9.99", "1.0.0"), -1);
  });

  it("treats missing patch component as 0", () => {
    assert.equal(compareSemver("1.0", "1.0.0"), 0);
    assert.equal(compareSemver("1.0.0", "1.0"), 0);
    assert.equal(compareSemver("1.0.1", "1.0"), 1);
  });

  it("treats missing minor component as 0", () => {
    assert.equal(compareSemver("1", "1.0.0"), 0);
    assert.equal(compareSemver("2", "1.99.99"), 1);
  });

  it("returns 0 when both sides are non-numeric (treated as 0.0.0)", () => {
    assert.equal(compareSemver("abc", "xyz"), 0);
  });

  it("compares 1.10.0 as newer than 1.9.0 (no string comparison)", () => {
    assert.equal(compareSemver("1.10.0", "1.9.0"), 1);
    assert.equal(compareSemver("1.9.0", "1.10.0"), -1);
  });

  it("compares the offboarding-agent bump scenario", () => {
    // The motivating use-case: installed 1.0.0, registry advertises 1.1.0.
    assert.equal(compareSemver("1.1.0", "1.0.0"), 1);
    // Inverse — already on 1.1.0, registry still at 1.0.0 (no update).
    assert.equal(compareSemver("1.0.0", "1.1.0"), -1);
  });

  it("treats prerelease suffix as 0 for its segment — no infinite update loop", () => {
    // The update-detection path calls `compareSemver(registry.version, installed.version) > 0`.
    // If a user runs a `-alpha` build whose persisted version is "1.0.0-alpha"
    // and the registry advertises "1.0.0", we must NOT mark an update available
    // — otherwise the badge sticks forever (clicking update fetches the same
    // version they nominally have). parseInt("0-alpha", 10) === 0, so both
    // sides reduce to [1,0,0] and compare equal. Guard against a future
    // regression that swaps parseInt for a strict numeric parse.
    assert.equal(compareSemver("1.0.0-alpha", "1.0.0"), 0);
    assert.equal(compareSemver("1.0.0", "1.0.0-alpha"), 0);
    // Note: "1.0.0-rc.2" splits on "." into ["1","0","0-rc","2"], which has
    // one extra segment vs "1.0.0", so it sorts higher. We don't claim full
    // semver-spec parity for prerelease ordering — only that the registry's
    // common `X.Y.Z` and `X.Y.Z-tag` forms don't loop with themselves.
  });
});
