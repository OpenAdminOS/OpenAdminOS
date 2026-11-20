import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ContextTooSmallError, contextTooSmallFromError, contextTooSmallMessage } from "@openadminos/agent-sdk";

import {
  assertPromptFits,
  checkPromptFit,
  DEFAULT_ANSWER_RESERVE_TOKENS,
  estimateTokens,
  resolveContextWindow,
} from "./prompt-fit.js";
import { parseOllamaLoadedContext, parseOllamaShow, readOllamaContextWindow } from "./ollama-context.js";
import { createOllamaLlm } from "./llm-ollama.js";

describe("estimateTokens", () => {
  it("is zero for empty text and grows with content", () => {
    assert.equal(estimateTokens(""), 0);
    assert.ok(estimateTokens("Require MFA for administrators") < estimateTokens("Require MFA for administrators and guests"));
  });

  it("weights GUIDs and punctuation more than prose of the same length", () => {
    const guid = '"62e90394-69f5-4237-9190-012177145e10"';
    const prose = "a".repeat(4) + " short words in a line here";
    assert.ok(estimateTokens(guid) > estimateTokens(prose.slice(0, guid.length)));
  });

  it("counts each non-ASCII character", () => {
    assert.equal(estimateTokens("東京"), 2);
  });
});

describe("checkPromptFit", () => {
  it("always fits when the context window is unknown", () => {
    const fit = checkPromptFit({ prompt: "x".repeat(400_000) });
    assert.equal(fit.fits, true);
    assert.equal(fit.limitTokens, undefined);
    assert.equal(fit.failure, undefined);
  });

  it("reserves the requested answer budget, or a default", () => {
    assert.equal(checkPromptFit({ prompt: "hello", maxTokens: 1100 }).answerTokens, 1100);
    assert.equal(checkPromptFit({ prompt: "hello" }).answerTokens, DEFAULT_ANSWER_RESERVE_TOKENS);
  });

  it("returns a typed failure with the numbers when the request is too large", () => {
    const fit = checkPromptFit({ system: "sys", prompt: "word ".repeat(20_000), maxTokens: 1100, contextWindow: 16_384, model: "m" });
    assert.equal(fit.fits, false);
    assert.deepEqual(fit.failure, {
      code: "context-too-small",
      promptTokens: fit.promptTokens,
      answerTokens: 1100,
      neededTokens: fit.promptTokens + 1100,
      limitTokens: 16_384,
      model: "m",
    });
  });

  it("assertPromptFits throws a ContextTooSmallError with the designed message", () => {
    assert.throws(
      () => assertPromptFits({ prompt: "word ".repeat(20_000), contextWindow: 4096, model: "small" }),
      (error: unknown) => {
        assert.ok(error instanceof ContextTooSmallError);
        assert.equal(error.code, "context-too-small");
        assert.equal(error.limitTokens, 4096);
        assert.equal(error.neededTokens, error.failure.neededTokens);
        const failure = contextTooSmallFromError(error);
        assert.ok(failure);
        assert.equal(error.message, contextTooSmallMessage(failure));
        assert.match(error.message, /needs about [\d,]+ tokens of context/);
        assert.match(error.message, /small accepts 4,096\. Nothing was sent to the model\./);
        assert.doesNotMatch(error.message, /!/);
        return true;
      },
    );
  });
});

describe("resolveContextWindow", () => {
  it("is undefined without the capability, on errors and on bad values", async () => {
    const base = { available: true, complete: async () => ({ text: "", model: "" }), async *stream() {} };
    assert.equal(await resolveContextWindow(base), undefined);
    assert.equal(await resolveContextWindow({ ...base, contextWindow: async () => { throw new Error("down"); } }), undefined);
    assert.equal(await resolveContextWindow({ ...base, contextWindow: async () => -1 }), undefined);
    assert.equal(await resolveContextWindow({ ...base, contextWindow: async () => 8192 }), 8192);
  });
});

// Shape of a real /api/show response for openadminos/openadmin-8b (Ollama 0.40).
const SHOW = {
  parameters: "num_ctx                        16384\ntemperature                    0.2",
  model_info: {
    "general.architecture": "mistral3",
    "mistral3.context_length": 262144,
    "mistral3.rope.scaling.original_context_length": 16384,
  },
};

describe("Ollama context window", () => {
  it("reads the pinned num_ctx and the architecture's maximum, not the rope key", () => {
    assert.deepEqual(parseOllamaShow(SHOW), { pinnedNumCtx: 16384, modelMaxContext: 262144 });
    assert.deepEqual(parseOllamaShow({ model_info: { "general.architecture": "llama", "llama.context_length": 131072 } }), { modelMaxContext: 131072 });
    assert.deepEqual(parseOllamaShow(null), {});
  });

  it("reads a loaded model's context from /api/ps, matching an implicit latest tag", () => {
    const ps = { models: [{ name: "gpt-oss:20b", model: "gpt-oss:20b", context_length: 32768 }, { name: "llama3.1:latest", context_length: 8192 }] };
    assert.equal(parseOllamaLoadedContext(ps, "gpt-oss:20b"), 32768);
    assert.equal(parseOllamaLoadedContext(ps, "llama3.1"), 8192);
    assert.equal(parseOllamaLoadedContext(ps, "qwen3"), undefined);
  });

  const fakeFetch = (routes: Record<string, unknown>): typeof fetch =>
    (async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      if (!(path in routes)) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(routes[path]), { status: 200 });
    }) as typeof fetch;

  it("uses the pinned num_ctx while the app cannot raise it", async () => {
    const window = await readOllamaContextWindow("http://127.0.0.1:11434", "openadminos/openadmin-8b", { fetchImpl: fakeFetch({ "/api/show": SHOW }) });
    assert.equal(window, 16384);
  });

  it("uses the model maximum when the app raises num_ctx", async () => {
    const window = await readOllamaContextWindow("http://127.0.0.1:11434", "m", { appRaisesNumCtx: true, fetchImpl: fakeFetch({ "/api/show": SHOW }) });
    assert.equal(window, 262144);
  });

  it("uses the loaded size for a model without a pinned num_ctx", async () => {
    const show = { model_info: { "general.architecture": "gptoss", "gptoss.context_length": 131072 } };
    const ps = { models: [{ name: "gpt-oss:20b", context_length: 32768 }] };
    assert.equal(await readOllamaContextWindow("http://127.0.0.1:11434", "gpt-oss:20b", { fetchImpl: fakeFetch({ "/api/show": show, "/api/ps": ps }) }), 32768);
    assert.equal(await readOllamaContextWindow("http://127.0.0.1:11434", "gpt-oss:20b", { fetchImpl: fakeFetch({ "/api/show": show }) }), 131072);
  });

  it("the Ollama adapter reports the model maximum, because it raises num_ctx on an overflow", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch({ "/api/show": SHOW });
    try {
      const llm = createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "openadminos/openadmin-8b" });
      assert.equal(await llm.contextWindow?.(), 262144);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("is unknown when Ollama does not answer or no model is set", async () => {
    const failing = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    assert.equal(await readOllamaContextWindow("http://127.0.0.1:11434", "m", { fetchImpl: failing }), undefined);
    assert.equal(await readOllamaContextWindow("http://127.0.0.1:11434", undefined), undefined);
  });
});
