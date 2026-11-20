import { walkDataClasses, type ClassificationOptions } from "./data-classification.js";
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
