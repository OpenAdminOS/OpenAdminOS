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
      if (input.content === "Show old devices") {
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
    text: "Show old devices",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await nova.handle({
    action: "answer",
    sessionId: sessionId!,
    text: "Show new devices",
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

it("keeps a valid voice session usable after an investigation failure", async () => {
  const f = fixture();
  const inputs: SendIntuneChatMessageInput[] = [];
  const nova = new NovaService(f.secrets, async () => f.state, async input => {
    inputs.push(input);
    return {
      conversation: { id: "recoverable-conversation" },
      assistantMessage: inputs.length === 1
        ? { status: "failed", content: "", error: "Search is temporarily unavailable. Retry later." }
        : { status: "completed", content: "42 devices" },
    } as SendIntuneChatMessageResult;
  }, async () => Response.json({ transport: { sdp: "answer" } }));
  await nova.handle({ action: "configure", apiKey: "test-key" });
  const { sessionId } = await nova.handle({ action: "start", mode: "openai", tenantId: "tenant-a", consent: true, sdp: "v=0" });
  const first = await nova.handle({ action: "answer", sessionId: sessionId!, text: "Research macOS" });
  assert.match(first.answerError!, /temporarily unavailable/);
  assert.match(first.text!, /retry or ask another question/);
  const next = await nova.handle({ action: "answer", sessionId: sessionId!, text: "How many devices?" });
  assert.equal(next.text, "42 devices");
  assert.equal(next.answerError, undefined);
  assert.equal(inputs[1]?.conversationId, "recoverable-conversation");
  await nova.handle({ action: "stop" });
  await assert.rejects(nova.handle({ action: "answer", sessionId: sessionId!, text: "Continue" }), /changed|expired/);
});

it("recovers from a question deadline without renewing or invalidating the session", async t => {
  const f = fixture();
  const nova = new NovaService(f.secrets, async () => f.state, async (_input, options) => {
    options.signal?.throwIfAborted();
    return { conversation: { id: "after-timeout" }, assistantMessage: { status: "completed", content: "42 devices" } } as SendIntuneChatMessageResult;
  });
  const { sessionId } = await nova.handle({ action: "start", mode: "local", tenantId: "tenant-a", consent: false });
  const deadline = t.mock.method(AbortSignal, "timeout", () => AbortSignal.abort(new DOMException("Deadline", "TimeoutError")));
  const result = await nova.handle({ action: "answer", sessionId: sessionId!, text: "Inspect my tenant" });
  assert.match(result.answerError!, /timed out/);
  deadline.mock.restore();
  assert.equal((await nova.handle({ action: "answer", sessionId: sessionId!, text: "How many devices?" })).text, "42 devices");
});

it("keeps spoken references separate and exposes only execution activity", async () => {
  const { nova, chatOptions } = fixture();
  const { sessionId } = await nova.handle({ action: "start", mode: "local", tenantId: "tenant-a", consent: false });
  const activity: unknown[] = [];
  await nova.handle({ action: "answer", sessionId: sessionId!, text: "How many of those?", history: [{ role: "user", text: "Show Windows devices" }] }, value => activity.push(value));
  assert.deepEqual(chatOptions[0].voiceHistory, [{ role: "user", text: "Show Windows devices" }]);
  assert.deepEqual(activity, [{ kind: "answer", status: "completed", message: "Result retrieved" }]);
  await nova.handle({ action: "stop" });
  chatOptions[0].onEvent?.({ type: "status", conversationId: "conversation-a", stage: "generating-answer", message: "Late activity" });
  assert.equal(activity.length, 1, "stopped sessions cannot emit stale activity");
  assert.equal(boundedVoiceAnswer("42 devices\n\nDetected matching agent: Draft script.\n\nPublic web sources:\nInvented link"), "42 devices");
  assert.equal(boundedVoiceAnswer("Current release", true), "Current release Public source links are available in Chat.");
});

it("streams real tool lifecycle labels without exposing model text or tool arguments", async () => {
  const f = fixture();
  const nova = new NovaService(f.secrets, async () => f.state, async (_input, options) => {
    options.onEvent?.({ type: "status", conversationId: "c", stage: "generating-answer", message: "Preparing answer" });
    options.onEvent?.({ type: "tool-step-start", conversationId: "c", assistantMessageId: "a", tool: "web_search", params: { query: "not forwarded" }, message: "Searching public sources", startedAt: new Date().toISOString() });
    options.onEvent?.({ type: "delta", conversationId: "c", assistantMessageId: "a", delta: "not execution status", content: "not execution status" });
    return { conversation: { id: "c" }, assistantMessage: { content: "Finished", status: "completed" } } as SendIntuneChatMessageResult;
  });
  const { sessionId } = await nova.handle({ action: "start", mode: "local", tenantId: "tenant-a", consent: false });
  const activity: unknown[] = [];
  await nova.handle({ action: "answer", sessionId: sessionId!, text: "Inspect the data" }, value => activity.push(value));
  assert.deepEqual(activity, [
    { kind: "reasoning", status: "running", message: "Preparing answer" },
    { kind: "web", status: "running", message: "Searching public sources" },
    { kind: "answer", status: "completed", message: "Result retrieved" },
  ]);
});

it('requires one-use visual approval, retains the full evidence, and invalidates drafts on interruption', async () => {
  const f = fixture();
  f.state.installedAgents = [];
  const sends: unknown[] = [];
  const nova = new NovaService(f.secrets, async () => f.state, async () => ({
    conversation: { id: 'test-chat' }, assistantMessage: { status: 'completed', content: 'Verified device report. '.repeat(150) },
  } as SendIntuneChatMessageResult), fetch, {
    connectors: async () => [{ descriptor: { id: 'whatsapp-web', name: 'WhatsApp' }, config: {}, status: 'connected' } as never],
    send: async input => { sends.push(input); return { messageId: 'accepted' }; }, startRun: async () => { throw new Error('Unexpected run'); },
  });
  const { sessionId } = await nova.handle({ action: 'start', mode: 'local', tenantId: 'tenant-a', consent: false });
  await nova.handle({ action: 'answer', sessionId: sessionId!, text: 'List devices' });
  const draft = await nova.handle({ action: 'answer', sessionId: sessionId!, text: 'Send this to my WhatsApp' });
  assert.ok(draft.pendingAction!.body.length > 2000);
  assert.equal(sends.length, 0);
  const decision = { action: 'decide-action' as const, sessionId: sessionId!, actionId: draft.pendingAction!.id, approved: true };
  const results = await Promise.allSettled([nova.handle(decision), nova.handle(decision)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(sends.length, 1);
  const next = await nova.handle({ action: 'answer', sessionId: sessionId!, text: 'Send this to my WhatsApp' });
  await nova.handle({ action: 'interrupt', sessionId: sessionId! });
  await assert.rejects(nova.handle({ ...decision, actionId: next.pendingAction!.id }), /expired/);
  assert.equal((await nova.handle({ action: 'answer', sessionId: sessionId!, text: 'Which tenant are we using?' })).text?.includes('Northwind'), true);
});

it('does not execute a prepared connector action after tenant changes', async () => {
  const f = fixture();
  let sends = 0;
  const nova = new NovaService(f.secrets, async () => f.state, async () => ({ conversation: { id: 'chat' }, assistantMessage: { status: 'completed', content: 'Report' } } as SendIntuneChatMessageResult), fetch, {
    connectors: async () => [{ descriptor: { id: 'whatsapp-web', name: 'WhatsApp' }, config: {} } as never],
    send: async () => { sends++; }, startRun: async () => { throw new Error('Unexpected run'); },
  });
  const { sessionId } = await nova.handle({ action: 'start', mode: 'local', tenantId: 'tenant-a', consent: false });
  await nova.handle({ action: 'answer', sessionId: sessionId!, text: 'List devices' });
  const draft = await nova.handle({ action: 'answer', sessionId: sessionId!, text: 'Send this to my WhatsApp' });
  f.state.activeTenantId = 'tenant-b';
  await assert.rejects(nova.handle({ action: 'decide-action', sessionId: sessionId!, actionId: draft.pendingAction!.id, approved: true }), /changed/);
  assert.equal(sends, 0);
});

it('opens connector setup directly from voice without invoking reasoning', async () => {
  const f = fixture();
  const { sessionId } = await f.nova.handle({ action: 'start', mode: 'local', tenantId: 'tenant-a', consent: false });
  const result = await f.nova.handle({ action: 'answer', sessionId: sessionId!, text: 'Open connectors' });
  assert.equal(result.route, '/connectors'); assert.equal(f.chats.length, 0);
});

it('retrieves a fresh report and requires a single visual decision for every connector', async () => {
  const f = fixture();
  const deliveries: string[] = [], questions: string[] = [];
  const ids = ['whatsapp-web', 'outlook', 'teams', 'slack', 'discord', 'signal'];
  const nova = new NovaService(f.secrets, async () => f.state, async input => {
    questions.push(input.content);
    return { conversation: { id: 'report' }, assistantMessage: { status: 'completed', content: `Fresh report ${questions.length}` } } as SendIntuneChatMessageResult;
  }, fetch, {
    connectors: async () => ids.map(id => ({ descriptor: { id, name: id }, status: 'connected', config: { defaultRecipients: 'admin@example.test', defaultTeamId: 'team', defaultChannelId: 'channel', defaultChannel: 'slack-channel', defaultRecipient: 'signal-recipient' } } as never)),
    send: async input => { deliveries.push(input.connectorId); }, startRun: async () => { throw new Error('Unexpected run'); },
  });
  const { sessionId } = await nova.handle({ action: 'start', mode: 'local', tenantId: 'tenant-a', consent: false });
  for (const [index, id] of ids.entries()) {
    const channel = id === 'whatsapp-web' ? 'WhatsApp' : id;
    const answer = await nova.handle({ action: 'answer', sessionId: sessionId!, text: `Send the list of non-compliant devices via ${channel}` });
    assert.equal(questions[index], 'List devices that are non-compliant');
    assert.equal(answer.pendingAction?.body, `Fresh report ${index + 1}`);
    assert.equal(deliveries.length, index);
    const decision = { action: 'decide-action' as const, sessionId: sessionId!, actionId: answer.pendingAction!.id, approved: true };
    await nova.handle(decision);
    await assert.rejects(nova.handle(decision), /expired/);
  }
  assert.deepEqual(deliveries, ids);
});

it('routes conversational email requests and follow-up capability questions using app configuration', async () => {
  const f = fixture();
  f.state.tenants[0]!.username = 'admin@example.test';
  const questions: string[] = [], sends: unknown[] = [];
  let status = 'connected';
  const nova = new NovaService(f.secrets, async () => f.state, async input => {
    questions.push(input.content);
    return { conversation: { id: 'report' }, assistantMessage: { status: 'completed', content: 'Verified non-compliant device list' } } as SendIntuneChatMessageResult;
  }, fetch, {
    connectors: async () => [{ descriptor: { id: 'outlook', name: 'Outlook' }, status, config: { defaultRecipients: 'admin@example.test' } } as never],
    send: async input => { sends.push(input); }, startRun: async () => { throw new Error('Unexpected run'); },
  });
  const { sessionId } = await nova.handle({ action: 'start', mode: 'local', tenantId: 'tenant-a', consent: false });
  const ask = (text: string) => nova.handle({ action: 'answer', sessionId: sessionId!, text });
  const request = 'Alright, so can you send me an email with the list of non-compliant devices';
  const report = await ask(request);
  assert.deepEqual(questions, ['List devices that are non-compliant']);
  assert.equal(report.pendingAction?.body, 'Verified non-compliant device list');
  assert.match(report.text!, /confirm/);
  assert.equal(sends.length, 0);
  for (const text of ["So outlook is connected, why can't you send an email", "Why can't you send an email?", 'Okay, can you send email?']) {
    const capability = await ask(text);
    assert.match(capability.text!, /Outlook.*connected/);
    assert.equal(capability.pendingAction, undefined);
  }
  assert.equal(questions.length, 1);
  status = 'needs-scope';
  const blocked = await ask(request);
  assert.match(blocked.answerError!, /Outlook needs permission/);
  assert.equal(blocked.pendingAction, undefined);
  assert.equal(questions.length, 1);
  assert.equal(sends.length, 0);
});

it('reports connector capabilities from configuration and never attaches an older report after failure', async () => {
  const f = fixture();
  let failed = false, questions = 0;
  const nova = new NovaService(f.secrets, async () => f.state, async () => {
    questions++;
    return { conversation: { id: 'report' }, assistantMessage: failed ? { status: 'failed', error: 'No permission', content: '' } : { status: 'completed', content: 'Previous report' } } as SendIntuneChatMessageResult;
  }, fetch, {
    connectors: async () => [{ descriptor: { id: 'outlook', name: 'Outlook' }, status: 'connected', config: { defaultRecipients: 'admin@example.test' } } as never],
    send: async () => { throw new Error('Must not send'); }, startRun: async () => { throw new Error('Unexpected run'); },
  });
  const { sessionId } = await nova.handle({ action: 'start', mode: 'local', tenantId: 'tenant-a', consent: false });
  const ask = (text: string) => nova.handle({ action: 'answer', sessionId: sessionId!, text });
  const capability = await ask('Can you send email?');
  assert.match(capability.text!, /Outlook.*connected/); assert.equal(questions, 0);
  await ask('List devices'); failed = true;
  const report = await ask('Send an email with the list of non-compliant devices');
  assert.match(report.answerError!, /No permission/); assert.equal(report.pendingAction, undefined);
  const old = await ask('Send this via email');
  assert.match(old.text!, /no completed result/); assert.equal(old.pendingAction, undefined);
});

it('interprets unfamiliar delivery wording, resolves corrections and keeps approval visual', async () => {
  const f = fixture();
  const sends: unknown[] = [], questions: string[] = [], contexts: unknown[] = [];
  let reply = { kind: 'clarify', reason: 'destination' } as Record<string, unknown>;
  const nova = new NovaService(f.secrets, async () => f.state, async input => {
    questions.push(input.content);
    return { conversation: { id: 'report' }, assistantMessage: { content: 'Verified report', status: 'completed' } } as SendIntuneChatMessageResult;
  }, fetch, {
    classifyCommand: async (_text, context, options) => { contexts.push(context); assert.equal(options.scope.providerId, 'ollama'); assert.equal(options.scope.isLocal, true); return JSON.stringify(reply); },
    connectors: async () => ['outlook', 'teams'].map(id => ({ descriptor: { id, name: id }, status: 'connected', config: { defaultRecipients: 'admin@example.test', defaultTeamId: 'team', defaultChannelId: 'channel' } } as never)),
    send: async input => { sends.push(input); }, startRun: async () => { throw new Error('Unexpected run'); },
  });
  const { sessionId } = await nova.handle({ action: 'start', mode: 'local', tenantId: 'tenant-a', consent: false });
  const ask = (text: string) => nova.handle({ action: 'answer', sessionId: sessionId!, text });
  const clarification = await ask('Could you get the non-compliant device report over to me?');
  assert.match(clarification.text!, /specify the destination/); assert.equal(questions.length, 0);
  reply = { kind: 'send', connectorId: 'outlook', self: false, question: 'List non-compliant devices' };
  const draft = await ask('Outlook');
  assert.match((contexts[1] as any).previousRequest, /non-compliant device report/);
  assert.equal(draft.pendingAction?.body, 'Verified report'); assert.equal(questions.length, 1);
  const spokenApproval = await ask('Yes please');
  assert.equal(spokenApproval.pendingAction?.id, draft.pendingAction?.id);
  assert.equal(sends.length, 0); assert.equal(contexts.length, 2);
  reply = { kind: 'send', connectorId: 'teams', self: false, question: null };
  const correction = await ask('Actually use Teams instead');
  assert.equal(contexts.length, 2);
  assert.equal(correction.pendingAction?.target, 'team / channel');
  assert.equal(correction.pendingAction?.body, 'Verified report');
  assert.equal(questions.length, 1); assert.equal(sends.length, 0);
  await assert.rejects(nova.handle({ action: 'decide-action', sessionId: sessionId!, actionId: draft.pendingAction!.id, approved: true }), /expired/);
  await nova.handle({ action: 'decide-action', sessionId: sessionId!, actionId: correction.pendingAction!.id, approved: true });
  assert.equal(sends.length, 1);
});

it('fails closed on interpretation failures and discards replaced or cross-tenant classifications', async () => {
  const f = fixture();
  let resolve: (s: string) => void = () => {}, signal: AbortSignal | undefined;
  let mode = 'invalid';
  let chats = 0;
  const contexts: unknown[] = [];
  const nova = new NovaService(f.secrets, async () => f.state, async () => { chats++; throw new Error('Unexpected research'); }, fetch, {
    classifyCommand: async (_text, context, options) => {
      contexts.push(context); signal = options.signal;
      if (mode === 'invalid') return '{"kind":"send","connectorId":"outlook","self":false,"to":"invented"}';
      if (mode === 'error') throw new Error('Model failed');
      return new Promise<string>(r => { resolve = r; });
    },
    connectors: async () => [], send: async () => { throw new Error('Unexpected send'); }, startRun: async () => { throw new Error('Unexpected run'); },
  });
  const { sessionId } = await nova.handle({ action: 'start', mode: 'local', tenantId: 'tenant-a', consent: false });
  const ask = (text: string) => nova.handle({ action: 'answer', sessionId: sessionId!, text });
  assert.match((await ask('Pop the report in my inbox')).text!, /could not reliably interpret/);
  mode = 'error'; assert.match((await ask('Outlook')).text!, /could not reliably interpret/);
  await ask('Never mind');
  mode = 'pending';
  const pending = ask('Forward those findings');
  await new Promise(r => setImmediate(r));
  assert.equal((contexts.at(-1) as any).previousRequest, undefined);
  const rejected = assert.rejects(pending, /replaced/);
  await ask('Open connectors');
  assert.equal(signal?.aborted, true);
  resolve('{"kind":"send","connectorId":"outlook","self":false}');
  await rejected;
  const changed = ask('Forward those findings');
  await new Promise(r => setImmediate(r));
  const changedRejected = assert.rejects(changed, /changed/);
  f.state.activeTenantId = 'other-tenant';
  resolve('{"kind":"navigate","page":"connectors"}');
  await changedRejected;
  assert.equal(chats, 0);
});

it('keeps the full noncompliant list through channel selection, failed setup and Outlook speech repair', async () => {
  const { voiceDeviceEvidenceAnswer } = await import('./intune-chat/voice-device-evidence.js');
  const f = fixture();
  f.state.tenants[0]!.username = 'admin@example.test';
  const sends: any[] = [], questions: string[] = [];
  const nova = new NovaService(f.secrets, async () => f.state, async input => {
    questions.push(input.content);
    const content = await voiceDeviceEvidenceAnswer(input.content, [{resource:'managedDevices',rows:9,refreshedAt:'2026-09-13T21:56:23.006Z'}] as any, {
      tenantId:'tenant-a', store:{queryGraphCache: () => ({totalCount:2,returnedRows:2,rows:[{row:{deviceName:'Device A'}},{row:{deviceName:'Device B'}}]})}
    } as any, () => {});
    assert.ok(content, input.content);
    return {conversation:{id:'report'},assistantMessage:{content,status:'completed'}} as SendIntuneChatMessageResult;
  }, fetch, {
    classifyCommand: async () => { throw new Error('Explicit commands must not need a model'); },
    connectors: async () => ['outlook','teams','whatsapp-web'].map(id => ({descriptor:{id,name:id},status:id==='whatsapp-web'?'needs-setup':'connected',config:{defaultRecipients:'admin@example.test',defaultTeamId:'team',defaultChannelId:'channel',defaultChannelName:'General'}} as never)),
    send:async input => {sends.push(input);}, startRun:async () => {throw new Error('Unexpected run');}
  });
  const {sessionId} = await nova.handle({action:'start',mode:'local',tenantId:'tenant-a',consent:false});
  const ask = (text:string) => nova.handle({action:'answer',sessionId:sessionId!,text});
  assert.match((await ask('Send me a Teams message with all the non-compliant devices as a list')).text!, /shared destinations/);
  const teams = await ask('Send this via Teams to the General channel');
  assert.match(teams.pendingAction!.body, /- Device A\n- Device B/);
  assert.equal(questions.length,1);
  assert.match((await ask('Can you send it also via WhatsApp')).text!, /setup/);
  const email = await ask('Can you also send it- send it with Outlook');
  assert.match(email.pendingAction!.body, /- Device A\n- Device B/);
  assert.equal(questions.length,1);
  const explicit = await ask('Stop What I want you to do is send me a list of non-compliant devices via email with the Outlook connector');
  assert.match(explicit.pendingAction!.body, /- Device A\n- Device B/);
  assert.equal(sends.length,0);
  await nova.handle({action:'decide-action',sessionId:sessionId!,actionId:explicit.pendingAction!.id,approved:true});
  assert.equal(sends.length,1);
  assert.match(sends[0].args.markdown, /Device A/);
  assert.match(sends[0].args.markdown, /Device B/);
});

it('retains a split spoken delivery request while interpretation is pending and never researches its connector fragment', async () => {
  const f = fixture();
  let contexts: any[] = [];
  const nova = new NovaService(f.secrets, async () => f.state, async () => {throw new Error('Unexpected research');}, fetch, {
    classifyCommand: async (_text, context) => {contexts.push(context); if(contexts.length===1) return new Promise<string>(()=>{}); return '{"kind":"research"}';},
    connectors:async () => [], send:async () => {throw new Error('Unexpected send');},startRun:async () => {throw new Error('Unexpected run');}
  });
  const {sessionId} = await nova.handle({action:'start',mode:'local',tenantId:'tenant-a',consent:false});
  const pending = nova.handle({action:'answer',sessionId:sessionId!,text:'Can you also send it- send it with'});
  const replaced = assert.rejects(pending, /replaced/);
  await new Promise(r=>setImmediate(r));
  const next = await nova.handle({action:'answer',sessionId:sessionId!,text:'Outlook'});
  await replaced;
  assert.equal(contexts.length, 1);
  assert.match(next.text!, /connector is unavailable/);
});

it('speaks readable freshness while preserving the original evidence timestamp elsewhere', () => {
  assert.match(boundedVoiceAnswer('9 devices, refreshed 2026-09-13T21:56:23.006Z.'), /13 September.*21:56 UTC/);
  assert.doesNotMatch(boundedVoiceAnswer('9 devices, refreshed 2026-09-13T21:56:23.006Z.'), /T21|\.006/);
});

it('answers general capabilities directly while preserving a running task and its subsequent action preview', async () => {
  const f = fixture();
  let finish!: (value: SendIntuneChatMessageResult) => void;
  let signal: AbortSignal | undefined;
  let chats = 0, sends = 0;
  const nova = new NovaService(f.secrets, async () => f.state, async (_input, options) => {
    chats++; signal=options.signal; return new Promise<SendIntuneChatMessageResult>(resolve=>{finish=resolve;});
  }, fetch, {classifyCommand: async () => {throw new Error('No classifier needed');},
    connectors:async()=>[{descriptor:{id:'outlook',name:'Outlook'},status:'connected',config:{defaultRecipients:'admin@example.test'}} as never],
    send:async()=>{sends++;},startRun:async()=>{throw new Error('Unexpected run');}});
  const {sessionId} = await nova.handle({action:'start',mode:'local',tenantId:'tenant-a',consent:false});
  const ask=(text:string)=>nova.handle({action:'answer',sessionId:sessionId!,text});
  const first=await ask('What can you do and what can you help me with');
  assert.match(first.text!, /I'm Nova/); assert.match(first.text!, /configured connectors/);
  assert.equal(chats,0); assert.equal(first.pendingAction,undefined);
  const pending=ask('How many devices do I have?');
  await new Promise(r=>setImmediate(r));
  for (const text of ['Who are you and how can you help me?', 'What can you do and what can you help me with']) {
    assert.match((await ask(text)).text!, /I'm Nova/);
    assert.equal(signal?.aborted,false); assert.equal(chats,1);
  }
  assert.match((await ask('We are on stage. And I want you to say hello to them')).text!, /Hello everyone/);
  assert.equal(signal?.aborted, false);
  assert.equal(chats, 1);
  finish({conversation:{id:'conversation'},assistantMessage:{content:'9 devices',status:'completed'}} as SendIntuneChatMessageResult);
  await pending;
  const draft=await ask('Send this via Outlook');
  await ask('Tell me about yourself');
  await ask('Say hello to the audience');
  await nova.handle({action:'decide-action',sessionId:sessionId!,actionId:draft.pendingAction!.id,approved:true});
  assert.equal(sends,1);
});
