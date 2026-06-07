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
