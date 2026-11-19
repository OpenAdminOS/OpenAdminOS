import { performance } from "node:perf_hooks";
import { setImmediate as yieldToMain } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import type { TenantMatchEntry } from "./tenant-value-index.js";
import type { WorkerScan, WorkerResult, WorkerValue, WorkerLargeValue } from "./request-classification.js";

type WorkerMessage =
  | { type: "values"; id: number; values: WorkerValue[] }
  | { type: "large-value"; id: number; value: WorkerLargeValue }
  | { type: "identity"; id: number; entries: TenantMatchEntry[] }
  | { type: "drop"; id: number }
  | WorkerScan;

const MAIN_SLICE_MS = 2;
const WORKER_TIMEOUT_MS = 3_000;

export class ClassificationSlice {
  private deadline = performance.now() + MAIN_SLICE_MS;

  get elapsed(): boolean { return performance.now() >= this.deadline; }

  async yield(): Promise<void> {
    await yieldToMain();
    this.deadline = performance.now() + MAIN_SLICE_MS;
  }
}

/** A single lazy worker handles desktop scans in order. A failed generation is discarded. */
export class ClassificationWorker {
  private readonly worker: Worker;
  private readonly garbage: FinalizationRegistry<number>;
  private tail = Promise.resolve();
  private reply?: (result: WorkerResult) => void;
  private failReply?: (error: Error) => void;
  private failure?: Error;
  private nextId = 0;
  private jobs = 0;
  readonly shards = new WeakMap<object, number>();

  constructor() {
    // The desktop uses compiled JavaScript. Runtime tests also exercise the
    // worker directly from TypeScript via the repository's tsx loader.
    const source = import.meta.url.endsWith(".ts");
    this.worker = source
      ? new Worker('require("tsx/esm/api").tsImport(require("node:worker_threads").workerData, __filename)',
        { eval: true, workerData: new URL("./classification-worker.ts", import.meta.url).href, execArgv: [] })
      : new Worker(new URL("./classification-worker.js", import.meta.url), { execArgv: [] });
    this.worker.on("message", (result: WorkerResult) => this.reply?.(result));
    this.worker.on("error", error => this.stop(error instanceof Error ? error : new Error("Classification worker failed.")));
    this.worker.on("exit", () => this.stop(new Error("Classification worker exited.")));
    this.worker.unref();
    this.garbage = new FinalizationRegistry(id => {
      if (!this.failure) this.post({ type: "drop", id });
    });
  }

  id(owner: object): number {
    const id = ++this.nextId;
    this.garbage.register(owner, id, owner);
    return id;
  }

  drop(owner: object, id: number): void {
    if (this.failure) return;
    this.garbage.unregister(owner);
    try { this.post({ type: "drop", id }); }
    catch { this.stop(new Error("Classification worker could not release evidence.")); }
  }

  post(message: WorkerMessage, transfers?: ArrayBuffer[]): void {
    if (this.failure) throw this.failure;
    this.worker.postMessage(message, transfers);
  }

  private stop(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    if (worker === this) worker = undefined;
    this.failReply?.(error);
    void this.worker.terminate();
  }

  run(prepare: (client: ClassificationWorker) => Promise<{ message: WorkerScan; transfers: ArrayBuffer[] }>,
    signal?: AbortSignal): Promise<WorkerResult> {
    if (++this.jobs === 1) this.worker.ref();
    let active = false;
    let cancelled: Error | undefined;
    let rejectCancellation!: (error: Error) => void;
    const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject; });
    const cancel = (error: Error) => {
      cancelled = error;
      if (active) this.stop(error);
      rejectCancellation(error);
    };
    const abort = () => cancel(new Error("Request classification was cancelled."));
    // The deadline includes queueing, synchronization and the worker scan.
    const timer = setTimeout(() => cancel(new Error("Classification worker timed out.")), WORKER_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const run = this.tail.then(async () => {
      if (cancelled) throw cancelled;
      if (this.failure) throw this.failure;
      active = true;
      const result = new Promise<WorkerResult>((resolve, reject) => {
        this.reply = resolve;
        this.failReply = reject;
      });
      try {
        const prepared = prepare(this).then(({ message, transfers }) => {
          this.post(message, transfers);
          return result;
        });
        return await Promise.race([prepared, result]);
      } catch (error) {
        // A partially synchronized matcher is unsafe to reuse.
        this.stop(error instanceof Error ? error : new Error("Classification worker failed."));
        throw error;
      } finally {
        active = false;
        delete this.reply;
        delete this.failReply;
      }
    });
    this.tail = run.then(() => undefined, () => undefined);
    return Promise.race([run, cancellation]).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (!--this.jobs) this.worker.unref();
    });
  }
}

let worker: ClassificationWorker | undefined;

export function requestWorker(): ClassificationWorker {
  return worker ??= new ClassificationWorker();
}

export function releaseClassificationIdentityShard(shard: object): void {
  const id = worker?.shards.get(shard);
  if (id === undefined || !worker) return;
  worker.shards.delete(shard);
  worker.drop(shard, id);
}

export type { WorkerMessage };
