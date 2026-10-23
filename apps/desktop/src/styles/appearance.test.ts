import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});

describe("saved appearance", () => {
  it("defaults to System and applies every preference with its resolved mode", async () => {
    const appearance = await import("./appearance");
    expect(appearance.readAppearance()).toBe("system");

    for (const theme of appearance.THEMES) {
      appearance.setAppearance(theme.id);
      expect(appearance.readAppearance()).toBe(theme.id);
      const resolved = theme.id === "system" ? "light" : theme.id;
      const mode = resolved === "light" ? "light" : "dark";
      expect(document.documentElement.dataset.theme).toBe(resolved);
      expect(document.documentElement.dataset.appearance).toBe(theme.id);
      expect(document.documentElement.dataset.mode).toBe(mode);
      expect(document.documentElement.style.colorScheme).toBe(mode);
    }
  });

  it("migrates every legacy value and safely normalizes unknown stored values", async () => {
    const appearance = await import("./appearance");
    appearance.setAppearance("graphite");
    expect(localStorage.getItem("openadminos:appearance:v1")).toBe("dark");
    appearance.setAppearance("off-white");
    expect(localStorage.getItem("openadminos:appearance:v1")).toBe("light");
    appearance.setAppearance("sand");
    expect(localStorage.getItem("openadminos:appearance:v1")).toBe("light");

    localStorage.setItem("openadminos:appearance:v1", "invalid");
    expect(appearance.readAppearance()).toBe("system");
    expect(localStorage.getItem("openadminos:appearance:v1")).toBe("system");
  });

  it("follows saved theme changes in another renderer window", async () => {
    const appearance = await import("./appearance");
    appearance.initializeAppearance();
    localStorage.setItem("openadminos:appearance:v1", "light");
    window.dispatchEvent(new StorageEvent("storage", { key: "openadminos:appearance:v1" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.mode).toBe("light");
  });

  it("updates the resolved renderer and native appearance when the OS theme changes", async () => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    let matches = false;
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      get matches() {
        return matches;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) =>
        listeners.add(listener as (event: MediaQueryListEvent) => void),
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) =>
        listeners.delete(listener as (event: MediaQueryListEvent) => void),
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
    const setAppearance = vi.fn(async () => undefined);
    window.openAdminOS = { setAppearance } as unknown as typeof window.openAdminOS;
    const appearance = await import("./appearance");
    appearance.initializeAppearance();

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(setAppearance).toHaveBeenLastCalledWith({
      preference: "system",
      resolvedTheme: "light",
    });

    matches = true;
    for (const listener of listeners) {
      listener({ matches: true } as MediaQueryListEvent);
    }
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(setAppearance).toHaveBeenLastCalledWith({
      preference: "system",
      resolvedTheme: "dark",
    });
  });
});
