import type { GraphCacheResourceKind } from "@openadminos/agent-sdk";
import type { TemplateInterpolation } from "@openadminos/runtime/data-classification";
import { escapeTenantDataBody } from "@openadminos/runtime";
import { cacheBreakdownEvidence, type BreakdownClasses, type GraphAggregate } from "./cache-breakdown-classification.js";

export type AnswerPackAggregates = Partial<Record<GraphCacheResourceKind, GraphAggregate>>;
const countFields = new Set([
  "cachedRows", "tenantTotal", "pages", "selectedRows", "includedSampleRows", "omittedCachedRows", "omittedBreakdownBuckets",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Resolve derived bucket spellings against the actual compact JSON sent to the provider. */
export function* traceAnswerPack(
  evidence: Record<string, unknown>, body: string, offset: number, aggregates?: AnswerPackAggregates,
): Generator<TemplateInterpolation | undefined, boolean> {
  let cursor = 0;
  const consume = (text: string) => {
    if (!body.startsWith(text, cursor)) return false;
    cursor += text.length;
    return true;
  };
  const serialize = (value: unknown) => escapeTenantDataBody(JSON.stringify(value) ?? "null");
  const entry = (start: number, end: number, classification?: TemplateInterpolation["classification"]): TemplateInterpolation =>
    ({ start: offset + start, end: offset + end, key: "", ...(classification ? { classification } : { incomplete: true }) });

  function* breakdowns(value: unknown, classes: BreakdownClasses | undefined): Generator<TemplateInterpolation | undefined, boolean> {
    const fields = record(value);
    if (!fields) return consume(serialize(value));
    if (!consume("{")) return false;
    let separator = "";
    for (const [field, buckets] of Object.entries(fields)) {
      if (!consume(separator) || !consume(serialize(field)) || !consume(":")) return false;
      separator = ",";
      const values = record(buckets);
      if (!values) {
        const start = cursor;
        if (!consume(serialize(buckets))) return false;
        yield entry(start, cursor);
        continue;
      }
      if (!consume("{")) return false;
      let bucketSeparator = "";
      for (const [bucket, count] of Object.entries(values)) {
        if (!consume(bucketSeparator)) return false;
        bucketSeparator = ",";
        const start = cursor + 1;
        if (!consume(serialize(bucket))) return false;
        const end = cursor - 1;
        const classification = classes?.get(field)?.get(bucket);
        yield entry(start, end, classification);
        if (!consume(":")) return false;
        const countStart = cursor;
        if (!consume(serialize(count))) return false;
        yield entry(countStart, cursor, classification);
      }
      if (!consume("}")) return false;
      yield;
    }
    return consume("}");
  }

  function* blocks(value: unknown, findings: boolean): Generator<TemplateInterpolation | undefined, boolean> {
    if (!Array.isArray(value) || !consume("[")) return false;
    for (const [i, block] of value.entries()) {
      if (i && !consume(",")) return false;
      const fields = record(block);
      if (!fields || !consume("{")) return false;
      const resource = fields.resource;
      const aggregate = typeof resource === "string" && fields.breakdownsCoverAllCachedRows === true &&
        aggregates && Object.hasOwn(aggregates, resource) ? aggregates[resource as GraphCacheResourceKind] : undefined;
      let separator = "";
      for (const [field, child] of Object.entries(fields)) {
        if (!consume(separator) || !consume(serialize(field)) || !consume(":")) return false;
        separator = ",";
        if (field === "breakdowns") {
          const loadClasses = aggregate && cacheBreakdownEvidence.get(aggregate);
          const classes = loadClasses ? yield* loadClasses() : undefined;
          if (!(yield* breakdowns(child, classes))) return false;
          continue;
        }
        const start = cursor;
        if (!consume(serialize(child))) return false;
        if (countFields.has(field) || findings && (field === "matchingRows" || field === "evaluatedSelectedRows")) {
          yield entry(start, cursor);
        } else yield;
      }
      if (!consume("}")) return false;
    }
    return consume("]");
  }

  if (!consume("{")) return false;
  let separator = "";
  for (const [field, value] of Object.entries(evidence)) {
    if (!consume(separator) || !consume(serialize(field)) || !consume(":")) return false;
    separator = ",";
    if (field === "resources" || field === "deterministicFindings") {
      if (!(yield* blocks(value, field === "deterministicFindings"))) return false;
    } else if (!consume(serialize(value))) return false;
    yield;
  }
  return consume("}") && cursor === body.length;
}


/** Comparison rows and rollups carry counts without per-row evidence. */
export function* traceMultiTenantCounts(body: string, offset: number): Generator<TemplateInterpolation, boolean> {
  const counts = /(?<!\\)"(?:compliant|nonCompliant|unknown|windowsDevices|tenantsScanned|failedTenants|skippedTenants|staleTenants)"\s*:\s*(\d+)/g;
  for (const match of body.matchAll(counts)) {
    const end = offset + match.index + match[0].length;
    const start = end - match[1]!.length;
    yield { start, end, key: "", incomplete: true };
  }
  return true;
}
