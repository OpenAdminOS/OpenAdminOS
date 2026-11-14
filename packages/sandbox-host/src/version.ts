import { readFileSync } from "node:fs";

let cached: string | undefined;

/** The host package's version, from its package.json (one folder above src and dist). */
export function hostVersion(): string {
  if (cached) return cached;
  try {
    const parsed = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    cached = typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    cached = "unknown";
  }
  return cached;
}
