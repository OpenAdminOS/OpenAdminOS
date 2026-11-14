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

/**
 * Reads a response body, ending with the signal's abort even when the
 * body itself does not notice it.
 */
export async function readTextUntilAborted(response: Response, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([response.text(), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    // A body still open after the abort is cancelled so its stream is released.
    response.body?.cancel().catch(() => undefined);
  }
}
