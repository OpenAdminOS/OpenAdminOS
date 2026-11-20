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
import { MODEL_FIT_OFFER_TTL_MS, ModelFitOffers, ModelOverrideError, chatModelFitFailure, guardModelFitLlm, loopFailureIssue, repeatedFailureIssue, resolveChatTurnProvider, type ModelFitOffer } from "./model-fit.js";
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

  it("reads the LM Studio adapter's messages and the newer Ollama forms, as the runtime words them", () => {
    const local = { providerId: "lm-studio" as const, model: "qwen3-8b", isLocal: true };
    const needs = classifyModelFitFailure("LM Studio context length too small: This request needs 15,857 tokens of context, but qwen3-8b is loaded in LM Studio with a context length of 4,096. Reload the model in LM Studio with a context length to at least 17,408.", local);
    assert.deepEqual([needs?.neededTokens, needs?.limitTokens], [15857, 4096]);
    const loadedOnly = classifyModelFitFailure("LM Studio context length too small: This request does not fit in the 8,192 tokens of context qwen3-8b is loaded with in LM Studio.", local);
    assert.deepEqual([loadedOnly?.reason, loadedOnly?.neededTokens, loadedOnly?.limitTokens], ["context-too-small", undefined, 8192]);
    assert.equal(classifyModelFitFailure("LM Studio context length too small: This request does not fit in the context length qwen3-8b is loaded with in LM Studio.", local)?.reason, "context-too-small");
    const ollamaLoaded = classifyModelFitFailure("Ollama context size too small: This request needs 50,000 tokens of context and did not fit in the 45,056 Ollama loaded for kept-outgrown.", { providerId: "ollama", isLocal: true });
    assert.deepEqual([ollamaLoaded?.neededTokens, ollamaLoaded?.limitTokens], [50000, 45056]);
    const kept = classifyModelFitFailure(new Error("Ollama context size too small: This request did not fit in the 45,056 token context kept from an earlier request. Ollama said: request exceeds"), { providerId: "ollama", isLocal: true });
    assert.deepEqual([kept?.reason, kept?.limitTokens], ["context-too-small", 45056]);
    // Memory forms without the "context size too small" prefix, as the runtime words them.
    for (const message of [
      `Ollama could not load ${LOCAL_MODEL} with the 45,056 token context size kept from an earlier request, usually because free memory ran out. Ollama said: model requires more system memory`,
      `Ollama failed partway through an answer from ${LOCAL_MODEL} with the 45,056 token context size kept from an earlier request, usually because free memory ran out. Ollama said: runner terminated`,
      `Ollama failed partway through an answer from ${LOCAL_MODEL} on the retry with a 45,056 token context size, usually because free memory ran out. Ollama said: runner terminated`,
    ]) {
      const issue = classifyModelFitFailure(new Error(message), { providerId: "ollama", model: LOCAL_MODEL, isLocal: true });
      assert.deepEqual([issue?.reason, issue?.limitTokens, issue?.limitIsMemory], ["context-too-small", 45056, true], message);
    }
    const wrapped = classifyModelFitFailure(`Agent failed: Ollama could not load ${LOCAL_MODEL} with the 45,056 token context size kept from an earlier request, usually because free memory ran out.`, { providerId: "ollama", isLocal: true });
    assert.equal(wrapped?.limitTokens, 45056);
    const retrySize = classifyModelFitFailure("Ollama context size too small: This request did not fit in the 32,768 token context of the retry. Ollama said: x", { providerId: "ollama", isLocal: true });
    assert.equal(retrySize?.limitTokens, 32768);
    // A remote-backed model on a loopback server already sent its prompt elsewhere: no on-device offer.
    assert.equal(chatModelFitFailure(new Error(OLLAMA_400), { ...ollama, remoteModels: [LOCAL_MODEL] }, LOCAL_MODEL), undefined);
    assert.equal(chatModelFitFailure(new Error(OLLAMA_400), ollama, "gpt-oss:120b-cloud"), undefined);
    assert.equal(repeatedFailureIssue({ ...ollama, remoteModels: [LOCAL_MODEL] }, LOCAL_MODEL), undefined);
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

  it("refuses a model server outside this device as a choice for one request", () => {
    const remoteLmStudio: ProviderSummary = { id: "lm-studio", name: "LM Studio", description: "", isLocal: false, status: "connected", models: ["qwen3-30b"] };
    assert.throws(() => resolveChatTurnProvider({ ...base, providers: [ollama, remoteLmStudio], override: { offerId: "fit_1", providerId: "lm-studio", model: "qwen3-30b" }, consent: freshConsent("lm-studio", "qwen3-30b") }), /server outside this device/);
    assert.deepEqual(modelFitChoices({ issue: { reason: "context-too-small", providerId: "ollama", model: LOCAL_MODEL }, providers: [ollama, remoteLmStudio, claude] }).hosted.map((choice) => choice.providerId), ["anthropic"]);
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
    providerTarget: async (providerId: ProviderId) => ({ endpoint: providerId === "anthropic" ? "claude-code" : undefined, destination: `dest-${providerId}` }),
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
        modelOverride: { offerId, providerId: "anthropic" as const, model: "claude-sonnet-5-5", destination: "dest-anthropic" },
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
      assert.ok(bindings.every((binding): boolean => binding === undefined), "an ordinary send is not bound");
      bindings.length = 0;
      const offerId = failed.assistantMessage.modelFit!.offerId!;
      await service.streamIntuneChatMessage({
        content: QUESTION,
        conversationId: failed.conversation.id,
        modelOverride: { offerId, providerId: "anthropic", model: "claude-sonnet-5-5", destination: "dest-anthropic" },
        hostedProviderConsent: freshConsent("anthropic", "claude-sonnet-5-5", false, offerId),
      }, () => undefined);
      assert.ok(bindings.length > 0 && bindings.every((binding) => binding?.endpoint === "claude-code"), JSON.stringify(bindings));
    });
  });

  it("keeps where a stopped request went", async () => {
    await withStore(async (store) => {
      const built: string[] = [];
      const host = chatHost(store, built);
      const controller = new AbortController();
      // The hosted model starts answering, then the admin stops the response.
      const stalling: RunLlmApi = {
        available: true,
        defaultModel: "claude-sonnet-5-5",
        complete: (options) => new Promise((_resolve, reject) => {
          controller.abort();
          options.signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
          if (options.signal?.aborted) reject(new Error("stopped"));
        }),
        // eslint-disable-next-line require-yield
        async *stream(options) { controller.abort(); if (options.signal?.aborted) throw new Error("stopped"); },
      };
      const buildLlm = host.buildLlm.bind(host);
      host.buildLlm = async (providerId, model, binding) => (providerId === "anthropic" ? (built.push(providerId), stalling) : buildLlm(providerId, model, binding));
      const service = new IntuneChatService(host);
      const failed = await service.streamIntuneChatMessage({ content: QUESTION }, () => undefined);
      const offerId = failed.assistantMessage.modelFit!.offerId!;
      const stopped = await service.streamIntuneChatMessage({
        content: QUESTION,
        conversationId: failed.conversation.id,
        modelOverride: { offerId, providerId: "anthropic", model: "claude-sonnet-5-5", destination: "dest-anthropic" },
        hostedProviderConsent: freshConsent("anthropic", "claude-sonnet-5-5", false, offerId),
      }, () => undefined, { signal: controller.signal });
      assert.equal(stopped.assistantMessage.status, "cancelled");
      assert.equal(stopped.assistantMessage.providerId, "anthropic");
      assert.deepEqual(stopped.assistantMessage.switchedFrom, { providerId: "ollama", model: LOCAL_MODEL, reason: "context-too-small", toOnDevice: false });
    });
  });

  it("refuses a hosted choice whose destination changed after its accept step opened", async () => {
    await withStore(async (store) => {
      const built: string[] = [];
      const host = chatHost(store, built);
      let destination = "resource-a";
      host.providerTarget = async () => ({ endpoint: destination, destination });
      const service = new IntuneChatService(host);
      const failed = await service.streamIntuneChatMessage({ content: QUESTION }, () => undefined);
      const offerId = failed.assistantMessage.modelFit!.offerId!;
      built.length = 0;
      // The accept step saw resource A; Settings now point the same deployment name at resource B.
      destination = "resource-b";
      const accepted = {
        content: QUESTION,
        conversationId: failed.conversation.id,
        modelOverride: { offerId, providerId: "anthropic" as const, model: "claude-sonnet-5-5", destination: "resource-a" },
        hostedProviderConsent: freshConsent("anthropic", "claude-sonnet-5-5", false, offerId),
      };
      await assert.rejects(service.streamIntuneChatMessage(accepted, () => undefined), /settings changed after you chose it/);
      assert.deepEqual(built, []);
      destination = "resource-a";
      const answered = await service.streamIntuneChatMessage(accepted, () => undefined);
      assert.equal(answered.assistantMessage.providerId, "anthropic");
    });
  });

  it("checks an on-device retry again before each model call and names no destination when nothing went out", async () => {
    await withStore(async (store) => {
      const built: string[] = [];
      let checks = 0;
      // On this device when the first request fails and when the retry is accepted, a remote-backed
      // alias by the time the model is called.
      const service = new IntuneChatService(chatHost(store, built, () => (checks += 1) <= 2));
      const failed = await service.streamIntuneChatMessage({ content: QUESTION }, () => undefined);
      const result = await service.streamIntuneChatMessage({
        content: QUESTION,
        conversationId: failed.conversation.id,
        modelOverride: { offerId: failed.assistantMessage.modelFit!.offerId!, providerId: "ollama", model: "gpt-oss:20b" },
      }, () => undefined);
      assert.equal(result.assistantMessage.status, "failed");
      assert.match(result.assistantMessage.error ?? "", /still runs on this device/);
      assert.equal(result.assistantMessage.switchedFrom, undefined);
      assert.ok(checks >= 3);
    });
  });

  it("guards every call of a wrapped model and reports each dispatch", async () => {
    const calls: string[] = [];
    let allowed = true;
    const inner: RunLlmApi = {
      available: true,
      async complete() { calls.push("complete"); return { text: "ok", model: "m" }; },
      async *stream() { calls.push("stream"); yield { delta: "ok", accumulated: "ok", done: true, model: "m" }; },
    };
    let dispatched = 0;
    const guarded = guardModelFitLlm(inner, {
      before: async () => { if (!allowed) throw new Error("not on this device"); },
      dispatched: () => { dispatched += 1; },
    });
    await guarded.complete({ prompt: "a" });
    // A call that is already stopped is not counted as sent.
    const stopped = new AbortController();
    stopped.abort();
    await guarded.complete({ prompt: "stopped", signal: stopped.signal });
    assert.equal(dispatched, 1);
    allowed = false;
    await assert.rejects(guarded.complete({ prompt: "b" }), /not on this device/);
    await assert.rejects((async () => { for await (const _chunk of guarded.stream({ prompt: "c" })) { /* drain */ } })(), /not on this device/);
    assert.deepEqual(calls, ["complete", "complete"]);
    assert.equal(dispatched, 1);
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
        modelOverride: { offerId, providerId: "anthropic", model: "claude-sonnet-5-5", destination: "dest-anthropic" },
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

  it("makes no offer when the model no longer runs on this device when it fails", async () => {
    await withStore(async (store) => {
      const service = new IntuneChatService(chatHost(store, [], () => false));
      const failed = await service.streamIntuneChatMessage({ content: QUESTION }, () => undefined);
      assert.equal(failed.assistantMessage.status, "failed");
      assert.equal(failed.assistantMessage.modelFit, undefined);
    });
  });

  it("ends as stopped, with no offer, when Stop comes while the locality check runs", async () => {
    await withStore(async (store) => {
      const controller = new AbortController();
      const host = chatHost(store, []);
      // The admin presses Stop while the check after the failure is still reading the model list.
      host.verifyOnDeviceModel = async () => { controller.abort(); return true; };
      const service = new IntuneChatService(host);
      const result = await service.streamIntuneChatMessage({ content: QUESTION }, () => undefined, { signal: controller.signal });
      assert.equal(result.assistantMessage.status, "cancelled");
      assert.equal(result.assistantMessage.modelFit, undefined);
    });
  });

  it("refuses a model fit acceptance on the non-streaming send", async () => {
    await withStore(async (store) => {
      const service = new IntuneChatService(chatHost(store, []));
      await assert.rejects(service.sendIntuneChatMessage({ content: QUESTION, hostedProviderConsent: freshConsent("anthropic", "claude-sonnet-5-5") }), /works only in Chat/);
    });
  });

  it("refuses the send, with the offer still unused, when the conversation is deleted during the last read before the claim", async () => {
    await withStore(async (store) => {
      const built: string[] = [];
      const host = chatHost(store, built);
      const service = new IntuneChatService(host);
      const failed = await service.streamIntuneChatMessage({ content: QUESTION }, () => undefined);
      const offerId = failed.assistantMessage.modelFit!.offerId!;
      built.length = 0;
      // The send reads the state at its start and again right before the claim; the deletion lands in that last read.
      const read = host.read.bind(host);
      let reads = 0;
      host.read = async () => {
        const state = await read();
        reads += 1;
        if (reads === 2) store.deleteConversation(failed.conversation.id);
        return state;
      };
      await assert.rejects(
        service.streamIntuneChatMessage({
          content: QUESTION,
          conversationId: failed.conversation.id,
          modelOverride: { offerId, providerId: "anthropic", model: "claude-sonnet-5-5", destination: "dest-anthropic" },
          hostedProviderConsent: freshConsent("anthropic", "claude-sonnet-5-5", false, offerId),
        }, () => undefined),
        /deleted/,
      );
      assert.deepEqual(built, []);
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
          modelOverride: { offerId: failed.assistantMessage.modelFit!.offerId!, providerId: "anthropic", model: "claude-sonnet-5-5", destination: "dest-anthropic" },
          hostedProviderConsent: freshConsent("anthropic", "claude-sonnet-5-5", false, failed.assistantMessage.modelFit!.offerId!),
        }, () => undefined),
        /deleted/,
      );
      assert.deepEqual(built, []);
    });
  });
});
