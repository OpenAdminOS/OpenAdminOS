/**
 * Words that never identify a tenant object on their own: product
 * vocabulary, common admin words and generic company words. A tenant value
 * made only of these (and numbers) is not indexed for the MCP egress
 * check, so "Windows 11 compliance" or "grant admin consent" stay usable.
 */
export const MCP_STOPWORDS: ReadonlySet<string> = new Set([
  // Product names
  "microsoft", "windows", "intune", "autopilot", "autopatch", "entra", "azure", "defender", "macos",
  "ios", "ipados", "android", "linux", "chromeos", "office", "teams", "outlook", "exchange", "sharepoint",
  "onedrive", "edge", "graph", "m365", "o365", "endpoint", "bitlocker", "filevault", "copilot",
  // Common admin words
  "all", "users", "user", "devices", "device", "admins", "admin", "administrators", "compliance",
  "compliant", "noncompliant", "policy", "policies", "test", "tests", "pilot", "group", "groups",
  "grant", "mark", "members", "member", "guests", "guest", "default", "none", "unknown", "enabled",
  "disabled", "true", "false", "null", "lab", "demo", "dev", "prod", "production", "sandbox", "staging",
  "baseline", "ring", "update", "updates", "security", "settings", "profile", "app", "apps", "the",
  "and", "of", "for", "in", "on", "to", "a", "an", "it",
  // Generic company words
  "practice", "services", "solutions", "consulting", "company", "corp", "corporation", "inc", "ltd",
  "gmbh", "llc", "ag", "plc", "international", "global", "systems", "technologies", "partners",
]);

/**
 * Normalizes text for token matching: compatibility forms folded (NFKC),
 * format characters such as zero-width spaces and combining marks removed,
 * lowercased, and every run of other characters turned into one space.
 */
export function normalizeTokens(text: string): string[] {
  const folded = text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return folded ? folded.split(" ") : [];
}

/** Whether a token sequence is only numbers and stopwords, so it identifies nothing. */
export function isGenericTokens(tokens: readonly string[]): boolean {
  return tokens.every((token) => /^\p{N}+$/u.test(token) || MCP_STOPWORDS.has(token));
}
