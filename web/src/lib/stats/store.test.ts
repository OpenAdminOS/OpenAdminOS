import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { createStatsStore, StatsStorageError } from "./store";

test("store sends aggregate install records and scoped IP hashes to the RPC client", async () => {
  const calls: [string, unknown][] = [];
  const replies = [null, true, false, true, true, true, true, true, false, true];
  const store = createStatsStore({
    async rpc(name, args) {
      calls.push([name, args]);
      return { data: replies.shift(), error: null };
    },
  }, "test-key");
  const ip = "192.0.2.1";
  const request = new Request("https://example.test", {
    headers: { "x-vercel-forwarded-for": ip, "x-real-ip": "198.51.100.1", "x-forwarded-for": "198.51.100.2" },
  });
  const forwardedOnly = new Request("https://example.test", { headers: { "x-forwarded-for": ip } });

  await store.recordInstall("sample-agent", "2026-11-24");
  assert.equal(await store.rateLimitHit("install", request, 60, 30), true);
  assert.equal(await store.rateLimitHit("install", request, 60, 30), false);
  // The database owns window expiry and allows a request in a fresh window.
  assert.equal(await store.rateLimitHit("install", request, 60, 30), true);
  assert.equal(await store.rateLimitHit("agent-submit", request, 60, 30), true);
  assert.equal(await store.rateLimitHit("support-issue", request, 60, 30), true);
  assert.equal(await store.rateLimitHit("install", forwardedOnly, 60, 30), true);
  for (const expected of [true, false, true]) {
    assert.equal(await store.claimSupportDedup("report-hash", 86400), expected);
  }

  const rateCall = (scope: string, address = ip) => ["rate_limit_hit", {
    p_scope: scope,
    p_key_hash: createHmac("sha256", "test-key").update(`${scope}\n${address}`).digest("hex"),
    p_window_seconds: 60,
    p_max: 30,
  }];
  assert.deepEqual(calls, [
    ["record_install", { p_slug: "sample-agent", p_day: "2026-11-24" }],
    ...Array.from({ length: 3 }, () => rateCall("install")),
    rateCall("agent-submit"),
    rateCall("support-issue"),
    rateCall("install", "unknown"),
    ...Array.from({ length: 3 }, () => ["claim_support_dedup", {
      p_hash: "report-hash", p_ttl_seconds: 86400,
    }]),
  ]);
  assert.equal(JSON.stringify(calls).includes(ip), false);
});

test("RPC errors are surfaced without echoing upstream response data", async () => {
  const store = createStatsStore({
    async rpc() {
      return { data: null, error: { code: "PGRST106", message: "private upstream details" } };
    },
  }, "test-key");
  await assert.rejects(store.health(), {
    name: StatsStorageError.name,
    message: "health failed (PGRST106).",
  });
});
