import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * The Windows title-bar overlay is painted by the OS, not by CSS, so its
 * colors are hardcoded in main.ts. If the renderer theme changes and
 * these drift, the window-control strip renders as a visibly different
 * block from the app chrome. This test fails when they disagree.
 */
function cssVar(name: string): string {
  const css = readFileSync(new URL("../src/styles/globals.css", import.meta.url), "utf8");
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`));
  assert.ok(match, `globals.css should define --${name}`);
  return match![1]!.toLowerCase();
}

describe("windows title bar overlay", () => {
  const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

  it("paints the overlay in the renderer's background color", () => {
    const overlay = main.match(/titleBarOverlay:\s*\{[^}]*color:\s*"(#[0-9a-fA-F]{6})"/);
    assert.ok(overlay, "main.ts should configure titleBarOverlay.color");
    assert.equal(overlay![1]!.toLowerCase(), cssVar("color-bg"));
  });

  it("paints the window control glyphs in the muted text color", () => {
    const symbol = main.match(/symbolColor:\s*"(#[0-9a-fA-F]{6})"/);
    assert.ok(symbol, "main.ts should configure titleBarOverlay.symbolColor");
    assert.equal(symbol![1]!.toLowerCase(), cssVar("color-text-muted"));
  });

  it("opens the window on the renderer background so launch does not flash", () => {
    const backgrounds = [...main.matchAll(/backgroundColor:\s*"(#[0-9a-fA-F]{6})"/g)].map(
      (m) => m[1]!.toLowerCase(),
    );
    assert.ok(backgrounds.length > 0, "main.ts should set a window backgroundColor");
    for (const background of backgrounds) {
      assert.equal(background, cssVar("color-bg"));
    }
  });
});
