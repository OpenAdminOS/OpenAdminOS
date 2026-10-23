import { useSyncExternalStore } from "react";

export type ResolvedThemeId = "light" | "dark" | "midnight";
export type ThemeId = "system" | ResolvedThemeId;
export type ThemeMode = "system" | "dark" | "light";
export type LegacyAppearance = "graphite" | "off-white" | "sand";

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
    id: "system",
    label: "System",
    mode: "system",
    description: "Follow the operating system light or dark appearance.",
    swatches: {
      background: "#faf9f6",
      surface: "#17191d",
      accent: "#1f1d1a",
      text: "#5c5852",
    },
  },
  {
    id: "light",
    label: "Light",
    mode: "light",
    description: "Warm paper for bright environments.",
    swatches: {
      background: "#faf9f6",
      surface: "#ffffff",
      accent: "#1f1d1a",
      text: "#1f1d1a",
    },
  },
  {
    id: "dark",
    label: "Dark",
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
    description: "Cool navy with a pale blue action color.",
    swatches: {
      background: "#0f1520",
      surface: "#141b28",
      accent: "#8fb4ff",
      text: "#e8eef7",
    },
  },
] as const satisfies readonly ThemeDefinition[];

export type Appearance = ThemeId;
export type AppearanceInput = ThemeId | LegacyAppearance;
export const DEFAULT_THEME_ID: ThemeId = "system";

const key = "openadminos:appearance:v1";
const changed = "openadminos:appearance-changed";
const themeById = new Map(THEMES.map((theme) => [theme.id, theme]));
const systemColorScheme = window.matchMedia("(prefers-color-scheme: dark)");
let current: ThemeId = DEFAULT_THEME_ID;
let resolved: ResolvedThemeId = systemColorScheme.matches ? "dark" : "light";
let error: string | null = null;
let systemListenerAttached = false;

export function normalizeThemeId(value: unknown): ThemeId {
  if (value === "graphite" || value === "dark") return "dark";
  if (value === "off-white" || value === "sand" || value === "light") return "light";
  if (value === "midnight" || value === "system") return value;
  return DEFAULT_THEME_ID;
}

export function getTheme(themeId: ThemeId): ThemeDefinition {
  return themeById.get(themeId) ?? themeById.get(DEFAULT_THEME_ID)!;
}

export function readAppearance(): ThemeId {
  try {
    const stored = localStorage.getItem(key);
    const themeId = normalizeThemeId(stored);
    if (stored !== null && stored !== themeId) localStorage.setItem(key, themeId);
    return themeId;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

function resolveTheme(themeId: ThemeId): ResolvedThemeId {
  if (themeId === "system") return systemColorScheme.matches ? "dark" : "light";
  return themeId;
}

function apply(themeId: ThemeId) {
  const resolvedThemeId = resolveTheme(themeId);
  const theme = getTheme(resolvedThemeId);
  current = themeId;
  resolved = resolvedThemeId;
  document.documentElement.dataset.theme = resolvedThemeId;
  document.documentElement.dataset.appearance = themeId;
  document.documentElement.dataset.mode = theme.mode;
  document.documentElement.style.colorScheme = theme.mode;
  void window.openAdminOS
    ?.setAppearance?.({ preference: themeId, resolvedTheme: resolvedThemeId })
    .catch(() => {
      error = "The window controls could not update. Restart OpenAdminOS to refresh the appearance.";
      window.dispatchEvent(new Event(changed));
    });
}

export function initializeAppearance() {
  apply(readAppearance());
  if (!systemListenerAttached) {
    systemListenerAttached = true;
    systemColorScheme.addEventListener("change", () => {
      if (current !== "system") return;
      apply(current);
      window.dispatchEvent(new Event(changed));
    });
  }
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
  const theme = useSyncExternalStore(subscribe, () => current, () => DEFAULT_THEME_ID);
  const resolvedTheme = useSyncExternalStore(subscribe, () => resolved, () => "light");
  const saveError = useSyncExternalStore(subscribe, () => error, () => null);
  return { theme, resolvedTheme, setAppearance, error: saveError };
}
