import { canonicalJson } from "./canonical.js";
import { FormatError } from "./errors.js";

export function record(value: unknown, fields: string[], label: string): asserts value is Record<string, unknown> {
  canonicalJson(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FormatError(`${label} must be an object.`);
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) throw new FormatError(`${label} has missing or unsupported fields.`);
  if ((value as Record<string, unknown>).v !== 1) throw new FormatError(`${label} must use format version 1.`);
}

export function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.length || value.trim() !== value) throw new FormatError(`${label} must be a nonempty string without surrounding whitespace.`);
}

export function timestamp(value: unknown, label: string): void {
  text(value, label);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) throw new FormatError(`${label} must be a UTC ISO timestamp with milliseconds.`);
}

export function integer(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new FormatError(`${label} must be a nonnegative safe integer.`);
}

export function bytes(value: unknown, length: number | undefined, label: string): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value)) throw new FormatError(`${label} must be unpadded base64url.`);
  const result = Buffer.from(value, "base64url");
  if (result.toString("base64url") !== value || (length !== undefined && result.length !== length)) throw new FormatError(`${label} has an invalid encoding or length.`);
  return result;
}

export function sortedIds(value: unknown, label: string, allowEmpty: boolean): asserts value is string[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length)) throw new FormatError(`${label} must be ${allowEmpty ? "an" : "a nonempty"} array.`);
  let previous: string | undefined;
  for (const id of value) {
    text(id, label);
    if (previous !== undefined && id <= previous) throw new FormatError(`${label} must be sorted and contain no duplicates.`);
    previous = id;
  }
}
