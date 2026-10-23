import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  DEFAULT_NATIVE_THEME_ID,
  NATIVE_THEME_COLORS,
  parseNativeAppearance,
  parseNativeTheme,
} from "./appearance.js";

const stylesheet = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles/globals.css"),
  "utf8",
);

function blockTokens(source: string) {
  return new Map(
    [...source.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map(
      (match) => [match[1], match[2].toLowerCase()],
    ),
  );
}

const defaultBlock = stylesheet.match(/@theme\s*\{([\s\S]*?)\n\}/)?.[1];
if (!defaultBlock) throw new Error("Missing default @theme block");
const defaultTokens = blockTokens(defaultBlock);

function themeTokens(themeId: keyof typeof NATIVE_THEME_COLORS) {
  if (themeId === "light") return defaultTokens;
  const block = stylesheet.match(
    new RegExp(`:root\\[data-theme="${themeId}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`),
  )?.[1];
  if (!block) throw new Error(`Missing ${themeId} theme block`);
  return new Map([...defaultTokens, ...blockTokens(block)]);
}

describe("native appearance", () => {
  it("keeps native chrome colors aligned with renderer tokens", () => {
    for (const [themeId, colors] of Object.entries(NATIVE_THEME_COLORS)) {
      const tokens = themeTokens(themeId as keyof typeof NATIVE_THEME_COLORS);
      assert.equal(colors.background, tokens.get("color-bg"), `${themeId} background`);
      assert.equal(colors.textMuted, tokens.get("color-text-muted"), `${themeId} text`);
    }
  });

  it("accepts current theme ids and normalizes legacy aliases", () => {
    assert.equal(DEFAULT_NATIVE_THEME_ID, "light");
    for (const themeId of Object.keys(NATIVE_THEME_COLORS)) {
      assert.equal(parseNativeTheme(themeId), themeId);
    }
    assert.equal(parseNativeTheme("graphite"), "dark");
    assert.equal(parseNativeTheme("off-white"), "light");
    assert.equal(parseNativeTheme("sand"), "light");
    assert.deepEqual(parseNativeAppearance("system", "dark"), {
      preference: "system",
      resolvedTheme: "dark",
    });
    assert.deepEqual(
      parseNativeAppearance({ preference: "system", resolvedTheme: "light" }),
      { preference: "system", resolvedTheme: "light" },
    );
    assert.throws(
      () => parseNativeAppearance({ preference: "system", resolvedTheme: "midnight" }),
      /must resolve to Light or Dark/,
    );
    assert.throws(() => parseNativeTheme("unknown"), /Choose System/);
    for (const inherited of ["constructor", "toString", "__proto__"]) {
      assert.throws(() => parseNativeTheme(inherited), /Choose System/);
    }
  });
});
