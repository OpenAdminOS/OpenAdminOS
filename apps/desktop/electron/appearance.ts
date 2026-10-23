export type NativeThemeId = "light" | "dark" | "midnight";
export type NativeThemePreference = "system" | NativeThemeId;
export type NativeThemeMode = "dark" | "light";

export interface NativeThemeColors {
  mode: NativeThemeMode;
  background: string;
  textMuted: string;
}

export interface NativeAppearance {
  preference: NativeThemePreference;
  resolvedTheme: NativeThemeId;
}

// These native chrome colors must match --color-bg and --color-text-muted in globals.css.
export const NATIVE_THEME_COLORS = {
  light: { mode: "light", background: "#faf9f6", textMuted: "#6f6a63" },
  dark: { mode: "dark", background: "#17191d", textMuted: "#98a0ab" },
  midnight: { mode: "dark", background: "#0f1520", textMuted: "#93a2ba" },
} as const satisfies Record<NativeThemeId, NativeThemeColors>;

export const DEFAULT_NATIVE_THEME_ID = "light" as const satisfies NativeThemeId;

export function parseNativeTheme(value: unknown): NativeThemeId {
  if (value === "graphite" || value === "dark") return "dark";
  if (value === "off-white" || value === "sand" || value === "light") return "light";
  if (value === "midnight") return value;
  throw new Error("Choose System, Light, Dark, or Midnight appearance.");
}

export function parseNativeAppearance(
  value: unknown,
  systemTheme: Exclude<NativeThemeId, "midnight"> = DEFAULT_NATIVE_THEME_ID,
): NativeAppearance {
  if (value === "system") {
    return { preference: "system", resolvedTheme: systemTheme };
  }
  if (typeof value === "object" && value !== null) {
    const preference = Reflect.get(value, "preference");
    const resolvedTheme = parseNativeTheme(Reflect.get(value, "resolvedTheme"));
    if (preference === "system") {
      if (resolvedTheme === "midnight") {
        throw new Error("System appearance must resolve to Light or Dark.");
      }
      return { preference, resolvedTheme };
    }
    const normalizedPreference = parseNativeTheme(preference);
    if (normalizedPreference !== resolvedTheme) {
      throw new Error("Resolved appearance must match the saved preference.");
    }
    return { preference: normalizedPreference, resolvedTheme };
  }
  const resolvedTheme = parseNativeTheme(value);
  return { preference: resolvedTheme, resolvedTheme };
}
