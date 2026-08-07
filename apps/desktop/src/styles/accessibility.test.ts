/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(resolve(process.cwd(), "src/styles/globals.css"), "utf8");

function token(name: string) {
  const match = stylesheet.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`Missing six-digit color token --${name}`);
  return match[1];
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

function tokenWithAlpha(name: string) {
  const match = stylesheet.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{8})`));
  if (!match) throw new Error(`Missing eight-digit color token --${name}`);
  return match[1];
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

describe("accessibility design tokens", () => {
  it("keeps primary, secondary, and informative metadata copy above 4.5:1", () => {
    const foregrounds = [token("color-text"), token("color-text-soft"), token("color-text-muted")];
    const surfaces = [
      token("color-bg"),
      token("color-bg-elevated"),
      token("color-bg-raised"),
      token("color-surface"),
      token("color-surface-hover"),
    ];

    for (const foreground of foregrounds) {
      for (const surface of surfaces) {
        expect(contrastRatio(foreground, surface)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps the on-accent foreground above 4.5:1 on every filled control color", () => {
    const onAccent = token("color-on-accent");
    const fills = [
      token("color-accent"),
      token("color-accent-hover"),
      token("color-accent-strong"),
      token("color-warning-fg"),
    ];
    for (const fill of fills) {
      expect(contrastRatio(onAccent, fill)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps placeholder text above 4.5:1 on every form and composer surface", () => {
    const placeholder = token("color-text-placeholder");
    const inputSurfaces = [
      token("color-bg"),
      token("color-bg-elevated"),
      token("color-bg-raised"),
      token("color-surface"),
      token("color-surface-hover"),
    ];
    for (const surface of inputSurfaces) {
      expect(contrastRatio(placeholder, surface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps semantic foregrounds above 4.5:1 on their soft backgrounds over every surface", () => {
    const surfaces = [
      token("color-bg"),
      token("color-bg-elevated"),
      token("color-bg-raised"),
      token("color-surface"),
      token("color-surface-hover"),
    ];
    for (const state of ["success", "warning", "danger", "info", "think"]) {
      const foreground = token(`color-${state}-fg`);
      const softBackground = tokenWithAlpha(`color-${state}-bg`);
      for (const surface of surfaces) {
        expect(contrastRatio(foreground, composite(softBackground, surface))).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });

  it("keeps legacy semantic token names identical to the fg/bg pairs", () => {
    for (const state of ["success", "warning", "danger", "info", "think"]) {
      expect(token(`color-${state}`)).toBe(token(`color-${state}-fg`));
      expect(tokenWithAlpha(`color-${state}-soft`)).toBe(tokenWithAlpha(`color-${state}-bg`));
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
    expect(stylesheet).toContain("@media (prefers-reduced-motion: reduce)");
    expect(stylesheet).toContain("@media (forced-colors: active)");
  });
});
