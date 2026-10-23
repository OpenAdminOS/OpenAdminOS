import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * The Windows title-bar overlay is painted by the OS, not by CSS, so its
 * colors come from the tested native appearance map. If main.ts bypasses
 * that map, the window-control strip can drift from the app chrome.
 */
describe("windows title bar overlay", () => {
  const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

  it("paints the overlay in the renderer's background color", () => {
    assert.match(
      main,
      /titleBarOverlay:\s*\{[^}]*color:\s*initialThemeColors\.background/,
    );
  });

  it("paints the window control glyphs in the muted text color", () => {
    assert.match(
      main,
      /symbolColor:\s*initialThemeColors\.textMuted/,
    );
  });

  it("opens each window on the current system background so launch does not flash", () => {
    assert.match(
      main,
      /NATIVE_THEME_COLORS\[nativeTheme\.shouldUseDarkColors \? "dark" : "light"\]/,
    );
    const backgrounds = main.match(/backgroundColor:\s*initialThemeColors\.background/g);
    assert.ok(
      (backgrounds?.length ?? 0) >= 2,
      "main and companion windows should use the system theme background",
    );
  });
});
