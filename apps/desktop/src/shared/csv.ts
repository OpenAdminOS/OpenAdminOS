/**
 * One CSV cell. A spreadsheet runs a cell as a formula when its first
 * character, or its first after leading whitespace, is =, +, - or @, or
 * when it starts with a tab or carriage return; such a cell gets a leading
 * apostrophe so it opens as text. Cells with a quote, comma or line break
 * are quoted.
 */
export function csvCell(value: unknown): string {
  const raw = String(value ?? "");
  const text = /^[\t\r]|^\s*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
}
