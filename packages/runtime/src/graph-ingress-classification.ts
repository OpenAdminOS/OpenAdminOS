import { walkDataClasses, type ClassificationOptions } from "./data-classification.js";
import { ClassificationSlice } from "./classification-worker-client.js";
import type { ClassifiedValues } from "./request-classification.js";

export interface WorkerGraphResult {
  batches: ArrayBuffer[];
  dropped: number;
  incomplete: boolean;
}

type GraphObservation = ClassifiedValues["fields"][number];
const MAX_GRAPH_MATCH_VALUE = 32_768;
const RESULT_BATCH_UNITS = 16_384;
export const MAX_GRAPH_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_GRAPH_MESSAGE_BYTES = 512 * 1024;

/** Transfer bounded chunks without cloning the field objects on the main thread. */
export function packWorkerGraphResult(data: unknown, options: ClassificationOptions): WorkerGraphResult {
  const encoder = new TextEncoder();
  const batches: ArrayBuffer[] = [];
  let fields: GraphObservation[] = [];
  let units = 0;
  let dropped = 0;
  const flush = () => {
    if (!fields.length) return;
    batches.push(encoder.encode(JSON.stringify(fields)).buffer as ArrayBuffer);
    fields = [];
    units = 0;
  };
  const result = walkDataClasses(data, options, (value, kind, _pointer, key, maskRole) => {
    if (typeof value !== "string" && typeof value !== "boolean" &&
        !(typeof value === "number" && Number.isFinite(value))) return;
    const length = typeof value === "string" ? value.length : 0;
    if (length > MAX_GRAPH_MATCH_VALUE || key.length > MAX_GRAPH_MATCH_VALUE) {
      dropped++;
      return;
    }
    fields.push({ value, kind, key, ...(maskRole ? { maskRole } : {}) });
    units += length + key.length + 48;
    if (units >= RESULT_BATCH_UNITS) flush();
  });
  flush();
  return { batches, dropped, incomplete: result.budgetExhausted };
}

/** Size retained input and plan bounded worker messages without copying the page. */
export async function graphClassificationInput(data: unknown, signal: AbortSignal): Promise<{
  bytes: number;
  header: unknown;
  collection?: string | true;
  rows?: unknown[];
  batches: Array<[start: number, end: number]>;
}> {
  const slice = new ClassificationSlice(signal);
  const record = data !== null && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
  let field: string | undefined;
  if (record) {
    for (const key in record) {
      if (Object.hasOwn(record, key) && key.toLowerCase() === "value" && Array.isArray(record[key])) {
        field = key;
        break;
      }
      if (slice.elapsed) await slice.yield();
    }
  }
  const rows = Array.isArray(data) ? data : field ? record![field] as unknown[] : undefined;
  let bytes = 0;
  const add = (amount: number) => {
    bytes += amount;
    if (bytes > MAX_GRAPH_INPUT_BYTES) throw new Error("Graph classification input exceeds the worker queue budget.");
    return slice.elapsed;
  };
  if (!Array.isArray(data)) {
    for (const amount of graphValueBytes(data, new Set(), field)) {
      if (add(amount)) await slice.yield();
      if (bytes > MAX_GRAPH_MESSAGE_BYTES) throw new Error("Graph classification header exceeds the message budget.");
    }
  }
  const batches: Array<[number, number]> = [];
  let first = 0;
  let batchBytes = 0;
  if (rows) {
    bytes += 32;
    for (let index = 0; index < rows.length; index++) {
      const before = bytes;
      if (add(32)) await slice.yield();
      for (const amount of graphValueBytes(rows[index], new Set())) {
        if (add(amount)) await slice.yield();
        if (bytes - before > MAX_GRAPH_MESSAGE_BYTES) throw new Error("Graph classification row exceeds the message budget.");
      }
      const rowBytes = bytes - before;
      if (index - first >= 4 || batchBytes + rowBytes > MAX_GRAPH_MESSAGE_BYTES) {
        batches.push([first, index]);
        first = index;
        batchBytes = 0;
      }
      batchBytes += rowBytes;
    }
    if (first < rows.length) batches.push([first, rows.length]);
  }
  const header = field ? { ...record, [field]: [] } : rows ? undefined : data;
  return { bytes, header, ...(rows ? { rows, collection: field || true } : {}), batches };
}

function* graphValueBytes(value: unknown, active: Set<object>, skip?: string): Iterable<number> {
  yield typeof value === "string" ? 32 + 2 * value.length : 32;
  if (!value || typeof value !== "object" || active.has(value)) return;
  if (active.size >= 128) throw new Error("Graph classification input exceeds the supported nesting depth.");
  active.add(value);
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    yield 16 + 2 * key.length;
    if (key === skip) continue;
    yield* graphValueBytes((value as Record<string, unknown>)[key], active);
  }
  active.delete(value);
}
