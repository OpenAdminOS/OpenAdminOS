import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createGraphAdapter } from "./graph-adapter.js";

/** A response whose body never ends, erroring only when the request's signal aborts, as fetch does. */
function stalledBody(init?: RequestInit): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"value":['));
      init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

describe("graph adapter cancellation", () => {
  it("times out a response that stalls after its headers", async () => {
    const graph = createGraphAdapter({
      tokenProvider: async () => "token",
      fetchImpl: (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => stalledBody(init)) as typeof fetch,
      timeoutMs: 50,
      maxRetries: 0,
    });
    await assert.rejects(graph.request({ method: "GET", path: "/users" }), /timed out after 50ms while reading the response/);
  });

  it("stops a stalled body when the caller aborts", async () => {
    const controller = new AbortController();
    const graph = createGraphAdapter({
      tokenProvider: async () => "token",
      signal: controller.signal,
      fetchImpl: (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => stalledBody(init)) as typeof fetch,
      timeoutMs: 60_000,
    });
    const timer = setTimeout(() => controller.abort(), 30);
    try {
      await assert.rejects(graph.request({ method: "GET", path: "/users" }), /cancelled/);
    } finally {
      clearTimeout(timer);
    }
  });

  it("ends the Retry-After wait of a 429 when the caller aborts", async () => {
    const controller = new AbortController();
    let calls = 0;
    const graph = createGraphAdapter({
      tokenProvider: async () => "token",
      signal: controller.signal,
      fetchImpl: (async () => {
        calls += 1;
        return new Response("{}", { status: 429, headers: { "retry-after": "50" } });
      }) as typeof fetch,
    });
    const timer = setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    try {
      await assert.rejects(graph.request({ method: "GET", path: "/users" }), /cancelled/);
    } finally {
      clearTimeout(timer);
    }
    assert.ok(Date.now() - started < 5_000, "the wait ended with the abort");
    assert.equal(calls, 1);
  });
});

/** A response whose body fails to read for a reason other than an abort. */
function brokenBody(status: number): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new TypeError("terminated"));
    },
  });
  return new Response(body, { status });
}

describe("graph adapter body read failures keep their earlier meaning", () => {
  it("reports the HTTP status of an error response whose body cannot be read", async () => {
    const graph = createGraphAdapter({ tokenProvider: async () => "token", fetchImpl: (async () => brokenBody(500)) as typeof fetch, maxRetries: 0 });
    await assert.rejects(graph.request({ method: "GET", path: "/users" }), /Graph responded with HTTP 500 for .*\/users: $/);
  });

  it("treats an unreadable body of a request that expects none as empty", async () => {
    const graph = createGraphAdapter({ tokenProvider: async () => "token", fetchImpl: (async () => brokenBody(200)) as typeof fetch, unauditedWrites: true });
    assert.equal(await graph.request({ method: "DELETE", path: "/users/1" }), undefined);
  });

  it("fails a JSON success whose body cannot be read with the read error", async () => {
    const graph = createGraphAdapter({ tokenProvider: async () => "token", fetchImpl: (async () => brokenBody(200)) as typeof fetch });
    await assert.rejects(graph.request({ method: "GET", path: "/users" }), /terminated/);
  });
});
