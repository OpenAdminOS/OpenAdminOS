import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type {
  HostedProviderChatConsent,
  IntuneChatStreamEvent,
  ManagedPolicyStatus,
  ProviderId,
  ProviderSummary,
  RunLlmApi,
} from "@openadminos/agent-sdk";

import { classifyModelFitFailure, isOllamaCloudModel, modelFitChoices, modelSizeBillions } from "../../src/shared/model-fit.js";
import { MODEL_FIT_OFFER_TTL_MS, ModelFitOffers, ModelOverrideError, loopFailureIssue, resolveChatTurnProvider, type ModelFitOffer } from "./model-fit.js";
import { IntuneChatService, type ChatServiceHost } from "./service.js";
import { IntelligenceSqliteStore } from "./sqlite-store.js";

const LOCAL_MODEL = "openadminos/openadmin-8b:latest";
// The adapter's message from PR #211, and Ollama's own HTTP 400.
const ADAPTER_ERROR = `Ollama context size too small: This request needs 40,652 tokens of context, but Ollama could only give ${LOCAL_MODEL} 16,384, usually because free memory ran out.`;
const OLLAMA_400 = 'Ollama responded with HTTP 400: {"error":"request (40652 tokens) exceeds the available context size (16384 tokens), try increasing it"}';

const ollama: ProviderSummary = {
  id: "ollama",
  name: "Ollama",
  description: "",
  isLocal: true,
  status: "connected",
  models: [LOCAL_MODEL, "gpt-oss:20b"],
};
const claude: ProviderSummary = {
  id: "anthropic",
  name: "Claude Code",
  description: "",
  isLocal: false,
  status: "connected",
  models: ["claude-sonnet-5-5"],
  defaultModel: "claude-sonnet-5-5",
  cli: { state: "ready" },
};
const codexSignedOut: ProviderSummary = {
  id: "openai",
  name: "Codex",
  description: "",
  isLocal: false,
  status: "error",
  models: [],
  cli: { state: "signed-out" },
};

function freshConsent(providerId: ProviderId, model?: string, remember?: boolean, modelFitOfferId = "fit_1"): HostedProviderChatConsent {
  return { noTenant: true, providerId, ...(model ? { model } : {}), acknowledgedAt: new Date().toISOString(), ...(remember ? { remember: true } : {}), modelFitOfferId };
}

describe("Model fit: classifying a failure", () => {
  it("reads the numbers from the Ollama adapter's message and from Ollama's own error", () => {
    assert.deepEqual(classifyModelFitFailure(new Error(ADAPTER_ERROR), { providerId: "ollama", model: LOCAL_MODEL, isLocal: true }), {
      reason: "context-too-small",
      neededTokens: 40652,
      limitTokens: 16384,
      providerId: "ollama",
      model: LOCAL_MODEL,
    });
    const modelMax = classifyModelFitFailure(
      `Ollama context size too small: This request needs 140,000 tokens of context, but gpt-oss:20b supports at most 131,072.`,
      { providerId: "ollama", model: "gpt-oss:20b", isLocal: true },
    );
    assert.equal(modelMax?.limitTokens, 131072);
    assert.equal(modelMax?.limitIsModelMax, true);
    const raw = classifyModelFitFailure(new Error(OLLAMA_400), { providerId: "ollama", model: LOCAL_MODEL, isLocal: true });
    assert.equal(raw?.neededTokens, 40652);
    assert.equal(raw?.limitTokens, 16384);
  });

  it("reads the adapter's memory failure, a wrapped typed failure and the loop's reason", () => {
    const memory = classifyModelFitFailure(
      `Ollama context size too small: This request needs 40,652 tokens of context, but Ollama could not load ${LOCAL_MODEL} with 40,960, usually because free memory ran out. Ollama said: model requires more system memory`,
      { providerId: "ollama", model: LOCAL_MODEL, isLocal: true },
    );
    assert.deepEqual([memory?.neededTokens, memory?.limitTokens, memory?.limitIsMemory], [40652, 40960, true]);
    // The agent runtime's prompt fit check: a `failure` record, behind a wrapper's `cause`.
    const failure = { code: "context-too-small", promptTokens: 30000, answerTokens: 1100, neededTokens: 31100, limitTokens: 16384 };
    const wrapped = new Error("Nothing was applied: the plan could not be checked.", { cause: { code: "context-too-small", failure } });
    const fromCause = classifyModelFitFailure(wrapped, { providerId: "ollama", model: LOCAL_MODEL, isLocal: true });
    assert.deepEqual([fromCause?.neededTokens, fromCause?.limitTokens], [31100, 16384]);
    assert.equal(classifyModelFitFailure(failure, { providerId: "ollama", isLocal: true })?.limitTokens, 16384);
    assert.equal(loopFailureIssue({ failureReason: "thinking-only" }, ollama, LOCAL_MODEL)?.reason, "thinking-only");
    assert.equal(loopFailureIssue({ failureReason: "malformed" }, ollama, LOCAL_MODEL), undefined);
    assert.equal(loopFailureIssue({ failureReason: "context-too-small" }, claude, "claude-sonnet-5-5"), undefined);
  });

  it("reads a typed failure from the runtime by its shape, and llama.cpp's error", () => {
    const typed = Object.assign(new Error("too big"), { kind: "context-too-small", needed: 9000, limit: 4096 });
    assert.equal(classifyModelFitFailure(typed, { providerId: "lm-studio", isLocal: true })?.neededTokens, 9000);
    const thinking = Object.assign(new Error("reasoning only"), { code: "thinking-only" });
    assert.equal(classifyModelFitFailure(thinking, { providerId: "ollama", isLocal: true })?.reason, "thinking-only");
    const llamaCpp = classifyModelFitFailure('HTTP 400 {"error":{"type":"exceed_context_size_error","n_prompt_tokens":20000,"n_ctx":8192}}', { providerId: "lemonade", isLocal: true });
    assert.deepEqual([llamaCpp?.neededTokens, llamaCpp?.limitTokens], [20000, 8192]);
  });

  it("keeps Apple Foundation's prompt count and context size", () => {
    const apple = classifyModelFitFailure(
      "Apple Foundation context window is too small for this prompt. The prompt uses 3900 tokens before response generation; the model supports 4096 tokens total. Reduce the answer pack or switch to a larger-context provider.",
      { providerId: "apple-foundation", isLocal: true },
    );
    assert.deepEqual([apple?.neededTokens, apple?.limitTokens, apple?.limitIsModelMax], [3900, 4096, true]);
  });

  it("ignores hosted providers and errors that are not about the context", () => {
    assert.equal(classifyModelFitFailure(new Error(OLLAMA_400), { providerId: "ollama", isLocal: false }), undefined);
    assert.equal(classifyModelFitFailure(new Error("Ollama not reachable at http://127.0.0.1:11434: connect ECONNREFUSED"), { providerId: "ollama", isLocal: true }), undefined);
    assert.equal(classifyModelFitFailure(new Error("The context menu could not open"), { providerId: "ollama", isLocal: true }), undefined);
  });

  it("reads the parameter count from a model name", () => {
    assert.equal(modelSizeBillions(LOCAL_MODEL), 8);
    assert.equal(modelSizeBillions("gpt-oss:20b"), 20);
    assert.equal(modelSizeBillions("qwen3:0.6b"), 0.6);
    assert.equal(modelSizeBillions("llama3"), undefined);
  });
});

describe("Model fit: the choices", () => {
  const issue = { reason: "context-too-small" as const, providerId: "ollama" as const, model: LOCAL_MODEL };

  it("lists only ready hosted providers and larger local models", () => {
    const choices = modelFitChoices({ issue, providers: [ollama, claude, codexSignedOut] });
    assert.deepEqual(choices.hosted.map((choice) => choice.providerId), ["anthropic"]);
    assert.equal(choices.hosted[0]!.model, "claude-sonnet-5-5");
    assert.deepEqual(choices.local.map((choice) => choice.model), ["gpt-oss:20b"]);
    assert.equal(choices.hostedBlockedByPolicy, false);
  });

  it("never offers an Ollama Cloud model as a model on this device", () => {
    assert.equal(isOllamaCloudModel("gpt-oss:120b-cloud"), true);
    assert.equal(isOllamaCloudModel("glm-4.6:cloud"), true);
    assert.equal(isOllamaCloudModel("gpt-oss:20b"), false);
    const choices = modelFitChoices({ issue, providers: [{ ...ollama, models: [LOCAL_MODEL, "gpt-oss:120b-cloud", "gpt-oss:20b"] }] });
    assert.deepEqual(choices.local.map((choice) => choice.model), ["gpt-oss:20b"]);
  });

  it("offers no hosted provider when the managed policy allows only local ones, and says the policy is why", () => {
    const policy: ManagedPolicyStatus = { files: [], values: { allowedProviders: ["ollama"] }, sources: {}, locked: [], issues: [] };
    // The main process leaves disallowed providers out of the list; even a stale one is not offered.
    const choices = modelFitChoices({ issue, providers: [ollama, claude], managedPolicy: policy });
    assert.deepEqual(choices.hosted, []);
    assert.equal(choices.hostedBlockedByPolicy, true);
    const none = modelFitChoices({ issue, providers: [ollama] });
    assert.deepEqual(none.hosted, []);
    assert.equal(none.hostedBlockedByPolicy, false);
  });
});

describe("Model fit: the per-request override", () => {
  const offer: ModelFitOffer = {
    id: "fit_1", conversationId: "chat_1", tenantId: undefined, content: "q", workspaceKey: undefined,
    anchor: { providerId: "ollama", model: LOCAL_MODEL }, failed: { providerId: "ollama", model: LOCAL_MODEL },
    reason: "context-too-small", createdAt: 0,
  };
  const base = { providers: [ollama, claude], active: ollama, activeModel: LOCAL_MODEL, nova: false, offer };
  const override = { offerId: "fit_1", providerId: "anthropic" as const, model: "claude-sonnet-5-5" };

  it("keeps the active provider without an override, and refuses a model fit acceptance on an ordinary send", () => {
    const turn = resolveChatTurnProvider({ ...base, offer: undefined, override: undefined, consent: undefined });
    assert.equal(turn.provider.id, "ollama");
    assert.equal(turn.switchedFrom, undefined);
    assert.throws(
      () => resolveChatTurnProvider({ ...base, active: claude, activeModel: "claude-sonnet-5-5", offer: undefined, override: undefined, consent: freshConsent("anthropic", "claude-sonnet-5-5") }),
      /approval was for one request/,
    );
  });

  it("refuses an override without its offer, without an acceptance, or with a remembered one", () => {
    assert.throws(() => resolveChatTurnProvider({ ...base, offer: undefined, override, consent: freshConsent("anthropic", "claude-sonnet-5-5") }), /no longer available/);
    assert.throws(() => resolveChatTurnProvider({ ...base, override, consent: undefined }), ModelOverrideError);
    assert.throws(() => resolveChatTurnProvider({ ...base, override, consent: freshConsent("anthropic", "claude-sonnet-5-5", true) }), /needs your approval for this request/);
    assert.throws(() => resolveChatTurnProvider({ ...base, override, consent: freshConsent("openai") }), /needs your approval/);
    // An acceptance of another offer, one made before this offer, or for another model does not cover it.
    assert.throws(() => resolveChatTurnProvider({ ...base, override, consent: freshConsent("anthropic", "claude-sonnet-5-5", false, "fit_other") }), /needs your approval/);
    assert.throws(() => resolveChatTurnProvider({ ...base, offer: { ...offer, createdAt: Date.now() + 60_000 }, override, consent: freshConsent("anthropic", "claude-sonnet-5-5") }), /needs your approval/);
    assert.throws(() => resolveChatTurnProvider({ ...base, override, consent: freshConsent("anthropic", "claude-opus-5-5") }), /needs your approval/);
  });

  it("runs on the chosen provider with a fresh acceptance and records what it replaced", () => {
    const turn = resolveChatTurnProvider({ ...base, override, consent: freshConsent("anthropic", "claude-sonnet-5-5") });
    assert.equal(turn.provider.id, "anthropic");
    assert.equal(turn.model, "claude-sonnet-5-5");
    assert.deepEqual(turn.switchedFrom, { providerId: "ollama", model: LOCAL_MODEL, reason: "context-too-small", toOnDevice: false });
  });

  it("refuses a provider that is not listed (left out by policy) or not ready, a stale offer, and Nova", () => {
    assert.throws(() => resolveChatTurnProvider({ ...base, providers: [ollama], override, consent: freshConsent("anthropic") }), /not available on this device/);
    assert.throws(() => resolveChatTurnProvider({ ...base, providers: [ollama, codexSignedOut], override: { offerId: "fit_1", providerId: "openai" }, consent: freshConsent("openai") }), /not ready/);
    assert.throws(() => resolveChatTurnProvider({ ...base, activeModel: "gpt-oss:20b", override, consent: freshConsent("anthropic") }), /changed since this request failed/);
    assert.throws(() => resolveChatTurnProvider({ ...base, nova: true, override, consent: freshConsent("anthropic") }), /Nova/);
  });

  it("runs on a larger local model without a hosted acceptance, but never on an Ollama Cloud model", () => {
    const turn = resolveChatTurnProvider({ ...base, override: { offerId: "fit_1", providerId: "ollama", model: "gpt-oss:20b" }, consent: undefined });
    assert.equal(turn.model, "gpt-oss:20b");
    const withCloud = { ...ollama, models: [...ollama.models, "gpt-oss:120b-cloud"] };
    assert.throws(
      () => resolveChatTurnProvider({ ...base, providers: [withCloud, claude], override: { offerId: "fit_1", providerId: "ollama", model: "gpt-oss:120b-cloud" }, consent: undefined }),
      /runs on another server/,
    );
    // A remote-backed alias with no cloud suffix, as Ollama's /api/tags marks it.
    const withAlias = { ...ollama, models: [...ollama.models, "big-70b"], remoteModels: ["big-70b"] };
    assert.throws(
      () => resolveChatTurnProvider({ ...base, providers: [withAlias, claude], override: { offerId: "fit_1", providerId: "ollama", model: "big-70b" }, consent: undefined }),
      /runs on another server/,
    );
    assert.deepEqual(modelFitChoices({ issue: { reason: "context-too-small", providerId: "ollama", model: LOCAL_MODEL }, providers: [withAlias] }).local.map((choice) => choice.model), ["gpt-oss:20b"]);
  });

  it("keeps the active model as the anchor after a larger local model also failed", () => {
    const retried: ModelFitOffer = { ...offer, failed: { providerId: "ollama", model: "gpt-oss:20b" } };
    const turn = resolveChatTurnProvider({ ...base, offer: retried, override, consent: freshConsent("anthropic", "claude-sonnet-5-5") });
    assert.deepEqual(turn.switchedFrom, { providerId: "ollama", model: LOCAL_MODEL, reason: "context-too-small", toOnDevice: false });
    assert.throws(() => resolveChatTurnProvider({ ...base, offer: retried, override: { offerId: "fit_1", providerId: "ollama", model: "gpt-oss:20b" }, consent: undefined }), /already could not do this request/);
  });
});

describe("Model fit: offers", () => {
  it("lets only one send claim an offer", () => {
    const offers = new ModelFitOffers();
    const id = offers.issue({ conversationId: "chat_1", tenantId: undefined, content: "q", workspaceKey: undefined, anchor: { providerId: "ollama", model: LOCAL_MODEL }, failed: { providerId: "ollama", model: LOCAL_MODEL }, reason: "context-too-small" });
    const request = { conversationId: "chat_1", tenantId: undefined, content: "q", workspaceKey: undefined };
    // Both sends pass the check before either claims it.
    offers.check(id, request);
    offers.check(id, request);
    offers.claim(id);
    assert.throws(() => offers.claim(id), /already used/);
  });

  it("binds an offer to its conversation, organization and question, and lets it expire", () => {
    let now = 1_000;
    const offers = new ModelFitOffers(() => now);
    const id = offers.issue({ conversationId: "chat_1", tenantId: "tenant-1", content: "q", workspaceKey: undefined, anchor: { providerId: "ollama", model: LOCAL_MODEL }, failed: { providerId: "ollama", model: LOCAL_MODEL }, reason: "context-too-small" });
    assert.equal(offers.check(id, { conversationId: "chat_1", tenantId: "tenant-1", content: "q", workspaceKey: undefined }).id, id);
    assert.throws(() => offers.check(id, { conversationId: "chat_2", tenantId: "tenant-1", content: "q", workspaceKey: undefined }), /another question/);
    assert.throws(() => offers.check(id, { conversationId: "chat_1", tenantId: undefined, content: "q", workspaceKey: undefined }), /another question/);
    assert.throws(() => offers.check(id, { conversationId: "chat_1", tenantId: "tenant-1", content: "other", workspaceKey: undefined }), /another question/);
    assert.throws(() => offers.check(id, { conversationId: "chat_1", tenantId: "tenant-1", content: "q", workspaceKey: '{"workspaceId":"w1"}' }), /another question/);
    now += MODEL_FIT_OFFER_TTL_MS + 1;
    assert.throws(() => offers.check(id, { conversationId: "chat_1", tenantId: "tenant-1", content: "q", workspaceKey: undefined }), /no longer available/);
  });
});

/** A local model that rejects every prompt for its size, and a hosted one that answers. */
function chatHost(store: IntelligenceSqliteStore, built: string[], onDevice: (model: string | undefined) => boolean = () => true, bindings: Array<{ endpoint: string | undefined } | undefined> = []): ChatServiceHost {
  const failingLocal: RunLlmApi = {
    available: true,
    defaultModel: LOCAL_MODEL,
    async complete() { throw new Error(ADAPTER_ERROR); },
    // eslint-disable-next-line require-yield
    async *stream() { throw new Error(ADAPTER_ERROR); },
  };
  const hosted: RunLlmApi = {
    available: true,
    defaultModel: "claude-sonnet-5-5",
    async complete() { return { text: '{"final":true,"answer":"Pre-provisioning runs the device phase before the user signs in."}', model: "claude-sonnet-5-5" }; },
    async *stream() { yield { delta: "Pre-provisioning runs the device phase first.", accumulated: "Pre-provisioning runs the device phase first.", done: true, model: "claude-sonnet-5-5" }; },
  };
  return {
    read: async () => ({ activeProviderId: "ollama", activeModelByProviderId: { ollama: LOCAL_MODEL }, installedAgents: [], tenants: [] }),
    resolveTenant: () => { throw new Error("no tenant in this test"); },
    requireIntelligenceStore: () => store,
    listProviders: async () => [ollama, claude],
    verifyOnDeviceModel: async (_providerId: ProviderId, model: string | undefined) => onDevice(model),
    providerEndpoint: async (providerId: ProviderId) => (providerId === "anthropic" ? "claude-code" : undefined),
    buildLlm: async (providerId: ProviderId, _model: string | undefined, binding?: { endpoint: string | undefined }) => {
      built.push(providerId);
      bindings.push(binding);
      return providerId === "anthropic" ? hosted : failingLocal;
    },
    intelligenceStore: store,
    graphFactory: undefined,
    appVersion: "test",
    userDataPath: undefined,
  } as unknown as ChatServiceHost;
}

async function withStore(run: (store: IntelligenceSqliteStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-model-fit-"));
  const store = new IntelligenceSqliteStore(join(dir, "openadminos.db"));
  try { await run(store); } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
}

const QUESTION = "How does Windows Autopilot pre-provisioning work?";

describe("Model fit in Chat", () => {
  it("records the issue on a failed answer and sends nothing to a hosted provider", async () => {
    await withStore(async (store) => {
      const built: string[] = [];
      const service = new IntuneChatService(chatHost(store, built));
      const events: IntuneChatStreamEvent[] = [];
      const result = await service.streamIntuneChatMessage({ content: QUESTION }, (event) => events.push(event));
      assert.equal(result.assistantMessage.status, "failed");
      const { offerId, ...issue } = result.assistantMessage.modelFit!;
      assert.deepEqual(issue, { reason: "context-too-small", neededTokens: 40652, limitTokens: 16384, providerId: "ollama", model: LOCAL_MODEL });
      assert.match(offerId!, /^fit_/);
      assert.ok(events.some((event) => event.type === "failed"));
      assert.ok(built.length > 0 && built.every((id) => id === "ollama"), `built ${built.join(", ")}`);
      // Stored with the answer, so a reload keeps the offer's reason.
      assert.equal(store.listMessages(result.conversation.id).at(-1)?.modelFit?.neededTokens, 40652);
      // The offer is in memory only and single use, so it is not stored.
      assert.equal(store.listMessages(result.conversation.id).at(-1)?.modelFit?.offerId, undefined);
    });
  });

  it("refuses an override with no offer from a failed answer, and a hosted one without a per-request acceptance, before any model is built", async () => {
    await withStore(async (store) => {
      const built: string[] = [];
      const service = new IntuneChatService(chatHost(store, built));
      // No failure came first: there is no offer to take up.
      await assert.rejects(
        service.streamIntuneChatMessage({ content: QUESTION, modelOverride: { offerId: "fit_made_up", providerId: "anthropic", model: "claude-sonnet-5-5" }, hostedProviderConsent: freshConsent("anthropic", "claude-sonnet-5-5") }, () => undefined),
        /no longer available/,
      );
      assert.deepEqual(built, []);
      const failed = await service.streamIntuneChatMessage({ content: QUESTION }, () => undefined);
      const offerId = failed.assistantMessage.modelFit!.offerId!;
      built.length = 0;
      const modelOverride = { offerId, providerId: "anthropic" as const, model: "claude-sonnet-5-5" };
      const conversationId = failed.conversation.id;
      await assert.rejects(service.streamIntuneChatMessage({ content: QUESTION, conversationId, modelOverride }, () => undefined), /needs your approval for this request/);
      await assert.rejects(
        service.streamIntuneChatMessage({ content: QUESTION, conversationId, modelOverride, hostedProviderConsent: freshConsent("anthropic", "claude-sonnet-5-5", true) }, () => undefined),
        /needs your approval for this request/,
      );
      // The offer is for this question in this conversation only.
      await assert.rejects(
        service.streamIntuneChatMessage({ content: "Another question about Autopilot", conversationId, modelOverride, hostedProviderConsent: freshConsent("anthropic", "claude-sonnet-5-5") }, () => undefined),
        /another question/,
      );
      assert.deepEqual(built, []);
    });
  });

  it("answers this one request with the chosen provider after the acceptance, names what it replaced, and uses the offer up", async () => {
    await withStore(async (store) => {
      const built: string[] = [];
      const service = new IntuneChatService(chatHost(store, built));
      const failed = await service.streamIntuneChatMessage({ content: QUESTION }, () => undefined);
      const offerId = failed.assistantMessage.modelFit!.offerId!;
      const conversationId = failed.conversation.id;
      built.length = 0;
      const accepted = {
        content: QUESTION,
        conversationId,
        modelOverride: { offerId, providerId: "anthropic" as const, model: "claude-sonnet-5-5" },
        hostedProviderConsent: freshConsent("anthropic", "claude-sonnet-5-5", false, offerId),
      };
      const result = await service.streamIntuneChatMessage(accepted, () => undefined);
      assert.equal(result.assistantMessage.status, "completed", result.assistantMessage.error);
      assert.equal(result.assistantMessage.providerId, "anthropic");
      assert.deepEqual(result.assistantMessage.switchedFrom, { providerId: "ollama", model: LOCAL_MODEL, reason: "context-too-small", toOnDevice: false });
      assert.ok(built.length > 0 && built.every((id) => id === "anthropic"), `built ${built.join(", ")}`);
      // Single use: the same acceptance cannot send it again.
      await assert.rejects(service.streamIntuneChatMessage({ ...accepted, hostedProviderConsent: freshConsent("anthropic", "claude-sonnet-5-5", false, offerId) }, () => undefined), /no longer available/);
      // The next request goes to the active local model again.
      const next = await service.streamIntuneChatMessage({ content: QUESTION, conversationId }, () => undefined);
      assert.equal(next.assistantMessage.providerId, "ollama");
      assert.equal(next.assistantMessage.switchedFrom, undefined);
    });
  });

  it("binds the chosen request to where its provider is reached when it is sent", async () => {
    await withStore(async (store) => {
      const built: string[] = [];
      const bindings: Array<{ endpoint: string | undefined } | undefined> = [];
      const service = new IntuneChatService(chatHost(store, built, () => true, bindings));
      const failed = await service.streamIntuneChatMessage({ content: QUESTION }, () => undefined);
      assert.ok(bindings.every((binding) => binding === undefined), "an ordinary send is not bound");
      bindings.length = 0;
      const offerId = failed.assistantMessage.modelFit!.offerId!;
      await service.streamIntuneChatMessage({
        content: QUESTION,
        conversationId: failed.conversation.id,
        modelOverride: { offerId, providerId: "anthropic", model: "claude-sonnet-5-5" },
        hostedProviderConsent: freshConsent("anthropic", "claude-sonnet-5-5", false, offerId),
      }, () => undefined);
      assert.ok(bindings.length > 0 && bindings.every((binding) => binding?.endpoint === "claude-code"), JSON.stringify(bindings));
    });
  });

  it("sends only one of two concurrent requests that take up the same offer", async () => {
    await withStore(async (store) => {
      const built: string[] = [];
      const service = new IntuneChatService(chatHost(store, built));
      const failed = await service.streamIntuneChatMessage({ content: QUESTION }, () => undefined);
      const offerId = failed.assistantMessage.modelFit!.offerId!;
      built.length = 0;
      const send = () => service.streamIntuneChatMessage({
        content: QUESTION,
        conversationId: failed.conversation.id,
        modelOverride: { offerId, providerId: "anthropic", model: "claude-sonnet-5-5" },
        hostedProviderConsent: freshConsent("anthropic", "claude-sonnet-5-5", false, offerId),
      }, () => undefined);
      const results = await Promise.allSettled([send(), send()]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
      assert.match(String(refused.reason), /already used|no longer available/);
    });
  });

  it("sends an on-device retry only after a fresh check that the model runs here", async () => {
    await withStore(async (store) => {
      const built: string[] = [];
      // gpt-oss:20b turned into a remote-backed alias since the provider list was read.
      const service = new IntuneChatService(chatHost(store, built, (model) => model !== "gpt-oss:20b"));
      const failed = await service.streamIntuneChatMessage({ content: QUESTION }, () => undefined);
      built.length = 0;
      await assert.rejects(
        service.streamIntuneChatMessage({
          content: QUESTION,
          conversationId: failed.conversation.id,
          modelOverride: { offerId: failed.assistantMessage.modelFit!.offerId!, providerId: "ollama", model: "gpt-oss:20b" },
        }, () => undefined),
        /could not confirm that gpt-oss:20b runs on this device/,
      );
      assert.deepEqual(built, []);
    });
  });

  it("refuses a model fit acceptance on the non-streaming send", async () => {
    await withStore(async (store) => {
      const service = new IntuneChatService(chatHost(store, []));
      await assert.rejects(service.sendIntuneChatMessage({ content: QUESTION, hostedProviderConsent: freshConsent("anthropic", "claude-sonnet-5-5") }), /works only in Chat/);
    });
  });

  it("refuses an offer whose conversation was deleted", async () => {
    await withStore(async (store) => {
      const built: string[] = [];
      const service = new IntuneChatService(chatHost(store, built));
      const failed = await service.streamIntuneChatMessage({ content: QUESTION }, () => undefined);
      await service.deleteIntuneChatConversation(failed.conversation.id);
      built.length = 0;
      await assert.rejects(
        service.streamIntuneChatMessage({
          content: QUESTION,
          conversationId: failed.conversation.id,
          modelOverride: { offerId: failed.assistantMessage.modelFit!.offerId!, providerId: "anthropic", model: "claude-sonnet-5-5" },
          hostedProviderConsent: freshConsent("anthropic", "claude-sonnet-5-5", false, failed.assistantMessage.modelFit!.offerId!),
        }, () => undefined),
        /deleted/,
      );
      assert.deepEqual(built, []);
    });
  });
});
