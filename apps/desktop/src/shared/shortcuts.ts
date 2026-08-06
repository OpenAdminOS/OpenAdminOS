export type ShortcutCommand = "commandPalette" | "newConversation" | "settings";
export type ShortcutContext = "global" | "overlayClosed";

export const OPEN_NEW_CONVERSATION_EVENT = "openadminos:new-conversation";

export interface ShortcutDefinition {
  command: ShortcutCommand;
  key: string;
  modifier: "mod";
  label: string;
  when: readonly ShortcutContext[];
}

export const SHORTCUTS: Readonly<Record<ShortcutCommand, ShortcutDefinition>> = {
  commandPalette: { command: "commandPalette", key: "k", modifier: "mod", label: "Command Palette", when: ["global"] },
  newConversation: { command: "newConversation", key: "n", modifier: "mod", label: "New conversation", when: ["global", "overlayClosed"] },
  settings: { command: "settings", key: ",", modifier: "mod", label: "Settings", when: ["global", "overlayClosed"] },
};

export function electronAccelerator(command: ShortcutCommand): string {
  const shortcut = SHORTCUTS[command];
  return `CmdOrCtrl+${shortcut.key === "," ? "," : shortcut.key.toUpperCase()}`;
}

export function isMacPlatform(platform = globalThis.navigator?.platform ?? ""): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

export function shortcutLabel(
  command: ShortcutCommand,
  platform = globalThis.navigator?.platform ?? "",
): string {
  const shortcut = SHORTCUTS[command];
  const key = shortcut.key === "," ? "," : shortcut.key.toUpperCase();
  return isMacPlatform(platform) ? `⌘${key}` : `Ctrl+${key}`;
}

export function matchesShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, command: ShortcutCommand): boolean {
  const shortcut = SHORTCUTS[command];
  return (
    !event.altKey &&
    !event.shiftKey &&
    (event.metaKey || event.ctrlKey) &&
    event.key.toLocaleLowerCase() === shortcut.key
  );
}

export function isTextInput(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
