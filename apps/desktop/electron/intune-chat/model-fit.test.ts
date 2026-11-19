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

import { classifyModelFitFailure, modelFitChoices, modelSizeBillions } from "../../src/shared/model-fit.js";
import { ModelOverrideError, resolveChatTurnProvider } from "./model-fit.js";
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

function freshConsent(providerId: ProviderId, model?: string, remember?: boolean): HostedProviderChatConsent {
  return { noTenant: true, providerId, ...(model ? { model } : {}), acknowledgedAt: new Date().toISOString(), ...(remember ? { remember: true } : {}) };
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

  it("reads a typed failure from the runtime by its shape, and llama.cpp's error", () => {
    const typed = Object.assign(new Error("too big"), { kind: "context-too-small", needed: 9000, limit: 4096 });
    assert.equal(classifyModelFitFailure(typed, { providerId: "lm-studio", isLocal: true })?.neededTokens, 9000);
    const thinking = Object.assign(new Error("reasoning only"), { code: "thinking-only" });
    assert.equal(classifyModelFitFailure(thinking, { providerId: "ollama", isLocal: true })?.reason, "thinking-only");
    const llamaCpp = classifyModelFitFailure('HTTP 400 {"error":{"type":"exceed_context_size_error","n_prompt_tokens":20000,"n_ctx":8192}}', { providerId: "lemonade", isLocal: true });
    assert.deepEqual([llamaCpp?.neededTokens, llamaCpp?.limitTokens], [20000, 8192]);
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
  const base = { providers: [ollama, claude], active: ollama, activeModel: LOCAL_MODEL, nova: false };
  const override = { providerId: "anthropic" as const, model: "claude-sonnet-5-5", fromProviderId: "ollama" as const, fromModel: LOCAL_MODEL, reason: "context-too-small" as const };

  it("keeps the active provider without an override", () => {
    const turn = resolveChatTurnProvider({ ...base, override: undefined, consent: undefined });
    assert.equal(turn.provider.id, "ollama");
    assert.equal(turn.switchedFrom, undefined);
  });

  it("refuses a hosted override without an acceptance, or with a remembered one", () => {
    assert.throws(() => resolveChatTurnProvider({ ...base, override, consent: undefined }), ModelOverrideError);
    assert.throws(() => resolveChatTurnProvider({ ...base, override, consent: freshConsent("anthropic", "claude-sonnet-5-5", true) }), /needs your approval for this request/);
    assert.throws(() => resolveChatTurnProvider({ ...base, override, consent: freshConsent("openai") }), /needs your approval/);
  });

  it("runs on the chosen provider with a fresh acceptance and records what it replaced", () => {
    const turn = resolveChatTurnProvider({ ...base, override, consent: freshConsent("anthropic", "claude-sonnet-5-5") });
    assert.equal(turn.provider.id, "anthropic");
    assert.equal(turn.model, "claude-sonnet-5-5");
    assert.deepEqual(turn.switchedFrom, { providerId: "ollama", model: LOCAL_MODEL, reason: "context-too-small" });
  });

  it("refuses a provider that is not listed (left out by policy) or not ready, a stale offer, and Nova", () => {
    assert.throws(() => resolveChatTurnProvider({ ...base, providers: [ollama], override, consent: freshConsent("anthropic") }), /not available on this device/);
    assert.throws(() => resolveChatTurnProvider({ ...base, providers: [ollama, codexSignedOut], override: { ...override, providerId: "openai", model: undefined }, consent: freshConsent("openai") }), /not ready/);
    assert.throws(() => resolveChatTurnProvider({ ...base, activeModel: "gpt-oss:20b", override, consent: freshConsent("anthropic") }), /changed since this request failed/);
    assert.throws(() => resolveChatTurnProvider({ ...base, nova: true, override, consent: freshConsent("anthropic") }), /Nova/);
  });

  it("runs on a larger local model without a hosted acceptance", () => {
    const turn = resolveChatTurnProvider({ ...base, override: { ...override, providerId: "ollama", model: "gpt-oss:20b" }, consent: undefined });
    assert.equal(turn.provider.id, "ollama");
    assert.equal(turn.model, "gpt-oss:20b");
  });
});

/** A local model that rejects every prompt for its size, and a hosted one that answers. */
function chatHost(store: IntelligenceSqliteStore, built: string[]): ChatServiceHost {
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
    buildLlm: async (providerId: ProviderId) => {
      built.push(providerId);
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
      assert.deepEqual(result.assistantMessage.modelFit, {
        reason: "context-too-small", neededTokens: 40652, limitTokens: 16384, providerId: "ollama", model: LOCAL_MODEL,
      });
      assert.ok(events.some((event) => event.type === "failed"));
      assert.ok(built.length > 0 && built.every((id) => id === "ollama"), `built ${built.join(", ")}`);
      // Stored with the answer, so a reload keeps the offer's reason.
      assert.equal(store.listMessages(result.conversation.id).at(-1)?.modelFit?.neededTokens, 40652);
    });
  });

  it("refuses the hosted override without a per-request acceptance, before any model is built", async () => {
    await withStore(async (store) => {
      const built: string[] = [];
      const service = new IntuneChatService(chatHost(store, built));
      const modelOverride = { providerId: "anthropic" as const, model: "claude-sonnet-5-5", fromProviderId: "ollama" as const, fromModel: LOCAL_MODEL, reason: "context-too-small" as const };
      await assert.rejects(service.streamIntuneChatMessage({ content: QUESTION, modelOverride }, () => undefined), /needs your approval for this request/);
      await assert.rejects(
        service.streamIntuneChatMessage({ content: QUESTION, modelOverride, hostedProviderConsent: freshConsent("anthropic", "claude-sonnet-5-5", true) }, () => undefined),
        /needs your approval for this request/,
      );
      assert.deepEqual(built, []);
    });
  });

  it("answers this one request with the chosen provider after the acceptance and names what it replaced", async () => {
    await withStore(async (store) => {
      const built: string[] = [];
      const service = new IntuneChatService(chatHost(store, built));
      const result = await service.streamIntuneChatMessage(
        {
          content: QUESTION,
          modelOverride: { providerId: "anthropic", model: "claude-sonnet-5-5", fromProviderId: "ollama", fromModel: LOCAL_MODEL, reason: "context-too-small" },
          hostedProviderConsent: freshConsent("anthropic", "claude-sonnet-5-5"),
        },
        () => undefined,
      );
      assert.equal(result.assistantMessage.status, "completed", result.assistantMessage.error);
      assert.equal(result.assistantMessage.providerId, "anthropic");
      assert.deepEqual(result.assistantMessage.switchedFrom, { providerId: "ollama", model: LOCAL_MODEL, reason: "context-too-small" });
      assert.ok(built.every((id) => id === "anthropic"), `built ${built.join(", ")}`);
      // The next request goes to the active local model again.
      const next = await service.streamIntuneChatMessage({ content: QUESTION, conversationId: result.conversation.id }, () => undefined);
      assert.equal(next.assistantMessage.providerId, "ollama");
      assert.equal(next.assistantMessage.switchedFrom, undefined);
    });
  });
});
