import type { GraphCacheResourceKind } from "@openadminos/agent-sdk";
import { canonicalizeDriftValue } from "./canonical.js";

export interface DriftFieldChange {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

const TIMESTAMP_FIELDS = new Set(["lastModifiedDateTime", "modifiedDateTime"]);

export function diffDriftObjects(
  before: unknown,
  after: unknown,
  resource: GraphCacheResourceKind,
): DriftFieldChange[] {
  const canonicalBefore = canonicalizeDriftValue(before, resource);
  const canonicalAfter = canonicalizeDriftValue(after, resource);
  const changes: DriftFieldChange[] = [];
  diffValues(canonicalBefore, canonicalAfter, "", changes);
  return changes;
}

export function isTimestampOnlyChange(changes: readonly DriftFieldChange[]): boolean {
  return changes.length > 0 && changes.every((change) => {
    const field = lastPathSegment(change.path);
    return field ? TIMESTAMP_FIELDS.has(field) : false;
  });
}

export function summarizeDriftChanges(changes: readonly DriftFieldChange[]): string {
  if (changes.length === 0) return "No fields changed.";
  const paths = changes.map((change) => change.path);
  const shown = paths.slice(0, 5);
  const suffix = paths.length > shown.length ? `, +${paths.length - shown.length} more` : "";
  const noun = changes.length === 1 ? "field" : "fields";
  return `${changes.length} ${noun} changed: ${shown.join(", ")}${suffix}`;
}

function diffValues(
  before: unknown,
  after: unknown,
  path: string,
  changes: DriftFieldChange[],
): void {
  if (Object.is(before, after)) return;

  if (Array.isArray(before) && Array.isArray(after)) {
    diffArrays(before, after, path, changes);
    return;
  }

  if (isRecord(before) && isRecord(after)) {
    diffRecords(before, after, path, changes);
    return;
  }

  changes.push({
    path: path || "$",
    kind: "changed",
    before,
    after,
  });
}

function diffRecords(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  path: string,
  changes: DriftFieldChange[],
): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    const nextPath = path ? `${path}.${key}` : key;
    const hasBefore = Object.prototype.hasOwnProperty.call(before, key);
    const hasAfter = Object.prototype.hasOwnProperty.call(after, key);
    if (!hasBefore) {
      changes.push({ path: nextPath, kind: "added", after: after[key] });
    } else if (!hasAfter) {
      changes.push({ path: nextPath, kind: "removed", before: before[key] });
    } else {
      diffValues(before[key], after[key], nextPath, changes);
    }
  }
}

function diffArrays(
  before: unknown[],
  after: unknown[],
  path: string,
  changes: DriftFieldChange[],
): void {
  // v0.3 compares arrays by index; inserting an element can appear as a cascade.
  const count = Math.max(before.length, after.length);
  for (let index = 0; index < count; index += 1) {
    const nextPath = `${path || "$"}[${index}]`;
    if (index >= before.length) {
      changes.push({ path: nextPath, kind: "added", after: after[index] });
    } else if (index >= after.length) {
      changes.push({ path: nextPath, kind: "removed", before: before[index] });
    } else {
      diffValues(before[index], after[index], nextPath, changes);
    }
  }
}

function lastPathSegment(path: string): string | undefined {
  const withoutIndexes = path.replace(/\[\d+\]/g, "");
  const segment = withoutIndexes.split(".").filter(Boolean).pop();
  return segment === "$" ? undefined : segment;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
