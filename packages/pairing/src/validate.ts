const CONTROL = /[\u0000-\u001f\u007f]/;
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

/** An id or a name: 1 to 200 characters, no control characters, no surrounding spaces. */
export function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200 && !CONTROL.test(value) && value.trim() === value;
}

/** A Microsoft Entra tenant id in lower case, so a signed record has one spelling. */
export function isTenantId(value: unknown): value is string {
  return typeof value === "string" && TENANT_ID.test(value);
}

/** 64 lowercase hex characters. */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

/** An instant in the exact form `Date.prototype.toISOString` writes. */
export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}

export function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Whether `value` is JSON that canonical JSON encodes without loss:
 * no undefined, functions, symbols, bigints, non-finite numbers, class
 * instances (Date included) or cycles.
 */
export function isJsonValue(value: unknown, seen: Set<object> = new Set()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, seen));
    if (!isPlainObject(value)) return false;
    return Object.values(value).every((entry) => isJsonValue(entry, seen));
  } finally {
    seen.delete(value);
  }
}

/** The keys of `value` that are not in `allowed`, and the allowed keys it lacks. */
export function keyProblems(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) return `unknown field ${extra.map((key) => JSON.stringify(key)).join(", ")}`;
  const missing = allowed.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length > 0) return `missing field ${missing.join(", ")}`;
  return undefined;
}
