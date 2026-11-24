import { unwrapAppFailure, type ContextTooSmallFailure } from "@openadminos/agent-sdk";
import type { RunRecord } from "./openAdminOS.js";

/** Ollama's quoted response can contain words that would select an unrelated playbook. */
export function ollamaFailureOwnText(error: string): string {
  return error.split("Ollama said:", 1)[0] ?? error;
}

function unwrapOllamaFailure(error: string): string {
  return unwrapAppFailure(ollamaFailureOwnText(error)).trim()
    .replace(/^MXC script agent "[^"]+" failed: Error: llm\.complete: /, "");
}

/** Match the Ollama adapter's two messages after unwrapping app errors. */
export function isOllamaReasoningWithoutAnswerMessage(error: string | undefined): boolean {
  if (!error) return false;
  const message = unwrapOllamaFailure(error);
  return /^Ollama stopped "[^"\r\n]+" at the token limit while it was still reasoning, so there is no answer\./.test(message)
    || /^Ollama returned only reasoning from "[^"\r\n]+" and no answer\./.test(message);
}

/** Prefer the runtime's recorded cause, with a text match for older runs. */
export function isReasoningWithoutAnswerRun(run: Pick<RunRecord, "failureCause" | "failureReason" | "providerId" | "error">): boolean {
  return run.failureCause === "reasoning-without-answer"
    || (run.providerId === "ollama" && !run.failureReason && isOllamaReasoningWithoutAnswerMessage(run.error));
}

/** Match the runtime's memory and uncounted overflow errors for a dropped context size. */
export function isOllamaKeptContextFailure(error: string | undefined, failure?: ContextTooSmallFailure): boolean {
  if (failure?.ollamaKeptContext === true) return true;
  if (!error) return false;
  const message = unwrapOllamaFailure(error);
  return /^Ollama (?:could not load|failed partway through an answer from) \S+ with the [\d,]+ token context size kept from an earlier request,/.test(message)
    || /^Ollama context size too small: This request did not fit in the [\d,]+ token context kept from an earlier request\./.test(message);
}
