import { isCommonWord, isGenericTokens, normalizeTokens } from "./mcp-stopwords.js";

/**
 * Tenant values for the MCP egress check: identity strings that must never
 * appear in a query sent to a third-party MCP host.
 */

/**
 * Free-text name keys. A value under one of these is skipped when it is only
 * numbers and stopwords, because names like "Windows 11" or "All Users"
 * identify nothing. givenName and surname count only as a full name.
 */
const TENANT_NAME_KEYS = new Set([
  "displayName", "name", "groupTag", "userDisplayName", "deviceName", "managedDeviceName", "hostName", "mailNickname",
]);

/**
 * Descriptive keys. Their values are often ordinary words ("Sales",
 * "Building 2"), so a value made only of common words is skipped.
 */
const TENANT_LABEL_KEYS = new Set(["companyName", "department", "officeLocation"]);

/**
 * Identifier keys. Their values are always indexed, whatever their words,
 * as is every key ending in Id, ID, Ids or IDs.
 */
const TENANT_IDENTIFIER_KEYS = new Set([
  "id", "userPrincipalName", "mail", "email", "emailAddress", "userName", "onPremisesSamAccountName",
  "serialNumber", "imei", "meid", "wiFiMacAddress", "ethernetMacAddress", "phoneNumber", "mobilePhone",
  "businessPhones", "otherMails", "proxyAddresses", "onPremisesDomainName", "domainName", "iccid", "udid",
]);
const ID_KEY = /I[dD]s?$/;

/**
 * Subtrees that hold property names and change details, not identities:
 * audit events list "Description", "Platform" or "Assignments" under
 * displayName there. They are skipped.
 */
const PROPERTY_NAME_SUBTREES = new Set(["modifiedProperties", "additionalDetails"]);

export type TenantValueKind = "identifier" | "name" | "label";

/**
 * Whether a name or label value can identify something. One that is only
 * numbers and stopwords cannot; a label of only common words cannot. A
 * single word must contain a digit or hyphen, or have 6 or more characters
 * and not be a common word, so "Mark" or "Platform" is not indexed.
 */
function isDistinctiveValue(value: string, tokens: readonly string[], kind: "name" | "label"): boolean {
  if (isGenericTokens(tokens)) return false;
  if (kind === "label" && tokens.every((token) => /^\p{N}+$/u.test(token) || isCommonWord(token))) return false;
  if (tokens.length > 1) return true;
  return /[\p{N}-]/u.test(value) || (tokens[0]!.length >= 6 && !isCommonWord(tokens[0]!));
}

/** Identifier values this long are also matched with separators removed. */
const COMPACT_IDENTIFIER_MIN = 8;

/**
 * Token sequence matcher. Values and queries are normalized the same way
 * (see normalizeTokens). A value matches when its token sequence appears
 * as a contiguous token sequence in the query, so "Mark" never matches
 * "marketplace" and "HR-LAPTOP-07" matches "hr laptop 07". Mostly numeric
 * values (phone numbers, IMEI, serials) also match with separators
 * removed: their digits are indexed as one token, and runs of numeric
 * tokens in the query are joined the same way. Sequences are bucketed by
 * their first token: a query is scanned once and, at each token, compared
 * only with the values starting with that token. Cost depends on the query
 * length and bucket size, not on how many values exist, so there is no cap.
 * Identifiers of 8 or more characters (MAC addresses, serials) are also
 * kept with separators removed and matched against every run of
 * consecutive query tokens joined, so "A1B2C3 D4E5F6" matches
 * "A1:B2:C3:D4:E5:F6".
 */
export class TenantValueIndex {
  private readonly buckets = new Map<string, Map<string, string[]>>();
  private readonly compact = new Set<string>();
  private compactMaxLength = 0;
  private count = 0;

  get size(): number {
    return this.count;
  }

  add(value: unknown, kind: TenantValueKind = "identifier"): void {
    if (typeof value !== "string") return;
    const tokens = normalizeTokens(value);
    if (tokens.length === 0 || tokens.join(" ").length < 3) return;
    if (kind !== "identifier" && !isDistinctiveValue(value, tokens, kind)) return;
    this.insert(tokens);
    const digits = value.replace(/\D/g, "");
    if (digits.length >= 6 && digits.length * 2 > value.replace(/\s/g, "").length) this.insert([digits]);
    const compact = tokens.join("");
    if (kind === "identifier" && compact.length >= COMPACT_IDENTIFIER_MIN) {
      this.compact.add(compact);
      this.compactMaxLength = Math.max(this.compactMaxLength, compact.length);
    }
  }

  addAll(values: Iterable<unknown>, kind: TenantValueKind = "identifier"): void {
    for (const value of values) this.add(value, kind);
  }

  /** Normalized values, for storage; adding them again yields the same index or a stricter one. */
  values(): string[] {
    return [...this.buckets.values()].flatMap((bucket) => [...bucket.keys()]);
  }

  /** Whether any indexed value appears as a token sequence in the text. */
  matches(text: string): boolean {
    const tokens = normalizeTokens(text);
    return this.matchesTokens(tokens) || this.matchesTokens(joinNumericRuns(tokens)) || this.matchesCompact(tokens);
  }

  private matchesCompact(tokens: readonly string[]): boolean {
    if (this.compact.size === 0) return false;
    for (let start = 0; start < tokens.length; start += 1) {
      let joined = "";
      for (let end = start; end < tokens.length; end += 1) {
        joined += tokens[end]!;
        if (joined.length > this.compactMaxLength) break;
        if (this.compact.has(joined)) return true;
      }
    }
    return false;
  }

  private insert(tokens: string[]): void {
    const key = tokens.join(" ");
    let bucket = this.buckets.get(tokens[0]!);
    if (!bucket) this.buckets.set(tokens[0]!, (bucket = new Map()));
    if (!bucket.has(key)) {
      bucket.set(key, tokens);
      this.count += 1;
    }
  }

  private matchesTokens(tokens: readonly string[]): boolean {
    for (let index = 0; index < tokens.length; index += 1) {
      const bucket = this.buckets.get(tokens[index]!);
      if (!bucket) continue;
      for (const sequence of bucket.values()) {
        if (index + sequence.length <= tokens.length && sequence.every((token, offset) => tokens[index + offset] === token)) return true;
      }
    }
    return false;
  }
}

/** "call 555 123 4567" becomes "call 5551234567". */
function joinNumericRuns(tokens: readonly string[]): string[] {
  const joined: string[] = [];
  for (const token of tokens) {
    const previous = joined.at(-1);
    if (previous !== undefined && /^\d+$/.test(previous) && /^\d+$/.test(token)) joined[joined.length - 1] = previous + token;
    else joined.push(token);
  }
  return joined;
}

/** Collects identity values from a tenant tool result or a cached Graph row. */
export function collectTenantValues(value: unknown, into: TenantValueIndex, depth = 0): void {
  if (depth > 12 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectTenantValues(item, into, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.givenName === "string" && typeof record.surname === "string") {
    into.add(`${record.givenName} ${record.surname}`, "name");
  }
  for (const [key, child] of Object.entries(record)) {
    if (PROPERTY_NAME_SUBTREES.has(key)) continue;
    const kind: TenantValueKind | undefined = TENANT_NAME_KEYS.has(key)
      ? "name"
      : TENANT_LABEL_KEYS.has(key)
        ? "label"
        : TENANT_IDENTIFIER_KEYS.has(key) || ID_KEY.test(key) ? "identifier" : undefined;
    if (typeof child === "string") {
      if (kind) into.add(child, kind);
    } else if (kind && Array.isArray(child) && child.every((item) => typeof item === "string")) {
      into.addAll(child, kind);
    } else {
      collectTenantValues(child, into, depth + 1);
    }
  }
}
