import type { ProviderId } from "./openAdminOS.js";

const IMPLEMENTED_PROVIDER_IDS: ReadonlySet<ProviderId> = new Set([
  "ollama",
  "apple-foundation",
  "lm-studio",
  "anthropic",
  "openai",
  "azure-openai",
  "copilot",
  "gemini",
]);

export function isProviderImplemented(id: ProviderId): boolean {
  return IMPLEMENTED_PROVIDER_IDS.has(id);
}

/**
 * How prompts reach a hosted provider, named per provider type: through
 * a locally installed vendor CLI, or straight to an API endpoint.
 */
const HOSTED_CHANNELS: Partial<Record<ProviderId, string>> = {
  anthropic: "the Claude Code CLI to Anthropic",
  openai: "the Codex CLI to OpenAI",
  copilot: "the GitHub Copilot CLI to GitHub",
  gemini: "the Gemini CLI to Google",
  "azure-openai": "the Azure OpenAI API to your deployment",
};

export function hostedChannel(provider: { id: ProviderId; name: string }): string {
  return HOSTED_CHANNELS[provider.id] ?? `the ${provider.name} API`;
}
