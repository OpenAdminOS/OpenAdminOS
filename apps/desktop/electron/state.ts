import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createOllamaLlm,
  createQueuedRun,
  executeApply,
  executePlan,
  executeRun,
  findRegistryAgentById,
  listBuiltInRegistryAgents,
  noopLlm,
  toInstalledAgent,
} from "@openagents/runtime";
import type { RunLlmApi } from "@openagents/agent-sdk";
import {
  deriveTrustState,
  providerCatalog,
  type AgentSummary,
  type AppState,
  type ProviderId,
  type ProviderSummary,
  type RegistryAgentSummary,
  type RunRecord,
} from "@openagents/agent-sdk";

interface PersistedState {
  activeProviderId: ProviderId;
  installedAgents: AgentSummary[];
  runs: RunRecord[];
}

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
  }>;
}

const defaultState: PersistedState = {
  activeProviderId: "ollama",
  installedAgents: [],
  runs: [],
};

const providerIds = new Set<ProviderId>(
  providerCatalog.map((provider) => provider.id),
);

export class AppStateStore {
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(task, task);
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  async getAppState(): Promise<AppState> {
    const persisted = await this.read();
    const providers = await this.listProviders();
    const activeProvider =
      providers.find((provider) => provider.id === persisted.activeProviderId) ??
      providers[0];

    return {
      activeProviderId: activeProvider?.id ?? "ollama",
      providers,
      registryAgents: this.listRegistryAgents(),
      installedAgents: persisted.installedAgents,
      runs: persisted.runs,
      trust: deriveTrustState(activeProvider),
    };
  }

  listRegistryAgents(): RegistryAgentSummary[] {
    return listBuiltInRegistryAgents();
  }

  async listAgents(): Promise<AgentSummary[]> {
    const persisted = await this.read();
    return persisted.installedAgents;
  }

  async listProviders(): Promise<ProviderSummary[]> {
    return Promise.all(
      providerCatalog.map(async (provider) => {
        if (provider.id !== "ollama") {
          return provider;
        }

        return checkOllama(provider);
      }),
    );
  }

  async installAgent(agentId: string): Promise<AppState> {
    await this.serialize(async () => {
      const persisted = await this.read();
      const existing = persisted.installedAgents.find(
        (agent) =>
          agent.id === agentId ||
          agent.slug === agentId ||
          agent.registryId === agentId,
      );

      if (existing) {
        return;
      }

      const registryAgent = findRegistryAgentById(agentId);
      if (!registryAgent) {
        throw new Error(`Unknown registry agent: ${agentId}`);
      }

      await this.write({
        ...persisted,
        installedAgents: [
          ...persisted.installedAgents,
          toInstalledAgent(registryAgent, new Date()),
        ],
      });
    });

    return this.getAppState();
  }

  async setActiveProvider(id: ProviderId): Promise<AppState> {
    if (!isProviderId(id)) {
      throw new Error(`Unknown provider: ${String(id)}`);
    }

    await this.serialize(async () => {
      const persisted = await this.read();
      await this.write({
        ...persisted,
        activeProviderId: id,
      });
    });

    return this.getAppState();
  }

  async startRun(agentSlug: string): Promise<RunRecord> {
    const queued = await this.serialize(async () => {
      const persisted = await this.read();
      const agent = persisted.installedAgents.find(
        (installedAgent) => installedAgent.slug === agentSlug,
      );

      if (!agent) {
        throw new Error(`Agent is not installed: ${agentSlug}`);
      }

      const providers = await this.listProviders();
      const activeProvider =
        providers.find((provider) => provider.id === persisted.activeProviderId) ??
        providers[0];
      const providerId = activeProvider?.id ?? persisted.activeProviderId;
      const model = activeProvider?.defaultModel;
      const queuedRun = createQueuedRun({ agent, providerId, model });

      await this.write({
        ...persisted,
        runs: [queuedRun, ...persisted.runs],
      });

      return { agent, providerId, model, queuedRun };
    });

    void this.driveRun({
      run: queued.queuedRun,
      agent: queued.agent,
      providerId: queued.providerId,
      model: queued.model,
    });
    return queued.queuedRun;
  }

  async confirmRun(runId: string, phrase: string): Promise<RunRecord> {
    const transition = await this.serialize(async () => {
      const persisted = await this.read();
      const run = persisted.runs.find((existing) => existing.id === runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }
      if (run.status !== "awaiting-confirmation") {
        throw new Error(
          `Run ${runId} is not awaiting confirmation (status: ${run.status}).`,
        );
      }
      if (!run.plan) {
        throw new Error(`Run ${runId} has no plan to confirm.`);
      }
      if (phrase !== run.plan.confirmationPhrase) {
        throw new Error("Confirmation phrase does not match.");
      }

      const agent = persisted.installedAgents.find(
        (installedAgent) => installedAgent.slug === run.agentSlug,
      );
      if (!agent) {
        throw new Error(`Agent is not installed: ${run.agentSlug}`);
      }
      if (agent.mode !== "write") {
        throw new Error(`Agent ${run.agentSlug} is not a write agent.`);
      }

      const confirmedAt = new Date().toISOString();
      const updated: RunRecord = {
        ...run,
        status: "running",
        confirmedAt,
        startedAt: confirmedAt,
        summary: `${agent.name} is applying.`,
      };
      await this.write({
        ...persisted,
        runs: persisted.runs.map((existing) =>
          existing.id === runId ? updated : existing,
        ),
      });

      const providers = await this.listProviders();
      const activeProvider =
        providers.find((provider) => provider.id === persisted.activeProviderId) ??
        providers[0];
      const providerId = run.providerId ?? activeProvider?.id ?? persisted.activeProviderId;
      const model = run.model ?? activeProvider?.defaultModel;

      return { agent, providerId, model, updated };
    });

    void this.driveApply({
      run: transition.updated,
      agent: transition.agent,
      providerId: transition.providerId,
      model: transition.model,
      plan: transition.updated.plan!,
    });
    return transition.updated;
  }

  async rejectRun(runId: string): Promise<RunRecord> {
    return this.serialize(async () => {
      const persisted = await this.read();
      const run = persisted.runs.find((existing) => existing.id === runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }
      if (run.status !== "awaiting-confirmation") {
        throw new Error(
          `Run ${runId} cannot be rejected (status: ${run.status}).`,
        );
      }

      const rejectedAt = new Date().toISOString();
      const updated: RunRecord = {
        ...run,
        status: "rejected",
        rejectedAt,
        finishedAt: rejectedAt,
        summary: `Run rejected by user.`,
      };
      await this.write({
        ...persisted,
        runs: persisted.runs.map((existing) =>
          existing.id === runId ? updated : existing,
        ),
      });
      return updated;
    });
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    const persisted = await this.read();
    return persisted.runs.find((run) => run.id === id);
  }

  private async buildLlm(
    providerId: ProviderId,
    model: string | undefined,
  ): Promise<RunLlmApi> {
    if (providerId !== "ollama") {
      return noopLlm;
    }
    const providers = await this.listProviders();
    const ollama = providers.find((provider) => provider.id === "ollama");
    if (!ollama || ollama.status !== "connected") {
      return noopLlm;
    }
    const defaultModel = model ?? ollama.defaultModel ?? ollama.models[0];
    const options: { defaultModel?: string } = {};
    if (defaultModel) {
      options.defaultModel = defaultModel;
    }
    return createOllamaLlm(options);
  }

  private async driveRun(input: {
    run: RunRecord;
    agent: AgentSummary;
    providerId: ProviderId;
    model?: string;
  }): Promise<void> {
    try {
      const driver = input.agent.mode === "write" ? executePlan : executeRun;
      const llm = await this.buildLlm(input.providerId, input.model);
      await driver({
        run: input.run,
        agent: input.agent,
        providerId: input.providerId,
        model: input.model,
        llm,
        onProgress: (next) => this.persistRunSnapshot(next),
      });
    } catch (error) {
      await this.persistFailedSnapshot(input.run, input.agent, error);
    }
  }

  private async driveApply(input: {
    run: RunRecord;
    agent: AgentSummary;
    providerId: ProviderId;
    model?: string;
    plan: NonNullable<RunRecord["plan"]>;
  }): Promise<void> {
    try {
      const llm = await this.buildLlm(input.providerId, input.model);
      await executeApply({
        run: input.run,
        agent: input.agent,
        providerId: input.providerId,
        model: input.model,
        plan: input.plan,
        llm,
        onProgress: (next) => this.persistRunSnapshot(next),
      });
    } catch (error) {
      await this.persistFailedSnapshot(input.run, input.agent, error);
    }
  }

  private async persistFailedSnapshot(
    run: RunRecord,
    agent: AgentSummary,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const finishedAt = new Date().toISOString();
    await this.persistRunSnapshot({
      ...run,
      status: "failed",
      finishedAt,
      summary: `${agent.name} failed: ${message}`,
      error: message,
    });
  }

  private persistRunSnapshot(run: RunRecord): Promise<void> {
    return this.serialize(async () => {
      const persisted = await this.read();
      const exists = persisted.runs.some((existing) => existing.id === run.id);
      const nextRuns = exists
        ? persisted.runs.map((existing) => (existing.id === run.id ? run : existing))
        : [run, ...persisted.runs];
      await this.write({ ...persisted, runs: nextRuns });
    });
  }

  private async read(): Promise<PersistedState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedState>;

      return {
        activeProviderId: isProviderId(parsed.activeProviderId)
          ? parsed.activeProviderId
          : defaultState.activeProviderId,
        installedAgents: Array.isArray(parsed.installedAgents)
          ? parsed.installedAgents
          : defaultState.installedAgents,
        runs: Array.isArray(parsed.runs) ? parsed.runs : defaultState.runs,
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        await this.write(defaultState);
      }

      return defaultState;
    }
  }

  private async write(state: PersistedState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && providerIds.has(value as ProviderId);
}

async function checkOllama(provider: ProviderSummary): Promise<ProviderSummary> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  const endpoint = (process.env.OPENAGENTS_OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");

  try {
    const response = await fetch(`${endpoint}/api/tags`, {
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        ...provider,
        status: "error",
        detail: `Ollama responded with HTTP ${response.status}`,
        models: [],
      };
    }

    const payload = (await response.json()) as OllamaTagsResponse;
    const models =
      payload.models
        ?.map((model) => model.name)
        .filter((name): name is string => Boolean(name)) ?? [];

    return {
      ...provider,
      status: "connected",
      detail:
        models.length > 0
          ? `Running on ${endpoint}`
          : "Ollama is running but no models are installed",
      models,
      defaultModel: models[0],
    };
  } catch {
    return {
      ...provider,
      status: "not-installed",
      detail: `Ollama is not reachable on ${endpoint}`,
      models: [],
    };
  } finally {
    clearTimeout(timeout);
  }
}
