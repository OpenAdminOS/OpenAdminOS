/**
 * Tenant values for the MCP egress check: identity strings that must never
 * appear in a query sent to a third-party MCP host.
 */

/**
 * Keys whose string values identify tenant objects. Only these, plus every
 * key ending in Id, are collected: a walk over all strings would also take
 * operating systems, states and setting values and block ordinary public
 * questions.
 */
const TENANT_IDENTITY_KEYS = new Set([
  "id", "displayName", "userPrincipalName", "mail", "mailNickname", "email", "emailAddress",
  "userDisplayName", "userName", "givenName", "surname", "onPremisesSamAccountName",
  "deviceName", "managedDeviceName", "hostName", "serialNumber", "imei", "meid",
  "wiFiMacAddress", "ethernetMacAddress", "phoneNumber", "groupTag", "name",
]);

/** Values too common to identify anything; they stay usable in public questions. */
const COMMON_VALUES = new Set([
  "true", "false", "null", "none", "unknown", "default", "enabled", "disabled", "compliant",
  "noncompliant", "windows", "macos", "android", "linux", "ipados", "all users", "all devices",
  "microsoft", "intune", "entra", "azure", "member", "guest", "user", "device", "group",
]);

const MIN_LENGTH = 4;

/**
 * Substring matcher over normalized values. Values are bucketed by their
 * first four characters; a text is scanned once, and at each position only
 * the values sharing that four-character prefix are compared. Cost grows
 * with text length and bucket size, not with the total number of values,
 * so no cap is needed.
 */
export class TenantValueIndex {
  private readonly buckets = new Map<string, Set<string>>();
  private count = 0;

  get size(): number {
    return this.count;
  }

  add(value: unknown): void {
    if (typeof value !== "string") return;
    const normalized = value.trim().toLowerCase();
    if (normalized.length < MIN_LENGTH || COMMON_VALUES.has(normalized)) return;
    const key = normalized.slice(0, MIN_LENGTH);
    let bucket = this.buckets.get(key);
    if (!bucket) this.buckets.set(key, (bucket = new Set()));
    if (!bucket.has(normalized)) {
      bucket.add(normalized);
      this.count += 1;
    }
  }

  addAll(values: Iterable<unknown>): void {
    for (const value of values) this.add(value);
  }

  values(): string[] {
    return [...this.buckets.values()].flatMap((bucket) => [...bucket]);
  }

  /** Whether any indexed value occurs in the lowercased text. */
  matches(text: string): boolean {
    for (let index = 0; index + MIN_LENGTH <= text.length; index += 1) {
      const bucket = this.buckets.get(text.slice(index, index + MIN_LENGTH));
      if (!bucket) continue;
      for (const value of bucket) if (text.startsWith(value, index)) return true;
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
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === "string") {
      if (TENANT_IDENTITY_KEYS.has(key) || /Id$/.test(key)) into.add(child);
    } else {
      collectTenantValues(child, into, depth + 1);
    }
  }
}
