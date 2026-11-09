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
  type ConnectTenantOptions,
  deriveTrustState,
  providerCatalog,
  type AgentDraft,
  type AgentCommunitySubmissionMetadata,
  type AgentCommunitySubmissionReview,
  type AgentCommunitySubmissionResult,
  type AgentDraftPreflightResult,
  type AgentUpdateReview,
  type AgentDiscordDelivery,
  type AgentOutlookDelivery,
  type AgentSchedule,
  type AgentSignalDelivery,
  type AgentSlackDelivery,
  type AgentTeamsDelivery,
  type AgentWhatsAppWebDelivery,
  type AppState,
  type OpenAdminOSApi,
  type ProviderId,
  type RegistryAgentSummary,
  type RequestedScope,
  type RunRecord,
  type StartRunOptions,
  type TenantCleanupSummary,
  type TenantRecord,
} from "../shared/openAdminOS";

interface AppStateContextValue {
  state: AppState;
  registryAgents: RegistryAgentSummary[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  refreshRegistry: () => Promise<void>;
  setRegistrySource: (
    url: string,
    options?: { confirmExternalSource?: boolean },
  ) => Promise<{ error: string | null; fromCache: boolean; cachedAt: string | null }>;
  installAgent: (agentId: string) => Promise<void>;
  uninstallAgent: (slug: string) => Promise<void>;
  getAgentUpdateReview: (slug: string) => Promise<AgentUpdateReview>;
  updateAgent: (
    slug: string,
    options?: { confirmTrustChanges?: boolean },
  ) => Promise<void>;
  setActiveProvider: (id: ProviderId) => Promise<void>;
  dismissProviderAutoSelectNotice: () => Promise<void>;
  setActiveModel: (providerId: ProviderId, model: string | null) => Promise<void>;
  setRegistryInstallCountsEnabled: (enabled: boolean) => Promise<void>;
  setUsageTelemetryEnabled: (enabled: boolean) => Promise<void>;
  startRun: (agentSlug: string, options?: StartRunOptions) => Promise<RunRecord>;
  confirmRun: (runId: string, phrase: string) => Promise<RunRecord>;
  rejectRun: (runId: string) => Promise<RunRecord>;
  cancelRun: (runId: string) => Promise<RunRecord>;
  connectTenant: (options?: ConnectTenantOptions) => Promise<TenantRecord | undefined>;
  /** Resolves with the new state, so callers can show a tenant probe warning. */
  addTenantAccess: (tenantId: string, partIds: string[]) => Promise<AppState>;
  /** Resolves with the new state, so callers can show a tenant probe warning. */
  refreshTenantGrants: (tenantId: string) => Promise<AppState>;
  /** Runs only the license check. Resolves with the new state. */
  retryTenantLicenseCheck: (tenantId: string) => Promise<AppState>;
  /** Cancels the check running for the tenant; its caller rejects. */
  cancelTenantCheck: (tenantId: string) => Promise<void>;
  cancelConnectTenant: () => Promise<void>;
  getRequestedScopes: () => Promise<RequestedScope[]>;
  setActiveTenant: (id: string) => Promise<void>;
  /** Make an organization active, or choose "No organization" with null. */
  setActiveOrganization: (id: string | null) => Promise<void>;
  renameOrganization: (id: string, name: string) => Promise<void>;
  assignAgentSchedule: (slug: string, organizationId: string) => Promise<void>;
  dismissOrganizationMigrationNotice: () => Promise<void>;
  /**
   * Disconnect a tenant. Resolves with its pending cleanup when the
   * organization was removed but its cleanup did not finish.
   */
  disconnectTenant: (id: string) => Promise<TenantCleanupSummary | undefined>;
  /** Retry a pending disconnect cleanup. Resolves with it when still pending. */
  retryTenantCleanup: (id: string) => Promise<TenantCleanupSummary | undefined>;
  removeSavedAppRegistration: (clientId: string, directoryTenantId?: string) => Promise<void>;
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
  updateAgentWhatsAppWebDelivery: (
    slug: string,
    delivery: AgentWhatsAppWebDelivery | null,
  ) => Promise<void>;
  updateAgentOutlookDelivery: (
    slug: string,
    delivery: AgentOutlookDelivery | null,
  ) => Promise<void>;
  updateAgentSlackDelivery: (
    slug: string,
    delivery: AgentSlackDelivery | null,
  ) => Promise<void>;
  updateAgentDiscordDelivery: (
    slug: string,
    delivery: AgentDiscordDelivery | null,
  ) => Promise<void>;
  updateAgentSignalDelivery: (
    slug: string,
    delivery: AgentSignalDelivery | null,
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
    appVersion: __APP_VERSION__,
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

  const setRegistrySource = useCallback(
    async (url: string, options?: { confirmExternalSource?: boolean }) => {
      const api = getOpenAdminOSApi();

      if (!api?.setRegistrySource) {
        const fallbackError = new Error(
          "Registry source changes are unavailable in browser development.",
        );
        setError(fallbackError);
        throw fallbackError;
      }

      setError(null);
      try {
        const result = await api.setRegistrySource(url, options);
        const nextState = await api.getAppState();
        setState(nextState);
        setRegistryAgents(nextState.registryAgents);
        return result;
      } catch (caughtError) {
        const registryError = toError(caughtError);
        setError(registryError);
        throw registryError;
      }
    },
    [],
  );

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

  const dismissProviderAutoSelectNotice = useCallback(async () => {
    const api = getOpenAdminOSApi();
    if (!api) {
      setState((currentState) => {
        const { providerAutoSelectNotice: _dismissed, ...rest } = currentState;
        return rest;
      });
      return;
    }
    try {
      const nextState = await api.dismissProviderAutoSelectNotice();
      setState(nextState);
      setRegistryAgents(nextState.registryAgents);
    } catch (caughtError) {
      setError(toError(caughtError));
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

  const setUsageTelemetryEnabled = useCallback(async (enabled: boolean) => {
    const api = getOpenAdminOSApi();
    if (!api?.setUsageTelemetryEnabled) {
      const fallbackError = new Error(
        "Usage telemetry settings are unavailable in this build.",
      );
      setError(fallbackError);
      throw fallbackError;
    }

    setError(null);
    try {
      const nextState = await api.setUsageTelemetryEnabled(enabled);
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

  const connectTenant = useCallback(async (options?: ConnectTenantOptions) => {
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
      const nextState = await api.connectTenant(options);
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

  const cancelConnectTenant = useCallback(async () => {
    const api = getOpenAdminOSApi();
    if (!api) return;
    await api.cancelConnectTenant();
  }, []);

  const addTenantAccess = useCallback(
    async (tenantId: string, partIds: string[]) => {
      const api = getOpenAdminOSApi();
      if (!api) {
        throw new Error("Adding tenant access is unavailable in browser development.");
      }
      setError(null);
      try {
        const nextState = await api.addTenantAccess(tenantId, partIds);
        setState(nextState);
        setRegistryAgents(nextState.registryAgents);
        return nextState;
      } catch (caughtError) {
        const tenantError = toError(caughtError);
        setError(tenantError);
        throw tenantError;
      }
    },
    [],
  );

  // Check again for an own app registration: a new token decides the grants.
  const refreshTenantGrants = useCallback(async (tenantId: string) => {
    const api = getOpenAdminOSApi();
    if (!api) {
      throw new Error("Checking tenant permissions is unavailable in browser development.");
    }
    setError(null);
    try {
      const nextState = await api.refreshTenantGrants(tenantId);
      setState(nextState);
      setRegistryAgents(nextState.registryAgents);
      return nextState;
    } catch (caughtError) {
      const tenantError = toError(caughtError);
      setError(tenantError);
      throw tenantError;
    }
  }, []);

  const retryTenantLicenseCheck = useCallback(async (tenantId: string) => {
    const api = getOpenAdminOSApi();
    if (!api) {
      throw new Error("Checking tenant licenses is unavailable in browser development.");
    }
    setError(null);
    try {
      const nextState = await api.retryTenantLicenseCheck(tenantId);
      setState(nextState);
      setRegistryAgents(nextState.registryAgents);
      return nextState;
    } catch (caughtError) {
      const tenantError = toError(caughtError);
      setError(tenantError);
      throw tenantError;
    }
  }, []);

  const cancelTenantCheck = useCallback(async (tenantId: string) => {
    const api = getOpenAdminOSApi();
    if (!api) return;
    await api.cancelTenantCheck(tenantId);
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

  const setActiveOrganization = useCallback(async (id: string | null) => {
    const api = getOpenAdminOSApi();
    if (!api) return;
    setError(null);
    try {
      const nextState = await api.setActiveOrganization(id);
      setState(nextState);
      setRegistryAgents(nextState.registryAgents);
    } catch (caughtError) {
      const organizationError = toError(caughtError);
      setError(organizationError);
      throw organizationError;
    }
  }, []);

  // These throw to the caller, which shows the reason next to the control.
  const renameOrganization = useCallback(async (id: string, name: string) => {
    const api = getOpenAdminOSApi();
    if (!api) throw new Error("Organizations are unavailable in browser development.");
    const nextState = await api.renameOrganization(id, name).catch((caught: unknown) => {
      throw toError(caught);
    });
    setState(nextState);
  }, []);

  const assignAgentSchedule = useCallback(async (slug: string, organizationId: string) => {
    const api = getOpenAdminOSApi();
    if (!api) throw new Error("Schedules are unavailable in browser development.");
    const nextState = await api.assignAgentSchedule(slug, organizationId).catch((caught: unknown) => {
      throw toError(caught);
    });
    setState(nextState);
  }, []);

  const dismissOrganizationMigrationNotice = useCallback(async () => {
    const api = getOpenAdminOSApi();
    if (!api) throw new Error("Schedules are unavailable in browser development.");
    const nextState = await api.dismissOrganizationMigrationNotice().catch((caught: unknown) => {
      throw toError(caught);
    });
    setState(nextState);
  }, []);

  const disconnectTenant = useCallback(async (id: string) => {
    const api = getOpenAdminOSApi();
    if (!api) return undefined;
    setError(null);
    try {
      const nextState = await api.disconnectTenant(id);
      setState(nextState);
      setRegistryAgents(nextState.registryAgents);
      return nextState.tenantCleanups?.find((cleanup) => cleanup.tenantId === id);
    } catch (caughtError) {
      const tenantError = toError(caughtError);
      setError(tenantError);
      // What changed on the host is shown even when the call failed.
      await api.getAppState().then((fresh) => {
        setState(fresh);
        setRegistryAgents(fresh.registryAgents);
      }).catch(() => undefined);
      throw tenantError;
    }
  }, []);

  const retryTenantCleanup = useCallback(async (id: string) => {
    const api = getOpenAdminOSApi();
    if (!api) return undefined;
    try {
      const nextState = await api.retryTenantCleanup(id);
      setState(nextState);
      return nextState.tenantCleanups?.find((cleanup) => cleanup.tenantId === id);
    } catch (caughtError) {
      await api.getAppState().then(setState).catch(() => undefined);
      throw toError(caughtError);
    }
  }, []);

  const removeSavedAppRegistration = useCallback(
    async (clientId: string, directoryTenantId?: string) => {
      const api = getOpenAdminOSApi();
      if (!api) {
        throw new Error("Saved app registrations are unavailable in browser development.");
      }
      const nextState = await api.removeSavedAppRegistration(clientId, directoryTenantId);
      setState(nextState);
      setRegistryAgents(nextState.registryAgents);
    },
    [],
  );

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

  const updateAgentWhatsAppWebDelivery = useCallback(
    async (slug: string, delivery: AgentWhatsAppWebDelivery | null) => {
      const api = getOpenAdminOSApi();
      if (!api) {
        const fallbackError = new Error(
          "Updating WhatsApp Web delivery is unavailable in browser development.",
        );
        setError(fallbackError);
        throw fallbackError;
      }
      setError(null);
      try {
        const nextState = await api.updateAgentWhatsAppWebDelivery(slug, delivery);
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

  const updateAgentOutlookDelivery = useCallback(
    async (slug: string, delivery: AgentOutlookDelivery | null) => {
      const api = getOpenAdminOSApi();
      if (!api) {
        const fallbackError = new Error(
          "Updating Outlook delivery is unavailable in browser development.",
        );
        setError(fallbackError);
        throw fallbackError;
      }
      setError(null);
      try {
        const nextState = await api.updateAgentOutlookDelivery(slug, delivery);
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

  const updateAgentSlackDelivery = useCallback(
    async (slug: string, delivery: AgentSlackDelivery | null) => {
      const api = getOpenAdminOSApi();
      if (!api) {
        const fallbackError = new Error(
          "Updating Slack delivery is unavailable in browser development.",
        );
        setError(fallbackError);
        throw fallbackError;
      }
      setError(null);
      try {
        const nextState = await api.updateAgentSlackDelivery(slug, delivery);
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

  const updateAgentDiscordDelivery = useCallback(
    async (slug: string, delivery: AgentDiscordDelivery | null) => {
      const api = getOpenAdminOSApi();
      if (!api) {
        const fallbackError = new Error(
          "Updating Discord delivery is unavailable in browser development.",
        );
        setError(fallbackError);
        throw fallbackError;
      }
      setError(null);
      try {
        const nextState = await api.updateAgentDiscordDelivery(slug, delivery);
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

  const updateAgentSignalDelivery = useCallback(
    async (slug: string, delivery: AgentSignalDelivery | null) => {
      const api = getOpenAdminOSApi();
      if (!api) {
        const fallbackError = new Error(
          "Updating Signal delivery is unavailable in browser development.",
        );
        setError(fallbackError);
        throw fallbackError;
      }
      setError(null);
      try {
        const nextState = await api.updateAgentSignalDelivery(slug, delivery);
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
  // registry refresh (6h interval / focus-triggered). No toast. The
  // user discovers the new state when they next look at Agent Hub.
  useEffect(() => {
    const api = getOpenAdminOSApi();
    if (!api?.onRegistryRefreshed) return;
    return api.onRegistryRefreshed(() => {
      void refresh();
    });
  }, [refresh]);

  useEffect(() => {
    const api = getOpenAdminOSApi();
    if (!api?.onAppStateChanged) return;
    return api.onAppStateChanged(() => {
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
      setRegistrySource,
      installAgent,
      uninstallAgent,
      getAgentUpdateReview,
      updateAgent,
      setActiveModel,
      setActiveProvider,
      dismissProviderAutoSelectNotice,
      setRegistryInstallCountsEnabled,
      setUsageTelemetryEnabled,
      startRun,
      confirmRun,
      rejectRun,
      cancelRun,
      connectTenant,
      addTenantAccess,
      refreshTenantGrants,
      retryTenantLicenseCheck,
      cancelTenantCheck,
      cancelConnectTenant,
      getRequestedScopes,
      setActiveTenant,
      setActiveOrganization,
      renameOrganization,
      assignAgentSchedule,
      dismissOrganizationMigrationNotice,
      disconnectTenant,
      retryTenantCleanup,
      removeSavedAppRegistration,
      updateAgentSettings,
      updateAgentSchedule,
      updateAgentTeamsDelivery,
      updateAgentWhatsAppWebDelivery,
      updateAgentOutlookDelivery,
      updateAgentSlackDelivery,
      updateAgentDiscordDelivery,
      updateAgentSignalDelivery,
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
      cancelConnectTenant,
      confirmRun,
      connectTenant,
      addTenantAccess,
      refreshTenantGrants,
      retryTenantLicenseCheck,
      cancelTenantCheck,
      disconnectTenant,
      retryTenantCleanup,
      removeSavedAppRegistration,
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
      dismissProviderAutoSelectNotice,
      setRegistryInstallCountsEnabled,
      setUsageTelemetryEnabled,
      setRegistrySource,
      setActiveTenant,
      setActiveOrganization,
      renameOrganization,
      assignAgentSchedule,
      dismissOrganizationMigrationNotice,
      startRun,
      state,
      submitAgentCommunitySubmission,
      uninstallAgent,
      updateAgent,
      updateAgentSchedule,
      updateAgentSettings,
      updateAgentDiscordDelivery,
      updateAgentOutlookDelivery,
      updateAgentSignalDelivery,
      updateAgentSlackDelivery,
      updateAgentTeamsDelivery,
      updateAgentWhatsAppWebDelivery,
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

/** Electron wraps host errors as "Error invoking remote method '<channel>': <Name>: <message>". */
const REMOTE_ERROR_PREFIX = /^Error invoking remote method ['"][^'"]+['"]: (?:(\w*Error): )?/;

function toError(error: unknown): Error {
  if (error instanceof Error) {
    const prefix = REMOTE_ERROR_PREFIX.exec(error.message);
    if (!prefix) return error;
    // The host's message without the wrapper, under the host's error name.
    const hostError = new Error(error.message.slice(prefix[0].length));
    hostError.name = prefix[1] ?? error.name;
    return hostError;
  }

  return new Error(typeof error === "string" ? error : "Unknown OpenAdminOS error.");
}
