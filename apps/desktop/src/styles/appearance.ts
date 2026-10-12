import { useSyncExternalStore } from "react";

export type Appearance = "dark" | "light";
const key = "openadminos:appearance:v1";
const changed = "openadminos:appearance-changed";
let current: Appearance = "dark";
let error: string | null = null;

export function readAppearance(): Appearance {
  try {
    return localStorage.getItem(key) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function apply(theme: Appearance) {
  current = theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  void window.openAdminOS?.setAppearance?.(theme).catch(() => {
    error = "The window controls could not update. Restart OpenAdminOS to refresh the appearance.";
    window.dispatchEvent(new Event(changed));
  });
}

export function initializeAppearance() {
  apply(readAppearance());
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null) {
      apply(readAppearance());
      window.dispatchEvent(new Event(changed));
    }
  });
}

export function setAppearance(theme: Appearance) {
  error = null;
  try {
    localStorage.setItem(key, theme);
  } catch {
    error = "Appearance changed for this window, but could not be saved. Check local storage access before restarting.";
  }
  apply(theme);
  window.dispatchEvent(new Event(changed));
}

function subscribe(listener: () => void) {
  window.addEventListener(changed, listener);
  return () => window.removeEventListener(changed, listener);
}

export function useAppearance() {
  const theme = useSyncExternalStore(subscribe, () => current, () => "dark" as const);
  const saveError = useSyncExternalStore(subscribe, () => error, () => null);
  return { theme, setAppearance, error: saveError };
}
