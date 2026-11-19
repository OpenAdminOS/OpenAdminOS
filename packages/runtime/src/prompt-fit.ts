import {
  ContextTooSmallError,
  type ContextTooSmallFailure,
  type RunLlmApi,
} from "@openadminos/agent-sdk";

/**
 * Tokens kept for the answer when a request sets no `maxTokens`. Ollama then
 * generates until the context is full, so some room must stay free.
 */
export const DEFAULT_ANSWER_RESERVE_TOKENS = 1024;

/** Chat template tokens added around the system and user messages. */
const MESSAGE_OVERHEAD_TOKENS = 16;

const PIECE = /[A-Za-z0-9]+|\s+|[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]+|[^\x00-\x7f]/gu;

/**
 * Estimate how many tokens a model needs for `text`, without a tokenizer.
 *
 * Tenant JSON is dense in punctuation, GUIDs and short keys, where the usual
 * "four characters per token" rule undercounts. This counts pieces instead:
 * letters cost a token per 5.5, digits a token per 2, mixed letters and
 * digits (GUIDs, hashes) a token per 1.3, punctuation a token per 2, every
 * non-ASCII character a token, and whitespace a token per line break.
 *
 * Calibrated on 2026-11-19 against Ollama's prompt_eval_count for
 * OpenAdmin 8B (Mistral tokenizer) and gpt-oss 20B on CA policy JSON,
 * device JSON, GUID lists, prose and code. It came out 3% to 24% above the
 * real count for OpenAdmin 8B and up to 43% above for gpt-oss, never below,
 * so it refuses early rather than late.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (const match of text.matchAll(PIECE)) {
    const piece = match[0];
    const first = piece.charCodeAt(0);
    if (first > 127) {
      tokens += 1;
    } else if (/^[A-Za-z0-9]/.test(piece)) {
      const digits = /[0-9]/.test(piece);
      const letters = /[A-Za-z]/.test(piece);
      tokens += Math.ceil(piece.length / (digits && letters ? 1.3 : digits ? 2 : 5.5));
    } else if (/^\s/.test(piece)) {
      const lineBreaks = piece.split("\n").length - 1;
      tokens += lineBreaks > 0 ? lineBreaks : piece.length > 1 ? 1 : 0;
    } else {
      tokens += Math.ceil(piece.length / 2);
    }
  }
  return tokens;
}

export interface PromptFitInput {
  system?: string;
  prompt: string;
  /** The answer budget the request asks for. Unset reserves `DEFAULT_ANSWER_RESERVE_TOKENS`. */
  maxTokens?: number;
  /** The model's context window. Unset means unknown, which always fits. */
  contextWindow?: number;
  model?: string;
}

export interface PromptFit {
  fits: boolean;
  promptTokens: number;
  answerTokens: number;
  neededTokens: number;
  /** The context window compared against, when known. */
  limitTokens?: number;
  /** Set when the request does not fit a known window. */
  failure?: ContextTooSmallFailure;
}

/**
 * Compare a request's estimated size with a context window. With no known
 * window the request fits: hosted providers report none and are never
 * blocked here.
 */
export function checkPromptFit(input: PromptFitInput): PromptFit {
  const promptTokens =
    estimateTokens(input.system ?? "") + estimateTokens(input.prompt) + MESSAGE_OVERHEAD_TOKENS;
  const answerTokens =
    typeof input.maxTokens === "number" && Number.isFinite(input.maxTokens) && input.maxTokens > 0
      ? Math.ceil(input.maxTokens)
      : DEFAULT_ANSWER_RESERVE_TOKENS;
  const neededTokens = promptTokens + answerTokens;
  const limit = input.contextWindow;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return { fits: true, promptTokens, answerTokens, neededTokens };
  }
  if (neededTokens <= limit) {
    return { fits: true, promptTokens, answerTokens, neededTokens, limitTokens: limit };
  }
  return {
    fits: false,
    promptTokens,
    answerTokens,
    neededTokens,
    limitTokens: limit,
    failure: {
      code: "context-too-small",
      promptTokens,
      answerTokens,
      neededTokens,
      limitTokens: limit,
      ...(input.model ? { model: input.model } : {}),
    },
  };
}

/**
 * Ask the provider for the model's context window. Any failure to answer
 * counts as unknown, so a lookup problem never blocks a run.
 */
export async function resolveContextWindow(llm: RunLlmApi, model?: string): Promise<number | undefined> {
  if (typeof llm.contextWindow !== "function") return undefined;
  try {
    const value = await llm.contextWindow(model);
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Throw a typed `ContextTooSmallError` when the request cannot fit. */
export function assertPromptFits(input: PromptFitInput): PromptFit {
  const fit = checkPromptFit(input);
  if (fit.failure) throw new ContextTooSmallError(fit.failure);
  return fit;
}
