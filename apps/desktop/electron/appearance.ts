export type NativeThemeId = "graphite" | "midnight" | "off-white" | "sand";
export type NativeThemeMode = "dark" | "light";

export interface NativeThemeColors {
  mode: NativeThemeMode;
  background: string;
  textMuted: string;
}

// These native chrome colors must match --color-bg and --color-text-muted in globals.css.
export const NATIVE_THEME_COLORS = {
  graphite: { mode: "dark", background: "#17191d", textMuted: "#a8b0bb" },
  midnight: { mode: "dark", background: "#0f1520", textMuted: "#93a2ba" },
  "off-white": { mode: "light", background: "#f4f5f7", textMuted: "#535e6c" },
  sand: { mode: "light", background: "#f6f1ea", textMuted: "#6b5a4b" },
} as const satisfies Record<NativeThemeId, NativeThemeColors>;

export const DEFAULT_NATIVE_THEME_ID: NativeThemeId = "midnight";

export function parseNativeTheme(value: unknown): NativeThemeId {
  if (value === "dark") return "graphite";
  if (value === "light") return "off-white";
  if (typeof value === "string" && Object.hasOwn(NATIVE_THEME_COLORS, value)) {
    return value as NativeThemeId;
  }
  throw new Error("Choose Graphite, Midnight, Off-white, or Sand appearance.");
}
