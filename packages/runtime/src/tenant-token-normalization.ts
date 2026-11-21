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
 * Ordinary English words that often appear in company, department, office
 * and audit property names. A tenant name word from this list ("Acme
 * Health", "Northern Cloud") blocks a query only as part of the whole name,
 * never alone, so "device health attestation" and "Cloud PC" stay usable.
 * A single-word name or label from this list is not indexed at all.
 */
export const MCP_COMMON_WORDS: ReadonlySet<string> = new Set([
  // Places and directions
  "north", "south", "east", "west", "northern", "southern", "eastern", "western", "central", "coast",
  "coastal", "valley", "river", "lake", "mountain", "city", "county", "state", "national", "regional",
  "local", "metro", "united", "american", "european", "pacific", "atlantic", "world", "earth",
  // Industries and organization words
  "health", "healthcare", "care", "medical", "clinic", "hospital", "pharma", "bank", "banking",
  "financial", "finance", "capital", "insurance", "trust", "fund", "energy", "power", "utilities",
  "water", "food", "foods", "retail", "logistics", "transport", "motors", "auto", "construction",
  "engineering", "manufacturing", "industries", "industrial", "holdings", "enterprises", "ventures",
  "labs", "studio", "studios", "media", "digital", "data", "cloud", "network", "networks", "net",
  "tech", "technology", "software", "school", "schools", "university", "college", "academy",
  "education", "institute", "foundation", "council", "government", "agency", "alliance",
  "association", "society", "community", "family", "life", "home", "example",
  // Departments and offices
  "department", "office", "center", "centre", "management", "marketing", "sales", "support",
  "operations", "accounting", "legal", "research", "development", "human", "resources", "people",
  "staff", "team", "information", "service", "customer", "customers", "building", "floor", "campus",
  "headquarters", "branch", "store", "warehouse", "remote", "field", "main", "executive", "board",
  // Ordinary adjectives
  "new", "first", "one", "best", "smart", "green", "blue", "red", "black", "white", "gold", "silver",
  "star", "sun", "bright", "prime", "pro", "plus", "general", "standard", "total", "advanced",
  "modern", "open", "secure", "safe", "shared", "personal", "corporate", "owned", "active",
  "inactive", "pending", "success", "failure", "error", "warning",
  // Graph property and audit vocabulary
  "description", "platform", "platforms", "assignment", "assignments", "configuration",
  "configurations", "name", "type", "value", "values", "status", "version", "owner", "owners",
  "manager", "location", "locations", "country", "region", "address", "display", "created",
  "modified", "deleted", "date", "time", "account", "accounts", "role", "roles", "permission",
  "permissions", "license", "licenses", "scope", "target", "targets", "source", "category",
  "categories", "property", "properties", "attribute", "attributes", "enrollment", "managed",
  "mobile", "desktop", "laptop", "laptops", "kiosk", "kiosks", "server", "servers", "workstation",
  "phone", "tablet", "printer", "wifi", "vpn", "certificate", "certificates", "password", "email",
  "mail", "rule", "rules", "filter", "filters", "include", "exclude", "included", "excluded",
  "condition", "conditions", "access", "conditional", "identity", "directory", "administrative",
  "unit", "units", "named", "domain", "domains", "attestation",
]);

/** Whether a token is a product, admin or ordinary word that identifies nothing alone. */
export function isCommonWord(token: string): boolean {
  return MCP_STOPWORDS.has(token) || MCP_COMMON_WORDS.has(token);
}

/** Scripts written without spaces between words. Each character is its own token. */
const UNSPACED_SCRIPT = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}])/gu;

/**
 * Normalizes text for token matching: compatibility forms folded (NFKC),
 * format and other default-ignorable characters (zero-width spaces, Hangul
 * fillers) and combining marks removed,
 * lowercased, and every run of other characters turned into one space.
 * Characters of scripts without word spaces become one token each, so a
 * value inside a longer run of such text still matches contiguously.
 */
export function normalizeTokens(text: string): string[] {
  const folded = text
    .normalize("NFKC")
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(UNSPACED_SCRIPT, " $1 ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return folded ? folded.split(" ") : [];
}

/** Whether a token sequence is only numbers and stopwords, so it identifies nothing. */
export function isGenericTokens(tokens: readonly string[]): boolean {
  return tokens.every((token) => /^\p{N}+$/u.test(token) || MCP_STOPWORDS.has(token));
}

/**
 * Whether any word mixes Latin letters with Cyrillic or Greek ones, as in
 * "Cоntoso" with a Cyrillic o. Such look-alike spellings slip past token
 * matching, so a query that contains one is treated as suspicious.
 */
export function hasMixedScriptToken(text: string): boolean {
  return normalizeTokens(text).some((token) => /\p{Script=Latin}/u.test(token) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(token));
}
