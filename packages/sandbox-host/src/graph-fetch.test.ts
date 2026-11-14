import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GraphRequestAuditAttempt, GraphRequestAuditResult } from "@openadminos/runtime";

import { sandboxGraphFetch } from "./graph-fetch.js";
import { SandboxRefusal } from "./refusal.js";

function harness(options: { failAudit?: boolean } = {}) {
  const order: string[] = [];
  const attempts: GraphRequestAuditAttempt[] = [];
  const results: GraphRequestAuditResult[] = [];
  const stops: SandboxRefusal[] = [];
  const inits: RequestInit[] = [];
  const base = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    order.push(`sent ${String(input)}`);
    inits.push(init ?? {});
    return Response.json({ value: [] }, { headers: { "request-id": "req-1" } });
  }) as typeof fetch;
  const wrapped = sandboxGraphFetch({
    base,
    sink: {
      attempted(attempt) {
        order.push(`audited ${attempt.method} ${attempt.path}`);
        if (options.failAudit) throw new Error("disk full");
        attempts.push(attempt);
      },
      result(result) {
        order.push(`result ${result.outcome}`);
        results.push(result);
      },
    },
    onStop: (refusal) => stops.push(refusal),
  });
  return { wrapped, order, attempts, results, stops, inits };
}

describe("sandboxGraphFetch", () => {
  it("records each request before it is sent, with the path and a query digest only", async () => {
    const h = harness();
    await h.wrapped("https://graph.microsoft.com/beta/deviceManagement/managedDevices?$select=id,deviceName", { method: "GET", headers: { authorization: "Bearer t" } });
    assert.deepEqual(h.order, [
      "audited GET /deviceManagement/managedDevices",
      "sent https://graph.microsoft.com/beta/deviceManagement/managedDevices?$select=id,deviceName",
      "result ok",
    ]);
    assert.match(h.attempts[0]?.queryDigest ?? "", /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(h.attempts).includes("deviceName"), false);
    assert.equal(h.results[0]?.status, 200);
    assert.equal(h.results[0]?.requestId, "req-1");
    assert.equal(h.inits[0]?.redirect, "error");
  });

  it("refuses every method but GET before sending", async () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const h = harness();
      await assert.rejects(
        h.wrapped("https://graph.microsoft.com/beta/deviceManagement/managedDevices/1/retire", { method }),
        (error: unknown) => error instanceof SandboxRefusal && error.reason === "graph-request-refused",
      );
      assert.equal(h.order.some((entry) => entry.startsWith("sent")), false, method);
      assert.equal(h.results[0]?.outcome, "refused");
      assert.equal(h.stops.length, 1);
    }
  });

  it("refuses other origins, $batch, /me and unversioned paths before sending", async () => {
    for (const url of [
      "https://evil.example/beta/users",
      "https://graph.microsoft.com.evil.example/beta/users",
      "http://graph.microsoft.com/beta/users",
      "https://graph.microsoft.com/beta/$batch",
      "https://graph.microsoft.com/v1.0/me/messages",
      "https://graph.microsoft.com/users",
    ]) {
      const h = harness();
      await assert.rejects(h.wrapped(url, { method: "GET" }), SandboxRefusal, url);
      assert.equal(h.order.some((entry) => entry.startsWith("sent")), false, url);
    }
  });

  it("sends nothing and stops the run when the audit log cannot record the request", async () => {
    const h = harness({ failAudit: true });
    await assert.rejects(h.wrapped("https://graph.microsoft.com/beta/users", { method: "GET" }), (error: unknown) => error instanceof SandboxRefusal && error.reason === "audit-failed");
    assert.equal(h.order.some((entry) => entry.startsWith("sent")), false);
    assert.equal(h.stops[0]?.reason, "audit-failed");
  });
});
