import { isGenericTokens, normalizeTokens } from "./mcp-stopwords.js";

/**
 * Tenant values for the MCP egress check: identity strings that must never
 * appear in a query sent to a third-party MCP host.
 */

/**
 * Keys whose string values identify tenant objects. Only these, plus every
 * key ending in Id or Ids, are collected: a walk over all strings would also
 * take operating systems, states and setting values and block ordinary
 * public questions. givenName and surname count only as a full name.
 */
const TENANT_IDENTITY_KEYS = new Set([
  "id", "displayName", "userPrincipalName", "mail", "mailNickname", "email", "emailAddress",
  "userDisplayName", "userName", "onPremisesSamAccountName", "deviceName", "managedDeviceName",
  "hostName", "serialNumber", "imei", "meid", "wiFiMacAddress", "ethernetMacAddress", "phoneNumber",
  "groupTag", "name", "otherMails", "proxyAddresses",
]);
const ID_KEY = /I[dD]s?$/;

/**
 * Token sequence matcher. Values and queries are normalized the same way
 * (see normalizeTokens). A value matches when its token sequence appears
 * as a contiguous token sequence in the query, so "Mark" never matches
 * "marketplace" and "HR-LAPTOP-07" matches "hr laptop 07". Sequences are
 * bucketed by their first token: a query is scanned once and, at each
 * token, compared only with the values starting with that token. Cost
 * depends on the query length and bucket size, not on how many values
 * exist, so there is no cap.
 */
export class TenantValueIndex {
  private readonly buckets = new Map<string, Map<string, string[]>>();
  private count = 0;

  get size(): number {
    return this.count;
  }

  add(value: unknown): void {
    if (typeof value !== "string") return;
    const tokens = normalizeTokens(value);
    if (tokens.length === 0 || tokens.join(" ").length < 3 || isGenericTokens(tokens)) return;
    const key = tokens.join(" ");
    let bucket = this.buckets.get(tokens[0]!);
    if (!bucket) this.buckets.set(tokens[0]!, (bucket = new Map()));
    if (!bucket.has(key)) {
      bucket.set(key, tokens);
      this.count += 1;
    }
  }

  addAll(values: Iterable<unknown>): void {
    for (const value of values) this.add(value);
  }

  /** Normalized values, for storage; adding them again yields the same index. */
  values(): string[] {
    return [...this.buckets.values()].flatMap((bucket) => [...bucket.keys()]);
  }

  /** Whether any indexed value appears as a token sequence in the text. */
  matches(text: string): boolean {
    const tokens = normalizeTokens(text);
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

/** Collects identity values from a tenant tool result or a cached Graph row. */
export function collectTenantValues(value: unknown, into: TenantValueIndex, depth = 0): void {
  if (depth > 12 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectTenantValues(item, into, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.givenName === "string" && typeof record.surname === "string") {
    into.add(`${record.givenName} ${record.surname}`);
  }
  for (const [key, child] of Object.entries(record)) {
    const identity = TENANT_IDENTITY_KEYS.has(key) || ID_KEY.test(key);
    if (typeof child === "string") {
      if (identity) into.add(child);
    } else if (identity && Array.isArray(child) && child.every((item) => typeof item === "string")) {
      into.addAll(child);
    } else {
      collectTenantValues(child, into, depth + 1);
    }
  }
}
