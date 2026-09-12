import assert from "node:assert/strict";
import { it } from "node:test";
import {
  NovaService,
  buildNovaInstructions,
  boundedVoiceAnswer,
  type NovaChatOptions,
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
  const chatOptions: NovaChatOptions[] = [];
  const nova = new NovaService(
    secrets,
    async () => state,
    async (input, options) => {
      chatOptions.push(options);
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
  return { nova, state, requests, chats, secrets, chatOptions };
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

it("does not resurrect a session when Stop overtakes a slow state lookup", async () => {
  const { state, secrets } = fixture();
  let release!: (state: AppState) => void;
  let requests = 0;
  const nova = new NovaService(
    secrets,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    async () => {
      throw Error("Unexpected chat");
    },
    async () => {
      requests++;
      return Response.json({});
    },
  );
  const starting = nova.handle({
    action: "start",
    mode: "local",
    tenantId: "tenant-a",
    consent: false,
  });
  await nova.handle({ action: "stop" });
  release(state);
  await assert.rejects(starting, /stopped/);
  assert.equal(requests, 0);
});

it("aborts delegated reasoning on Stop and discards a late result", async () => {
  const { state, secrets } = fixture();
  let finish!: (value: SendIntuneChatMessageResult) => void;
  let signal!: AbortSignal;
  const nova = new NovaService(
    secrets,
    async () => state,
    async (_input, options) => {
      signal = options.signal;
      assert.deepEqual(options.scope, {
        tenantId: "tenant-a",
        providerId: "ollama",
        model: undefined,
        isLocal: true,
      });
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  );
  const { sessionId } = await nova.handle({
    action: "start",
    mode: "local",
    tenantId: "tenant-a",
    consent: false,
  });
  const answer = nova.handle({
    action: "answer",
    sessionId: sessionId!,
    text: "Devices?",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await nova.handle({ action: "stop" });
  assert.equal(signal.aborted, true);
  finish({
    conversation: { id: "old" },
    assistantMessage: { status: "completed", content: "Old result" },
  } as SendIntuneChatMessageResult);
  await assert.rejects(answer, /abort/i);
});

it("replaces an older question without speaking its late result", async () => {
  const { state, secrets } = fixture();
  let finish!: (value: SendIntuneChatMessageResult) => void;
  let firstSignal!: AbortSignal;
  const result = {
    conversation: { id: "current" },
    assistantMessage: { status: "completed", content: "Current answer" },
  } as SendIntuneChatMessageResult;
  const nova = new NovaService(
    secrets,
    async () => state,
    async (input, options) => {
      if (input.content === "Old question") {
        firstSignal = options.signal;
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return result;
    },
  );
  const { sessionId } = await nova.handle({
    action: "start",
    mode: "local",
    tenantId: "tenant-a",
    consent: false,
  });
  const first = nova.handle({
    action: "answer",
    sessionId: sessionId!,
    text: "Old question",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await nova.handle({
    action: "answer",
    sessionId: sessionId!,
    text: "New question",
  });
  assert.equal(firstSignal.aborted, true);
  assert.equal(second.text, "Current answer");
  finish(result);
  await assert.rejects(first, /abort/i);
});

it("stops reading oversized local speech responses", async () => {
  let cancelled = false;
  const { nova } = fixture(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  const { sessionId } = await nova.handle({
    action: "start",
    mode: "local",
    tenantId: "tenant-a",
    consent: false,
  });
  await assert.rejects(
    nova.handle({ action: "speak", sessionId: sessionId!, text: "Hello" }),
    /too large/,
  );
  assert.equal(cancelled, true);
});

it("requires a new session after changing the model or local-provider trust", async () => {
  const { nova, state, chats } = fixture();
  state.providers[0].models = ["model-a", "model-b"];
  state.activeModelByProviderId = { ollama: "model-a" };
  const { sessionId } = await nova.handle({
    action: "start",
    mode: "local",
    tenantId: "tenant-a",
    consent: false,
  });
  state.activeModelByProviderId = { ollama: "model-b" };
  await assert.rejects(
    nova.handle({ action: "answer", sessionId: sessionId!, text: "Devices?" }),
    /changed/,
  );
  state.activeModelByProviderId = { ollama: "model-a" };
  state.providers[0].isLocal = false;
  await assert.rejects(
    nova.handle({ action: "answer", sessionId: sessionId!, text: "Devices?" }),
    /changed/,
  );
  assert.equal(chats.length, 0);
});


it("web research capability is scoped to a consented hosted session and stops with it", async () => {
  const f = fixture();
  let session = await f.nova.handle({ action: "start", mode: "local", tenantId: "tenant-a", consent: false });
  await f.nova.handle({ action: "answer", sessionId: session.sessionId!, text: "Research current vendor guidance" });
  assert.equal(f.chatOptions[0].webSearch, undefined);
  await f.nova.handle({ action: "configure", apiKey: "test-key" });
  session = await f.nova.handle({ action: "start", mode: "openai", tenantId: "tenant-a", consent: true, sdp: "v=0" });
  await f.nova.handle({ action: "answer", sessionId: session.sessionId!, text: "Research current vendor guidance" });
  assert.equal(typeof f.chatOptions[1].webSearch, "function");
  await f.nova.handle({ action: "stop" });
  const requests = f.requests.length;
  await assert.rejects(f.chatOptions[1].webSearch!("public query"));
  assert.equal(f.requests.length, requests);
});
it("hosted voice delegates general public research as well as tenant comparisons", () => {
  const { state } = fixture();
  assert.match(buildNovaInstructions(state, "", true), /search the public web for any topic/);
  assert.match(buildNovaInstructions(state, "", false), /unavailable in local voice/);
});
