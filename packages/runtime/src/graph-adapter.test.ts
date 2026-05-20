import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createGraphAdapter } from "./graph-adapter.js";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function mockFetch(
  responses: Array<Response | (() => Response)>,
  calls: RecordedCall[],
): typeof fetch {
  let i = 0;
  return (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers as Record<string, string> | undefined;
    if (rawHeaders) {
      for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v;
    }
    calls.push({
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const next = responses[i++];
    if (!next) throw new Error(`mockFetch: no response queued for call ${i}`);
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
}

describe("createGraphAdapter", () => {
  it("attaches the bearer token from the provider on every request", async () => {
    const calls: RecordedCall[] = [];
    const adapter = createGraphAdapter({
      tokenProvider: async () => "token-abc",
      fetchImpl: mockFetch([jsonResponse({ value: [] })], calls),
    });

    await adapter.request({ method: "GET", path: "/me" });

    assert.equal(calls[0]?.headers["authorization"], "Bearer token-abc");
  });

  it("rejects paths that do not start with '/'", async () => {
    const calls: RecordedCall[] = [];
    const adapter = createGraphAdapter({
      tokenProvider: async () => "t",
      fetchImpl: mockFetch([], calls),
    });

    await assert.rejects(
      () => adapter.request({ method: "GET", path: "me" }),
      /path must start with/,
    );
    assert.equal(calls.length, 0, "must not fire a request with an invalid path");
  });

  it("rejects unsupported HTTP methods", async () => {
    const calls: RecordedCall[] = [];
    const adapter = createGraphAdapter({
      tokenProvider: async () => "t",
      fetchImpl: mockFetch([], calls),
    });

    await assert.rejects(
      // @ts-expect-error - testing runtime guard
      () => adapter.request({ method: "OPTIONS", path: "/me" }),
      /unsupported method/,
    );
  });

  it("does NOT retry POST on 5xx (avoids duplicating non-idempotent writes)", async () => {
    const calls: RecordedCall[] = [];
    const adapter = createGraphAdapter({
      tokenProvider: async () => "t",
      maxRetries: 5,
      fetchImpl: mockFetch(
        [new Response("boom", { status: 500 })],
        calls,
      ),
    });

    await assert.rejects(
      () =>
        adapter.request({
          method: "POST",
          path: "/deviceManagement/managedDevices/abc/retire",
        }),
      /HTTP 500/,
    );
    assert.equal(calls.length, 1, "POST 500 must fail fast — retry would double-apply the write");
  });

  it("retries idempotent GET on 5xx and eventually succeeds", async () => {
    const calls: RecordedCall[] = [];
    const adapter = createGraphAdapter({
      tokenProvider: async () => "t",
      maxRetries: 3,
      fetchImpl: mockFetch(
        [
          new Response("boom", { status: 503, headers: { "retry-after": "0" } }),
          jsonResponse({ value: [{ id: "x" }] }),
        ],
        calls,
      ),
    });

    const out = (await adapter.request({ method: "GET", path: "/users" })) as {
      value: Array<{ id: string }>;
    };
    assert.equal(calls.length, 2);
    assert.equal(out.value[0]?.id, "x");
  });

  it("retries on 429 regardless of method (rate-limit signal)", async () => {
    const calls: RecordedCall[] = [];
    const adapter = createGraphAdapter({
      tokenProvider: async () => "t",
      maxRetries: 3,
      fetchImpl: mockFetch(
        [
          new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
          jsonResponse({ ok: true }),
        ],
        calls,
      ),
    });

    const out = await adapter.request({
      method: "POST",
      path: "/foo",
      body: { x: 1 },
    });
    assert.deepEqual(out, { ok: true });
    assert.equal(calls.length, 2);
  });

  it("surfaces 401 as a reconnect-required error and does not retry", async () => {
    const calls: RecordedCall[] = [];
    const adapter = createGraphAdapter({
      tokenProvider: async () => "stale",
      maxRetries: 5,
      fetchImpl: mockFetch(
        [new Response("nope", { status: 401 })],
        calls,
      ),
    });

    await assert.rejects(
      () => adapter.request({ method: "GET", path: "/me" }),
      /Tenant needs reconnect/,
    );
    assert.equal(calls.length, 1);
  });

  it("serialises a JSON body and sets content-type for writes", async () => {
    const calls: RecordedCall[] = [];
    const adapter = createGraphAdapter({
      tokenProvider: async () => "t",
      fetchImpl: mockFetch([jsonResponse({ ok: true })], calls),
    });

    await adapter.request({
      method: "POST",
      path: "/groups",
      body: { displayName: "Ops" },
    });

    assert.equal(calls[0]?.body, JSON.stringify({ displayName: "Ops" }));
    assert.equal(calls[0]?.headers["content-type"], "application/json");
  });

  it("builds a URL with query parameters appended", async () => {
    const calls: RecordedCall[] = [];
    const adapter = createGraphAdapter({
      tokenProvider: async () => "t",
      fetchImpl: mockFetch([jsonResponse({ value: [] })], calls),
    });

    await adapter.request({
      method: "GET",
      path: "/users",
      query: { $top: "5", $select: "id,displayName" },
    });

    const url = calls[0]?.url ?? "";
    assert.match(url, /\/users\?/);
    // URLSearchParams percent-encodes `$` as `%24` and `,` as `%2C`.
    assert.match(url, /(?:\$|%24)top=5/);
    assert.match(url, /(?:\$|%24)select=id(?:,|%2C)displayName/);
  });

  it("encodes the device id when retiring (path-injection guard)", async () => {
    const calls: RecordedCall[] = [];
    const adapter = createGraphAdapter({
      tokenProvider: async () => "t",
      fetchImpl: mockFetch(
        [new Response(null, { status: 204 })],
        calls,
      ),
    });

    await adapter.retireManagedDevice("weird/id with space");
    assert.match(calls[0]?.url ?? "", /weird%2Fid%20with%20space\/retire$/);
    assert.equal(calls[0]?.method, "POST");
  });

  it("rejects an empty deviceId on retireManagedDevice", async () => {
    const adapter = createGraphAdapter({
      tokenProvider: async () => "t",
      fetchImpl: mockFetch([], []),
    });
    await assert.rejects(
      () => adapter.retireManagedDevice(""),
      /non-empty deviceId/,
    );
  });
});
