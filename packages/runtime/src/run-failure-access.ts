import { GraphAccessDeniedError, graphAccessDenialFromError, type GraphAccessDenial } from "@openadminos/agent-sdk";

/**
 * The Graph denial behind a failed run. A typed denial is kept as it is. For
 * any other error only the app's own words count: what a provider said,
 * quoted after "Ollama said:" (for example "403 MiB"), is not a Graph denial.
 */
export function runFailureAccessDenial(error: unknown): GraphAccessDenial | undefined {
  if (error instanceof GraphAccessDeniedError) return graphAccessDenialFromError(error);
  const message = error instanceof Error ? error.message : String(error);
  return graphAccessDenialFromError(message.split("Ollama said:")[0] ?? message);
}
