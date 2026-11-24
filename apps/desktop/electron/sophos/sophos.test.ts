import assert from "node:assert/strict";
import test from "node:test";

import { SophosApi } from "./api.js";
import { prepareSophosPlan } from "./plans.js";
import { readSophos } from "./reads.js";

const id = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const identity = { tenantId: id, host: "api-eu01.central.sophos.com" };
const token = { access_token: "fixture-token", token_type: "bearer", expires_in: 3600 };
const whoami = { id, idType: "tenant", apiHosts: { dataRegion: `https://${identity.host}` } };
const credentials = { clientId: "fixture-client", clientSecret: "fixture-secret" };

test("Sophos uses a form credential exchange, refreshes before expiry and pins regional requests", async () => {
  let time = 0;
  let exchanges = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    assert.equal(init?.redirect, "manual");
    if (target.hostname === "id.sophos.com") {
      exchanges++;
      assert.equal(target.pathname, "/api/v2/oauth2/token");
      assert.equal(init?.method, "POST");
      assert.deepEqual(Object.fromEntries(init?.body as URLSearchParams), {
        grant_type: "client_credentials", scope: "token", client_id: credentials.clientId, client_secret: credentials.clientSecret,
      });
      return Response.json(token);
    }
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), "Bearer fixture-token");
    if (target.hostname === "api.central.sophos.com") {
      assert.equal(target.pathname, "/whoami/v1");
      assert.equal(headers.get("X-Tenant-ID"), null);
      return Response.json(whoami);
    }
    assert.equal(target.hostname, identity.host);
    assert.equal(headers.get("X-Tenant-ID"), id);
    return Response.json({ items: [] });
  };
  const api = new SophosApi(credentials, { fetch: fetcher, now: () => time });
  assert.deepEqual(await api.identify(), identity);
  await api.read(identity, "endpoints");
  assert.equal(exchanges, 1);
  time = 3_599_000;
  await api.read(identity, "endpoints");
  assert.equal(exchanges, 2);
});

test("Sophos refuses partner and organization identities and unexpected regions", async () => {
  for (const idType of ["partner", "organization"]) {
    const api = new SophosApi(credentials, {
      fetch: async (url) => Response.json(String(url).includes("whoami") ? { ...whoami, idType } : token),
    });
    await assert.rejects(api.identify(), /Partner and organization credentials/);
  }
  for (const dataRegion of ["https://api-eu01.central.sophos.com.evil.test", "http://api-eu01.central.sophos.com", "https://api-eu01.central.sophos.com:8443", "https://api-eu01.central.sophos.com/path", "https://api-eu01.central.sophos.com\n"]) {
    const api = new SophosApi(credentials, {
      fetch: async (url) => Response.json(String(url).includes("whoami") ? { ...whoami, apiHosts: { dataRegion } } : token),
    });
    await assert.rejects(api.identify(), /unexpected response/);
  }
});

test("Sophos uses key, cursor and numbered paging and sends filters only to the regional API", async () => {
  const requests: URL[] = [];
  const api = new SophosApi(credentials, { fetch: async (url) => {
    const target = new URL(String(url));
    if (target.hostname === "id.sophos.com") return Response.json(token);
    requests.push(target);
    if (target.pathname.includes("siem")) return Response.json({ items: [], has_more: true, next_cursor: "next-event" });
    if (target.pathname.includes("firewall")) return Response.json({ items: [], pages: { current: 2, total: 3 } });
    return Response.json({ items: [], pages: { nextKey: "next-item", maxSize: 50 } });
  } });
  assert.equal((await readSophos(api, identity, "sophos_list_endpoints", { next: "first", tamperProtectionEnabled: false })).page?.next, "next-item");
  assert.equal(requests[0]?.searchParams.get("pageFromKey"), "first");
  assert.equal(requests[0]?.searchParams.get("tamperProtectionEnabled"), "false");
  assert.equal((await readSophos(api, identity, "sophos_list_alerts", { severity: ["high", "medium"] })).page?.next, "next-item");
  assert.equal(requests[1]?.searchParams.get("severity"), "high,medium");
  assert.equal((await readSophos(api, identity, "sophos_list_events", { next: "first-event" })).page?.next, "next-event");
  assert.equal(requests[2]?.searchParams.get("cursor"), "first-event");
  assert.equal((await readSophos(api, identity, "sophos_list_firewall_groups", { next: 2 })).page?.next, 3);
  assert.equal(requests[3]?.searchParams.get("pageTotal"), "true");
});

test("Sophos returns designed errors and bounds retries without echoing the response", async () => {
  for (const [status, expected, calls] of [[401, /expired/, 1], [403, /Read-Only/, 1], [429, /rate limiting/, 4], [503, /temporarily unavailable/, 4], [307, /redirected/, 1]] as const) {
    let requests = 0;
    const api = new SophosApi(credentials, { wait: async () => {}, fetch: async (url) => {
      if (String(url).includes("id.sophos.com")) return Response.json(token);
      requests++;
      return new Response(credentials.clientSecret, { status });
    } });
    await assert.rejects(api.read(identity, "endpoints"), (error: Error) => expected.test(error.message) && !error.message.includes(credentials.clientSecret));
    assert.equal(requests, calls);
  }
});

test("Sophos prepares exact endpoint targets with typed confirmation without making a write", async () => {
  const api = new SophosApi(credentials, { fetch: async (url, init) => {
    const target = new URL(String(url));
    if (target.hostname === "id.sophos.com") return Response.json(token);
    assert.equal(init?.method, undefined);
    assert.equal(target.searchParams.get("ids"), id);
    return Response.json({ items: [{ id, hostname: "LAB-01", isolation: { status: "notIsolated" } }] });
  } });
  const plan = await prepareSophosPlan(api, identity, { organizationId: "lab", kind: "isolate", targetIds: [id], comment: "Investigate" });
  assert.equal(plan.confirmationPhrase, "ISOLATE 1 DEVICE");
  assert.equal(plan.actions[0]?.id, id);
  assert.match(plan.actions[0]?.description ?? "", /notIsolated → Isolated/);
  await assert.rejects(prepareSophosPlan(api, identity, { organizationId: "lab", kind: "isolate", targetIds: [id] }), /isolation reason/);
});

test("Sophos change denials identify Management and uncertain writes are not retried", async () => {
  for (const [status, message] of [[403, /Service Principal Management/], [503, /did not confirm/]] as const) {
    let writes = 0;
    const api = new SophosApi(credentials, { fetch: async (url, init) => {
      if (String(url).includes("id.sophos.com")) return Response.json(token);
      writes++;
      assert.deepEqual(JSON.parse(String(init?.body)), { ids: [id] });
      return new Response(null, { status });
    } });
    await assert.rejects(api.change(identity, "scan", [id]), message);
    assert.equal(writes, 1);
  }
});

test("Sophos times out with a recovery message", async () => {
  const api = new SophosApi(credentials, { timeoutMs: 5, fetch: async (url, init) => {
    if (String(url).includes("id.sophos.com")) return Response.json(token);
    return new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error("fixture deadline")), 100);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(init.signal?.reason);
      }, { once: true });
    });
  } });
  await assert.rejects(api.read(identity, "endpoints"), /did not answer in time/);
});
