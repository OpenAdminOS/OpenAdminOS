import { FormatError } from "./errors.js";

/** Sorted UTF-16 keys, JSON primitive encoding, no whitespace or implicit conversions. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown, depth: number): string {
    if (depth > 100) throw new FormatError("JSON nesting exceeds 100 levels.");
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || item === null) throw new FormatError("Canonical JSON requires finite JSON values.");
    if (ancestors.has(item)) throw new FormatError("Canonical JSON cannot contain cycles.");
    if (Object.getOwnPropertySymbols(item).length) throw new FormatError("Canonical JSON cannot contain symbol keys.");
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.getOwnPropertyNames(item).length !== item.length + 1) throw new FormatError("Canonical JSON requires dense arrays without extra properties.");
        const values: string[] = [];
        for (let i = 0; i < item.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new FormatError("Canonical JSON requires plain array elements.");
          values.push(encode(descriptor.value, depth + 1));
        }
        return `[${values.join(",")}]`;
      }
      const prototype: unknown = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new FormatError("Canonical JSON requires plain objects.");
      const fields = Object.getOwnPropertyNames(item).sort().map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!("value" in descriptor) || !descriptor.enumerable) throw new FormatError("Canonical JSON requires enumerable data properties.");
        return `${JSON.stringify(key)}:${encode(descriptor.value, depth + 1)}`;
      });
      return `{${fields.join(",")}}`;
    } finally {
      ancestors.delete(item);
    }
  }
  return encode(value, 0);
}

export function domainBytes(type: string, value: unknown): Buffer {
  return Buffer.from(`openadminos-team/v1/${type}\0${canonicalJson(value)}`, "utf8");
}
