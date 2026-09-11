import assert from "node:assert/strict";
import { it } from "node:test";
import { NovaService } from "./nova.js";
import type {
  AppState,
  SecretAccessor,
  SendIntuneChatMessageInput,
  SendIntuneChatMessageResult,
} from "@openadminos/agent-sdk";
function fixture() {
  const values = new Map<string, string>();
  const secrets: SecretAccessor = {
    get: async (k) => values.get(k),
    set: async (k, v) => {
      values.set(k, v);
    },
    remove: async (k) => {
      values.delete(k);
    },
  };
  const state = {
    activeTenantId: "tenant-a",
    activeProviderId: "ollama",
    providers: [{ id: "ollama", isLocal: true }],
  } as AppState;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const chats: SendIntuneChatMessageInput[] = [];
  const nova = new NovaService(
    secrets,
    async () => state,
    async (input) => {
      chats.push(input);
      return {
        conversation: { id: "conversation-a" },
        assistantMessage: { content: "42 devices", status: "completed" },
      } as SendIntuneChatMessageResult;
    },
    async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({ transport: { sdp: "answer" }, text: "hello" });
    },
  );
  return { nova, state, requests, chats };
}
it("hosted voice requires consent, uses client delegation, and does not return the key", async () => {
  const { nova, requests } = fixture();
  await nova.handle({ action: "configure", apiKey: "test-key" });
  await assert.rejects(
    nova.handle({
      action: "start",
      mode: "openai",
      tenantId: "tenant-a",
      consent: false,
      sdp: "v=0",
    }),
    /Confirm/,
  );
  assert.equal(requests.length, 0);
  const result = await nova.handle({
    action: "start",
    mode: "openai",
    tenantId: "tenant-a",
    consent: true,
    sdp: "v=0",
  });
  assert.equal(result.sdp, "answer");
  assert.equal(JSON.stringify(result).includes("test-key"), false);
  assert.equal(requests[0].url, "https://api.openai.com/v1/live/sessions");
  const body = JSON.parse(String(requests[0].init?.body));
  assert.equal(body.session.model, "gpt-live-1");
  assert.equal(body.session.delegation.type, "client");
});
it("local voice never connects to OpenAI and rejects stale tenant sessions", async () => {
  const { nova, state, requests, chats } = fixture();
  const { sessionId } = await nova.handle({
    action: "start",
    mode: "local",
    tenantId: "tenant-a",
    consent: false,
  });
  await nova.handle({
    action: "answer",
    sessionId: sessionId!,
    text: "Device count?",
  });
  assert.equal(requests.length, 0);
  assert.equal(chats[0].hostedProviderConsent, undefined);
  assert.equal(chats[0].refreshIfStale, false);
  state.activeTenantId = "tenant-b";
  await assert.rejects(
    nova.handle({ action: "answer", sessionId: sessionId!, text: "Devices?" }),
    /changed/,
  );
  assert.equal(chats.length, 1);
});
it("stop invalidates a session and local mode refuses hosted reasoning", async () => {
  const { nova, state } = fixture();
  const { sessionId } = await nova.handle({
    action: "start",
    mode: "local",
    tenantId: "tenant-a",
    consent: false,
  });
  await nova.handle({ action: "stop" });
  await assert.rejects(
    nova.handle({ action: "answer", sessionId: sessionId!, text: "Devices?" }),
    /changed/,
  );
  state.providers[0].isLocal = false;
  await assert.rejects(
    nova.handle({
      action: "start",
      mode: "local",
      tenantId: "tenant-a",
      consent: false,
    }),
    /local agent/,
  );
});

it("greetings and navigation are bounded and do not invoke tenant tools", async () => {
  const { nova, chats } = fixture();
  const { sessionId } = await nova.handle({
    action: "start",
    mode: "local",
    tenantId: "tenant-a",
    consent: false,
    name: "Ugur",
  });
  assert.deepEqual(
    await nova.handle({
      action: "answer",
      sessionId: sessionId!,
      text: "Hey Nova",
    }),
    { text: "Hey Ugur, how are you?" },
  );
  assert.deepEqual(
    await nova.handle({
      action: "answer",
      sessionId: sessionId!,
      text: "Open Agent Team",
    }),
    { text: "Opening agent team.", route: "/office" },
  );
  assert.equal(chats.length, 0);
});
