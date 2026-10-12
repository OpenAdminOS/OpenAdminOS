/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const fullStylesheet = readFileSync(resolve(process.cwd(), "src/styles/globals.css"), "utf8");

const themeIds = ["graphite", "midnight", "off-white", "sand"] as const;

function colorTokens(source: string) {
  return new Map(
    [...source.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6,8})\s*;/g)].map(
      (match) => [match[1], match[2]],
    ),
  );
}

const defaultBlock = fullStylesheet.match(/@theme\s*\{([\s\S]*?)\n\}/)?.[1];
if (!defaultBlock) throw new Error("Missing default @theme block");
const defaultTokens = colorTokens(defaultBlock);

function tokensFor(theme: (typeof themeIds)[number]) {
  if (theme === "graphite") return defaultTokens;
  const escaped = theme.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = fullStylesheet.match(
    new RegExp(`:root\\[data-theme="${escaped}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`),
  )?.[1];
  if (!block) throw new Error(`Missing ${theme} theme block`);
  return new Map([...defaultTokens, ...colorTokens(block)]);
}

function token(theme: (typeof themeIds)[number], name: string) {
  const value = tokensFor(theme).get(name);
  if (!value || value.length !== 7) throw new Error(`Missing six-digit color token --${name} for ${theme}`);
  return value;
}

function luminance(hex: string) {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string) {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function tokenWithAlpha(theme: (typeof themeIds)[number], name: string) {
  const value = tokensFor(theme).get(name);
  if (!value || value.length !== 9) throw new Error(`Missing eight-digit color token --${name} for ${theme}`);
  return value;
}

/** Composite an #rrggbbaa color over an opaque #rrggbb surface. */
function composite(overlay: string, surface: string) {
  const alpha = Number.parseInt(overlay.slice(7, 9), 16) / 255;
  const channel = (offset: number) =>
    Math.round(
      alpha * Number.parseInt(overlay.slice(offset, offset + 2), 16) +
        (1 - alpha) * Number.parseInt(surface.slice(offset, offset + 2), 16),
    )
      .toString(16)
      .padStart(2, "0");
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

const componentSource = (relativePath: string) =>
  readFileSync(resolve(process.cwd(), relativePath), "utf8");

describe.each(themeIds)("%s accessibility design tokens", (theme) => {
  it("keeps primary, secondary, and informative metadata copy above 4.5:1", () => {
    const foregrounds = [
      token(theme, "color-text"),
      token(theme, "color-text-soft"),
      token(theme, "color-text-muted"),
    ];
    const surfaces = [
      token(theme, "color-bg"),
      token(theme, "color-bg-elevated"),
      token(theme, "color-bg-raised"),
      token(theme, "color-surface"),
      token(theme, "color-surface-hover"),
    ];

    for (const foreground of foregrounds) {
      for (const surface of surfaces) {
        expect(contrastRatio(foreground, surface)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps the on-accent foreground above 4.5:1 on every filled control color", () => {
    const onAccent = token(theme, "color-on-accent");
    const fills = [
      token(theme, "color-accent"),
      token(theme, "color-accent-hover"),
      token(theme, "color-accent-strong"),
      token(theme, "color-warning-fg"),
      token(theme, "color-danger-fg"),
    ];
    for (const fill of fills) {
      expect(contrastRatio(onAccent, fill)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps placeholder text above 4.5:1 on every form and composer surface", () => {
    const placeholder = token(theme, "color-text-placeholder");
    const inputSurfaces = [
      token(theme, "color-bg"),
      token(theme, "color-bg-elevated"),
      token(theme, "color-bg-raised"),
      token(theme, "color-surface"),
      token(theme, "color-surface-hover"),
    ];
    for (const surface of inputSurfaces) {
      expect(contrastRatio(placeholder, surface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps semantic foregrounds above 4.5:1 on their soft backgrounds over every surface", () => {
    const surfaces = [
      token(theme, "color-bg"),
      token(theme, "color-bg-elevated"),
      token(theme, "color-bg-raised"),
      token(theme, "color-surface"),
      token(theme, "color-surface-hover"),
    ];
    for (const state of ["success", "warning", "danger", "info", "think"]) {
      const foreground = token(theme, `color-${state}-fg`);
      const softBackground = tokenWithAlpha(theme, `color-${state}-bg`);
      for (const surface of surfaces) {
        expect(contrastRatio(foreground, composite(softBackground, surface))).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });

  it("keeps legacy semantic token names identical to the fg/bg pairs", () => {
    for (const state of ["success", "warning", "danger", "info", "think"]) {
      expect(token(theme, `color-${state}`)).toBe(token(theme, `color-${state}-fg`));
      expect(tokenWithAlpha(theme, `color-${state}-soft`)).toBe(
        tokenWithAlpha(theme, `color-${state}-bg`),
      );
    }
  });

  it("keeps hardcoded on-accent ink literals out of key shared and Chat components", () => {
    const files = [
      "src/components/Button.tsx",
      "src/components/Avatar.tsx",
      "src/components/AppShell.tsx",
      "src/components/ConnectorConfirmModal.tsx",
      "src/pages/IntuneChat.tsx",
      "src/setup/TenantSetupDialog.tsx",
      "src/pages/RunResult.tsx",
    ];
    for (const file of files) {
      expect(componentSource(file)).not.toMatch(/#1a120c|#1c1917/i);
    }
  });

  it("defines reduced-motion and forced-colors fallbacks", () => {
    expect(fullStylesheet).toContain("@media (prefers-reduced-motion: reduce)");
    expect(fullStylesheet).toContain("@media (forced-colors: active)");
  });
});

describe("desktop type scale", () => {
  it("exposes the locked sizes and line heights as Tailwind theme tokens", () => {
    for (const [name, size, lineHeight] of [
      ["xs", "11px", "16px"],
      ["sm", "12px", "18px"],
      ["base", "13px", "20px"],
      ["md", "15px", "22px"],
      ["lg", "20px", "28px"],
    ]) {
      expect(fullStylesheet).toContain(`--text-${name}: ${size};`);
      expect(fullStylesheet).toContain(`--text-${name}--line-height: ${lineHeight};`);
    }
  });
});
