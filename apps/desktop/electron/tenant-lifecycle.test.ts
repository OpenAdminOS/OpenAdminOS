import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RunRecord, TenantRecord } from "@openadminos/agent-sdk";

import { TenantClosedError, TenantLifecycle } from "./tenant-lifecycle.js";
import { filterClosedTenantChanges, sanitizeTenantRemovals, tenantCleanupPendingMessage } from "./tenant-removal.js";

const quiet = () => undefined;

describe("tenant lifecycle", () => {
  it("refuses a lease once the tenant closes, fires the lease signal and drains the work", async () => {
    const lifecycle = new TenantLifecycle(quiet);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let aborted = false;
    const work = lifecycle.withTenantLease("t1", async (lease) => {
      lease.signal.addEventListener("abort", () => (aborted = true));
      await held;
      return "done";
    });
    lifecycle.close("t1");
    assert.equal(aborted, true);
    assert.equal(lifecycle.phase("t1"), "closing");
    await assert.rejects(lifecycle.withTenantLease("t1", async () => "late"), TenantClosedError);
    const early = await lifecycle.drain("t1", 20);
    assert.deepEqual(early, { drained: false, pending: 1 });
    release();
    assert.equal(await work, "done");
    assert.deepEqual(await lifecycle.drain("t1", 1000), { drained: true, pending: 0 });
  });

  it("refuses work of an older generation after the tenant is connected again", async () => {
    const lifecycle = new TenantLifecycle(quiet);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const stale = lifecycle.withTenantLease("t1", async () => {
      await held;
      // Written after the tenant was removed and connected again.
      lifecycle.assertWritable("t1", "late write");
    });
    lifecycle.close("t1");
    lifecycle.markRemoved("t1");
    lifecycle.open("t1");
    assert.equal(lifecycle.generation("t1"), 2);
    assert.equal(lifecycle.isWritable("t1"), true);
    release();
    await assert.rejects(stale, TenantClosedError);
    // New work of the new connection is fine.
    await lifecycle.withTenantLease("t1", async () => lifecycle.assertWritable("t1", "new write"));
  });

  it("does not open a tenant whose cleanup is pending, and reopens one whose removal could not be recorded", () => {
    const lifecycle = new TenantLifecycle(quiet);
    lifecycle.close("t1");
    assert.throws(() => lifecycle.open("t1"), TenantClosedError);
    lifecycle.abortClose("t1");
    assert.equal(lifecycle.phase("t1"), "open");
    assert.equal(lifecycle.generation("t1"), 1);
    assert.equal(lifecycle.signal("t1").aborted, false);
  });

  it("guards fetch and token acquisition before every call, and withholds a token that arrives after closing began", async () => {
    const lifecycle = new TenantLifecycle(quiet);
    const calls: string[] = [];
    const base = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("{}");
    }) as typeof fetch;
    const guarded = lifecycle.guardedFetch("t1", base);
    await guarded("https://graph.microsoft.com/v1.0/users");
    let release!: (token: string) => void;
    const pending = lifecycle.guardToken("t1", () => new Promise<string>((resolve) => (release = resolve)));
    lifecycle.close("t1");
    release("token");
    await assert.rejects(pending, TenantClosedError);
    await assert.rejects(guarded("https://graph.microsoft.com/v1.0/users"), TenantClosedError);
    assert.deepEqual(calls, ["https://graph.microsoft.com/v1.0/users"]);
    await assert.rejects(lifecycle.guardToken("t1", async () => "never"), TenantClosedError);
  });
});

describe("state file write filter", () => {
  const tenant = (id: string) => ({ id, displayName: id, username: `admin@${id}`, homeAccountId: `home-${id}`, addedAt: "2026-11-01T00:00:00.000Z" }) as TenantRecord;
  const run = (id: string, tenantId: string, status = "completed") => ({ id, tenantId, status, agentSlug: "a", queuedAt: "2026-11-01T00:00:00.000Z", steps: [], logs: [] }) as unknown as RunRecord;

  it("allows removals but drops additions and changes for a tenant that is not writable", () => {
    const before = {
      tenants: [tenant("open"), tenant("closing")],
      runs: [run("r-open", "open"), run("r-closing", "closing", "running")],
      runDeliveryQueue: [{ runId: "r-closing" }],
      novaConnectorAudit: [{ tenantId: "closing", n: 1 }],
      activeTenantId: "open",
    };
    const next = {
      tenants: [tenant("open"), { ...tenant("closing"), displayName: "renamed" }, tenant("new-closing")],
      runs: [run("r-open", "open", "running"), run("r-closing", "closing", "completed"), run("r-late", "closing")],
      runDeliveryQueue: [{ runId: "r-closing" }, { runId: "r-late" }],
      novaConnectorAudit: [{ tenantId: "closing", n: 1 }, { tenantId: "closing", n: 2 }, { tenantId: "open", n: 3 }],
      activeTenantId: "closing",
      gateway: { boundTenantId: "closing" },
    };
    const closed = new Set(["closing", "new-closing"]);
    const { state, dropped } = filterClosedTenantChanges(next, before, (id) => !closed.has(id));
    assert.deepEqual(state.tenants.map((entry) => [entry.id, entry.displayName]), [["open", "open"], ["closing", "closing"]]);
    assert.deepEqual(state.runs.map((entry) => [entry.id, entry.status]), [["r-open", "running"], ["r-closing", "running"]]);
    assert.deepEqual(state.runDeliveryQueue, [{ runId: "r-closing" }]);
    assert.deepEqual(state.novaConnectorAudit, [{ tenantId: "closing", n: 1 }, { tenantId: "open", n: 3 }]);
    assert.equal(state.activeTenantId, "open");
    assert.equal(state.gateway?.boundTenantId, undefined);
    assert.ok(dropped.length >= 6);
    // Removing everything of the closing tenant passes untouched.
    const removal = filterClosedTenantChanges({ tenants: [tenant("open")], runs: [run("r-open", "open")] }, before, (id) => !closed.has(id));
    assert.deepEqual(removal.dropped, []);
  });

  it("reads removal records and words the pending cleanup message", () => {
    assert.deepEqual(sanitizeTenantRemovals([{ tenantId: "t1", displayName: "Contoso", removedAt: "x", error: "Locked." }, { nope: 1 }]), [
      { tenantId: "t1", displayName: "Contoso", removedAt: "x", error: "Locked." },
    ]);
    assert.equal(
      tenantCleanupPendingMessage({ displayName: "Contoso", error: "The Microsoft sign-in could not be removed. Locked." }),
      "Disconnecting Contoso has not finished on this device: The Microsoft sign-in could not be removed. Locked. Retry cleanup on Connections, then connect again.",
    );
  });
});
