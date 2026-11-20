import { performance } from "node:perf_hooks";
import { setImmediate as yieldToMain } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import type { ClassificationOptions } from "./data-classification.js";
import type { CacheStartupPage, CacheClassificationRow, CacheClassificationResult } from "./cache-classification.js";
import type { TenantMatchEntry, TenantValueIndex } from "./tenant-value-index.js";
import type { WorkerScan, WorkerResult, WorkerValue, WorkerLargeValue } from "./request-classification.js";

import type { WorkerGraphResult } from "./graph-ingress-classification.js";

type WorkerJob = WorkerScan
  | { type: "graph"; data: unknown; graphPath: string; shards: number[]; collection?: string | true }
  | { type: "cache"; rows: CacheClassificationRow[]; graphPath: string; shards: number[]; indexValues: boolean; indexNames: boolean; startup?: CacheStartupPage };

interface WorkerReplies {
  scan: WorkerResult;
  graph: WorkerGraphResult;
  cache: CacheClassificationResult;
}

type WorkerReply = WorkerReplies[keyof WorkerReplies];
type WorkerMessage =
  | { type: "values"; id: number; values: WorkerValue[] }
  | { type: "large-value"; id: number; value: WorkerLargeValue }
  | { type: "graph-rows"; rows: unknown[] }
  | { type: "identity"; id: number; entries: TenantMatchEntry[] }
  | { type: "drop"; id: number }
  | WorkerJob;

const MAIN_SLICE_MS = 2;
const WORKER_TIMEOUT_MS = 3_000;
export const CLASSIFICATION_QUEUE_MAX_JOBS = 24;
export const CLASSIFICATION_QUEUE_MAX_BYTES = 128 * 1024 * 1024;

export class ClassificationWorkerRetiredError extends Error {}

interface QueuedJob {
  start(): void;
  reject(error: Error): void;
}

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
  private readonly queue = new Set<QueuedJob>();
  private active?: QueuedJob;
  private preparation?: Promise<void>;
  private reply?: (result: WorkerReply) => void;
  private failure?: Error;
  private nextId = 0;
  private queuedBytes = 0;
  readonly shards = new WeakMap<object, number>();

  constructor() {
    // The desktop uses compiled JavaScript. Runtime tests also exercise the
    // worker directly from TypeScript via the repository's tsx loader.
    const source = import.meta.url.endsWith(".ts");
    this.worker = source
      ? new Worker('require("tsx/esm/api").tsImport(require("node:worker_threads").workerData, __filename)',
        { eval: true, workerData: new URL("./classification-worker.ts", import.meta.url).href, execArgv: [] })
      : new Worker(new URL("./classification-worker.js", import.meta.url), { execArgv: [] });
    this.worker.on("message", (result: WorkerReply) => this.reply?.(result));
    this.worker.on("error", error => this.stop(error instanceof Error ? error : new Error("Classification worker failed.")));
    this.worker.on("exit", () => this.stop(new Error("Classification worker exited.")));
    this.worker.unref();
    this.garbage = new FinalizationRegistry(id => {
      this.release(id);
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
    this.release(id);
  }

  private release(id: number): void {
    if (this.failure) return;
    try { this.post({ type: "drop", id }); }
    catch { this.stop(new Error("Classification worker could not release evidence.")); }
  }

  post(message: WorkerMessage, transfers?: ArrayBuffer[]): void {
    if (this.failure) throw this.failure;
    this.worker.postMessage(message, transfers);
  }

  stop(error: Error): Promise<number> {
    if (this.termination) return this.termination;
    this.failure = error;
    if (worker === this) worker = undefined;
    this.termination = this.worker.terminate();
    const retired = Promise.all([this.termination, this.preparation]);
    retirements.add(retired);
    const released = () => { retirements.delete(retired); };
    void retired.then(released, released);
    this.active?.reject(error);
    for (const job of this.queue) job.reject(new ClassificationWorkerRetiredError(error.message, { cause: error }));
    return this.termination;
  }

  private termination?: Promise<number>;

  private startNext(): void {
    if (this.failure || this.active) return;
    const job = this.queue.values().next().value;
    if (!job) return;
    this.queue.delete(job);
    this.active = job;
    job.start();
  }

  run<T extends WorkerJob["type"]>(
    bytes: number,
    prepare: (client: ClassificationWorker) => Promise<{
      message: Extract<WorkerJob, { type: T }>; transfers?: ArrayBuffer[];
    }>,
    signal?: AbortSignal,
  ): Promise<WorkerReplies[T]> {
    if (this.failure) return Promise.reject(this.failure);
    if (signal?.aborted) return Promise.reject(new Error("Request classification was cancelled."));
    if (this.queue.size + Number(Boolean(this.active)) >= CLASSIFICATION_QUEUE_MAX_JOBS ||
        bytes > CLASSIFICATION_QUEUE_MAX_BYTES - this.queuedBytes) {
      return Promise.reject(new Error("Classification worker queue is full."));
    }
    const jobSignal = signal && AbortSignal.any([signal]);
    return new Promise<WorkerReplies[T]>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        jobSignal?.removeEventListener("abort", abort);
        this.queue.delete(job);
        if (this.active === job) {
          delete this.active;
          delete this.reply;
        }
        this.queuedBytes -= bytes;
        if (!this.failure && !this.queue.size && !this.active) this.worker.unref();
        queueMicrotask(() => this.startNext());
      };
      const cancel = (error: Error) => {
        if (this.active === job) void this.stop(error);
        else job.reject(error);
      };
      const abort = () => cancel(new Error("Request classification was cancelled."));
      const job: QueuedJob = {
        start: () => {
          this.reply = result => {
            finish();
            resolve(result as WorkerReplies[T]);
          };
          const preparation = Promise.resolve().then(() => {
            if (this.failure) throw this.failure;
            return prepare(this);
          }).then(({ message, transfers }) => this.post(message, transfers)).catch(error => {
            // A partially synchronized matcher is unsafe to reuse.
            void this.stop(error instanceof Error ? error : new Error("Classification worker failed."));
          });
          this.preparation = preparation;
          void preparation.then(() => {
            if (this.preparation === preparation) delete this.preparation;
          });
        },
        reject(error) {
          finish();
          reject(error);
        },
      };
      // Include queueing, synchronization and the worker scan in the deadline.
      const timer = setTimeout(() => cancel(new Error("Classification worker timed out.")), WORKER_TIMEOUT_MS);
      jobSignal?.addEventListener("abort", abort, { once: true });
      this.queuedBytes += bytes;
      this.worker.ref();
      this.queue.add(job);
      this.startNext();
    });
  }
}

const IDENTITY_BATCH_UNITS = 16_384;

export async function syncIdentityShards(
  client: ClassificationWorker, identityIndex: ClassificationOptions["identityIndex"], slice: ClassificationSlice,
): Promise<{ shards: number[]; isCurrent: () => boolean }> {
  const snapshot = [...identityIndex?.workerShards?.() ?? []];
  const mirrors: Array<[TenantValueIndex, number]> = [];
  for (const shard of snapshot) {
    let id = client.shards.get(shard);
    if (id === undefined) {
      id = client.id(shard);
      client.shards.set(shard, id);
      let entries: TenantMatchEntry[] = [];
      let units = 0;
      for (const entry of shard.workerEntries()) {
        if (client.shards.get(shard) !== id) break;
        entries.push(entry);
        units += entry[1].length + 24;
        if (units >= IDENTITY_BATCH_UNITS || slice.elapsed) {
          client.post({ type: "identity", id, entries });
          entries = [];
          units = 0;
          if (slice.elapsed) await slice.yield();
        }
      }
      if (entries.length && client.shards.get(shard) === id) client.post({ type: "identity", id, entries });
    }
    mirrors.push([shard, id]);
  }
  return {
    shards: mirrors.flatMap(([shard, id]) => client.shards.get(shard) === id ? [id] : []),
    isCurrent: () => {
      if (identityIndex && (!identityIndex.workerShards || identityIndex.isComplete?.() === false)) return false;
      const current = [...identityIndex?.workerShards?.() ?? []];
      return current.length === mirrors.length && mirrors.every(([shard, id], i) =>
        current[i] === shard && client.shards.get(shard) === id);
    },
  };
}

export async function classifyCacheRows(
  rows: CacheClassificationRow[], graphPath: string, identityIndex: ClassificationOptions["identityIndex"],
  indexValues: boolean, indexNames: boolean, signal?: AbortSignal, startup?: CacheStartupPage,
): Promise<CacheClassificationResult> {
  const bytes = rows.reduce((sum, row) =>
    sum + 64 + 2 * (row.rawJson.length + row.graphId.length + (row.displayName?.length ?? 0)), 128);
  return requestWorker().run<"cache">(bytes, async client => {
    const { shards } = await syncIdentityShards(client, identityIndex, new ClassificationSlice());
    return { message: { type: "cache", rows, graphPath, shards, indexValues, indexNames, startup } };
  }, signal);
}

let worker: ClassificationWorker | undefined;
const retirements = new Set<Promise<unknown>>();
let shutDown = false;

export function requestWorker(): ClassificationWorker {
  if (shutDown) throw new Error("Classification worker shut down.");
  return worker ??= new ClassificationWorker();
}

export async function retireClassificationWorker(): Promise<void> {
  // Drop messages normally bypass the job queue. Disconnect can also have
  // an active scan or staged messages, so retire and wait for actual exit.
  void worker?.stop(new ClassificationWorkerRetiredError("Classification worker retired for tenant removal."));
  await Promise.all(retirements);
}

export function shutdownClassificationWorker(): void {
  shutDown = true;
  void worker?.stop(new Error("Classification worker shut down."));
}

export function releaseClassificationIdentityShard(shard: object): void {
  const id = worker?.shards.get(shard);
  if (id === undefined || !worker) return;
  worker.shards.delete(shard);
  worker.drop(shard, id);
}

export type { WorkerMessage };
