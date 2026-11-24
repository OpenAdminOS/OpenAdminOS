import type { GraphCachePageRequest, GraphCacheResourceKind } from "@openadminos/agent-sdk";
import { GRAPH_CACHE_RESOURCES } from "./planner.js";

function boundedString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`Invalid cache ${name}.`);
  }
  return value;
}

function cacheRequest(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A cache page request is required.");
  }
  return value as Record<string, unknown>;
}

function cacheTarget(input: Record<string, unknown>): Pick<GraphCachePageRequest, "tenantId" | "resource"> {
  const tenantId = boundedString(input.tenantId, "tenantId", 256);
  const resource = boundedString(input.resource, "resource", 128);
  if (!GRAPH_CACHE_RESOURCES.some((definition) => definition.resource === resource)) throw new Error("Unknown cache resource.");
  return { tenantId, resource: resource as GraphCacheResourceKind };
}

export function validateCachePage(value: unknown): GraphCachePageRequest {
  const input = cacheRequest(value);
  const target = cacheTarget(input);
  const { offset, limit, search } = input;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 ||
      typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Invalid cache page range.");
  }
  if (search !== undefined && (typeof search !== "string" || search.length > 256)) {
    throw new Error("Invalid cache search.");
  }
  return { ...target, offset, limit, ...(search === undefined ? {} : { search }) };
}

export function validateCacheDetail(value: unknown): import("@openadminos/agent-sdk").GraphCacheDetailRequest {
  const input = cacheRequest(value);
  return { ...cacheTarget(input), id: boundedString(input.id, "row ID", 2048) };
}
