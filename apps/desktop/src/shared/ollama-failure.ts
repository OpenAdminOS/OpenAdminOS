import { unwrapAppFailure, type ContextTooSmallFailure } from "@openadminos/agent-sdk";

/** Ollama's quoted response can contain words that would select an unrelated playbook. */
export function ollamaFailureOwnText(error: string): string {
  return error.split("Ollama said:", 1)[0] ?? error;
}

/** Match the runtime's memory and uncounted overflow errors for a dropped context size. */
export function isOllamaKeptContextFailure(error: string | undefined, failure?: ContextTooSmallFailure): boolean {
  if (failure?.ollamaKeptContext === true) return true;
  if (!error) return false;
  const message = unwrapAppFailure(ollamaFailureOwnText(error)).trim()
    .replace(/^MXC script agent "[^"]+" failed: Error: llm\.complete: /, "");
  return /^Ollama (?:could not load|failed partway through an answer from) \S+ with the [\d,]+ token context size kept from an earlier request,/.test(message)
    || /^Ollama context size too small: This request did not fit in the [\d,]+ token context kept from an earlier request\./.test(message);
}
