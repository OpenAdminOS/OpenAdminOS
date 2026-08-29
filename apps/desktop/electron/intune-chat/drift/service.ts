import type {
  CreateDriftBaselineInput,
  DriftBaseline,
  DriftBaselineDriftEntry,
  DriftBaselineDriftInput,
  DriftBaselineDriftResult,
  DriftBaselineResourceDrift,
  DriftEntryDetail,
  DriftEntryDetailInput,
  DriftFieldChange,
  DriftObjectHistoryInput,
  DriftObjectHistoryResult,
  DriftStatus,
  DriftTimelineEntry,
  DriftTimelineInput,
  DriftTimelineResult,
  GraphCacheResourceKind,
  GraphCacheResourceStatus,
  ListDriftBaselinesInput,
  RenameDriftBaselineInput,
  RetireDriftBaselineInput,
  TenantRecord,
} from "@openadminos/agent-sdk";
import { definitionForResource } from "../planner.js";
import type {
  CachedGraphResourceRecord,
  DriftBaselineChangeRecord,
  DriftBaselineRecord,
  DriftObjectVersionRecord,
  DriftResourceStatsRecord,
  DriftSnapshotChangeRecord,
  DriftSnapshotRecord,
} from "../sqlite-store.js";
import { attributeDriftChange, type DriftAuditCache } from "./attribution.js";
import {
  diffDriftObjects,
  isTimestampOnlyChange,
  summarizeDriftChanges,
} from "./diff.js";
import { DRIFT_TRACKED_RESOURCES } from "./tracked-resources.js";

const DEFAULT_TIMELINE_LIMIT = 200;
const MAX_TIMELINE_LIMIT = 5_000;
const MAX_SNAPSHOTS_PER_RESOURCE = 5_000;
const DETAIL_RAW_LIMIT_BYTES = 48 * 1024;
const TRACKED_RESOURCES = [...DRIFT_TRACKED_RESOURCES];
const INTUNE_AUDIT_EVENTS_RESOURCE: GraphCacheResourceKind = "intuneAuditEvents";

export interface DriftPersistedState {
  tenants: TenantRecord[];
  activeTenantId?: string;
}

export interface DriftServiceHost {
  read(): Promise<DriftPersistedState>;
  resolveTenant(persisted: DriftPersistedState, tenantId?: string): TenantRecord;
  listDriftSnapshots(
    tenantId: string,
    options?: {
      resource?: GraphCacheResourceKind;
      from?: string;
      to?: string;
      limit?: number;
    },
  ): DriftSnapshotRecord[];
  getDriftSnapshot(tenantId: string, snapshotId: string): DriftSnapshotRecord | undefined;
  listDriftChangesForSnapshot(
    tenantId: string,
    snapshotId: string,
  ): DriftSnapshotChangeRecord[];
  getDriftObjectHistory(
    tenantId: string,
    resource: GraphCacheResourceKind,
    graphId: string,
    options?: { limit?: number },
  ): DriftObjectVersionRecord[];
  listCachedGraphResourceRows(input: {
    tenantId: string;
    resource: GraphCacheResourceKind;
    limit?: number;
  }): CachedGraphResourceRecord[];
  getGraphCacheStatus(
    tenantId: string,
    resources: readonly GraphCacheResourceKind[],
  ): GraphCacheResourceStatus[];
  getDriftResourceStats(
    tenantId: string,
    resources: readonly GraphCacheResourceKind[],
  ): DriftResourceStatsRecord[];
  createDriftBaseline(input: {
    tenantId: string;
    name: string;
    now: string;
    resources: readonly GraphCacheResourceKind[];
  }): DriftBaselineRecord;
  listDriftBaselines(tenantId: string): DriftBaselineRecord[];
  getDriftBaseline(
    tenantId: string,
    baselineId: string,
  ): DriftBaselineRecord | undefined;
  getActiveDriftBaseline(tenantId: string): DriftBaselineRecord | undefined;
  renameDriftBaseline(
    tenantId: string,
    baselineId: string,
    name: string,
  ): DriftBaselineRecord;
  retireDriftBaseline(
    tenantId: string,
    baselineId: string,
    now: string,
  ): DriftBaselineRecord;
  listDriftBaselineChanges(input: {
    tenantId: string;
    baselineId: string;
    resources: readonly GraphCacheResourceKind[];
  }): DriftBaselineChangeRecord[];
}

export class DriftService {
  constructor(private readonly host: DriftServiceHost) {}

  async getDriftTimeline(input: DriftTimelineInput): Promise<DriftTimelineResult> {
    const tenant = await this.resolveTenant(input.tenantId);
    const limit = normalizeLimit(input.limit, DEFAULT_TIMELINE_LIMIT);
    const resources = normalizeTrackedResources(input.resources);
    const previousBySnapshotId = this.previousSnapshotMap(tenant.id, resources);
    const auditCache = this.readAuditCache(tenant.id);
    const entries: DriftTimelineEntry[] = [];

    let historyTruncated = false;
    const snapshots = resources.flatMap((resource) => {
      const resourceSnapshots = this.host.listDriftSnapshots(tenant.id, {
        resource,
        ...(input.from ? { from: input.from } : {}),
        ...(input.to ? { to: input.to } : {}),
        limit: MAX_SNAPSHOTS_PER_RESOURCE + 1,
      });
      if (resourceSnapshots.length > MAX_SNAPSHOTS_PER_RESOURCE) {
        historyTruncated = true;
      }
      return resourceSnapshots.slice(0, MAX_SNAPSHOTS_PER_RESOURCE);
    });
    snapshots.sort(compareSnapshotsDesc);

    for (const snapshot of snapshots) {
      const resourceLabel = labelForResource(snapshot.resource);
      if (isBaselineSnapshot(snapshot)) {
        entries.push({
          id: `${snapshot.id}:baseline`,
          snapshotId: snapshot.id,
          capturedAt: snapshot.capturedAt,
          resource: snapshot.resource,
          resourceLabel,
          changeKind: "baseline",
          fieldChangeCount: 0,
          timestampOnly: false,
          rowCount: snapshot.rowCount,
        });
        continue;
      }

      for (const change of this.host.listDriftChangesForSnapshot(tenant.id, snapshot.id)) {
        if (!DRIFT_TRACKED_RESOURCES.has(change.resource)) continue;
        if (!resources.includes(change.resource)) continue;
        const fieldChanges = fieldChangesFor(change);
        const attribution = attributeDriftChange({
          resource: change.resource,
          graphId: change.graphId,
          previousCapturedAt: previousBySnapshotId.get(snapshot.id)?.capturedAt,
          capturedAt: snapshot.capturedAt,
          auditCache,
        });
        const displayName =
          change.displayName ??
          displayNameFromRaw(change.currentRawJson) ??
          displayNameFromRaw(change.previousRawJson);
        entries.push({
          id: `${snapshot.id}:${change.resource}:${change.graphId}:${change.kind}`,
          snapshotId: snapshot.id,
          capturedAt: snapshot.capturedAt,
          resource: change.resource,
          resourceLabel,
          graphId: change.graphId,
          ...(displayName ? { displayName } : {}),
          changeKind: change.kind,
          fieldChangeCount: fieldChanges.length,
          timestampOnly: isTimestampOnlyChange(fieldChanges),
          attribution,
        });
      }
    }

    entries.sort(compareTimelineEntriesDesc);
    const filteredEntries = input.query
      ? entries.filter((entry) => timelineEntryMatches(entry, input.query ?? ""))
      : entries;
    return {
      tenantId: tenant.id,
      entries: filteredEntries.slice(0, limit),
      hasMore: filteredEntries.length > limit,
      limit,
      ...(historyTruncated ? { historyTruncated: true } : {}),
    };
  }

  async getDriftEntryDetail(input: DriftEntryDetailInput): Promise<DriftEntryDetail> {
    const tenant = await this.resolveTenant(input.tenantId);
    ensureTrackedResource(input.resource);
    const snapshot = this.host.getDriftSnapshot(tenant.id, input.snapshotId);
    if (!snapshot || snapshot.resource !== input.resource) {
      throw new Error("Drift snapshot was not found for this tenant and resource.");
    }
    const change = this.host
      .listDriftChangesForSnapshot(tenant.id, snapshot.id)
      .find(
        (entry) =>
          entry.resource === input.resource &&
          entry.graphId === input.graphId,
      );
    if (!change) {
      throw new Error("Drift change was not found for this snapshot and object.");
    }

    const changes = fieldChangesFor(change);
    const detail: DriftEntryDetail = {
      changes,
      summary: summarizeDriftChanges(changes),
      attribution: attributeDriftChange({
        resource: input.resource,
        graphId: input.graphId,
        previousCapturedAt: this.previousSnapshotMap(tenant.id, [input.resource]).get(
          snapshot.id,
        )?.capturedAt,
        capturedAt: snapshot.capturedAt,
        auditCache: this.readAuditCache(tenant.id),
      }),
    };

    if (rawTooLarge(change.previousRawJson) || rawTooLarge(change.currentRawJson)) {
      detail.truncated = true;
      return detail;
    }

    if (change.previousRawJson !== undefined) {
      detail.before = parseRawJson(change.previousRawJson);
    }
    if (change.currentRawJson !== undefined) {
      detail.after = parseRawJson(change.currentRawJson);
    }
    return detail;
  }

  async getDriftObjectHistory(
    input: DriftObjectHistoryInput,
  ): Promise<DriftObjectHistoryResult> {
    const tenant = await this.resolveTenant(input.tenantId);
    ensureTrackedResource(input.resource);
    const limit = normalizeLimit(input.limit, 50);
    const versions = this.host.getDriftObjectHistory(
      tenant.id,
      input.resource,
      input.graphId,
      { limit },
    );
    return {
      tenantId: tenant.id,
      resource: input.resource,
      graphId: input.graphId,
      versions: versions.map((version) => ({
        version: version.version,
        snapshotId: version.firstSeenSnapshotId,
        capturedAt: version.firstSeenAt,
        contentHash: version.contentHash,
        ...(version.displayName ? { displayName: version.displayName } : {}),
        ...(version.removedSnapshotId
          ? { removedSnapshotId: version.removedSnapshotId }
          : {}),
        ...(version.removedAt ? { removedAt: version.removedAt } : {}),
      })),
    };
  }

  async getDriftStatus(tenantId: string): Promise<DriftStatus> {
    const tenant = await this.resolveTenant(tenantId);
    const stats = this.host.getDriftResourceStats(tenant.id, TRACKED_RESOURCES);
    const cacheStatus = new Map(
      this.host
        .getGraphCacheStatus(tenant.id, TRACKED_RESOURCES)
        .map((entry) => [entry.resource, entry]),
    );
    return {
      tenantId: tenant.id,
      resources: stats.map((stat) => ({
        resource: stat.resource,
        resourceLabel: labelForResource(stat.resource),
        baselineCaptured: Boolean(stat.baselineCapturedAt),
        ...(stat.baselineCapturedAt
          ? { baselineCapturedAt: stat.baselineCapturedAt }
          : {}),
        ...(stat.lastSnapshotAt ? { lastSnapshotAt: stat.lastSnapshotAt } : {}),
        snapshotCount: stat.snapshotCount,
        totalTrackedVersions: stat.totalTrackedVersions,
        currentObjectCount: stat.currentObjectCount,
        ...(cacheStatus.get(stat.resource)?.pageLimitReached
          ? { pageLimitReached: true }
          : {}),
      })),
    };
  }

  async createBaseline(input: CreateDriftBaselineInput): Promise<DriftBaseline> {
    const tenant = await this.resolveTenant(input.tenantId);
    return this.host.createDriftBaseline({
      tenantId: tenant.id,
      name: input.name,
      now: new Date().toISOString(),
      resources: TRACKED_RESOURCES,
    });
  }

  async listBaselines(input: ListDriftBaselinesInput): Promise<DriftBaseline[]> {
    const tenant = await this.resolveTenant(input.tenantId);
    return this.host.listDriftBaselines(tenant.id);
  }

  async renameBaseline(input: RenameDriftBaselineInput): Promise<DriftBaseline> {
    const tenant = await this.resolveTenant(input.tenantId);
    return this.host.renameDriftBaseline(tenant.id, input.baselineId, input.name);
  }

  async retireBaseline(input: RetireDriftBaselineInput): Promise<DriftBaseline> {
    const tenant = await this.resolveTenant(input.tenantId);
    return this.host.retireDriftBaseline(
      tenant.id,
      input.baselineId,
      new Date().toISOString(),
    );
  }

  async getBaselineDrift(
    input: DriftBaselineDriftInput,
  ): Promise<DriftBaselineDriftResult> {
    const tenant = await this.resolveTenant(input.tenantId);
    const baseline = input.baselineId
      ? this.host.getDriftBaseline(tenant.id, input.baselineId)
      : this.host.getActiveDriftBaseline(tenant.id);
    if (!baseline) {
      throw new Error(
        input.baselineId
          ? "Baseline was not found for this tenant."
          : "No active baseline exists for this tenant. Create one from the Changes view first.",
      );
    }
    const resources = normalizeTrackedResources(input.resources);
    const limit = normalizeLimit(input.limit, DEFAULT_TIMELINE_LIMIT);
    const changes = this.host.listDriftBaselineChanges({
      tenantId: tenant.id,
      baselineId: baseline.id,
      resources,
    });

    const countsByResource = new Map<
      GraphCacheResourceKind,
      { added: number; removed: number; modified: number }
    >();
    for (const resource of resources) {
      countsByResource.set(resource, { added: 0, removed: 0, modified: 0 });
    }
    const entries: DriftBaselineDriftEntry[] = [];
    for (const change of changes) {
      const counts = countsByResource.get(change.resource);
      if (counts) counts[change.kind] += 1;
      entries.push(baselineDriftEntry(change));
    }
    entries.sort(compareBaselineEntries);

    return {
      tenantId: tenant.id,
      baseline,
      evaluatedAt: new Date().toISOString(),
      resources: resources.map((resource): DriftBaselineResourceDrift => {
        const counts = countsByResource.get(resource) ?? {
          added: 0,
          removed: 0,
          modified: 0,
        };
        return {
          resource,
          resourceLabel: labelForResource(resource),
          ...counts,
        };
      }),
      entries: entries.slice(0, limit),
      hasMore: entries.length > limit,
      limit,
    };
  }

  private async resolveTenant(tenantId: string): Promise<TenantRecord> {
    const persisted = await this.host.read();
    return this.host.resolveTenant(persisted, tenantId);
  }

  private readAuditCache(tenantId: string): DriftAuditCache {
    const statusByResource = new Map(
      this.host
        .getGraphCacheStatus(tenantId, [
          INTUNE_AUDIT_EVENTS_RESOURCE,
          "directoryAudits",
        ])
        .map((status) => [status.resource, status]),
    );
    const statuses: DriftAuditCache["statuses"] = {};
    const intuneAuditStatus = statusByResource.get(INTUNE_AUDIT_EVENTS_RESOURCE);
    const directoryAuditStatus = statusByResource.get("directoryAudits");
    if (intuneAuditStatus) statuses.intuneAuditEvents = intuneAuditStatus;
    if (directoryAuditStatus) statuses.directoryAudits = directoryAuditStatus;
    return {
      intuneAuditEvents: this.host.listCachedGraphResourceRows({
        tenantId,
        resource: INTUNE_AUDIT_EVENTS_RESOURCE,
        limit: 1000,
      }),
      directoryAudits: this.host.listCachedGraphResourceRows({
        tenantId,
        resource: "directoryAudits",
        limit: 1000,
      }),
      statuses,
    };
  }

  private previousSnapshotMap(
    tenantId: string,
    resources: readonly GraphCacheResourceKind[],
  ): Map<string, DriftSnapshotRecord> {
    const out = new Map<string, DriftSnapshotRecord>();
    for (const resource of resources) {
      const snapshots = this.host
        .listDriftSnapshots(tenantId, {
          resource,
          limit: MAX_TIMELINE_LIMIT,
        })
        .sort(compareSnapshotsAsc);
      for (let index = 1; index < snapshots.length; index += 1) {
        const current = snapshots[index];
        const previous = snapshots[index - 1];
        if (current && previous) out.set(current.id, previous);
      }
    }
    return out;
  }
}

function timelineEntryMatches(entry: DriftTimelineEntry, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [
    entry.displayName,
    entry.graphId,
    entry.resource,
    entry.resourceLabel,
    entry.changeKind,
    entry.attribution?.actor?.userPrincipalName,
    entry.attribution?.actor?.appDisplayName,
    entry.attribution?.activity,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLocaleLowerCase()
    .includes(needle);
}

function baselineDriftEntry(change: DriftBaselineChangeRecord): DriftBaselineDriftEntry {
  const base = {
    resource: change.resource,
    resourceLabel: labelForResource(change.resource),
    graphId: change.graphId,
    ...(change.displayName ? { displayName: change.displayName } : {}),
    changeKind: change.kind,
  };
  if (rawTooLarge(change.pinnedRawJson) || rawTooLarge(change.currentRawJson)) {
    return { ...base, fieldChangeCount: 0, changes: [], truncated: true };
  }
  const changes = diffDriftObjects(
    change.kind === "added" ? {} : parseRawJson(change.pinnedRawJson),
    change.kind === "removed" ? {} : parseRawJson(change.currentRawJson),
    change.resource,
  );
  return { ...base, fieldChangeCount: changes.length, changes };
}

function compareBaselineEntries(
  left: DriftBaselineDriftEntry,
  right: DriftBaselineDriftEntry,
): number {
  if (left.resource !== right.resource) {
    return left.resource.localeCompare(right.resource);
  }
  if (left.changeKind !== right.changeKind) {
    return left.changeKind.localeCompare(right.changeKind);
  }
  const leftName = left.displayName ?? left.graphId;
  const rightName = right.displayName ?? right.graphId;
  return leftName.localeCompare(rightName);
}

function fieldChangesFor(change: DriftSnapshotChangeRecord): DriftFieldChange[] {
  if (change.kind === "added") {
    return diffDriftObjects({}, parseRawJson(change.currentRawJson), change.resource);
  }
  if (change.kind === "removed") {
    return diffDriftObjects(parseRawJson(change.previousRawJson), {}, change.resource);
  }
  return diffDriftObjects(
    parseRawJson(change.previousRawJson),
    parseRawJson(change.currentRawJson),
    change.resource,
  );
}

function normalizeTrackedResources(
  resources: readonly GraphCacheResourceKind[] | undefined,
): GraphCacheResourceKind[] {
  if (!resources || resources.length === 0) return [...TRACKED_RESOURCES];
  const out: GraphCacheResourceKind[] = [];
  for (const resource of resources) {
    ensureTrackedResource(resource);
    if (!out.includes(resource)) out.push(resource);
  }
  return out;
}

function ensureTrackedResource(resource: GraphCacheResourceKind): void {
  if (!DRIFT_TRACKED_RESOURCES.has(resource)) {
    throw new Error(`Resource is not tracked for drift: ${resource}`);
  }
}

function normalizeLimit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(MAX_TIMELINE_LIMIT, Math.floor(value)));
}

function isBaselineSnapshot(snapshot: DriftSnapshotRecord): boolean {
  return (
    snapshot.changesAdded === 0 &&
    snapshot.changesRemoved === 0 &&
    snapshot.changesModified === 0
  );
}

function rawTooLarge(rawJson: string | undefined): boolean {
  return rawJson !== undefined && Buffer.byteLength(rawJson, "utf8") > DETAIL_RAW_LIMIT_BYTES;
}

function parseRawJson(rawJson: string | undefined): unknown {
  if (rawJson === undefined) return undefined;
  try {
    return JSON.parse(rawJson) as unknown;
  } catch {
    return undefined;
  }
}

function displayNameFromRaw(rawJson: string | undefined): string | undefined {
  const row = parseRawJson(rawJson);
  if (!isRecord(row)) return undefined;
  return (
    stringValue(row.displayName) ??
    stringValue(row.name) ??
    stringValue(row.deviceName)
  );
}

function labelForResource(resource: GraphCacheResourceKind): string {
  return definitionForResource(resource).label;
}

function compareSnapshotsAsc(left: DriftSnapshotRecord, right: DriftSnapshotRecord): number {
  const byTime = Date.parse(left.capturedAt) - Date.parse(right.capturedAt);
  return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
}

function compareSnapshotsDesc(left: DriftSnapshotRecord, right: DriftSnapshotRecord): number {
  return compareSnapshotsAsc(right, left);
}

function compareTimelineEntriesDesc(left: DriftTimelineEntry, right: DriftTimelineEntry): number {
  const byTime = Date.parse(right.capturedAt) - Date.parse(left.capturedAt);
  return byTime === 0 ? right.id.localeCompare(left.id) : byTime;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
