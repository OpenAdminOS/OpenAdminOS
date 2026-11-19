import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
import { createQueuedRun, executeRun } from "./index.js";
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
});
