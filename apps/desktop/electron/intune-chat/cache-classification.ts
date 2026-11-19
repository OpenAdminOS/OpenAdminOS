import { GRAPH_FIELD_CLASSES_VERSION, walkDataClasses, type ClassifiedValues, type ClassificationOptions } from "@openadminos/runtime/data-classification";
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
