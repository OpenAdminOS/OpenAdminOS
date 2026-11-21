import { maxDataClass } from "@openadminos/agent-sdk";
import { decodeCacheRowClassification, type TemplateInterpolation } from "@openadminos/runtime/data-classification";

export type BreakdownClass = NonNullable<TemplateInterpolation["classification"]>;
export type BreakdownClasses = Map<string, Map<string, BreakdownClass>>;
export type GraphAggregate = {
  total: number;
  breakdowns: Record<string, Record<string, number>>;
};
export const cacheBreakdownEvidence = new WeakMap<GraphAggregate, () => Generator<undefined, BreakdownClasses>>();

export function cacheBucketItems(value: string | number): Array<{ key: string; index?: string }> {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("[")) return trimmed.split(",").map(part => part.trim()).filter(Boolean).map(key => ({ key }));
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.flatMap((item, i) =>
        typeof item === "string" || typeof item === "number" || typeof item === "boolean"
          ? [{ key: String(item), index: String(i) }] : []);
    } catch { /* Use the original spelling when SQLite did not return an array. */ }
  }
  return [{ key: String(value) }];
}

export type BucketObservation = { count: number; classification?: BreakdownClass; incomplete?: true };

export function addBreakdownObservations(
  observations: Map<string, Map<string, BucketObservation>>, source: string,
  dimensions: readonly string[], arrayFields: ReadonlySet<string>, values: Readonly<Record<string, string | number | null>>,
  encoded: string | null | undefined,
): void {
  const decoded = decodeCacheRowClassification(encoded);
  // Index complete stored paths once per row, preserving array coordinates.
  const paths = decoded?.[1] === false ? new Map(decoded[2].map(([path, , kind, maskRole]) =>
    [JSON.stringify(path), { kind, source, ...(maskRole ? { maskRole } : {}) }])) : undefined;
  for (const field of dimensions) {
    const value = values[field];
    if (typeof value !== "string" && typeof value !== "number") continue;
    const path = field === "status.errorCode" ? ["status", "errorCode"] : [field];
    const items = arrayFields.has(field) ? cacheBucketItems(value) : [{ key: String(value) }];
    const buckets = observations.get(field) ?? new Map<string, BucketObservation>();
    observations.set(field, buckets);
    for (const { key, index } of items) {
      const classification = paths?.get(JSON.stringify(index === undefined ? path : [...path, index]));
      const bucket = buckets.get(key) ?? { count: 0 };
      bucket.count++;
      if (!classification) bucket.incomplete = true;
      else if (!bucket.classification || maxDataClass(bucket.classification.kind, classification.kind) === classification.kind &&
        (bucket.classification.kind !== classification.kind || classification.maskRole === "nameOrIdentifier")) {
        bucket.classification = classification;
      }
      buckets.set(key, bucket);
    }
  }
}

export function verifiedBreakdownClasses(
  breakdowns: GraphAggregate["breakdowns"], observations: ReadonlyMap<string, ReadonlyMap<string, BucketObservation>>,
): BreakdownClasses {
  const result: BreakdownClasses = new Map();
  for (const [field, buckets] of Object.entries(breakdowns)) {
    const verified = new Map<string, BreakdownClass>();
    for (const [key, count] of Object.entries(buckets)) {
      const observed = observations.get(field)?.get(key);
      if (observed?.classification && !observed.incomplete && observed.count === count) verified.set(key, observed.classification);
    }
    result.set(field, verified);
  }
  return result;
}
