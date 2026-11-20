import { walkDataClasses, type ClassificationOptions } from "./data-classification.js";
import { CLASSIFICATION_QUEUE_MAX_BYTES, ClassificationSlice } from "./classification-worker-client.js";
import type { ClassifiedValues } from "./request-classification.js";

export interface WorkerGraphResult {
  batches: ArrayBuffer[];
  dropped: number;
  incomplete: boolean;
}

type GraphObservation = ClassifiedValues["fields"][number];
const MAX_GRAPH_MATCH_VALUE = 32_768;
const RESULT_BATCH_UNITS = 16_384;

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

/** Estimate retained JSON input bytes without constructing a second copy of the page. */
export async function graphClassificationBytes(data: unknown, signal?: AbortSignal): Promise<number> {
  const slice = new ClassificationSlice();
  let bytes = 0;
  for (const amount of graphValueBytes(data, new Set())) {
    bytes += amount;
    if (bytes > CLASSIFICATION_QUEUE_MAX_BYTES) throw new Error("Graph classification input exceeds the worker queue budget.");
    if (slice.elapsed) {
      signal?.throwIfAborted();
      await slice.yield();
    }
  }
  return bytes;
}

function* graphValueBytes(value: unknown, active: Set<object>): Iterable<number> {
  yield typeof value === "string" ? 32 + 2 * value.length : 32;
  if (!value || typeof value !== "object" || active.has(value)) return;
  if (active.size >= 128) throw new Error("Graph classification input exceeds the supported nesting depth.");
  active.add(value);
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    yield 16 + 2 * key.length;
    yield* graphValueBytes((value as Record<string, unknown>)[key], active);
  }
  active.delete(value);
}
