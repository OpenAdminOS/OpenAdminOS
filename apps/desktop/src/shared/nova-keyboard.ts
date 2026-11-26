export const DEFAULT_NOVA_KEY = "Control+Alt+Space";
export const NOVA_KEY_TAKEN = "Nova could not register this shortcut. Another app or the system may be using it. Record a different shortcut or turn it off.";

const modifiers = ["Control", "Alt", "Shift", "Super"];

export const NOVA_KEY_FORMAT = "Use Ctrl, Alt or Super with a letter, number, function key or Space.";
export const NOVA_KEY_RESERVED = "This combination is reserved for editing or system shortcuts. Choose a different combination.";
export const NOVA_KEY_LETTER = "Use at least two modifiers for a letter shortcut, such as Ctrl+Alt+V.";
export const NOVA_PANEL_KEY = "Alt+V";

export function novaKeyProblem(value: string): string | undefined {
  const parts = value.split("+");
  const key = parts.pop() ?? "";
  const has = (modifier: string) => parts.includes(modifier);
  const command = has("Control") || has("Super");
  if ((command && parts.length === 1 && /^[CVXZASQW]$/.test(key)) ||
    (parts.length > 0 && key === "Tab") || (has("Alt") && key === "F4") ||
    (has("Super") && parts.length === 1 && (key === "L" || key === "Space")) ||
    (has("Control") && has("Alt") && key === "Delete")) return NOVA_KEY_RESERVED;
  if (/^[A-Z]$/.test(key) && parts.length < 2) return NOVA_KEY_LETTER;
  return undefined;
}

export function parseNovaKey(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const parts = value.split("+");
  const key = parts.pop();
  if (!key || !/^(?:[A-Z0-9]|Space|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(key)) return undefined;
  if (!parts.some(part => part !== "Shift") || new Set(parts).size !== parts.length || parts.some(part => !modifiers.includes(part))) return undefined;
  return [...modifiers.filter(part => parts.includes(part)), key].join("+");
}

export function recordNovaKey(event: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">) {
  const key = event.code.replace(/^(?:Key|Digit)/, "");
  return [
    ...(event.ctrlKey ? ["Control"] : []),
    ...(event.altKey ? ["Alt"] : []),
    ...(event.shiftKey ? ["Shift"] : []),
    ...(event.metaKey ? ["Super"] : []),
    key,
  ].join("+");
}

export function novaHint(key: string | null | undefined): string {
  return key ? novaKeyLabel(key) : NOVA_PANEL_KEY;
}

export function novaKeyLabel(key: string | null | undefined) {
  if (key === null) return "Off";
  return (key ?? DEFAULT_NOVA_KEY).replace("Control", "Ctrl").replace("Alt", /Mac/.test(navigator.platform) ? "Option" : "Alt").replace("Super", /Mac/.test(navigator.platform) ? "Command" : "Super");
}
