import { walkDataClasses, type ClassifiedValues, type ClassificationOptions } from "./data-classification.js";
import { GRAPH_FIELD_CLASSES_VERSION } from "./graph-field-classes.js";
import { TenantValueIndex, type TenantValueIndexSnapshot } from "./tenant-value-index.js";
import { collectTenantValues } from "./tenant-values.js";
import type { DataClass } from "@openadminos/agent-sdk";

type MaskRole = NonNullable<ClassifiedValues["fields"][number]["maskRole"]>;
type Field = [path: string[], key: string, kind: DataClass, maskRole?: MaskRole];
type RowClassification = [version: number, incomplete: boolean, fields: Field[]];

/** The SQLite sidecar contains paths and classes only. Values stay in raw_json. */
export function describeCacheRow(row: unknown, options: ClassificationOptions): string {
  const fields: Field[] = [];
  try {
    const summary = walkDataClasses(row, options, (_value, kind, pointer, key, maskRole) => {
      const path = pointer === "" ? [] : pointer.slice(1).split("/").map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"));
      fields.push(maskRole ? [path, key, kind, maskRole] : [path, key, kind]);
    });
    return JSON.stringify([GRAPH_FIELD_CLASSES_VERSION, summary.budgetExhausted, fields] satisfies RowClassification);
  } catch {
    return JSON.stringify([GRAPH_FIELD_CLASSES_VERSION, true, []] satisfies RowClassification);
  }
}

export function readCacheClassification(row: unknown, encoded: string | null | undefined): ClassifiedValues {
  try {
    const [version, incomplete, fields] = JSON.parse(encoded ?? "null") as RowClassification;
    if (version !== GRAPH_FIELD_CLASSES_VERSION) return { fields: [], incomplete: true };
    return { incomplete, fields: fields.flatMap(([path, key, kind, maskRole]) => {
      let value = row;
      for (const part of path) value = (value as Record<string, unknown>)[part];
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? [{ value, key, kind, ...(maskRole ? { maskRole } : {}) }] : [];
    }) };
  } catch {
    return { fields: [], incomplete: true };
  }
}

export interface CacheClassificationRow {
  rawJson: string;
  graphId: string;
  displayName: string | null;
}

export interface CacheStartupPage {
  dbPath: string;
  tenantId: string;
  resource: string;
  afterRowId: number;
  indexOnly: boolean;
}

export interface CacheClassificationResult {
  sidecars: string[];
  nextRowId?: number;
  egressIndex?: TenantValueIndexSnapshot;
  firstNames?: TenantValueIndexSnapshot;
}

export const INCOMPLETE_CACHE_CLASSIFICATION = JSON.stringify([GRAPH_FIELD_CLASSES_VERSION, true, []] satisfies RowClassification);

export function addCacheIdentity(index: TenantValueIndex, id: string, name: string | null, row: unknown): void {
  index.add(id);
  index.add(name, "name");
  collectTenantValues(row, index);
}

export function addUserFirstName(index: TenantValueIndex, name: string | null, row: unknown): void {
  const record = row as Record<string, unknown> | null;
  index.add(record?.givenName ?? name?.trim().split(/\s+/, 1)[0], "name");
}

export function prepareCacheClassification(
  rows: readonly CacheClassificationRow[], options: ClassificationOptions, indexValues: boolean, indexNames: boolean,
  indexOnly = false,
): CacheClassificationResult {
  const egressIndex = indexValues ? new TenantValueIndex() : undefined;
  const firstNames = indexNames ? new TenantValueIndex() : undefined;
  const sidecars: string[] = [];
  for (const { rawJson, graphId, displayName } of rows) {
    const row: unknown = JSON.parse(rawJson);
    if (egressIndex) addCacheIdentity(egressIndex, graphId, displayName, row);
    if (firstNames) addUserFirstName(firstNames, displayName, row);
    if (!indexOnly) sidecars.push(describeCacheRow(row, options));
  }
  return {
    sidecars,
    ...(egressIndex ? { egressIndex: egressIndex.workerSnapshot() } : {}),
    ...(firstNames ? { firstNames: firstNames.workerSnapshot() } : {}),
  };
}
