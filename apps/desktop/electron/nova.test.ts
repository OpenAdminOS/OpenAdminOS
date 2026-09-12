import assert from "node:assert/strict";
import { it } from "node:test";
import {
  NovaService,
  buildNovaInstructions,
  boundedVoiceAnswer,
} from "./nova.js";
import type {
  AppState,
  SecretAccessor,
  SendIntuneChatMessageInput,
  SendIntuneChatMessageResult,
} from "@openadminos/agent-sdk";
function fixture(reply?: (url: string) => Response) {
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
    tenants: [{ id: "tenant-a", displayName: "Northwind" }],
    providers: [
      { id: "ollama", name: "Ollama", isLocal: true, status: "connected" },
    ],
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
      return (
        reply?.(String(url)) ??
        Response.json({ transport: { sdp: "answer" }, text: "hello" })
      );
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
  assert.equal(chats[0].refreshIfStale, true);
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

it("identifies the selected tenant without a cache or a reasoning request", async () => {
  const { nova, chats, state } = fixture();
  const { sessionId } = await nova.handle({
    action: "start",
    mode: "local",
    tenantId: "tenant-a",
    consent: false,
  });
  const answer = await nova.handle({
    action: "answer",
    sessionId: sessionId!,
    text: "Hey, are you connected to any tenant?",
  });
  assert.match(answer.text!, /Northwind/);
  assert.equal(chats.length, 0);
  const instructions = buildNovaInstructions(state, "Ugur");
  assert.match(instructions, /Northwind/);
  assert.match(instructions, /whether you can see devices/);
  assert.match(instructions, /Preloading is optional/);
});

it("retrieves devices on demand and bounds the spoken result", async () => {
  const { nova, chats } = fixture();
  const { sessionId } = await nova.handle({
    action: "start",
    mode: "local",
    tenantId: "tenant-a",
    consent: false,
  });
  await nova.handle({
    action: "answer",
    sessionId: sessionId!,
    text: "Do you see any of my devices?",
  });
  assert.equal(chats[0].refreshIfStale, true);
  const full = "Evidence. ".repeat(10000);
  assert.ok(boundedVoiceAnswer(full).length <= 2000);
  assert.match(boundedVoiceAnswer(full), /full answer and evidence.*Chat/);
});

it("blocks disconnected reasoning before microphone setup and keeps keys private", async () => {
  const { nova, state, requests } = fixture();
  state.providers[0].status = "error";
  await assert.rejects(
    nova.handle({ action: "check", mode: "openai" }),
    /reasoning provider/,
  );
  assert.equal(requests.length, 0);
  state.providers[0].status = "connected";
  await nova.handle({ action: "configure", apiKey: "test-key" });
  await nova.handle({ action: "check", mode: "openai", connectivity: false });
  assert.equal(
    requests.length,
    0,
    "Starting voice must not depend on Models API permission",
  );
});

it("checks both local speech services without a hosted request", async () => {
  const { nova, requests } = fixture((url) =>
    Response.json(
      url.endsWith("/health") ? { status: "ok" } : { data: [{ id: "kokoro" }] },
    ),
  );
  await nova.handle({ action: "check", mode: "local" });
  assert.deepEqual(
    requests.map((r) => r.url),
    ["http://127.0.0.1:8080/health", "http://127.0.0.1:8880/v1/models"],
  );
  const failed = fixture(() => new Response("loading", { status: 503 }));
  await assert.rejects(
    failed.nova.handle({ action: "check", mode: "local" }),
    /Whisper is not ready/,
  );
});

it("reports API credential failures without returning credential contents", async () => {
  const { nova } = fixture(() => new Response("Unauthorized", { status: 401 }));
  await nova.handle({ action: "configure", apiKey: "private-test-key" });
  await assert.rejects(
    nova.handle({ action: "check", mode: "openai" }),
    (error: Error) => {
      assert.match(error.message, /HTTP 401/);
      assert.doesNotMatch(error.message, /private-test-key/);
      return true;
    },
  );
});
