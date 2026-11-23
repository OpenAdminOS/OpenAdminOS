import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  contextTooSmallMessage,
  type AgentSummary,
  type LlmOptions,
  type RunGraphApi,
  type RunLlmApi,
} from "@openadminos/agent-sdk";

import { checkPromptFit, estimateTokens } from "./prompt-fit.js";
import { appVersionSatisfies, createQueuedRun, executeRun } from "./index.js";
import { createOllamaLlm } from "./llm-ollama.js";
import { syntheticConditionalAccessPolicies } from "./test-fixtures/conditional-access.js";

const LOCAL_CONTEXT = 16_384;
const ANSWER_BUDGET = 1_100;

const agent: AgentSummary = {
  id: "conditional-access-explainer",
  slug: "conditional-access-explainer",
  name: "Conditional Access explainer",
  description: "Fixture",
  mode: "read",
  category: "policies",
  tier: "agent",
  requiresEntraTier: "p1",
  scopes: ["Policy.Read.All"],
  version: "1.2.0",
  installedAt: new Date().toISOString(),
  author: { name: "OpenAdminOS" },
  registryPath: resolve(fileURLToPath(new URL("../../../agents/", import.meta.url)), "conditional-access-explainer"),
};

function graphReturning(policies: unknown[]): RunGraphApi {
  return {
    listManagedDevices: async () => [],
    retireManagedDevice: async () => undefined,
    request: async (input: { path: string }) => {
      assert.equal(input.path, "/identity/conditionalAccess/policies");
      return { value: policies };
    },
  } as unknown as RunGraphApi;
}

function recordingLlm(contextWindow: number | undefined): { llm: RunLlmApi; sent: LlmOptions[] } {
  const sent: LlmOptions[] = [];
  const llm: RunLlmApi = {
    available: true,
    defaultModel: "openadminos/openadmin-8b:latest",
    async complete() {
      throw new Error("Agent runs use the streaming boundary.");
    },
    async *stream(options: LlmOptions) {
      sent.push(options);
      yield { delta: "Review", accumulated: "Review", model: "openadminos/openadmin-8b:latest", done: true };
    },
    ...(contextWindow !== undefined ? { contextWindow: async () => contextWindow } : {}),
  };
  return { llm, sent };
}

async function runExplainer(policies: unknown[], contextWindow: number | undefined) {
  const { llm, sent } = recordingLlm(contextWindow);
  const result = await executeRun({
    run: createQueuedRun({ agent, providerId: "ollama" }),
    agent,
    providerId: "ollama",
    llm,
    createGraph: () => graphReturning(policies),
    onProgress: () => {},
  });
  return { result, sent };
}

function fitOf(options: LlmOptions) {
  return checkPromptFit({
    system: options.system,
    prompt: options.prompt,
    maxTokens: options.maxTokens,
    contextWindow: LOCAL_CONTEXT,
  });
}

describe("Conditional Access explainer prompt size", () => {
  it("fits 33 realistic policies in a 16k context with an 1,100 token answer budget", async () => {
    const policies = syntheticConditionalAccessPolicies(33);
    const { result, sent } = await runExplainer(policies, LOCAL_CONTEXT);
    assert.equal(result.status, "completed", result.error);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.maxTokens, ANSWER_BUDGET);
    const fit = fitOf(sent[0]!);
    assert.equal(fit.fits, true, `needed ${fit.neededTokens} tokens`);
    // The raw Graph objects alone used to be larger than this whole prompt.
    assert.ok(estimateTokens(JSON.stringify(policies)) > fit.promptTokens);
  });

  it("sends each policy once, as a compact record, with names only in the age groups", async () => {
    const policies = syntheticConditionalAccessPolicies(33);
    const { sent } = await runExplainer(policies, LOCAL_CONTEXT);
    const prompt = sent[0]!.prompt;
    for (const policy of policies) {
      // Policy ids never reach the prompt: no Graph object is copied in.
      assert.equal(prompt.includes(String(policy.id)), false, `${String(policy.displayName)} id leaked`);
      const record = `"name":"${String(policy.displayName)}"`;
      assert.equal(prompt.split(record).length - 1, 1, `${String(policy.displayName)} record count`);
    }
    for (const key of ["\"conditions\"", "\"grantControls\"", "\"sessionControls\"", "@odata", "allowedCombinations"]) {
      assert.equal(prompt.includes(key), false, `prompt carries ${key}`);
    }
    // The age breakdown holds names, not policy objects.
    const ageBlock = /Policies not modified for a long time, by name: <tenant_data[^>]*>\n([\s\S]*?)\n<\/tenant_data/.exec(prompt)?.[1];
    assert.ok(ageBlock, "age breakdown is in the prompt");
    const buckets = JSON.parse(ageBlock) as Record<string, unknown[]>;
    const names = Object.values(buckets).flat();
    assert.ok(names.length > 0);
    for (const name of names) assert.equal(typeof name, "string");
  });

  it("fits 100 policies, and a larger tenant stops in preflight with the typed reason", async () => {
    const hundred = await runExplainer(syntheticConditionalAccessPolicies(100), LOCAL_CONTEXT);
    assert.equal(hundred.result.status, "completed", hundred.result.error);
    const fit = fitOf(hundred.sent[0]!);
    assert.equal(fit.fits, true, `100 policies need ${fit.neededTokens} tokens`);

    const large = await runExplainer(syntheticConditionalAccessPolicies(250), LOCAL_CONTEXT);
    assert.equal(large.sent.length, 0, "nothing may be sent to the model");
    assert.equal(large.result.status, "failed");
    const reason = large.result.failureReason;
    assert.ok(reason, "failure carries a typed reason");
    assert.equal(reason.code, "context-too-small");
    assert.equal(reason.limitTokens, LOCAL_CONTEXT);
    assert.equal(reason.answerTokens, ANSWER_BUDGET);
    assert.ok(reason.neededTokens > LOCAL_CONTEXT);
    assert.equal(reason.model, "openadminos/openadmin-8b:latest");
    assert.equal(large.result.error, contextTooSmallMessage(reason));
    assert.doesNotMatch(large.result.error ?? "", /HTTP 400/);
  });

  it("does not block a provider that reports no context window", async () => {
    const { result, sent } = await runExplainer(syntheticConditionalAccessPolicies(250), undefined);
    assert.equal(result.status, "completed", result.error);
    assert.equal(sent.length, 1);
    assert.equal(result.failureReason, undefined);
  });

  it("counts an adapter's system suffix in the check, also when the prompt alone is already too large", async () => {
    const suffix = "Approved instruction. ".repeat(400);
    for (const count of [33, 250]) {
      const { llm, sent } = recordingLlm(LOCAL_CONTEXT);
      const withSuffix: RunLlmApi = { ...llm, systemSuffix: suffix };
      const plain = await executeRun({ run: createQueuedRun({ agent, providerId: "ollama" }), agent, providerId: "ollama", llm: recordingLlm(1).llm, createGraph: () => graphReturning(syntheticConditionalAccessPolicies(count)), onProgress: () => {} });
      const result = await executeRun({ run: createQueuedRun({ agent, providerId: "ollama" }), agent, providerId: "ollama", llm: withSuffix, createGraph: () => graphReturning(syntheticConditionalAccessPolicies(count)), onProgress: () => {} });
      // A one token window refuses every request, so `plain` reports the size without the suffix.
      const without = plain.failureReason!.promptTokens;
      if (result.failureReason) {
        assert.ok(result.failureReason.promptTokens >= without + estimateTokens(suffix), "the suffix is counted");
        assert.equal(sent.length, 0);
      } else {
        assert.equal(sent.length, 1);
      }
    }
  });

    it("treats a failing context lookup as unknown", async () => {
    const { llm, sent } = recordingLlm(undefined);
    llm.contextWindow = async () => {
      throw new Error("lookup failed");
    };
    const result = await executeRun({
      run: createQueuedRun({ agent, providerId: "ollama" }),
      agent,
      providerId: "ollama",
      llm,
      createGraph: () => graphReturning(syntheticConditionalAccessPolicies(5)),
      onProgress: () => {},
    });
    assert.equal(result.status, "completed", result.error);
    assert.equal(sent.length, 1);
  });

  it("through the real Ollama adapter, never sends an oversized request to /api/chat", async () => {
    // Mocked Ollama: the /api/show shape OpenAdmin 8B returns, and a chat
    // endpoint that records every call. No local model is involved.
    const chats: unknown[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/show") {
        return new Response(JSON.stringify({
          parameters: "num_ctx                        16384\ntemperature                    0.2",
          model_info: { "general.architecture": "mistral3", "mistral3.context_length": 262144, "mistral3.rope.scaling.original_context_length": 16384 },
        }), { status: 200 });
      }
      if (path === "/api/chat") {
        chats.push(JSON.parse(String(init?.body)));
        return new Response(`${JSON.stringify({ model: "openadminos/openadmin-8b:latest", message: { content: "Review" }, done: true })}\n`, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    try {
      const run = async (count: number) => executeRun({
        run: createQueuedRun({ agent, providerId: "ollama" }),
        agent,
        providerId: "ollama",
        llm: createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "openadminos/openadmin-8b:latest" }),
        createGraph: () => graphReturning(syntheticConditionalAccessPolicies(count)),
        onProgress: () => {},
      });
      const large = await run(250);
      assert.equal(chats.length, 0, "an oversized request reached /api/chat");
      assert.equal(large.status, "failed");
      assert.equal(large.failureReason?.code, "context-too-small");
      assert.equal(large.failureReason?.limitTokens, 16_384);

      const fits = await run(33);
      assert.equal(fits.status, "completed", fits.error);
      assert.equal(chats.length, 1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("Conditional Access explainer minimum app version", () => {
  it("accepts the first nightly with the compact records and later builds, not 0.7.2 or earlier nightlies", () => {
    const manifest = readFileSync(resolve(agent.registryPath!, "manifest.yaml"), "utf8");
    const min = /^\s*minAppVersion:\s*(\S+)\s*$/m.exec(manifest)?.[1];
    assert.equal(min, "0.7.3-nightly.20261123094040");
    assert.equal(appVersionSatisfies("0.7.2", min!), false);
    assert.equal(appVersionSatisfies("0.7.3-nightly.20261120052634", min!), false);
    assert.equal(appVersionSatisfies("0.7.3-nightly.20261123094040", min!), true);
    assert.equal(appVersionSatisfies("0.7.3-nightly.20261123100828", min!), true);
    assert.equal(appVersionSatisfies("0.7.3", min!), true);
  });
});
