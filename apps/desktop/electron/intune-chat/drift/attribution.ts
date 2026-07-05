import type {
  DriftAttribution,
  GraphCacheResourceKind,
  GraphCacheResourceStatus,
} from "@openadminos/agent-sdk";

const WINDOW_START_SKEW_MS = 5 * 60 * 1000;

export interface CachedAuditRow {
  row: unknown;
  refreshedAt?: string;
}

export interface DriftAuditCache {
  intuneAuditEvents: readonly CachedAuditRow[];
  directoryAudits: readonly CachedAuditRow[];
  statuses: Partial<Record<"intuneAuditEvents" | "directoryAudits", GraphCacheResourceStatus>>;
}

export interface DriftAttributionInput {
  resource: GraphCacheResourceKind;
  graphId: string;
  previousCapturedAt?: string;
  capturedAt: string;
  auditCache: DriftAuditCache;
}

interface AttributionCandidate {
  activityDateTime: string;
  activityMs: number;
  attribution: Omit<DriftAttribution, "alsoMatched"> & { status: "matched" };
}

export function attributeDriftChange(input: DriftAttributionInput): DriftAttribution {
  const endMs = Date.parse(input.capturedAt);
  const previousMs = input.previousCapturedAt
    ? Date.parse(input.previousCapturedAt)
    : Number.NaN;
  if (!Number.isFinite(endMs) || !Number.isFinite(previousMs)) {
    return { status: "unknown" };
  }
  const startMs = previousMs - WINDOW_START_SKEW_MS;

  const intuneMatches = input.auditCache.intuneAuditEvents
    .map((row) => intuneAuditCandidate(row.row, input.graphId, startMs, endMs))
    .filter((candidate): candidate is AttributionCandidate => Boolean(candidate));
  if (intuneMatches.length > 0) {
    return closestAttribution(intuneMatches, endMs);
  }

  const directoryMatches = input.auditCache.directoryAudits
    .map((row) => directoryAuditCandidate(row.row, input.graphId, startMs, endMs))
    .filter((candidate): candidate is AttributionCandidate => Boolean(candidate));
  if (directoryMatches.length > 0) {
    return closestAttribution(directoryMatches, endMs);
  }

  if (auditCacheStale(input.auditCache, startMs, endMs)) {
    return { status: "unknown", reason: "audit-cache-stale" };
  }

  return { status: "unknown" };
}

function intuneAuditCandidate(
  row: unknown,
  graphId: string,
  startMs: number,
  endMs: number,
): AttributionCandidate | undefined {
  if (!isRecord(row)) return undefined;
  const activityDateTime = stringValue(row.activityDateTime);
  const activityMs = parseTimestamp(activityDateTime);
  if (
    activityDateTime === undefined ||
    activityMs === undefined ||
    activityMs < startMs ||
    activityMs > endMs
  ) {
    return undefined;
  }
  const resources = Array.isArray(row.resources) ? row.resources : [];
  const matched = resources.some((resource) => {
    if (!isRecord(resource)) return false;
    return stringValue(resource.resourceId) === graphId;
  });
  if (!matched) return undefined;

  const actor = isRecord(row.actor) ? row.actor : undefined;
  const attribution: AttributionCandidate["attribution"] = {
    status: "matched",
    source: "intuneAudit",
    activityDateTime,
  };
  const activity =
    stringValue(row.displayName) ??
    stringValue(row.activityType) ??
    stringValue(row.activityOperationType);
  if (activity) attribution.activity = activity;
  const actorValue = compactActor({
    userPrincipalName: actor ? stringValue(actor.userPrincipalName) : undefined,
    appDisplayName: actor
      ? stringValue(actor.applicationDisplayName)
      : undefined,
    actorType: actor ? stringValue(actor.auditActorType) : undefined,
  });
  if (actorValue) attribution.actor = actorValue;
  return {
    activityDateTime,
    activityMs,
    attribution,
  };
}

function directoryAuditCandidate(
  row: unknown,
  graphId: string,
  startMs: number,
  endMs: number,
): AttributionCandidate | undefined {
  if (!isRecord(row)) return undefined;
  const activityDateTime = stringValue(row.activityDateTime);
  const activityMs = parseTimestamp(activityDateTime);
  if (
    activityDateTime === undefined ||
    activityMs === undefined ||
    activityMs < startMs ||
    activityMs > endMs
  ) {
    return undefined;
  }
  const targetResources = Array.isArray(row.targetResources)
    ? row.targetResources
    : [];
  const matched = targetResources.some((resource) => {
    if (!isRecord(resource)) return false;
    return stringValue(resource.id) === graphId;
  });
  if (!matched) return undefined;

  const initiatedBy = isRecord(row.initiatedBy) ? row.initiatedBy : undefined;
  const user = initiatedBy && isRecord(initiatedBy.user) ? initiatedBy.user : undefined;
  const app = initiatedBy && isRecord(initiatedBy.app) ? initiatedBy.app : undefined;
  const attribution: AttributionCandidate["attribution"] = {
    status: "matched",
    source: "directoryAudit",
    activityDateTime,
  };
  const activity =
    stringValue(row.activityDisplayName) ??
    stringValue(row.operationType) ??
    stringValue(row.category);
  if (activity) attribution.activity = activity;
  const actor = compactActor({
    userPrincipalName: user ? stringValue(user.userPrincipalName) : undefined,
    appDisplayName: app ? stringValue(app.displayName) : undefined,
    actorType: user ? "user" : app ? "app" : undefined,
  });
  if (actor) attribution.actor = actor;
  return {
    activityDateTime,
    activityMs,
    attribution,
  };
}

function closestAttribution(
  matches: AttributionCandidate[],
  endMs: number,
): DriftAttribution {
  const [selected] = [...matches].sort((left, right) => {
    const leftDistance = Math.abs(endMs - left.activityMs);
    const rightDistance = Math.abs(endMs - right.activityMs);
    if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    return right.activityMs - left.activityMs;
  });
  if (!selected) return { status: "unknown" };
  return {
    ...selected.attribution,
    ...(matches.length > 1 ? { alsoMatched: matches.length - 1 } : {}),
  };
}

function auditCacheStale(
  cache: DriftAuditCache,
  startMs: number,
  endMs: number,
): boolean {
  return (
    auditSourceStale(
      cache.intuneAuditEvents,
      cache.statuses.intuneAuditEvents,
      intuneAuditActivityMs,
      startMs,
      endMs,
    ) ||
    auditSourceStale(
      cache.directoryAudits,
      cache.statuses.directoryAudits,
      directoryAuditActivityMs,
      startMs,
      endMs,
    )
  );
}

function auditSourceStale(
  rows: readonly CachedAuditRow[],
  status: GraphCacheResourceStatus | undefined,
  activityMsForRow: (row: unknown) => number | undefined,
  startMs: number,
  endMs: number,
): boolean {
  if (!status?.refreshedAt) return true;
  const newestActivityMs = rows.reduce<number | undefined>((newest, row) => {
    const value = activityMsForRow(row.row);
    if (value === undefined) return newest;
    return newest === undefined ? value : Math.max(newest, value);
  }, undefined);
  if (newestActivityMs !== undefined) {
    return newestActivityMs < startMs;
  }
  const refreshedMs = parseTimestamp(status.refreshedAt);
  return refreshedMs === undefined || refreshedMs < endMs;
}

function intuneAuditActivityMs(row: unknown): number | undefined {
  return isRecord(row) ? parseTimestamp(stringValue(row.activityDateTime)) : undefined;
}

function directoryAuditActivityMs(row: unknown): number | undefined {
  return isRecord(row) ? parseTimestamp(stringValue(row.activityDateTime)) : undefined;
}

function compactActor(input: {
  userPrincipalName: string | undefined;
  appDisplayName: string | undefined;
  actorType: string | undefined;
}): DriftAttribution["actor"] | undefined {
  const actor = {
    ...(input.userPrincipalName ? { userPrincipalName: input.userPrincipalName } : {}),
    ...(input.appDisplayName ? { appDisplayName: input.appDisplayName } : {}),
    ...(input.actorType ? { actorType: input.actorType } : {}),
  };
  return Object.keys(actor).length > 0 ? actor : undefined;
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
