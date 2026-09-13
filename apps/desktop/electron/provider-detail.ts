import {
  classifyOllamaEndpoint,
  classifyLmStudioEndpoint,
  probeAppleFoundationLlm,
  probeClaudeCodeLlm,
  probeCodexLlm,
  probeCopilotLlm,
  probeGeminiLlm,
  type CliProbe,
  probeLmStudioLlm,
  resolveLmStudioEndpoint,
  resolveOllamaEndpoint,
} from "@openadminos/runtime";
import {
  type AzureOpenAIProviderConfig,
  providerCatalog,
  type ProviderId,
  type ProviderSummary,
} from "@openadminos/agent-sdk";



export const providerIds = new Set<ProviderId>(
  providerCatalog.map((provider) => provider.id),
);



export interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
  }>;
}



export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && providerIds.has(value as ProviderId);
}



export async function checkOllama(provider: ProviderSummary): Promise<ProviderSummary> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  const endpoint = resolveOllamaEndpoint().replace(/\/$/, "");
  const endpointTrust = classifyOllamaEndpoint(endpoint);
  const trustedProvider = endpointTrust.isLocal
    ? provider
    : {
        ...provider,
        description:
          "Use an Ollama-compatible endpoint outside this device. Tenant prompts leave this device when active.",
        isLocal: false,
      };

  try {
    const response = await fetch(`${endpoint}/api/tags`, {
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        ...trustedProvider,
        status: "error",
        detail: ollamaEndpointDetail(
          endpointTrust,
          `Ollama responded with HTTP ${response.status}`,
        ),
        models: [],
      };
    }

    const payload = (await response.json()) as OllamaTagsResponse;
    const installedModels =
      payload.models
        ?.map((model) => model.name)
        .filter((name): name is string => Boolean(name)) ?? [];
    // /api/tags also includes embedding-only models. Ask Ollama instead of
    // guessing capabilities from names, which can be arbitrary local aliases.
    let unverified = false;
    const supported = await Promise.all(installedModels.map(async (model) => {
      try {
        const details = await fetch(`${endpoint}/api/show`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model }),
          signal: controller.signal,
        });
        if (!details.ok) throw new Error("Model details unavailable");
        const data = await details.json() as { capabilities?: unknown };
        if (!Array.isArray(data.capabilities)) throw new Error("Model capabilities unavailable");
        return data.capabilities.includes("completion");
      } catch {
        unverified = true;
        return false;
      }
    }));
    const models = installedModels.filter((_, i) => supported[i]);

    return {
      ...trustedProvider,
      status: models.length ? "connected" : "error",
      detail: ollamaEndpointDetail(
        endpointTrust,
        models.length > 0
          ? `Running on ${endpoint}${unverified ? ". Some model capabilities could not be verified; refresh to retry" : ""}`
          : unverified
            ? "Ollama is running, but text-generation capabilities could not be verified. Check the server's /api/show support and refresh providers."
            : "Ollama has no text-generation models available. Install a text-generation model, then refresh providers.",
      ),
      models,
      defaultModel: models[0],
    };
  } catch {
    return {
      ...trustedProvider,
      status: "not-installed",
      detail: ollamaEndpointDetail(
        endpointTrust,
        `Ollama is not reachable on ${endpoint}`,
      ),
      models: [],
    };
  } finally {
    clearTimeout(timeout);
  }
}



export async function checkAppleFoundation(provider: ProviderSummary): Promise<ProviderSummary> {
  const probe = await probeAppleFoundationLlm();
  if (!probe.installed) {
    return {
      ...provider,
      status: "not-installed",
      detail:
        probe.detail ??
        "Apple Foundation helper is not available. Build OpenAdminOS on a compatible Mac.",
      models: [],
    };
  }

  if (!probe.ready) {
    return {
      ...provider,
      status: "error",
      detail:
        probe.detail ??
        "Apple Intelligence Foundation Models are not available on this Mac.",
      models: probe.models,
      defaultModel: probe.defaultModel,
    };
  }

  return {
    ...provider,
    status: "connected",
    detail: appleFoundationProbeDetail(probe),
    models: probe.models,
    defaultModel: probe.defaultModel,
  };
}



export async function checkLmStudio(provider: ProviderSummary): Promise<ProviderSummary> {
  const endpoint = resolveLmStudioEndpoint().replace(/\/$/, "");
  const endpointTrust = classifyLmStudioEndpoint(endpoint);
  const trustedProvider = endpointTrust.isLocal
    ? provider
    : {
        ...provider,
        description:
          "Use an LM Studio-compatible endpoint outside this device. Tenant prompts leave this device when active.",
        isLocal: false,
      };
  const probe = await probeLmStudioLlm({ endpoint });

  if (!probe.ready) {
    return {
      ...trustedProvider,
      status: probe.status === "error" ? "error" : "not-installed",
      detail: lmStudioEndpointDetail(
        endpointTrust,
        probe.detail ??
          "LM Studio isn't running or the local server is off. Start the server from LM Studio's Developer tab, then try again.",
      ),
      models: probe.models,
      defaultModel: probe.defaultModel,
    };
  }

  return {
    ...trustedProvider,
    status: "connected",
    detail: lmStudioEndpointDetail(
      endpointTrust,
      probe.detail ?? `LM Studio server is running on ${endpoint}.`,
    ),
    models: probe.models,
    defaultModel: probe.defaultModel,
  };
}



export function checkAzureOpenAI(
  provider: ProviderSummary,
  config: AzureOpenAIProviderConfig,
): ProviderSummary {
  const endpoint = config.endpoint.trim();
  const deployment = config.deployment.trim();
  const apiVersion = config.apiVersion.trim();
  if (!endpoint || !deployment || !apiVersion || !config.hasKey) {
    return {
      ...provider,
      status: "not-installed",
      detail: "Add your Azure OpenAI endpoint, deployment, and key in Settings.",
      models: [],
    };
  }

  let host: string;
  try {
    host = new URL(endpoint).host;
  } catch {
    return {
      ...provider,
      status: "error",
      detail: "Azure OpenAI endpoint is not a valid URL. Check Settings.",
      models: [deployment],
      defaultModel: deployment,
    };
  }

  return {
    ...provider,
    status: "available",
    detail: `Configured for ${host} · deployment ${deployment} · API ${apiVersion}. Use Test to verify the key before sending tenant context.`,
    models: [deployment],
    defaultModel: deployment,
  };
}



export function appleFoundationProbeDetail(
  probe: Awaited<ReturnType<typeof probeAppleFoundationLlm>>,
): string {
  const parts = [
    probe.detail ?? "Apple Intelligence Foundation Models available locally.",
  ];
  if (typeof probe.contextSize === "number") {
    parts.push(`Context window: ${probe.contextSize.toLocaleString()} tokens`);
  }
  if (probe.supportedLanguages && probe.supportedLanguages.length > 0) {
    parts.push(`${probe.supportedLanguages.length} supported locales`);
  }
  return parts.join(" · ");
}



export function ollamaEndpointDetail(
  endpointTrust: { isLocal: boolean },
  detail: string,
): string {
  if (endpointTrust.isLocal) return detail;
  return `${detail}. Endpoint is not loopback; prompts leave this device if this provider is active.`;
}



export function lmStudioEndpointDetail(
  endpointTrust: { isLocal: boolean },
  detail: string,
): string {
  if (endpointTrust.isLocal) return detail;
  return `${detail}. Endpoint is not loopback; prompts leave this device if this provider is active.`;
}



export async function checkClaudeCode(provider: ProviderSummary): Promise<ProviderSummary> {
  const probe = await probeClaudeCodeLlm();
  const cli: ProviderSummary["cli"] = {
    binaryPath: probe.binaryPath, version: probe.version,
    state: !probe.installed ? "not-installed" : probe.ready ? "ready" : probe.failure ?? "request-failed",
  };
  if (!probe.installed) {
    return {
      ...provider, cli,
      status: "not-installed",
      detail: probe.detail ?? "Claude Code CLI (`claude`) is not installed or not on PATH.",
      models: [],
    };
  }

  if (!probe.ready) {
    return {
      ...provider, cli,
      status: "error",
      detail:
        probe.detail ??
        "Claude Code is installed but not authenticated. Run `claude auth login` and try again.",
      models: probe.models,
      defaultModel: probe.defaultModel,
    };
  }

  return {
    ...provider, cli,
    status: "connected",
    detail: probe.detail ?? "Authenticated through the local Claude Code CLI.",
    models: probe.models,
    defaultModel: probe.defaultModel,
  };
}



export async function checkCodex(provider: ProviderSummary): Promise<ProviderSummary> {
  const probe = await probeCodexLlm();
  const cli: ProviderSummary["cli"] = {
    binaryPath: probe.binaryPath, version: probe.version,
    state: !probe.installed ? "not-installed" : probe.ready ? "ready" : probe.failure ?? "request-failed",
  };
  if (!probe.installed) {
    return {
      ...provider, cli,
      status: "not-installed",
      detail: probe.detail ?? "Codex CLI (`codex`) is not installed or not on PATH.",
      models: [],
    };
  }

  if (!probe.ready) {
    return {
      ...provider, cli,
      status: "error",
      detail:
        probe.detail ??
        `Codex CLI is installed but not authenticated. Run \`codex login\` and try again.`,
      models: probe.models,
      defaultModel: probe.defaultModel,
    };
  }

  return {
    ...provider, cli,
    status: "connected",
    detail: probe.detail ?? `Authenticated via ${probe.authPath}`,
    models: probe.models,
    defaultModel: probe.defaultModel,
  };
}

export async function checkAdditionalCli(provider: ProviderSummary): Promise<ProviderSummary> {
  const probe: CliProbe = provider.id === "copilot" ? await probeCopilotLlm() : await probeGeminiLlm();
  return {
    ...provider,
    status: !probe.installed ? "not-installed" : probe.ready ? "connected" : probe.failure ? "error" : "available",
    detail: probe.detail, models: probe.models, defaultModel: probe.defaultModel,
    cli: { binaryPath: probe.binaryPath, version: probe.version, state: probe.ready ? "ready" : probe.failure ?? "check-required" },
  };
}
