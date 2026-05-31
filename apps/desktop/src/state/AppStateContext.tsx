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
  type AgentCommunitySubmissionMetadata,
  type AgentCommunitySubmissionReview,
  type AgentCommunitySubmissionResult,
  type AgentDraftPreflightResult,
  type AgentUpdateReview,
  type AgentSchedule,
  type AgentTeamsDelivery,
  type AppState,
  type OpenAdminOSApi,
  type ProviderId,
  type RegistryAgentSummary,
  type RequestedScope,
  type RunRecord,
  type StartRunOptions,
  type TenantRecord,
} from "../shared/openAdminOS";

interface AppStateContextValue {
  state: AppState;
  registryAgents: RegistryAgentSummary[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  refreshRegistry: () => Promise<void>;
  installAgent: (agentId: string) => Promise<void>;
  uninstallAgent: (slug: string) => Promise<void>;
  getAgentUpdateReview: (slug: string) => Promise<AgentUpdateReview>;
  updateAgent: (
    slug: string,
    options?: { confirmTrustChanges?: boolean },
  ) => Promise<void>;
  setActiveProvider: (id: ProviderId) => Promise<void>;
  setActiveModel: (providerId: ProviderId, model: string | null) => Promise<void>;
  setRegistryInstallCountsEnabled: (enabled: boolean) => Promise<void>;
  startRun: (agentSlug: string, options?: StartRunOptions) => Promise<RunRecord>;
  confirmRun: (runId: string, phrase: string) => Promise<RunRecord>;
  rejectRun: (runId: string) => Promise<RunRecord>;
  cancelRun: (runId: string) => Promise<RunRecord>;
  connectTenant: () => Promise<TenantRecord | undefined>;
  getRequestedScopes: () => Promise<RequestedScope[]>;
  setActiveTenant: (id: string) => Promise<void>;
  disconnectTenant: (id: string) => Promise<void>;
  updateAgentSettings: (
    slug: string,
    values: Record<string, unknown>,
  ) => Promise<void>;
  updateAgentSchedule: (
    slug: string,
    schedule: AgentSchedule | null,
  ) => Promise<void>;
  updateAgentTeamsDelivery: (
    slug: string,
    delivery: AgentTeamsDelivery | null,
  ) => Promise<void>;
  draftAgentManifest: (prompt: string) => Promise<AgentDraft>;
  validateAgentDraft: (yamlSource: string, allowedSlug?: string) => Promise<AgentDraft>;
  preflightAgentDraft: (
    yamlSource: string,
    allowedSlug?: string,
  ) => Promise<AgentDraftPreflightResult>;
  saveAgentDraft: (yamlSource: string) => Promise<void>;
  updateUserAgentDraft: (slug: string, yamlSource: string) => Promise<void>;
  exportAgentDraftBundle: (yamlSource: string) => Promise<string | undefined>;
  prepareAgentCommunitySubmission: (
    yamlSource: string,
    metadata: AgentCommunitySubmissionMetadata,
    allowedSlug?: string,
  ) => Promise<AgentCommunitySubmissionReview>;
  submitAgentCommunitySubmission: (
    yamlSource: string,
    metadata: AgentCommunitySubmissionMetadata,
    allowedSlug?: string,
  ) => Promise<AgentCommunitySubmissionResult>;
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
    appVersion: import.meta.env.VITE_APP_VERSION ?? "0.0.0",
    providers,
    registryAgents: [],
    installedAgents: [],
    runs: [],
    trust: deriveTrustState(activeProvider),
    tenants: [],
    lastRegistryRefresh: null,
    registryRefreshError: null,
    registrySource: "https://raw.githubusercontent.com/OpenAdminOS/OpenAdminOS/main/agents",
    registryInstallCountsEnabled: true,
  };
}

function getOpenAdminOSApi(): OpenAdminOSApi | undefined {
  return window.openAdminOS;
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
    const api = getOpenAdminOSApi();

    if (!api) {
      setRegistryAgents([]);
      return;
    }

    try {
      // Trigger a network fetch on the main process, then reload full app state
      // so lastRegistryRefresh / registryRefreshError / registryAgents update together.
      if (api.refreshRegistry) await api.refreshRegistry();
      const nextState = await api.getAppState();
      setState(nextState);
      setRegistryAgents(nextState.registryAgents);
    } catch (caughtError) {
      setError(toError(caughtError));
    }
  }, []);

  const refresh = useCallback(async () => {
    const api = getOpenAdminOSApi();

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
    const api = getOpenAdminOSApi();

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

  const uninstallAgent = useCallback(async (slug: string) => {
    const api = getOpenAdminOSApi();

    if (!api) {
      const fallbackError = new Error(
        "Agent uninstall is unavailable in browser development.",
      );
      setError(fallbackError);
      throw fallbackError;
    }

    setLoading(true);
    setError(null);

    try {
      const nextState = await api.uninstallAgent(slug);
      setState(nextState);
      setRegistryAgents(nextState.registryAgents);
    } catch (caughtError) {
      const uninstallError = toError(caughtError);
      setError(uninstallError);
      throw uninstallError;
    } finally {
      setLoading(false);
    }
  }, []);

  const getAgentUpdateReview = useCallback(async (slug: string) => {
    const api = getOpenAdminOSApi();

    if (!api?.getAgentUpdateReview) {
      throw new Error("Agent update review is unavailable in browser development.");
    }

    return api.getAgentUpdateReview(slug);
  }, []);

  const updateAgent = useCallback(async (
    slug: string,
    options?: { confirmTrustChanges?: boolean },
  ) => {
    const api = getOpenAdminOSApi();

    if (!api) {
      const fallbackError = new Error(
        "Agent update is unavailable in browser development.",
      );
      setError(fallbackError);
      throw fallbackError;
    }

    setLoading(true);
    setError(null);

    try {
      const nextState = await api.updateAgent(slug, options);
      setState(nextState);
      setRegistryAgents(nextState.registryAgents);
    } catch (caughtError) {
      const updateError = toError(caughtError);
      setError(updateError);
      throw updateError;
    } finally {
      setLoading(false);
    }
  }, []);

  const setActiveModel = useCallback(
    async (providerId: ProviderId, model: string | null) => {
      const api = getOpenAdminOSApi();
      if (!api) {
        const fallbackError = new Error(
          "Setting the active model is unavailable in browser development.",
        );
        setError(fallbackError);
        throw fallbackError;
      }
      setError(null);
      try {
        const nextState = await api.setActiveModel(providerId, model);
        setState(nextState);
        setRegistryAgents(nextState.registryAgents);
      } catch (caughtError) {
        const modelError = toError(caughtError);
        setError(modelError);
        throw modelError;
      }
    },
    [],
  );

  const setActiveProvider = useCallback(async (id: ProviderId) => {
    const api = getOpenAdminOSApi();
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

  const setRegistryInstallCountsEnabled = useCallback(async (enabled: boolean) => {
    const api = getOpenAdminOSApi();
    if (!api) {
      setState((currentState) => ({
        ...currentState,
        registryInstallCountsEnabled: enabled,
      }));
      return;
    }

    setError(null);
    try {
      const nextState = await api.setRegistryInstallCountsEnabled(enabled);
      setState(nextState);
      setRegistryAgents(nextState.registryAgents);
    } catch (caughtError) {
      const settingsError = toError(caughtError);
      setError(settingsError);
      throw settingsError;
    }
  }, []);

  const startRun = useCallback(
    async (agentSlug: string, options?: StartRunOptions) => {
      const api = getOpenAdminOSApi();

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
    const api = getOpenAdminOSApi();
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

  const getRequestedScopes = useCallback(async (): Promise<RequestedScope[]> => {
    const api = getOpenAdminOSApi();
    if (!api) return [];
    return api.getRequestedScopes();
  }, []);

  const connectTenant = useCallback(async () => {
    const api = getOpenAdminOSApi();
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
    const api = getOpenAdminOSApi();
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
    const api = getOpenAdminOSApi();
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

  const updateAgentSettings = useCallback(
    async (slug: string, values: Record<string, unknown>) => {
      const api = getOpenAdminOSApi();
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

  const updateAgentSchedule = useCallback(
    async (slug: string, schedule: AgentSchedule | null) => {
      const api = getOpenAdminOSApi();
      if (!api) {
        const fallbackError = new Error(
          "Updating an agent schedule is unavailable in browser development.",
        );
        setError(fallbackError);
        throw fallbackError;
      }
      setError(null);
      try {
        const nextState = await api.updateAgentSchedule(slug, schedule);
        setState(nextState);
        setRegistryAgents(nextState.registryAgents);
      } catch (caughtError) {
        const scheduleError = toError(caughtError);
        setError(scheduleError);
        throw scheduleError;
      }
    },
    [],
  );

  const updateAgentTeamsDelivery = useCallback(
    async (slug: string, delivery: AgentTeamsDelivery | null) => {
      const api = getOpenAdminOSApi();
      if (!api) {
        const fallbackError = new Error(
          "Updating Teams delivery is unavailable in browser development.",
        );
        setError(fallbackError);
        throw fallbackError;
      }
      setError(null);
      try {
        const nextState = await api.updateAgentTeamsDelivery(slug, delivery);
        setState(nextState);
        setRegistryAgents(nextState.registryAgents);
      } catch (caughtError) {
        const deliveryError = toError(caughtError);
        setError(deliveryError);
        throw deliveryError;
      }
    },
    [],
  );

  const draftAgentManifest = useCallback(async (prompt: string) => {
    const api = getOpenAdminOSApi();
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

  const validateAgentDraft = useCallback(async (yamlSource: string, allowedSlug?: string) => {
    const api = getOpenAdminOSApi();
    if (!api) {
      const fallbackError = new Error(
        "Validating an agent draft is unavailable in browser development.",
      );
      setError(fallbackError);
      throw fallbackError;
    }
    setError(null);
    try {
      return await api.validateAgentDraft(yamlSource, allowedSlug);
    } catch (caughtError) {
      const validationError = toError(caughtError);
      setError(validationError);
      throw validationError;
    }
  }, []);

  const preflightAgentDraft = useCallback(async (yamlSource: string, allowedSlug?: string) => {
    const api = getOpenAdminOSApi();
    if (!api) {
      const fallbackError = new Error(
        "Testing an agent draft is unavailable in browser development.",
      );
      setError(fallbackError);
      throw fallbackError;
    }
    setError(null);
    try {
      return await api.preflightAgentDraft(yamlSource, allowedSlug);
    } catch (caughtError) {
      const preflightError = toError(caughtError);
      setError(preflightError);
      throw preflightError;
    }
  }, []);

  const saveAgentDraft = useCallback(async (yamlSource: string) => {
    const api = getOpenAdminOSApi();
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

  const updateUserAgentDraft = useCallback(async (slug: string, yamlSource: string) => {
    const api = getOpenAdminOSApi();
    if (!api) {
      const fallbackError = new Error(
        "Updating an agent draft is unavailable in browser development.",
      );
      setError(fallbackError);
      throw fallbackError;
    }
    setError(null);
    try {
      const nextState = await api.updateUserAgentDraft(slug, yamlSource);
      setState(nextState);
      setRegistryAgents(nextState.registryAgents);
    } catch (caughtError) {
      const updateError = toError(caughtError);
      setError(updateError);
      throw updateError;
    }
  }, []);

  const exportAgentDraftBundle = useCallback(async (yamlSource: string) => {
    const api = getOpenAdminOSApi();
    if (!api) {
      const fallbackError = new Error(
        "Exporting an agent bundle is unavailable in browser development.",
      );
      setError(fallbackError);
      throw fallbackError;
    }
    setError(null);
    try {
      const result = await api.exportAgentDraftBundle(yamlSource);
      return result.canceled ? undefined : result.directoryPath;
    } catch (caughtError) {
      const exportError = toError(caughtError);
      setError(exportError);
      throw exportError;
    }
  }, []);

  const prepareAgentCommunitySubmission = useCallback(
    async (
      yamlSource: string,
      metadata: AgentCommunitySubmissionMetadata,
      allowedSlug?: string,
    ) => {
      const api = getOpenAdminOSApi();
      if (!api) {
        const fallbackError = new Error(
          "Preparing a community submission is unavailable in browser development.",
        );
        setError(fallbackError);
        throw fallbackError;
      }
      setError(null);
      try {
        return await api.prepareAgentCommunitySubmission(
          yamlSource,
          metadata,
          allowedSlug,
        );
      } catch (caughtError) {
        const prepareError = toError(caughtError);
        setError(prepareError);
        throw prepareError;
      }
    },
    [],
  );

  const submitAgentCommunitySubmission = useCallback(
    async (
      yamlSource: string,
      metadata: AgentCommunitySubmissionMetadata,
      allowedSlug?: string,
    ) => {
      const api = getOpenAdminOSApi();
      if (!api) {
        const fallbackError = new Error(
          "Submitting a community agent is unavailable in browser development.",
        );
        setError(fallbackError);
        throw fallbackError;
      }
      setError(null);
      try {
        const result = await api.submitAgentCommunitySubmission(
          yamlSource,
          metadata,
          allowedSlug,
        );
        const nextState = await api.getAppState();
        setState(nextState);
        setRegistryAgents(nextState.registryAgents);
        return result;
      } catch (caughtError) {
        const submitError = toError(caughtError);
        setError(submitError);
        throw submitError;
      }
    },
    [],
  );

  const cancelRun = useCallback(async (runId: string) => {
    const api = getOpenAdminOSApi();
    if (!api) {
      const fallbackError = new Error("Run cancellation is unavailable in browser development.");
      setError(fallbackError);
      throw fallbackError;
    }

    setError(null);

    try {
      const run = await api.cancelRun(runId);
      const nextState = await api.getAppState();
      setState(nextState);
      setRegistryAgents(nextState.registryAgents);
      return run;
    } catch (caughtError) {
      const cancelError = toError(caughtError);
      setError(cancelError);
      throw cancelError;
    }
  }, []);

  const rejectRun = useCallback(async (runId: string) => {
    const api = getOpenAdminOSApi();
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

  // Refresh once whenever the window regains focus. Cheap, and catches
  // out-of-band state changes (e.g. the user started or stopped Ollama
  // in another window, plugged in a new tenant, etc.) without forcing a
  // permanent polling loop.
  useEffect(() => {
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // Silent swap-in when the main process completes a background
  // registry refresh (6h interval / focus-triggered). No toast — the
  // user discovers the new state when they next look at Agent Hub.
  useEffect(() => {
    const api = getOpenAdminOSApi();
    if (!api?.onRegistryRefreshed) return;
    return api.onRegistryRefreshed(() => {
      void refresh();
    });
  }, [refresh]);

  const value = useMemo<AppStateContextValue>(
    () => ({
      state,
      registryAgents,
      loading,
      error,
      refresh,
      refreshRegistry,
      installAgent,
      uninstallAgent,
      getAgentUpdateReview,
      updateAgent,
      setActiveModel,
      setActiveProvider,
      setRegistryInstallCountsEnabled,
      startRun,
      confirmRun,
      rejectRun,
      cancelRun,
      connectTenant,
      getRequestedScopes,
      setActiveTenant,
      disconnectTenant,
      updateAgentSettings,
      updateAgentSchedule,
      updateAgentTeamsDelivery,
      draftAgentManifest,
      validateAgentDraft,
      preflightAgentDraft,
      saveAgentDraft,
      updateUserAgentDraft,
      exportAgentDraftBundle,
      prepareAgentCommunitySubmission,
      submitAgentCommunitySubmission,
    }),
    [
      cancelRun,
      confirmRun,
      connectTenant,
      disconnectTenant,
      draftAgentManifest,
      error,
      exportAgentDraftBundle,
      getAgentUpdateReview,
      getRequestedScopes,
      installAgent,
      loading,
      refresh,
      refreshRegistry,
      registryAgents,
      rejectRun,
      preflightAgentDraft,
      prepareAgentCommunitySubmission,
      saveAgentDraft,
      setActiveModel,
      setActiveProvider,
      setRegistryInstallCountsEnabled,
      setActiveTenant,
      startRun,
      state,
      submitAgentCommunitySubmission,
      uninstallAgent,
      updateAgent,
      updateAgentSchedule,
      updateAgentSettings,
      updateAgentTeamsDelivery,
      updateUserAgentDraft,
      validateAgentDraft,
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

  return new Error(typeof error === "string" ? error : "Unknown OpenAdminOS error.");
}
