import { useSyncExternalStore } from "react";

export type ThemeId = "graphite" | "midnight" | "off-white" | "sand";
export type ThemeMode = "dark" | "light";
export type LegacyAppearance = "dark" | "light";

export interface ThemeDefinition {
  id: ThemeId;
  label: string;
  mode: ThemeMode;
  description: string;
  swatches: {
    background: string;
    surface: string;
    accent: string;
    text: string;
  };
}

export const THEMES = [
  {
    id: "graphite",
    label: "Graphite",
    mode: "dark",
    description: "Neutral graphite for low-light work.",
    swatches: {
      background: "#17191d",
      surface: "#1e2126",
      accent: "#f4f5f7",
      text: "#f4f5f7",
    },
  },
  {
    id: "midnight",
    label: "Midnight",
    mode: "dark",
    description: "Cool navy for low-light work.",
    swatches: {
      background: "#0f1520",
      surface: "#141b28",
      accent: "#8fb4ff",
      text: "#e8eef7",
    },
  },
  {
    id: "off-white",
    label: "Off-white",
    mode: "light",
    description: "Neutral off-white for bright environments.",
    swatches: {
      background: "#f4f5f7",
      surface: "#ffffff",
      accent: "#17191d",
      text: "#17191d",
    },
  },
  {
    id: "sand",
    label: "Sand",
    mode: "light",
    description: "Warm paper tones for bright environments.",
    swatches: {
      background: "#f6f1ea",
      surface: "#fffdf9",
      accent: "#9a4f1f",
      text: "#2a2119",
    },
  },
] as const satisfies readonly ThemeDefinition[];

export type Appearance = ThemeId;
export type AppearanceInput = ThemeId | LegacyAppearance;

const key = "openadminos:appearance:v1";
const changed = "openadminos:appearance-changed";
const themeById = new Map(THEMES.map((theme) => [theme.id, theme]));
let current: ThemeId = "graphite";
let error: string | null = null;

export function normalizeThemeId(value: unknown): ThemeId {
  if (value === "dark") return "graphite";
  if (value === "light") return "off-white";
  return typeof value === "string" && themeById.has(value as ThemeId)
    ? (value as ThemeId)
    : "graphite";
}

export function getTheme(themeId: ThemeId): ThemeDefinition {
  return themeById.get(themeId) ?? THEMES[0];
}

export function readAppearance(): ThemeId {
  try {
    const stored = localStorage.getItem(key);
    const themeId = normalizeThemeId(stored);
    if (stored !== null && stored !== themeId) localStorage.setItem(key, themeId);
    return themeId;
  } catch {
    return "graphite";
  }
}

function apply(themeId: ThemeId) {
  const theme = getTheme(themeId);
  current = theme.id;
  document.documentElement.dataset.theme = theme.id;
  document.documentElement.dataset.mode = theme.mode;
  document.documentElement.style.colorScheme = theme.mode;
  void window.openAdminOS?.setAppearance?.(theme.id).catch(() => {
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

export function setAppearance(value: AppearanceInput) {
  const themeId = normalizeThemeId(value);
  error = null;
  try {
    localStorage.setItem(key, themeId);
  } catch {
    error = "Appearance changed for this window, but could not be saved. Check local storage access before restarting.";
  }
  apply(themeId);
  window.dispatchEvent(new Event(changed));
}

function subscribe(listener: () => void) {
  window.addEventListener(changed, listener);
  return () => window.removeEventListener(changed, listener);
}

export function useAppearance() {
  const theme = useSyncExternalStore(subscribe, () => current, () => "graphite" as const);
  const saveError = useSyncExternalStore(subscribe, () => error, () => null);
  return { theme, setAppearance, error: saveError };
}
