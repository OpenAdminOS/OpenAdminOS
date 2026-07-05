import { createHash } from "node:crypto";
import type { GraphCacheResourceKind } from "@openadminos/agent-sdk";
import { DRIFT_IGNORED_FIELDS } from "./tracked-resources.js";

type JsonRecord = Record<string, unknown>;

export function canonicalDriftJson(
  value: unknown,
  resource: GraphCacheResourceKind,
): string {
  return JSON.stringify(canonicalizeDriftValue(value, resource, "")) ?? "null";
}

export function driftContentHash(
  value: unknown,
  resource: GraphCacheResourceKind,
): string {
  return createHash("sha256")
    .update(canonicalDriftJson(value, resource), "utf8")
    .digest("hex");
}

export function canonicalizeDriftValue(
  value: unknown,
  resource: GraphCacheResourceKind,
  path: string = "",
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      canonicalizeDriftValue(entry, resource, `${path}[${index}]`),
    );
  }
  if (!isRecord(value)) return value;

  const out: JsonRecord = {};
  for (const key of Object.keys(value).sort()) {
    const childPath = path ? `${path}.${key}` : key;
    if (isIgnoredField(resource, key, childPath)) continue;
    out[key] = canonicalizeDriftValue(value[key], resource, childPath);
  }
  return out;
}

function isIgnoredField(
  resource: GraphCacheResourceKind,
  key: string,
  path: string,
): boolean {
  if (key.startsWith("@odata.") && key !== "@odata.type") return true;
  return ignoredFieldPaths(resource).some((ignored) => matchesIgnoredPath(ignored, key, path));
}

function ignoredFieldPaths(resource: GraphCacheResourceKind): readonly string[] {
  return [
    ...DRIFT_IGNORED_FIELDS.base,
    ...(DRIFT_IGNORED_FIELDS.byResource[resource] ?? []),
  ];
}

function matchesIgnoredPath(ignored: string, key: string, path: string): boolean {
  return path === ignored || key === ignored || path.endsWith(`.${ignored}`);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
