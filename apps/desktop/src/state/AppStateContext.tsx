import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  deriveTrustState,
  providerCatalog,
  type AgentDraft,
  type AppState,
  type OpenAgentsApi,
  type ProviderId,
  type RegistryAgentSummary,
  type RunRecord,
  type StartRunOptions,
  type TenantRecord,
} from "../shared/openAgents";

interface AppStateContextValue {
  state: AppState;
  registryAgents: RegistryAgentSummary[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  refreshRegistry: () => Promise<void>;
  installAgent: (agentId: string) => Promise<void>;
  setActiveProvider: (id: ProviderId) => Promise<void>;
  startRun: (agentSlug: string, options?: StartRunOptions) => Promise<RunRecord>;
  confirmRun: (runId: string, phrase: string) => Promise<RunRecord>;
  rejectRun: (runId: string) => Promise<RunRecord>;
  connectTenant: () => Promise<TenantRecord | undefined>;
  setActiveTenant: (id: string) => Promise<void>;
  disconnectTenant: (id: string) => Promise<void>;
  setRealWritesEnabled: (enabled: boolean) => Promise<void>;
  updateAgentSettings: (
    slug: string,
    values: Record<string, unknown>,
  ) => Promise<void>;
  draftAgentManifest: (prompt: string) => Promise<AgentDraft>;
  saveAgentDraft: (yamlSource: string) => Promise<void>;
}

interface AppStateProviderProps {
  children: ReactNode;
}

const fallbackActiveProviderId = providerCatalog[0]?.id ?? "ollama";

function createFallbackState(activeProviderId: ProviderId): AppState {
  const providers = [...providerCatalog];
  const activeProvider = providers.find((provider) => provider.id === activeProviderId);

  return {
    activeProviderId,
    providers,
    registryAgents: [],
    installedAgents: [],
    runs: [],
    trust: deriveTrustState(activeProvider),
    tenants: [],
    realWritesEnabled: false,
  };
}

function getOpenAgentsApi(): OpenAgentsApi | undefined {
  return window.openAgents;
}

const AppStateContext = createContext<AppStateContextValue | undefined>(undefined);

export function AppStateProvider({ children }: AppStateProviderProps) {
  const [state, setState] = useState<AppState>(() =>
    createFallbackState(fallbackActiveProviderId),
  );
  const [registryAgents, setRegistryAgents] = useState<RegistryAgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refreshRegistry = useCallback(async () => {
    const api = getOpenAgentsApi();

    if (!api) {
      setRegistryAgents([]);
      return;
    }

    try {
      const agents = await api.listRegistryAgents();
      setRegistryAgents(agents);
      setState((currentState) => ({
        ...currentState,
        registryAgents: agents,
      }));
    } catch (caughtError) {
      setError(toError(caughtError));
    }
  }, []);

  const refresh = useCallback(async () => {
    const api = getOpenAgentsApi();

    if (!api) {
      setState((currentState) => createFallbackState(currentState.activeProviderId));
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const nextState = await api.getAppState();
      setState(nextState);
      setRegistryAgents(nextState.registryAgents);
    } catch (caughtError) {
      setError(toError(caughtError));
    } finally {
      setLoading(false);
    }
  }, []);

  const installAgent = useCallback(async (agentId: string) => {
    const api = getOpenAgentsApi();

    if (!api) {
      const fallbackError = new Error("Agent install is unavailable in browser development.");
      setError(fallbackError);
      throw fallbackError;
    }

    setLoading(true);
    setError(null);

    try {
      const nextState = await api.installAgent(agentId);
      setState(nextState);
      setRegistryAgents(nextState.registryAgents);
    } catch (caughtError) {
      const installError = toError(caughtError);
      setError(installError);
      throw installError;
    } finally {
      setLoading(false);
    }
  }, []);

  const setActiveProvider = useCallback(async (id: ProviderId) => {
    const api = getOpenAgentsApi();
    setLoading(true);
    setError(null);

    try {
      if (api) {
        const nextState = await api.setActiveProvider(id);
        setState(nextState);
        setRegistryAgents(nextState.registryAgents);
      } else {
        setState(createFallbackState(id));
      }
    } catch (caughtError) {
      const providerError = toError(caughtError);
      setError(providerError);
      throw providerError;
    } finally {
      setLoading(false);
    }
  }, []);

  const startRun = useCallback(
    async (agentSlug: string, options?: StartRunOptions) => {
      const api = getOpenAgentsApi();

      if (!api) {
        const fallbackError = new Error("Agent runs are unavailable in browser development.");
        setError(fallbackError);
        throw fallbackError;
      }

      setLoading(true);
      setError(null);

      try {
        const run = await api.startRun(agentSlug, options);
        const nextState = await api.getAppState();
        setState(nextState);
        setRegistryAgents(nextState.registryAgents);
        return run;
      } catch (caughtError) {
        const runError = toError(caughtError);
        setError(runError);
        throw runError;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const confirmRun = useCallback(async (runId: string, phrase: string) => {
    const api = getOpenAgentsApi();
    if (!api) {
      const fallbackError = new Error("Run confirmation is unavailable in browser development.");
      setError(fallbackError);
      throw fallbackError;
    }

    setError(null);

    try {
      const run = await api.confirmRun(runId, phrase);
      const nextState = await api.getAppState();
      setState(nextState);
      setRegistryAgents(nextState.registryAgents);
      return run;
    } catch (caughtError) {
      const confirmError = toError(caughtError);
      setError(confirmError);
      throw confirmError;
    }
  }, []);

  const connectTenant = useCallback(async () => {
    const api = getOpenAgentsApi();
    if (!api) {
      const fallbackError = new Error(
        "Tenant connect is unavailable in browser development.",
      );
      setError(fallbackError);
      throw fallbackError;
    }
    setError(null);
    try {
      const nextState = await api.connectTenant();
      setState(nextState);
      setRegistryAgents(nextState.registryAgents);
      const id = nextState.activeTenantId;
      return id ? nextState.tenants.find((tenant) => tenant.id === id) : undefined;
    } catch (caughtError) {
      const tenantError = toError(caughtError);
      setError(tenantError);
      throw tenantError;
    }
  }, []);

  const setActiveTenant = useCallback(async (id: string) => {
    const api = getOpenAgentsApi();
    if (!api) return;
    setError(null);
    try {
      const nextState = await api.setActiveTenant(id);
      setState(nextState);
      setRegistryAgents(nextState.registryAgents);
    } catch (caughtError) {
      const tenantError = toError(caughtError);
      setError(tenantError);
      throw tenantError;
    }
  }, []);

  const disconnectTenant = useCallback(async (id: string) => {
    const api = getOpenAgentsApi();
    if (!api) return;
    setError(null);
    try {
      const nextState = await api.disconnectTenant(id);
      setState(nextState);
      setRegistryAgents(nextState.registryAgents);
    } catch (caughtError) {
      const tenantError = toError(caughtError);
      setError(tenantError);
      throw tenantError;
    }
  }, []);

  const setRealWritesEnabled = useCallback(async (enabled: boolean) => {
    const api = getOpenAgentsApi();
    if (!api) return;
    setError(null);
    try {
      const nextState = await api.setRealWritesEnabled(enabled);
      setState(nextState);
      setRegistryAgents(nextState.registryAgents);
    } catch (caughtError) {
      const settingError = toError(caughtError);
      setError(settingError);
      throw settingError;
    }
  }, []);

  const updateAgentSettings = useCallback(
    async (slug: string, values: Record<string, unknown>) => {
      const api = getOpenAgentsApi();
      if (!api) {
        const fallbackError = new Error(
          "Updating agent settings is unavailable in browser development.",
        );
        setError(fallbackError);
        throw fallbackError;
      }
      setError(null);
      try {
        const nextState = await api.updateAgentSettings(slug, values);
        setState(nextState);
        setRegistryAgents(nextState.registryAgents);
      } catch (caughtError) {
        const settingsError = toError(caughtError);
        setError(settingsError);
        throw settingsError;
      }
    },
    [],
  );

  const draftAgentManifest = useCallback(async (prompt: string) => {
    const api = getOpenAgentsApi();
    if (!api) {
      const fallbackError = new Error(
        "Drafting an agent is unavailable in browser development.",
      );
      setError(fallbackError);
      throw fallbackError;
    }
    setError(null);
    try {
      return await api.draftAgentManifest(prompt);
    } catch (caughtError) {
      const draftError = toError(caughtError);
      setError(draftError);
      throw draftError;
    }
  }, []);

  const saveAgentDraft = useCallback(async (yamlSource: string) => {
    const api = getOpenAgentsApi();
    if (!api) {
      const fallbackError = new Error(
        "Saving an agent draft is unavailable in browser development.",
      );
      setError(fallbackError);
      throw fallbackError;
    }
    setError(null);
    try {
      const nextState = await api.saveAgentDraft(yamlSource);
      setState(nextState);
      setRegistryAgents(nextState.registryAgents);
    } catch (caughtError) {
      const saveError = toError(caughtError);
      setError(saveError);
      throw saveError;
    }
  }, []);

  const rejectRun = useCallback(async (runId: string) => {
    const api = getOpenAgentsApi();
    if (!api) {
      const fallbackError = new Error("Run rejection is unavailable in browser development.");
      setError(fallbackError);
      throw fallbackError;
    }

    setError(null);

    try {
      const run = await api.rejectRun(runId);
      const nextState = await api.getAppState();
      setState(nextState);
      setRegistryAgents(nextState.registryAgents);
      return run;
    } catch (caughtError) {
      const rejectError = toError(caughtError);
      setError(rejectError);
      throw rejectError;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!state.runs.some((run) => run.status === "queued" || run.status === "running")) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refresh();
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [refresh, state.runs]);

  const value = useMemo<AppStateContextValue>(
    () => ({
      state,
      registryAgents,
      loading,
      error,
      refresh,
      refreshRegistry,
      installAgent,
      setActiveProvider,
      startRun,
      confirmRun,
      rejectRun,
      connectTenant,
      setActiveTenant,
      disconnectTenant,
      setRealWritesEnabled,
      updateAgentSettings,
      draftAgentManifest,
      saveAgentDraft,
    }),
    [
      confirmRun,
      connectTenant,
      disconnectTenant,
      draftAgentManifest,
      error,
      setRealWritesEnabled,
      installAgent,
      loading,
      refresh,
      refreshRegistry,
      registryAgents,
      rejectRun,
      saveAgentDraft,
      setActiveProvider,
      setActiveTenant,
      startRun,
      state,
      updateAgentSettings,
    ],
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState() {
  const context = useContext(AppStateContext);

  if (!context) {
    throw new Error("useAppState must be used within AppStateProvider.");
  }

  return context;
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === "string" ? error : "Unknown Open Agents error.");
}
