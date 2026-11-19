/**
 * Typed reason for a model request that does not fit the model's context
 * window. The runtime raises it before anything is sent, so the UI and the
 * provider switch flow can act on the numbers without parsing a message.
 */
export interface ContextTooSmallFailure {
  code: "context-too-small";
  /** Estimated prompt tokens (system and user text). */
  promptTokens: number;
  /** Tokens reserved for the answer. */
  answerTokens: number;
  /** promptTokens + answerTokens. */
  neededTokens: number;
  /** The model's context window in tokens. */
  limitTokens: number;
  /** Model the request was meant for, when known. */
  model?: string;
}

/** Machine readable reasons a run failed. Extend with new codes as they appear. */
export type RunFailureReason = ContextTooSmallFailure;

export class ContextTooSmallError extends Error {
  readonly code = "context-too-small" as const;
  readonly failure: ContextTooSmallFailure;

  constructor(failure: ContextTooSmallFailure) {
    super(contextTooSmallMessage(failure));
    this.name = "ContextTooSmallError";
    this.failure = failure;
  }
}

const formatTokens = (value: number) => value.toLocaleString("en-US");

/** Plain copy for the failure. Names the size needed, the limit, and the ways out. */
export function contextTooSmallMessage(failure: ContextTooSmallFailure): string {
  const model = failure.model ? `${failure.model}` : "The selected model";
  return (
    `This request needs about ${formatTokens(failure.neededTokens)} tokens of context ` +
    `(${formatTokens(failure.promptTokens)} for the prompt and ${formatTokens(failure.answerTokens)} for the answer), ` +
    `but ${model} accepts ${formatTokens(failure.limitTokens)}. Nothing was sent to the model. ` +
    "Pick a model with a larger context window, switch to a hosted provider, or narrow the agent's scope, then re-run."
  );
}

/** The typed reason carried by an error, if it is a context fit failure. */
export function contextTooSmallFromError(error: unknown): ContextTooSmallFailure | undefined {
  if (error instanceof ContextTooSmallError) return error.failure;
  if (error && typeof error === "object" && (error as { code?: unknown }).code === "context-too-small") {
    const failure = (error as { failure?: unknown }).failure;
    if (isContextTooSmallFailure(failure)) return failure;
  }
  return undefined;
}

export function isContextTooSmallFailure(value: unknown): value is ContextTooSmallFailure {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.code === "context-too-small" &&
    [record.promptTokens, record.answerTokens, record.neededTokens, record.limitTokens].every(
      (entry) => typeof entry === "number" && Number.isFinite(entry),
    )
  );
}
