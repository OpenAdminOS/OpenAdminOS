import { describe, expect, it } from "vitest";
import { electronAccelerator, matchesShortcut, SHORTCUTS, shortcutLabel } from "./shortcuts.js";

describe("shortcut registry", () => {
  it("formats platform-correct labels", () => {
    expect(shortcutLabel("commandPalette", "MacIntel")).toBe("⌘K");
    expect(shortcutLabel("commandPalette", "Win32")).toBe("Ctrl+K");
    expect(shortcutLabel("settings", "MacIntel")).toBe("⌘,");
  });

  it("matches either platform modifier without accepting extra modifiers", () => {
    expect(
      matchesShortcut(
        { key: "K", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
        "commandPalette",
      ),
    ).toBe(true);
    expect(
      matchesShortcut(
        { key: "k", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
        "commandPalette",
      ),
    ).toBe(false);
  });

  it("keeps Electron accelerators and overlay contexts in the same registry", () => {
    expect(electronAccelerator("commandPalette")).toBe("CmdOrCtrl+K");
    expect(electronAccelerator("newConversation")).toBe("CmdOrCtrl+N");
    expect(electronAccelerator("settings")).toBe("CmdOrCtrl+,");
    expect(SHORTCUTS.newConversation.when).toContain("overlayClosed");
  });
});
