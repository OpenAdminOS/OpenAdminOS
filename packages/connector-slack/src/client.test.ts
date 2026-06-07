import assert from "node:assert/strict";
import test from "node:test";

import { ConnectorAuthError } from "@openadminos/agent-sdk";

import { createSlackClient } from "./client.js";

test("Slack client posts message with bot bearer token", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createSlackClient({
    botToken: "xoxb-test",
    fetchImpl: (async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ ok: true, channel: "C123", ts: "171.2" });
    }) as typeof fetch,
  });

  const result = await client.postMessage({ channel: "C123", text: "hello" });

  assert.deepEqual(result, { channel: "C123", ts: "171.2" });
  assert.equal(calls[0]?.url, "https://slack.com/api/chat.postMessage");
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, "Bearer xoxb-test");
});

test("Slack client maps invalid_auth to ConnectorAuthError", async () => {
  const client = createSlackClient({
    botToken: "bad",
    fetchImpl: (async () => Response.json({ ok: false, error: "invalid_auth" })) as typeof fetch,
  });

  await assert.rejects(
    () => client.authTest(),
    (error) => error instanceof ConnectorAuthError,
  );
});
