export const OPEN_NOVA_EVENT = "openadminos:open-nova";

/** What the Nova panel does when it opens: a saved shortcut to run, by its name. */
export interface OpenNovaDetail {
  shortcut?: string;
}

export function openNovaPanel() {
  window.dispatchEvent(new CustomEvent(OPEN_NOVA_EVENT));
}

/**
 * Opens the Nova panel to run a saved shortcut: in the live session, or
 * once the admin starts one. Opening never starts a session by itself.
 */
export function openNovaShortcut(shortcut: string) {
  window.dispatchEvent(new CustomEvent<OpenNovaDetail>(OPEN_NOVA_EVENT, { detail: { shortcut } }));
}
