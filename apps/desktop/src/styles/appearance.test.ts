import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});

describe("saved appearance", () => {
  it("defaults to dark and restores a saved light preference", async () => {
    const appearance = await import("./appearance");
    expect(appearance.readAppearance()).toBe("dark");
    appearance.setAppearance("light");
    expect(appearance.readAppearance()).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    appearance.initializeAppearance();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("ignores invalid stored values and follows changes in another window", async () => {
    const appearance = await import("./appearance");
    localStorage.setItem("openadminos:appearance:v1", "invalid");
    expect(appearance.readAppearance()).toBe("dark");
    appearance.initializeAppearance();
    localStorage.setItem("openadminos:appearance:v1", "light");
    window.dispatchEvent(new StorageEvent("storage", { key: "openadminos:appearance:v1" }));
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
