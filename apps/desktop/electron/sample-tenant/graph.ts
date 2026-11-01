import type { GraphRequestInput, RunGraphApi } from "@openadminos/agent-sdk";

import {
  createSampleTenantDataset,
  type SampleTenantDataset,
} from "./dataset.js";

const PAGE_SIZE = 50;

export class SampleGraphError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: { error: { code: string; message: string } };

  constructor(status: number, code: string, message: string) {
    super(`Microsoft Graph request failed: HTTP ${status} ${code}. ${message}`);
    this.name = "SampleGraphError";
    this.status = status;
    this.code = code;
    this.body = { error: { code, message } };
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function normalizePath(path: string): { path: string; query: Record<string, string> } {
  const url = path.startsWith("http://") || path.startsWith("https://")
    ? new URL(path)
    : new URL(path, "https://graph.microsoft.com/beta");
  const pathname = url.pathname.startsWith("/beta/")
    ? url.pathname.slice("/beta".length)
    : url.pathname === "/beta"
      ? "/"
      : url.pathname;
  return {
    path: pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname,
    query: Object.fromEntries(url.searchParams.entries()),
  };
}

function property(record: Record<string, unknown>, path: string): unknown {
  return path.split("/").reduce<unknown>((value, key) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[key];
  }, record);
}

function compare(value: unknown, operator: string, rawExpected: string): boolean {
  const expected = rawExpected.replace(/^'|'$/g, "").replace(/''/g, "'");
  if (operator === "eq" || operator === "ne") {
    const normalizedExpected = expected === "true" ? true : expected === "false" ? false : /^-?\d+(?:\.\d+)?$/.test(expected) ? Number(expected) : expected;
    const matches = value === normalizedExpected || String(value ?? "").toLowerCase() === String(normalizedExpected).toLowerCase();
    return operator === "eq" ? matches : !matches;
  }
  const left = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  const right = /^-?\d+(?:\.\d+)?$/.test(expected) ? Number(expected) : Date.parse(expected);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (operator === "ge") return left >= right;
  if (operator === "gt") return left > right;
  if (operator === "le") return left <= right;
  if (operator === "lt") return left < right;
  return false;
}

function matchesFilter(row: Record<string, unknown>, filter: string): boolean {
  const orParts = filter.split(/\s+or\s+/i);
  return orParts.some((orPart) =>
    orPart.split(/\s+and\s+/i).every((part) => {
      const raw = part.trim();
      const trimmed = raw.startsWith("(") && raw.endsWith(")")
        ? raw.slice(1, -1).trim()
        : raw;
      const startsWith = /^startsWith\(([^,]+),\s*'([^']*)'\)$/i.exec(trimmed);
      if (startsWith) {
        return String(property(row, startsWith[1]!.trim()) ?? "")
          .toLowerCase()
          .startsWith(startsWith[2]!.toLowerCase());
      }
      const expression = /^([A-Za-z0-9_./]+)\s+(eq|ne|ge|gt|le|lt)\s+(.+)$/i.exec(trimmed);
      if (!expression) {
        throw new SampleGraphError(400, "Request_UnsupportedQuery", `The sample tenant does not support this filter: ${filter}`);
      }
      return compare(property(row, expression[1]!), expression[2]!.toLowerCase(), expression[3]!.trim());
    }),
  );
}

function selectFields(row: Record<string, unknown>, select: string | undefined) {
  if (!select) return clone(row);
  const result: Record<string, unknown> = {};
  for (const key of select.split(",").map((entry) => entry.trim()).filter(Boolean)) {
    if (Object.prototype.hasOwnProperty.call(row, key)) result[key] = clone(row[key]);
  }
  if (row["@odata.type"] !== undefined) result["@odata.type"] = row["@odata.type"];
  return result;
}

function sortRows(rows: Array<Record<string, unknown>>, orderBy: string | undefined) {
  if (!orderBy) return rows;
  const [field, direction] = orderBy.trim().split(/\s+/);
  if (!field) return rows;
  return [...rows].sort((left, right) => {
    const a = property(left, field);
    const b = property(right, field);
    const compared = String(a ?? "").localeCompare(String(b ?? ""));
    return direction?.toLowerCase() === "desc" ? -compared : compared;
  });
}

function collectionResponse(
  path: string,
  rows: Array<Record<string, unknown>>,
  query: Record<string, string>,
) {
  let selected = query.$filter ? rows.filter((row) => matchesFilter(row, query.$filter!)) : [...rows];
  if (query.$search) {
    const term = query.$search.replace(/^"|"$/g, "").trim().toLowerCase();
    selected = selected.filter((row) =>
      JSON.stringify(row).toLowerCase().includes(term),
    );
  }
  selected = sortRows(selected, query.$orderby);
  const skip = Math.max(0, Number(query.$skiptoken ?? query.$skip ?? 0) || 0);
  const requestedTop = Math.max(1, Number(query.$top ?? PAGE_SIZE) || PAGE_SIZE);
  const pageSize = Math.min(requestedTop, PAGE_SIZE);
  const page = selected.slice(skip, skip + pageSize).map((row) => selectFields(row, query.$select));
  const next = skip + pageSize;
  return {
    "@odata.context": `https://graph.microsoft.com/beta/$metadata#${path.replace(/^\//, "")}`,
    ...(query.$count === "true" ? { "@odata.count": selected.length } : {}),
    value: page,
    ...(next < selected.length
      ? {
          "@odata.nextLink": `https://graph.microsoft.com/beta${path}?${new URLSearchParams({
            ...query,
            $skiptoken: String(next),
          }).toString()}`,
        }
      : {}),
  };
}

function locateCollection(
  dataset: SampleTenantDataset,
  path: string,
): { collectionPath: string; rows: Array<Record<string, unknown>>; itemId?: string; suffix?: string } | undefined {
  const paths = Object.keys(dataset.resources).sort((left, right) => right.length - left.length);
  for (const collectionPath of paths) {
    if (path === collectionPath) return { collectionPath, rows: dataset.resources[collectionPath]! };
    if (!path.startsWith(`${collectionPath}/`)) continue;
    const remainder = path.slice(collectionPath.length + 1);
    const [itemId, ...suffixParts] = remainder.split("/");
    return {
      collectionPath,
      rows: dataset.resources[collectionPath]!,
      itemId: decodeURIComponent(itemId ?? ""),
      ...(suffixParts.length > 0 ? { suffix: suffixParts.join("/") } : {}),
    };
  }
  return undefined;
}

function writeBody(input: GraphRequestInput): Record<string, unknown> {
  if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) {
    throw new SampleGraphError(400, "Request_BadRequest", "A JSON object body is required.");
  }
  return clone(input.body as Record<string, unknown>);
}

/** A clock shared by the pilot Graph, prepared answers, and pilot agents. */
export type SampleClock = () => Date;

export interface SampleGraphOptions {
  /** Fixed reference time. Prefer `clock` so every read sees the current time. */
  now?: Date;
  /** Returns the current time. Defaults to the system clock. */
  clock?: SampleClock;
}

export interface SampleGraph extends RunGraphApi {
  /** The clock this Graph materializes timestamps with. */
  readonly clock: SampleClock;
}

/**
 * Simulated writes are kept as an overlay on top of the generated dataset:
 * field patches keyed by resource id, removed ids, and created rows. The
 * dataset itself is materialized from relative offsets on every read, so
 * timestamps always describe the moment of the request while the overlay
 * survives until the pilot tenant is removed.
 */
interface SampleOverlay {
  patches: Map<string, Record<string, unknown>>;
  deleted: Set<string>;
  created: Map<string, Array<Record<string, unknown>>>;
  singletonPatches: Map<string, Record<string, unknown>>;
  createdCount: number;
  version: number;
}

function overlayKey(collectionPath: string, id: string): string {
  return `${collectionPath}\u0000${id}`;
}

function applyOverlay(
  dataset: SampleTenantDataset,
  overlay: SampleOverlay,
): SampleTenantDataset {
  if (overlay.version === 0) return dataset;
  const resources: SampleTenantDataset["resources"] = {};
  for (const [collectionPath, rows] of Object.entries(dataset.resources)) {
    const next: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const key = overlayKey(collectionPath, String(row.id));
      if (overlay.deleted.has(key)) continue;
      const patch = overlay.patches.get(key);
      next.push(patch ? { ...row, ...clone(patch) } : row);
    }
    for (const created of overlay.created.get(collectionPath) ?? []) {
      if (!overlay.deleted.has(overlayKey(collectionPath, String(created.id)))) {
        next.push(clone(created));
      }
    }
    resources[collectionPath] = next;
  }
  const singletons: SampleTenantDataset["singletons"] = {};
  for (const [path, value] of Object.entries(dataset.singletons)) {
    const patch = overlay.singletonPatches.get(path);
    singletons[path] = patch ? { ...value, ...clone(patch) } : value;
  }
  return { loadedAt: dataset.loadedAt, resources, singletons };
}

/**
 * A process-local Graph implementation backed by the generated pilot
 * dataset. Each instance owns its overlay, so simulated writes never escape
 * the pilot tenant and are discarded with it.
 */
export function createSampleGraph(options: SampleGraphOptions = {}): SampleGraph {
  const fixed = options.now ? new Date(options.now.getTime()) : undefined;
  const clock: SampleClock =
    options.clock ?? (fixed ? () => new Date(fixed.getTime()) : () => new Date());
  const overlay: SampleOverlay = {
    patches: new Map(),
    deleted: new Set(),
    created: new Map(),
    singletonPatches: new Map(),
    createdCount: 0,
    version: 0,
  };
  let cached: { at: number; version: number; dataset: SampleTenantDataset } | undefined;
  const materialize = (): SampleTenantDataset => {
    const now = clock();
    if (cached && cached.at === now.getTime() && cached.version === overlay.version) {
      return cached.dataset;
    }
    const dataset = applyOverlay(createSampleTenantDataset(now), overlay);
    cached = { at: now.getTime(), version: overlay.version, dataset };
    return dataset;
  };
  const patchRow = (collectionPath: string, id: string, patch: Record<string, unknown>) => {
    const key = overlayKey(collectionPath, id);
    const createdRows = overlay.created.get(collectionPath);
    const createdRow = createdRows?.find((row) => String(row.id) === id);
    if (createdRow) Object.assign(createdRow, clone(patch));
    else overlay.patches.set(key, { ...(overlay.patches.get(key) ?? {}), ...clone(patch) });
    overlay.version += 1;
  };

  const request: RunGraphApi["request"] = async (input) => {
    input.signal?.throwIfAborted();
    const dataset = materialize();
    const normalized = normalizePath(input.path);
    const query = { ...normalized.query, ...(input.query ?? {}) };
    const path = normalized.path;
    const singleton = dataset.singletons[path];
    if (singleton) {
      if (input.method === "GET") return selectFields(singleton, query.$select);
      if (input.method === "PATCH") {
        overlay.singletonPatches.set(path, {
          ...(overlay.singletonPatches.get(path) ?? {}),
          ...writeBody(input),
        });
        overlay.version += 1;
        return clone({ ...singleton, ...overlay.singletonPatches.get(path) });
      }
      throw new SampleGraphError(405, "Request_BadRequest", `Method ${input.method} is not supported for ${path}.`);
    }

    const located = locateCollection(dataset, path);
    if (!located) {
      throw new SampleGraphError(404, "Request_ResourceNotFound", `The sample tenant has no route for ${path}.`);
    }
    if (!located.itemId) {
      if (input.method === "GET") return collectionResponse(located.collectionPath, located.rows, query);
      if (input.method === "POST") {
        overlay.createdCount += 1;
        const created = { id: `sample-created-${overlay.createdCount}`, ...writeBody(input) };
        overlay.created.set(located.collectionPath, [
          ...(overlay.created.get(located.collectionPath) ?? []),
          created,
        ]);
        overlay.version += 1;
        return clone(created);
      }
      throw new SampleGraphError(405, "Request_BadRequest", `Method ${input.method} is not supported for ${path}.`);
    }

    const index = located.rows.findIndex((row) => String(row.id) === located.itemId);
    if (index < 0) {
      throw new SampleGraphError(404, "Request_ResourceNotFound", `The sample tenant could not find ${located.itemId}.`);
    }
    const item = located.rows[index]!;
    if (located.suffix === "retire") {
      if (input.method !== "POST") throw new SampleGraphError(405, "Request_BadRequest", "Retire requires POST.");
      patchRow(located.collectionPath, located.itemId, {
        retired: true,
        managementState: "retirePending",
      });
      return { simulated: true };
    }
    if (located.suffix === "memberOf" || located.suffix === "transitiveMemberOf") {
      if (input.method !== "GET") throw new SampleGraphError(405, "Request_BadRequest", "Group membership supports GET only.");
      return collectionResponse("/groups", dataset.resources["/groups"]!.slice(0, 4), query);
    }
    if (located.collectionPath === "/groups" && located.suffix === "members") {
      if (input.method !== "GET") throw new SampleGraphError(405, "Request_BadRequest", "Group members support GET only.");
      const memberIds = Array.isArray(item.memberIds) ? item.memberIds.map(String) : [];
      const members = dataset.resources["/users"]!.filter((user) =>
        memberIds.includes(String(user.id)),
      );
      return collectionResponse("/users", members, query);
    }
    if (located.collectionPath === "/groups" && located.suffix === "drives") {
      if (input.method !== "GET") throw new SampleGraphError(405, "Request_BadRequest", "Group drives support GET only.");
      return collectionResponse("/drives", [{ id: `drive-${located.itemId}`, name: "Shared documents", driveType: "documentLibrary", webUrl: "https://contoso-sample.invalid/shared-documents" }], query);
    }
    if (
      located.collectionPath === "/deviceManagement/managedDevices" &&
      located.suffix === "deviceCompliancePolicyStates"
    ) {
      if (input.method !== "GET") throw new SampleGraphError(405, "Request_BadRequest", "Compliance states support GET only.");
      return collectionResponse(
        "/deviceCompliancePolicyStates",
        [{ id: "sample-compliance-state", displayName: "WIN-Compliance-Baseline", state: item.complianceState === "noncompliant" ? "nonCompliant" : "compliant" }],
        query,
      );
    }
    if (
      located.collectionPath === "/deviceManagement/managedDevices" &&
      /^deviceCompliancePolicyStates\/[^/]+\/settingStates$/.test(located.suffix ?? "")
    ) {
      if (input.method !== "GET") throw new SampleGraphError(405, "Request_BadRequest", "Compliance setting states support GET only.");
      const reasons = Array.isArray(item.complianceReasons)
        ? item.complianceReasons.map((reason, index) => ({ id: `setting-${index + 1}`, settingName: String(reason), state: "nonCompliant", currentValue: "false" }))
        : [];
      return collectionResponse("/settingStates", reasons, query);
    }
    if (located.collectionPath === "/directoryRoles" && located.suffix === "members") {
      if (input.method !== "GET") throw new SampleGraphError(405, "Request_BadRequest", "Directory role members support GET only.");
      const memberIds = Array.isArray(item.memberIds) ? item.memberIds.map(String) : [];
      const members = dataset.resources["/users"]!.filter((user) =>
        memberIds.includes(String(user.id)),
      );
      return collectionResponse("/users", members, query);
    }
    if (
      located.collectionPath === "/deviceAppManagement/mobileApps" &&
      located.suffix === "assignments"
    ) {
      if (input.method !== "GET") throw new SampleGraphError(405, "Request_BadRequest", "App assignments support GET only.");
      return collectionResponse(
        "/deviceAppManagement/mobileApps/assignments",
        rowArray(item.assignments),
        query,
      );
    }
    if (located.suffix) {
      throw new SampleGraphError(404, "Request_ResourceNotFound", `The sample tenant has no sub-resource ${located.suffix}.`);
    }
    if (input.method === "GET") return selectFields(item, query.$select);
    if (input.method === "PATCH" || input.method === "PUT") {
      const patch = writeBody(input);
      patchRow(located.collectionPath, located.itemId, patch);
      return clone({ ...item, ...patch });
    }
    if (input.method === "DELETE") {
      overlay.deleted.add(overlayKey(located.collectionPath, located.itemId));
      overlay.version += 1;
      return { simulated: true };
    }
    throw new SampleGraphError(405, "Request_BadRequest", `Method ${input.method} is not supported for ${path}.`);
  };

  return {
    clock,
    async listManagedDevices() {
      const devices: Array<Record<string, unknown>> = [];
      let path = "/deviceManagement/managedDevices?$top=999";
      while (path) {
        const response = (await request({ method: "GET", path })) as {
          value: Array<Record<string, unknown>>;
          "@odata.nextLink"?: string;
        };
        devices.push(...response.value);
        path = response["@odata.nextLink"] ?? "";
      }
      return devices as unknown as Awaited<ReturnType<RunGraphApi["listManagedDevices"]>>;
    },
    async retireManagedDevice(deviceId: string) {
      await request({ method: "POST", path: `/deviceManagement/managedDevices/${encodeURIComponent(deviceId)}/retire` });
    },
    request,
  };
}

function rowArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}
