import type { GraphCachePageRequest, GraphCacheResourceKind } from "@openadminos/agent-sdk";
import { GRAPH_CACHE_RESOURCES } from "./planner.js";

function boundedString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`Invalid cache ${name}.`);
  }
  return value;
}

export function validateCachePage(value: unknown): GraphCachePageRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A cache page request is required.");
  }
  const input = value as Record<string, unknown>;
  const tenantId = boundedString(input.tenantId, "tenantId", 256);
  const resource = boundedString(input.resource, "resource", 128);
  if (!GRAPH_CACHE_RESOURCES.some((definition) => definition.resource === resource)) throw new Error("Unknown cache resource.");
  const { offset, limit, search } = input;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 ||
      typeof limit !== "number" || !Number.isSafeInteger(limit)) {
    throw new Error("Invalid cache page range.");
  }
  if (search !== undefined && (typeof search !== "string" || search.length > 256)) {
    throw new Error("Invalid cache search.");
  }
  return { tenantId, resource: resource as GraphCacheResourceKind, offset, limit, ...(search === undefined ? {} : { search }) };
}
