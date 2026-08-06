import assert from "node:assert/strict";
import test from "node:test";

import { createTeamsGraphClient } from "./graph-client.js";

function tenant() {
  return {
    tenantId: "tenant-1",
    username: "admin@example.com",
    async acquireTokenForScopes(scopes: string[]) {
      assert.ok(scopes.every((scope) => scope.startsWith("https://graph.microsoft.com/")));
      return "token-1";
    },
  };
}

test("Teams Graph client uses the required beta endpoint", async () => {
  const urls: string[] = [];
  const client = createTeamsGraphClient({
    tenant: tenant(),
    fetchImpl: (async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ value: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  await client.fetch({
    method: "GET",
    path: "/me/joinedTeams",
    scopes: ["Team.ReadBasic.All"],
    capabilityId: "list-teams",
  });
  assert.deepEqual(urls, ["https://graph.microsoft.com/beta/me/joinedTeams"]);
});

test("Teams Graph client does not retry message POST after a 5xx response", async () => {
  let calls = 0;
  const client = createTeamsGraphClient({
    tenant: tenant(),
    maxRetries: 5,
    fetchImpl: (async () => {
      calls += 1;
      return new Response("failed", { status: 503 });
    }) as typeof fetch,
  });
  await assert.rejects(
    () => client.fetch({
      method: "POST",
      path: "/chats/chat-1/messages",
      scopes: ["ChatMessage.Send"],
      capabilityId: "post-chat-message",
      body: { body: { content: "hello" } },
    }),
    /HTTP 503/,
  );
  assert.equal(calls, 1);
});
