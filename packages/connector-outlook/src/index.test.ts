import assert from "node:assert/strict";
import test from "node:test";

import { createOutlookGraphClient } from "./graph-client.js";

test("Outlook Graph client sends mail with delegated Mail.Send token", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createOutlookGraphClient({
    tenant: {
      tenantId: "tenant-1",
      username: "admin@example.com",
      async acquireTokenForScopes(scopes) {
        assert.deepEqual(scopes, ["https://graph.microsoft.com/Mail.Send"]);
        return "token-1";
      },
    },
    fetchImpl: (async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response("", { status: 202 });
    }) as typeof fetch,
  });

  await client.fetch({
    method: "POST",
    path: "/me/sendMail",
    scopes: ["Mail.Send"],
    capabilityId: "send-mail",
    body: { message: { subject: "Test" } },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://graph.microsoft.com/beta/me/sendMail");
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, "Bearer token-1");
  assert.equal(calls[0]?.init.method, "POST");
});

test("Outlook Graph client does not retry sendMail after a 5xx response", async () => {
  let calls = 0;
  const client = createOutlookGraphClient({
    tenant: {
      tenantId: "tenant-1",
      username: "admin@example.com",
      async acquireTokenForScopes() { return "token-1"; },
    },
    maxRetries: 5,
    fetchImpl: (async () => {
      calls += 1;
      return new Response("failed", { status: 503 });
    }) as typeof fetch,
  });

  await assert.rejects(
    () => client.fetch({
      method: "POST",
      path: "/me/sendMail",
      scopes: ["Mail.Send"],
      capabilityId: "send-mail",
      body: { message: { subject: "Test" } },
    }),
    /HTTP 503/,
  );
  assert.equal(calls, 1);
});
