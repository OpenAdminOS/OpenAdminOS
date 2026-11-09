import {
  classifyOllamaEndpoint,
  classifyLmStudioEndpoint,
  fetchLocal,
  isConnectionRefused,
  probeAppleFoundationLlm,
  probeClaudeCodeLlm,
  probeCodexLlm,
  probeCopilotInstallation,
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
    digest?: string;
  }>;
}

// Capabilities never change for a given model digest, so a refresh does not
// need to ask again. Keyed by endpoint, name, and digest.
const ollamaCompletionSupport = new Map<string, boolean>();
const OLLAMA_TAGS_TIMEOUT_MS = 1500;
// /api/show can be slow while Ollama is cold-starting or holds many models.
const OLLAMA_SHOW_TIMEOUT_MS = 5000;



export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && providerIds.has(value as ProviderId);
}



/** Options for a check run by the first-launch scan. */
export interface ScanCheckOptions {
  /** Stops the check and its requests or processes. */
  signal?: AbortSignal;
  /** Never contact an endpoint outside this device. */
  localOnly?: boolean;
  /** A CLI binary to use instead of discovery (tests). */
  binaryPath?: string;
  /** How long an HTTP check may take: the scan passes its remaining budget. */
  timeoutMs?: number;
}

/** At most this many Ollama model capability reads run at once. */
const OLLAMA_SHOW_CONCURRENCY = 4;

async function mapLimited<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function checkOllama(provider: ProviderSummary, options: ScanCheckOptions = {}): Promise<ProviderSummary> {
  const endpoint = resolveOllamaEndpoint().replace(/\/$/, "");
  const endpointTrust = classifyOllamaEndpoint(endpoint);
  if (options.localOnly && !endpointTrust.isLocal) {
    return { ...provider, isLocal: false, status: "error", checkFailed: true, detail: `Ollama is set to ${endpoint}, outside this device, so it is not checked here.`, models: [] };
  }
  const controller = new AbortController();
  // With a budget (a scan check), the tags request and the capability reads share it.
  const deadline = options.timeoutMs !== undefined ? Date.now() + options.timeoutMs : undefined;
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? OLLAMA_TAGS_TIMEOUT_MS);
  options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  const trustedProvider = endpointTrust.isLocal
    ? provider
    : {
        ...provider,
        description:
          "Use an Ollama-compatible endpoint outside this device. Tenant prompts leave this device when active.",
        isLocal: false,
      };

  try {
    const response = await fetchLocal(`${endpoint}/api/tags`, {
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        ...trustedProvider,
        status: "error",
        checkFailed: true,
        detail: ollamaEndpointDetail(
          endpointTrust,
          `Ollama responded with HTTP ${response.status}`,
        ),
        models: [],
      };
    }

    const payload = (await response.json()) as OllamaTagsResponse;
    clearTimeout(timeout);
    const installed =
      payload.models?.filter((model): model is { name: string; digest?: string } => Boolean(model.name)) ?? [];
    const installedModels = installed.map((model) => model.name);
    // /api/tags also includes embedding-only models. Ask Ollama instead of
    // guessing capabilities from names, which can be arbitrary local aliases.
    let unverified = false;
    const showController = new AbortController();
    const showTimeout = setTimeout(() => showController.abort(), deadline !== undefined ? Math.max(deadline - Date.now(), 0) : OLLAMA_SHOW_TIMEOUT_MS);
    options.signal?.addEventListener("abort", () => showController.abort(), { once: true });
    const supported = await mapLimited(installed, OLLAMA_SHOW_CONCURRENCY, async ({ name: model, digest }) => {
      const key = digest ? `${endpoint}\0${model}\0${digest}` : undefined;
      const known = key ? ollamaCompletionSupport.get(key) : undefined;
      if (known !== undefined) return known;
      try {
        const details = await fetch(`${endpoint}/api/show`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model }),
          signal: showController.signal,
        });
        if (!details.ok) throw new Error("Model details unavailable");
        const data = await details.json() as { capabilities?: unknown };
        if (!Array.isArray(data.capabilities)) throw new Error("Model capabilities unavailable");
        const completion = data.capabilities.includes("completion");
        if (key) ollamaCompletionSupport.set(key, completion);
        return completion;
      } catch {
        unverified = true;
        return false;
      }
    }).finally(() => clearTimeout(showTimeout));
    const models = installedModels.filter((_, i) => supported[i]);

    return {
      ...trustedProvider,
      status: models.length ? "connected" : "error",
      // Capabilities that could not be read are a failed check, not "no text model".
      ...(models.length === 0 && unverified ? { checkFailed: true } : {}),
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
  } catch (error) {
    // Only a refused connection means Ollama is not running. A timeout, a
    // stopped check or an unreadable response is a failed check.
    if (isConnectionRefused(error)) {
      return {
        ...trustedProvider,
        status: "not-installed",
        detail: ollamaEndpointDetail(endpointTrust, `Ollama is not reachable on ${endpoint}`),
        models: [],
      };
    }
    const timedOut = error instanceof Error && error.name === "AbortError";
    return {
      ...trustedProvider,
      status: "error",
      checkFailed: true,
      detail: ollamaEndpointDetail(
        endpointTrust,
        timedOut ? `Ollama on ${endpoint} did not answer in time.` : `Ollama on ${endpoint} answered with a response OpenAdminOS could not read.`,
      ),
      models: [],
    };
  } finally {
    clearTimeout(timeout);
  }
}



export async function checkAppleFoundation(provider: ProviderSummary, options: ScanCheckOptions = {}): Promise<ProviderSummary> {
  const probe = await probeAppleFoundationLlm(options.signal ? { signal: options.signal } : {});
  if (probe.failed) {
    return { ...provider, status: "error", checkFailed: true, detail: probe.detail ?? "The Apple Foundation helper did not answer.", models: [] };
  }
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



export async function checkLmStudio(provider: ProviderSummary, options: ScanCheckOptions = {}): Promise<ProviderSummary> {
  const endpoint = resolveLmStudioEndpoint().replace(/\/$/, "");
  const endpointTrust = classifyLmStudioEndpoint(endpoint);
  if (options.localOnly && !endpointTrust.isLocal) {
    return { ...provider, isLocal: false, status: "error", checkFailed: true, detail: `LM Studio is set to ${endpoint}, outside this device, so it is not checked here.`, models: [] };
  }
  const trustedProvider = endpointTrust.isLocal
    ? provider
    : {
        ...provider,
        description:
          "Use an LM Studio-compatible endpoint outside this device. Tenant prompts leave this device when active.",
        isLocal: false,
      };
  const probe = await probeLmStudioLlm({
    endpoint,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });

  if (!probe.ready) {
    return {
      ...trustedProvider,
      status: probe.status === "error" ? "error" : "not-installed",
      ...(probe.status === "error" ? { checkFailed: true } : {}),
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



export async function checkClaudeCode(provider: ProviderSummary, options: ScanCheckOptions = {}): Promise<ProviderSummary> {
  const probe = await probeClaudeCodeLlm({ ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}), ...(options.signal ? { signal: options.signal } : {}) });
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



export async function checkCodex(provider: ProviderSummary, options: ScanCheckOptions = {}): Promise<ProviderSummary> {
  const probe = await probeCodexLlm({ ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}), ...(options.signal ? { signal: options.signal } : {}) });
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

export async function checkAdditionalCli(provider: ProviderSummary, options: ScanCheckOptions & { scan?: boolean } = {}): Promise<ProviderSummary> {
  const cliOptions = { ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}), ...(options.signal ? { signal: options.signal } : {}) };
  // The scan reads Copilot's installation only: its full probe starts an RPC server and lists models from GitHub.
  const probe: CliProbe = provider.id === "copilot"
    ? options.scan ? await probeCopilotInstallation(cliOptions) : await probeCopilotLlm(cliOptions)
    : await probeGeminiLlm(cliOptions);
  return {
    ...provider,
    status: !probe.installed ? "not-installed" : probe.ready ? "connected" : probe.failure ? "error" : "available",
    detail: probe.detail, models: probe.models, defaultModel: probe.defaultModel,
    cli: { binaryPath: probe.binaryPath, version: probe.version, state: probe.ready ? "ready" : probe.failure ?? "check-required" },
  };
}
