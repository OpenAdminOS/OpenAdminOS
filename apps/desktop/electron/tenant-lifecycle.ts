import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The lifecycle of each Microsoft 365 tenant on this device, and the one
 * place that decides whether work for a tenant may still run, reach the
 * network or persist data.
 *
 * - `open`: connected; leased work runs.
 * - `closing`: Disconnect began (or its cleanup is pending after a failure
 *   or a restart). Nothing new starts, every lease's signal has fired, and
 *   the egress and persistence choke points refuse the tenant.
 * - `removed`: cleanup finished. The tenant may be connected again, which
 *   opens a new generation.
 *
 * Work runs inside `withTenantLease`. The lease carries the generation it
 * started in, is registered so Disconnect can drain it, and is also kept
 * in async context so a choke point can tell that a request or write comes
 * from work of an older generation, even after the tenant was reconnected.
 */
export type TenantPhase = "open" | "closing" | "removed";

export const TENANT_CLOSED_COPY =
  "This organization is being disconnected, so nothing new starts or applies for it.";

export class TenantClosedError extends Error {
  override readonly name = "TenantClosedError";
  /** What was refused, for the log only; the message is the user-facing copy. */
  constructor(readonly tenantId: string, readonly what?: string) {
    super(TENANT_CLOSED_COPY);
  }
}

export interface TenantLease {
  readonly tenantId: string;
  readonly generation: number;
  /** Fires when the tenant starts closing. */
  readonly signal: AbortSignal;
}

interface Entry {
  phase: TenantPhase;
  generation: number;
  controller: AbortController;
  work: Set<Promise<unknown>>;
}

export interface DrainResult {
  /** True when every leased piece of work settled within the bound. */
  drained: boolean;
  /** Work still running when the bound passed. */
  pending: number;
}

export class TenantLifecycle {
  private readonly entries = new Map<string, Entry>();
  private readonly context = new AsyncLocalStorage<readonly TenantLease[]>();

  constructor(private readonly log: (message: string, detail: Record<string, unknown>) => void = (message, detail) =>
    console.warn(`[tenant-lifecycle] ${message}`, detail)) {}

  private entry(tenantId: string): Entry {
    let entry = this.entries.get(tenantId);
    if (!entry) {
      entry = { phase: "open", generation: 1, controller: new AbortController(), work: new Set() };
      this.entries.set(tenantId, entry);
    }
    return entry;
  }

  phase(tenantId: string): TenantPhase {
    return this.entries.get(tenantId)?.phase ?? "open";
  }

  generation(tenantId: string): number {
    return this.entries.get(tenantId)?.generation ?? 1;
  }

  /** The innermost lease for this tenant in the current async context. */
  ambientLease(tenantId: string): TenantLease | undefined {
    const stack = this.context.getStore();
    if (!stack) return undefined;
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (stack[index]!.tenantId === tenantId) return stack[index];
    }
    return undefined;
  }

  /**
   * True while the tenant is open and the calling work, if it runs under a
   * lease for this tenant, belongs to the current generation.
   */
  isWritable(tenantId: string): boolean {
    const entry = this.entries.get(tenantId);
    if (entry && entry.phase !== "open") return false;
    const lease = this.ambientLease(tenantId);
    return !lease || lease.generation === (entry?.generation ?? 1);
  }

  /** Throw `TenantClosedError` unless `isWritable`. Logs the refusal. */
  assertWritable(tenantId: string, what: string): void {
    if (this.isWritable(tenantId)) return;
    this.log("refused", { tenantId, what, phase: this.phase(tenantId), generation: this.generation(tenantId), leaseGeneration: this.ambientLease(tenantId)?.generation });
    throw new TenantClosedError(tenantId, what);
  }

  /** The signal that fires when this tenant starts closing. */
  signal(tenantId: string): AbortSignal {
    return this.entry(tenantId).controller.signal;
  }

  /**
   * Run tenant work under a lease. Refuses when the tenant is not open,
   * registers the work so Disconnect can drain it, and exposes the lease
   * to the choke points through async context.
   */
  async withTenantLease<T>(tenantId: string, work: (lease: TenantLease) => Promise<T>): Promise<T> {
    this.assertWritable(tenantId, "start");
    const entry = this.entry(tenantId);
    const lease: TenantLease = { tenantId, generation: entry.generation, signal: entry.controller.signal };
    const stack = [...(this.context.getStore() ?? []), lease];
    const running = this.context.run(stack, () => work(lease));
    const tracked = running.then(() => undefined, () => undefined);
    entry.work.add(tracked);
    void tracked.finally(() => entry.work.delete(tracked));
    return running;
  }

  /** Lease several tenants at once, for work that spans them (multi-tenant Chat). */
  async withTenantLeases<T>(tenantIds: readonly string[], work: () => Promise<T>): Promise<T> {
    const unique = [...new Set(tenantIds)];
    const step = (index: number): Promise<T> =>
      index >= unique.length ? work() : this.withTenantLease(unique[index]!, () => step(index + 1));
    return step(0);
  }

  /** Begin closing: refuse new work and fire every lease's signal. */
  close(tenantId: string): void {
    const entry = this.entry(tenantId);
    if (entry.phase === "closing") return;
    entry.phase = "closing";
    entry.controller.abort(new TenantClosedError(tenantId));
  }

  /**
   * Disconnect could not record the removal: nothing changed, so the tenant
   * opens again in the same generation. Work that was stopped by the close
   * still saves its final state (a cancelled run, for example).
   */
  abortClose(tenantId: string): void {
    const entry = this.entry(tenantId);
    if (entry.phase !== "closing") return;
    entry.phase = "open";
    entry.controller = new AbortController();
  }

  /** Cleanup finished; the tenant may be connected again. */
  markRemoved(tenantId: string): void {
    const entry = this.entry(tenantId);
    if (entry.phase === "open") entry.controller.abort(new TenantClosedError(tenantId));
    entry.phase = "removed";
  }

  /**
   * Open a new generation for a tenant that is being connected. Refused
   * while its earlier disconnect is still cleaning up.
   */
  open(tenantId: string): void {
    const entry = this.entries.get(tenantId);
    if (!entry || entry.phase === "open") return;
    if (entry.phase === "closing") throw new TenantClosedError(tenantId, "cleanup pending");
    entry.phase = "open";
    entry.generation += 1;
    entry.controller = new AbortController();
  }

  /** Wait for leased work of this tenant to settle, at most `timeoutMs`. */
  async drain(tenantId: string, timeoutMs: number): Promise<DrainResult> {
    const entry = this.entries.get(tenantId);
    const deadline = Date.now() + timeoutMs;
    while (entry && entry.work.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { drained: false, pending: entry.work.size };
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all([...entry.work]),
        new Promise((resolve) => { timer = setTimeout(resolve, remaining); }),
      ]).finally(() => clearTimeout(timer));
    }
    return { drained: true, pending: 0 };
  }

  /**
   * A fetch that refuses the request, and every retry, once the tenant is
   * not writable for the calling work, and aborts with the tenant's signal.
   */
  guardedFetch(tenantId: string, base: typeof fetch = fetch): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      this.assertWritable(tenantId, `request ${new URL(url).host}`);
      const signal = init?.signal ? AbortSignal.any([init.signal, this.signal(tenantId)]) : this.signal(tenantId);
      return base(input, { ...init, signal });
    }) as typeof fetch;
  }

  /**
   * Wrap a token acquisition: refused before it starts, and its token
   * withheld if the tenant started closing while it was pending.
   */
  async guardToken<T>(tenantId: string, acquire: () => Promise<T>): Promise<T> {
    this.assertWritable(tenantId, "token");
    const result = await acquire();
    this.assertWritable(tenantId, "token");
    return result;
  }
}
