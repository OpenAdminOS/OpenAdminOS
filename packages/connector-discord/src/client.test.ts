import assert from "node:assert/strict";
import test from "node:test";

import { createDiscordWebhookClient } from "./client.js";

test("Discord client executes webhook with wait=true and mentions disabled", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createDiscordWebhookClient({
    webhookUrl: "https://discord.com/api/webhooks/123/token",
    fetchImpl: (async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ id: "msg-1", channel_id: "chan-1" });
    }) as typeof fetch,
  });

  const result = await client.sendMessage({ text: "@everyone hello", threadId: "thread-1" });

  assert.deepEqual(result, { id: "msg-1", channelId: "chan-1" });
  assert.equal(calls[0]?.url, "https://discord.com/api/webhooks/123/token?wait=true&thread_id=thread-1");
  assert.equal(
    calls[0]?.init.body,
    JSON.stringify({
      content: "@everyone hello",
      allowed_mentions: { parse: [] },
    }),
  );
});

test("discord client sends flag 4 only when embeds are suppressed", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ id: "m1" });
  }) as typeof fetch;
  const webhookUrl = "https://discord.com/api/webhooks/123/token";
  await createDiscordWebhookClient({ webhookUrl, fetchImpl }).sendMessage({ text: "a" });
  await createDiscordWebhookClient({ webhookUrl, fetchImpl, suppressEmbeds: true }).sendMessage({ text: "b" });
  assert.equal(bodies[0]?.flags, undefined);
  assert.equal(bodies[1]?.flags, 4);
});
