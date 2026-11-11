import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  auditGraphWritesFetch,
  createGraphAdapter,
  GraphWriteAuditError,
  GraphWriteUnauditedError,
  isGraphHost,
  type GraphWriteAuditSink,
} from "./graph-adapter.js";
import { GraphAccessDeniedError } from "@openadminos/agent-sdk";

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
  it("keeps granted MSAL scopes for opaque tokens and parses the full Graph code", async () => {
    const calls: RecordedCall[] = [];
    const adapter = createGraphAdapter({
      tokenProvider: async () => ({ accessToken: "opaque-secret-token", scopes: ["AuditLog.Read.All"] }),
      accessContext: () => ({ requiredScopes: ["AuditLog.Read.All"] }),
      fetchImpl: mockFetch([jsonResponse({ error: { message: "x".repeat(500), code: "Authentication_RequestFromNonPremiumTenantOrB2CTenant" } }, { status: 403 })], calls),
    });
    await assert.rejects(adapter.request({ method: "GET", path: "/auditLogs/signIns" }), error => {
      assert.ok(error instanceof GraphAccessDeniedError);
      assert.equal(error.accessDenial.cause, "missing-licence");
      assert.doesNotMatch(JSON.stringify(error), /opaque-secret-token/);
      assert.doesNotMatch(error.message, /reconnect/i);
      return true;
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.headers.authorization, "Bearer opaque-secret-token");
  });

  it("uses scp as a diagnostic fallback and leaves unparseable tokens unknown", async () => {
    for (const [token, cause] of [
      [`e30.${Buffer.from(JSON.stringify({ scp: "User.Read.All" })).toString("base64url")}.signature`, "missing-role"],
      [`e30.${Buffer.from(JSON.stringify({ scp: "AuditLog.Read.All" })).toString("base64url")}.signature`, "missing-consent"],
      ["opaque-token", "unknown"],
      ["not.a.token", "unknown"],
      [`e30.${Buffer.from(JSON.stringify({ roles: ["User.Read.All"] })).toString("base64url")}.signature`, "unknown"],
    ]) {
      const adapter = createGraphAdapter({ tokenProvider: async () => token!, accessContext: () => ({ requiredScopes: ["User.Read.All"] }),
        fetchImpl: mockFetch([jsonResponse({ error: { code: "Authorization_RequestDenied" } }, { status: 403 })], []),
      });
      await assert.rejects(adapter.request({ method: "GET", path: "/users" }), error => {
        assert.ok(error instanceof GraphAccessDeniedError);
        assert.equal(error.accessDenial.cause, cause);
        return true;
      });
    }
  });

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
      unauditedWrites: true,
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

  it("does NOT retry the retire helper on 5xx", async () => {
    const calls: RecordedCall[] = [];
    const adapter = createGraphAdapter({
      unauditedWrites: true,
      tokenProvider: async () => "t",
      maxRetries: 5,
      fetchImpl: mockFetch([new Response("boom", { status: 503 })], calls),
    });

    await assert.rejects(() => adapter.retireManagedDevice("device-1"), /HTTP 503/);
    assert.equal(calls.length, 1, "retire must never retry a possibly-applied POST");
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
      unauditedWrites: true,
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
      unauditedWrites: true,
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
      unauditedWrites: true,
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

describe("createGraphAdapter transient network faults", () => {
  it("retries an idempotent GET after a dropped connection and succeeds", async () => {
    const calls: RecordedCall[] = [];
    const adapter = createGraphAdapter({
      tokenProvider: async () => "t",
      maxRetries: 3,
      retryBackoffMs: 0,
      fetchImpl: mockFetch(
        [
          () => {
            throw new TypeError("fetch failed");
          },
          jsonResponse({ value: [{ id: "x" }] }),
        ],
        calls,
      ),
    });

    const result = await adapter.request({ method: "GET", path: "/users" });

    assert.deepEqual(result, { value: [{ id: "x" }] });
    assert.equal(calls.length, 2, "the dropped connection must be retried, not fatal");
  });

  it("retries a GET that times out", async () => {
    const calls: RecordedCall[] = [];
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    const adapter = createGraphAdapter({
      tokenProvider: async () => "t",
      maxRetries: 2,
      retryBackoffMs: 0,
      fetchImpl: mockFetch(
        [
          () => {
            throw abortError;
          },
          jsonResponse({ value: [] }),
        ],
        calls,
      ),
    });

    await adapter.request({ method: "GET", path: "/users" });
    assert.equal(calls.length, 2);
  });

  it("gives up after the retry budget and reports the network error", async () => {
    const calls: RecordedCall[] = [];
    const adapter = createGraphAdapter({
      tokenProvider: async () => "t",
      maxRetries: 2,
      retryBackoffMs: 0,
      fetchImpl: mockFetch(
        [
          () => {
            throw new TypeError("fetch failed");
          },
          () => {
            throw new TypeError("fetch failed");
          },
          () => {
            throw new TypeError("fetch failed");
          },
        ],
        calls,
      ),
    });

    await assert.rejects(
      () => adapter.request({ method: "GET", path: "/users" }),
      /Graph request failed/,
    );
    assert.equal(calls.length, 3, "one initial attempt plus maxRetries");
  });

  it("does NOT retry a POST that failed mid-flight", async () => {
    const calls: RecordedCall[] = [];
    const adapter = createGraphAdapter({
      unauditedWrites: true,
      tokenProvider: async () => "t",
      maxRetries: 3,
      retryBackoffMs: 0,
      fetchImpl: mockFetch(
        [
          () => {
            throw new TypeError("fetch failed");
          },
          jsonResponse({}),
        ],
        calls,
      ),
    });

    await assert.rejects(
      () =>
        adapter.request({
          method: "POST",
          path: "/deviceManagement/managedDevices/abc/retire",
        }),
      /Graph request failed/,
    );
    assert.equal(
      calls.length,
      1,
      "a timed-out write may already have applied upstream; retrying could double-apply it",
    );
  });

  it("treats caller cancellation as cancellation, not a retryable fault", async () => {
    const calls: RecordedCall[] = [];
    const controller = new AbortController();
    const adapter = createGraphAdapter({
      tokenProvider: async () => "t",
      maxRetries: 3,
      retryBackoffMs: 0,
      fetchImpl: mockFetch(
        [
          () => {
            controller.abort();
            const err = new Error("aborted");
            err.name = "AbortError";
            throw err;
          },
          jsonResponse({ value: [] }),
        ],
        calls,
      ),
    });

    await assert.rejects(
      () => adapter.request({ method: "GET", path: "/users", signal: controller.signal }),
      /cancelled/i,
    );
    assert.equal(calls.length, 1, "a user stop must not be retried");
  });

  it("does not start a request when the caller signal is already aborted", async () => {
    const calls: RecordedCall[] = [];
    const controller = new AbortController();
    controller.abort();
    const adapter = createGraphAdapter({
      tokenProvider: async () => "t",
      fetchImpl: mockFetch([jsonResponse({ value: [] })], calls),
    });

    await assert.rejects(
      () => adapter.request({ method: "GET", path: "/users", signal: controller.signal }),
      /cancelled/i,
    );
    assert.equal(calls.length, 0);
  });
});

describe("cancellation while acquiring a Graph token", () => {
  it("rejects promptly and never dispatches a late token after cancellation", async () => {
    const controller = new AbortController();
    let finish!: (token: string) => void;
    let fetchCount = 0;
    const graph = createGraphAdapter({
      unauditedWrites: true,
      signal: controller.signal,
      tokenProvider: () => new Promise<string>((resolve) => { finish = resolve; }),
      fetchImpl: async () => { fetchCount += 1; return new Response("{}"); },
    });
    const request = graph.request({ method: "PATCH", path: "/users/test", body: { accountEnabled: false } });
    controller.abort(new Error("Cancelled test"));
    await assert.rejects(request, /Cancelled test/);
    finish("late-token");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fetchCount, 0);
  });
});

describe("Graph write audit", () => {
  function recordingSink(events: unknown[], options: { failAttempted?: boolean; failResult?: boolean } = {}): GraphWriteAuditSink {
    return {
      attempted: async (attempt) => {
        if (options.failAttempted) throw new Error("disk full");
        events.push({ kind: "attempted", ...attempt });
      },
      result: async (result) => {
        if (options.failResult) throw new Error("database closed");
        events.push({ kind: "result", ...result });
      },
    };
  }

  it("records the attempt before the request is sent and the result after it, with one attempt id", async () => {
    const events: Array<Record<string, unknown>> = [];
    const calls: RecordedCall[] = [];
    const adapter = createGraphAdapter({
      tokenProvider: async () => "t",
      writeAudit: {
        attempted: async (attempt) => {
          assert.equal(calls.length, 0, "the attempt is recorded before anything is sent");
          events.push({ kind: "attempted", ...attempt });
        },
        result: async (result) => {
          events.push({ kind: "result", ...result });
        },
      },
      fetchImpl: mockFetch([
        new Response(JSON.stringify({ id: "g1" }), { status: 201, headers: { "request-id": "req-1" } }),
      ], calls),
    });
    await adapter.request({ method: "POST", path: "/groups", query: { $select: "id" }, body: { displayName: "Sales" } });
    assert.equal(calls.length, 1);
    assert.equal(events.length, 2);
    const [attempted, result] = events;
    assert.equal(attempted?.kind, "attempted");
    assert.equal(attempted?.method, "POST");
    assert.equal(attempted?.path, "/groups");
    assert.equal(attempted?.bodyDigest, createHash("sha256").update(JSON.stringify({ displayName: "Sales" })).digest("hex"));
    assert.doesNotMatch(JSON.stringify(events), /Sales/);
    assert.equal(result?.attemptId, attempted?.attemptId);
    assert.equal(result?.outcome, "ok");
    assert.equal(result?.status, 201);
    assert.equal(result?.requestId, "req-1");
    assert.equal(result?.attempts, 1);
  });

  it("records a failed write with its status and error class", async () => {
    const events: Array<Record<string, unknown>> = [];
    const adapter = createGraphAdapter({
      tokenProvider: async () => "t",
      writeAudit: recordingSink(events),
      fetchImpl: mockFetch([new Response("conflict", { status: 409, headers: { "client-request-id": "client-1" } })], []),
    });
    await assert.rejects(adapter.request({ method: "PATCH", path: "/users/u1", body: { city: "Berlin" } }), /HTTP 409/);
    const result = events[1];
    assert.equal(result?.outcome, "failed");
    assert.equal(result?.status, 409);
    assert.equal(result?.requestId, "client-1");
    assert.equal(result?.errorClass, "http-error");
  });

  it("records a write that failed before it was sent as not-sent", async () => {
    const events: Array<Record<string, unknown>> = [];
    const calls: RecordedCall[] = [];
    const adapter = createGraphAdapter({
      tokenProvider: async () => { throw new Error("sign-in required"); },
      writeAudit: recordingSink(events),
      fetchImpl: mockFetch([], calls),
    });
    await assert.rejects(adapter.retireManagedDevice("device-1"), /sign-in required/);
    assert.equal(calls.length, 0);
    assert.equal(events[0]?.path, "/deviceManagement/managedDevices/device-1/retire");
    assert.equal(events[1]?.errorClass, "not-sent");
    assert.equal(events[1]?.attempts, 0);
  });

  it("refuses the write and sends nothing when the attempt cannot be recorded", async () => {
    const calls: RecordedCall[] = [];
    const adapter = createGraphAdapter({
      tokenProvider: async () => "t",
      writeAudit: recordingSink([], { failAttempted: true }),
      fetchImpl: mockFetch([new Response(null, { status: 204 })], calls),
    });
    await assert.rejects(adapter.request({ method: "DELETE", path: "/groups/g1" }), (error) => {
      assert.ok(error instanceof GraphWriteAuditError);
      assert.match(error.message, /^DELETE \/groups\/g1 was not sent: the audit log could not record it\. disk full/);
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it("keeps a sent write's outcome when only its result cannot be recorded, and says so in the log", async () => {
    const logs: string[] = [];
    const adapter = createGraphAdapter({
      tokenProvider: async () => "t",
      writeAudit: recordingSink([], { failResult: true }),
      log: (level, message) => { if (level === "warn") logs.push(message); },
      fetchImpl: mockFetch([new Response(null, { status: 204 })], []),
    });
    await adapter.request({ method: "DELETE", path: "/groups/g1" });
    assert.ok(logs.some((message) => /audit log could not record the result of DELETE \/groups\/g1/.test(message)));
  });

  it("refuses every write when no audit sink is given, unless unaudited writes are asked for", async () => {
    const calls: RecordedCall[] = [];
    const adapter = createGraphAdapter({
      tokenProvider: async () => "t",
      fetchImpl: mockFetch([jsonResponse({ value: [] })], calls),
    });
    for (const method of ["POST", "PATCH", "PUT", "DELETE"] as const) {
      await assert.rejects(adapter.request({ method, path: "/groups/g1", body: {} }), (error) => {
        assert.ok(error instanceof GraphWriteUnauditedError);
        assert.match(error.message, new RegExp(`^${method} /groups/g1 was not sent: this Graph client has no audit log`));
        return true;
      });
    }
    await assert.rejects(adapter.retireManagedDevice("device-1"), GraphWriteUnauditedError);
    assert.equal(calls.length, 0);
    // Reads need no sink.
    await adapter.request({ method: "GET", path: "/groups" });
    assert.equal(calls.length, 1);

    const optedOut = createGraphAdapter({
      tokenProvider: async () => "t",
      unauditedWrites: true,
      fetchImpl: mockFetch([new Response(null, { status: 204 })], calls),
    });
    await optedOut.request({ method: "DELETE", path: "/groups/g1" });
    assert.equal(calls.at(-1)?.method, "DELETE");
  });

  it("does not record reads", async () => {
    const events: unknown[] = [];
    const adapter = createGraphAdapter({
      tokenProvider: async () => "t",
      writeAudit: recordingSink(events),
      fetchImpl: mockFetch([jsonResponse({ value: [] })], []),
    });
    await adapter.request({ method: "GET", path: "/groups" });
    assert.equal(events.length, 0);
  });
});

describe("isGraphHost", () => {
  it("matches the Graph hosts in any case, with or without one trailing dot", () => {
    for (const host of ["graph.microsoft.com", "graph.microsoft.com.", "GRAPH.MICROSOFT.COM.", "graph.microsoft.us.", "dod-graph.microsoft.us", "microsoftgraph.chinacloudapi.cn."]) {
      assert.equal(isGraphHost(host), true, host);
    }
    for (const host of ["graph.microsoft.com..", "evilgraph.microsoft.com", "graph.microsoft.com.example.com", "slack.com", ""]) {
      assert.equal(isGraphHost(host), false, host);
    }
  });
});

describe("auditGraphWritesFetch", () => {
  function recordingSink(events: Array<Record<string, unknown>>, options: { failAttempted?: boolean } = {}): GraphWriteAuditSink {
    return {
      attempted: async (attempt) => {
        if (options.failAttempted) throw new Error("database is closed");
        events.push({ kind: "attempted", ...attempt });
      },
      result: async (result) => {
        events.push({ kind: "result", ...result });
      },
    };
  }

  it("records a Graph write before it is sent and its result after, and passes reads and other hosts through", async () => {
    const events: Array<Record<string, unknown>> = [];
    const calls: RecordedCall[] = [];
    const audited = auditGraphWritesFetch(
      mockFetch([
        new Response(null, { status: 202, headers: { "request-id": "req-1" } }),
        jsonResponse({ value: [] }),
        jsonResponse({ ok: true }),
      ], calls),
      recordingSink(events),
    );
    const body = JSON.stringify({ message: { subject: "Report" } });
    await audited("https://graph.microsoft.com/beta/me/sendMail", { method: "POST", body });
    await audited("https://graph.microsoft.com/beta/me", { method: "GET" });
    await audited("https://slack.com/api/chat.postMessage", { method: "POST", body: "{}" });
    assert.equal(calls.length, 3);
    assert.equal(events.length, 2);
    const [attempted, result] = events;
    assert.deepEqual(attempted, {
      kind: "attempted",
      attemptId: result?.attemptId,
      method: "POST",
      path: "/me/sendMail",
      bodyDigest: createHash("sha256").update(body).digest("hex"),
    });
    assert.equal(result?.outcome, "ok");
    assert.equal(result?.status, 202);
    assert.equal(result?.requestId, "req-1");
    assert.equal(result?.attempts, 1);
  });

  it("records a write to the fully qualified Graph host with a trailing dot", async () => {
    const events: Array<Record<string, unknown>> = [];
    const audited = auditGraphWritesFetch(
      mockFetch([new Response(null, { status: 202 }), new Response(null, { status: 202 })], []),
      recordingSink(events),
    );
    await audited("https://graph.microsoft.com./beta/me/sendMail", { method: "POST", body: "{}" });
    await audited("https://GRAPH.microsoft.us./v1.0/groups/g1", { method: "DELETE" });
    assert.deepEqual(
      events.map((event) => `${String(event.kind)} ${String(event.method)} ${String(event.path)}`),
      ["attempted POST /me/sendMail", "result POST /me/sendMail", "attempted DELETE /groups/g1", "result DELETE /groups/g1"],
    );
  });

  it("records a refused Graph write as failed with its class", async () => {
    const events: Array<Record<string, unknown>> = [];
    const audited = auditGraphWritesFetch(mockFetch([new Response("{}", { status: 403 })], []), recordingSink(events));
    const response = await audited("https://graph.microsoft.com/v1.0/teams/t1/channels/c1/messages", { method: "POST", body: "{}" });
    assert.equal(response.status, 403);
    assert.equal(events[1]?.path, "/teams/t1/channels/c1/messages");
    assert.equal(events[1]?.outcome, "failed");
    assert.equal(events[1]?.errorClass, "access-denied");
  });

  it("sends nothing when the attempt cannot be recorded", async () => {
    const calls: RecordedCall[] = [];
    const audited = auditGraphWritesFetch(mockFetch([new Response(null, { status: 202 })], calls), recordingSink([], { failAttempted: true }));
    await assert.rejects(audited("https://graph.microsoft.com/beta/me/sendMail", { method: "POST", body: "{}" }), (error) => {
      assert.ok(error instanceof GraphWriteAuditError);
      assert.match(error.message, /^POST \/me\/sendMail was not sent: the audit log could not record it\. database is closed/);
      return true;
    });
    assert.equal(calls.length, 0);
  });
});
