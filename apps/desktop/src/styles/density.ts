import { useSyncExternalStore } from "react";

export type Density = "comfortable" | "compact";

export const DEFAULT_DENSITY: Density = "comfortable";
export const DENSITY_STORAGE_KEY = "openadminos:density:v1";

const changed = "openadminos:density-changed";
let current: Density = DEFAULT_DENSITY;
let initialized = false;

function normalizeDensity(value: unknown): Density {
  return value === "compact" ? "compact" : DEFAULT_DENSITY;
}

export function readDensity(): Density {
  try {
    return normalizeDensity(localStorage.getItem(DENSITY_STORAGE_KEY));
  } catch {
    return DEFAULT_DENSITY;
  }
}

function applyDensity(value: Density) {
  current = value;
  document.documentElement.dataset.density = value;
}

export function initializeDensity() {
  applyDensity(readDensity());
  if (initialized) return;
  initialized = true;
  window.addEventListener("storage", (event) => {
    if (event.key !== DENSITY_STORAGE_KEY && event.key !== null) return;
    applyDensity(readDensity());
    window.dispatchEvent(new Event(changed));
  });
}

export function setDensity(value: Density) {
  try {
    localStorage.setItem(DENSITY_STORAGE_KEY, value);
  } catch {
    // The preference still applies to this renderer when storage is unavailable.
  }
  applyDensity(value);
  window.dispatchEvent(new Event(changed));
}

function subscribe(listener: () => void) {
  window.addEventListener(changed, listener);
  return () => window.removeEventListener(changed, listener);
}

export function useDensity() {
  const density = useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT_DENSITY,
  );
  return { density, setDensity };
}
