import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});

describe("saved appearance", () => {
  it("defaults to Midnight and applies every theme with its matching mode", async () => {
    const appearance = await import("./appearance");
    expect(appearance.readAppearance()).toBe("midnight");

    for (const theme of appearance.THEMES) {
      appearance.setAppearance(theme.id);
      expect(appearance.readAppearance()).toBe(theme.id);
      expect(document.documentElement.dataset.theme).toBe(theme.id);
      expect(document.documentElement.dataset.mode).toBe(theme.mode);
      expect(document.documentElement.style.colorScheme).toBe(theme.mode);
    }
  });

  it("maps legacy values, stores normalized ids, and rejects unknown stored values", async () => {
    const appearance = await import("./appearance");
    appearance.setAppearance("dark");
    expect(localStorage.getItem("openadminos:appearance:v1")).toBe("graphite");
    appearance.setAppearance("light");
    expect(localStorage.getItem("openadminos:appearance:v1")).toBe("off-white");

    localStorage.setItem("openadminos:appearance:v1", "invalid");
    expect(appearance.readAppearance()).toBe("midnight");
    expect(localStorage.getItem("openadminos:appearance:v1")).toBe("midnight");
  });

  it("follows saved theme changes in another renderer window", async () => {
    const appearance = await import("./appearance");
    appearance.initializeAppearance();
    localStorage.setItem("openadminos:appearance:v1", "sand");
    window.dispatchEvent(new StorageEvent("storage", { key: "openadminos:appearance:v1" }));
    expect(document.documentElement.dataset.theme).toBe("sand");
    expect(document.documentElement.dataset.mode).toBe("light");
  });
});
