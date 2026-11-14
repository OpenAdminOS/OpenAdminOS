/**
 * Typed failures of the local model clients, so a host classifies them by
 * code instead of message text. A timeout is the provider not answering
 * in time; a cancellation is the caller stopping the request.
 */
export class LlmTimeoutError extends Error {
  readonly code = "model-timeout" as const;
  constructor(message: string) {
    super(message);
    this.name = "LlmTimeoutError";
  }
}

export class LlmCancelledError extends Error {
  readonly code = "model-cancelled" as const;
  constructor(message: string) {
    super(message);
    this.name = "LlmCancelledError";
  }
}

export function llmErrorCode(error: unknown): "model-timeout" | "model-cancelled" | undefined {
  if (error instanceof LlmTimeoutError || error instanceof LlmCancelledError) return error.code;
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "model-timeout" || code === "model-cancelled" ? code : undefined;
}
