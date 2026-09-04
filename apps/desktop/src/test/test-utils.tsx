import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { vi } from "vitest";

import { ToastProvider } from "../components/Toast";
import { AppStateProvider } from "../state";
import { SetupFlowProvider } from "../setup/SetupFlowContext";
import {
  DEFAULT_AZURE_OPENAI_API_VERSION,
  DEFAULT_DRIFT_RETENTION_SETTINGS,
  DEFAULT_RUN_HISTORY_RETENTION_SETTINGS,
  deriveTrustState,
  type AgentDraft,
  type AgentDraftPreflightResult,
  type AgentSummary,
  type AppState,
  type AzureOpenAIProviderConfig,
  type CompanionLaunchSettings,
  type CompanionSnapshot,
  type DriftRetentionSettings,
  type GraphCacheStatus,
  type LocalDataSummary,
  type OpenAdminOSApi,
  type ProviderId,
  type ProviderSummary,
  type ReleaseDiagnostics,
  type RunRecord,
  type RunHistoryRetentionSettings,
  type SandboxSettings,
  type SchedulerLaunchSettings,
  type SendIntuneChatMessageInput,
  type SendIntuneChatMessageResult,
  type TenantRecord,
  type UpdateState,
} from "../shared/openAdminOS";

const now = "2026-07-05T10:00:00.000Z";

export const mockTenant: TenantRecord = {
  id: "tenant-1",
  displayName: "Contoso IT",
  username: "admin@contoso.example",
  homeAccountId: "home-account-1",
  addedAt: now,
  lastUsedAt: now,
  entraTier: "p1",
};

export const mockProviders: ProviderSummary[] = [
  {
    id: "ollama",
    name: "Ollama",
    description: "Run open-source models locally. Tenant data and prompts stay on this machine.",
    isLocal: true,
    status: "connected",
    detail: "http://127.0.0.1:11434",
    models: ["llama3.1"],
    defaultModel: "llama3.1",
  },
  {
    id: "apple-foundation",
    name: "Apple Foundation",
    description: "Use Apple's on-device Foundation Models framework on compatible Macs.",
    isLocal: true,
    status: "available",
    detail: "Compatible Mac required",
    models: ["SystemLanguageModel.default"],
    defaultModel: "SystemLanguageModel.default",
  },
  {
    id: "lm-studio",
    name: "LM Studio",
    description: "Use LM Studio's local OpenAI-compatible server for private model runs.",
    isLocal: true,
    status: "not-installed",
    detail: "Connection check not implemented yet",
    models: [],
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "Use OpenAI through the locally installed Codex CLI.",
    isLocal: false,
    status: "connected",
    detail: "Codex auth detected",
    models: ["gpt-5"],
    defaultModel: "gpt-5",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Use Anthropic through the locally installed Claude Code CLI.",
    isLocal: false,
    status: "not-installed",
    detail: "Adapter pending",
    models: [],
  },
  {
    id: "azure-openai",
    name: "Azure OpenAI",
    description: "Use an Azure OpenAI deployment for hosted model runs.",
    isLocal: false,
    status: "not-installed",
    detail: "Adapter pending",
    models: [],
  },
];

export function createMockAgent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: "device-offboard",
    slug: "device-offboard",
    name: "Device Offboard",
    description: "Reviews stale devices and prepares offboarding actions.",
    mode: "write",
    category: "devices",
    tier: "agent",
    requiresEntraTier: "free",
    scopes: ["DeviceManagementManagedDevices.ReadWrite.All"],
    author: { name: "openadminos", verified: true },
    version: "0.1.0",
    installedAt: now,
    ...overrides,
  };
}

export function createAwaitingConfirmationRun(
  overrides: Partial<RunRecord> = {},
): RunRecord {
  return {
    id: "run-write-1",
    agentSlug: "device-offboard",
    status: "awaiting-confirmation",
    queuedAt: now,
    startedAt: now,
    providerId: "ollama",
    model: "llama3.1",
    tenantId: mockTenant.id,
    summary: "Write plan is ready for review.",
    steps: [],
    logs: [],
    plan: {
      summary: "Retire two stale Windows devices after offboarding review.",
      confirmationPhrase: "OFFBOARD 2 DEVICES",
      actions: [
        {
          id: "action-1",
          kind: "retire-device",
          label: "Retire WIN-OLD-001",
          description: "Last synced 96 days ago.",
          severity: "destructive",
          request: {
            method: "POST",
            path: "/deviceManagement/managedDevices/device-1/retire",
          },
        },
        {
          id: "action-2",
          kind: "retire-device",
          label: "Retire WIN-OLD-002",
          description: "Last synced 104 days ago.",
          severity: "destructive",
          request: {
            method: "POST",
            path: "/deviceManagement/managedDevices/device-2/retire",
          },
        },
      ],
    },
    ...overrides,
  };
}

export function createMockAppState(overrides: Partial<AppState> = {}): AppState {
  const providers = overrides.providers ?? mockProviders;
  const activeProviderId = overrides.activeProviderId ?? "ollama";
  const activeProvider = providers.find((provider) => provider.id === activeProviderId);
  const activeTenantId = overrides.activeTenantId ?? mockTenant.id;
  const activeTenant = [mockTenant, ...(overrides.tenants ?? [])].find(
    (tenant) => tenant.id === activeTenantId,
  );

  return {
    appVersion: "0.2.5",
    activeProviderId,
    activeModelByProviderId: {
      ollama: "llama3.1",
      openai: "gpt-5",
      ...(overrides.activeModelByProviderId ?? {}),
    },
    providers,
    registryAgents: [],
    installedAgents: [createMockAgent()],
    runs: [],
    trust: deriveTrustState({
      provider: activeProvider,
      activeTenant,
      model: overrides.activeModelByProviderId?.[activeProviderId],
    }),
    tenants: [mockTenant],
    activeTenantId,
    lastRegistryRefresh: now,
    registryRefreshError: null,
    registrySource: "https://raw.githubusercontent.com/OpenAdminOS/OpenAdminOS/main/agents",
    registryInstallCountsEnabled: true,
    usageTelemetryEnabled: false,
    ...overrides,
  };
}

export function makeMockBridge(
  overrides: Partial<OpenAdminOSApi> = {},
  initialState: AppState = createMockAppState(),
): OpenAdminOSApi {
  let appState = initialState;
  let azureOpenAIConfig: AzureOpenAIProviderConfig = {
    endpoint: "",
    deployment: "",
    apiVersion: DEFAULT_AZURE_OPENAI_API_VERSION,
    hasKey: false,
  };
  let runHistoryRetention: RunHistoryRetentionSettings = {
    ...DEFAULT_RUN_HISTORY_RETENTION_SETTINGS,
  };
  let driftRetention: DriftRetentionSettings = {
    ...DEFAULT_DRIFT_RETENTION_SETTINGS,
  };
  const updateState = (nextState: AppState) => {
    appState = nextState;
    return appState;
  };

  const bridge: OpenAdminOSApi = {
    platform: "linux",
    getCompanionSnapshot: vi.fn(async () => createCompanionSnapshot(appState)),
    getCompanionLaunchSettings: vi.fn(async () => createCompanionLaunchSettings()),
    getAppState: vi.fn(async () => appState),
    getSchedulerLaunchSettings: vi.fn(async () => createSchedulerLaunchSettings()),
    getSandboxSettings: vi.fn(async () => createSandboxSettings()),
    getReleaseDiagnostics: vi.fn(async () => createReleaseDiagnostics()),
    exportSupportBundle: vi.fn(async () => ({
      canceled: false,
      filePath: "/tmp/openadminos-support.json",
    })),
    submitSupportIssue: vi.fn(async () => ({
      issueUrl: "https://github.com/OpenAdminOS/OpenAdminOS/issues/1",
      issueNumber: 1,
      diagnosticsIncluded: false,
      redacted: false,
    })),
    writeClipboardText: vi.fn(async () => undefined),
    openMainWindow: vi.fn(async () => undefined),
    runDueReadSchedules: vi.fn(async () => ({
      queued: 0,
      skippedWrite: 0,
      skippedInFlight: 0,
      skippedNotDue: 0,
      errors: [],
    })),
    setCompanionLaunchEnabled: vi.fn(async (enabled: boolean) =>
      createCompanionLaunchSettings({ enabled }),
    ),
    setSandboxedCodeEnabled: vi.fn(async (enabled: boolean) =>
      createSandboxSettings({ enabled }),
    ),
    setSchedulerLaunchEnabled: vi.fn(async (enabled: boolean) =>
      createSchedulerLaunchSettings({ enabled }),
    ),
    listRegistryAgents: vi.fn(async () => appState.registryAgents),
    refreshRegistry: vi.fn(async () => ({ error: null, fromCache: false, cachedAt: now })),
    setRegistrySource: vi.fn(async () => ({ error: null, fromCache: false, cachedAt: now })),
    setRegistryInstallCountsEnabled: vi.fn(async (enabled: boolean) =>
      updateState({ ...appState, registryInstallCountsEnabled: enabled }),
    ),
    getUsageTelemetryPreview: vi.fn(async () => ({
      enabled: appState.usageTelemetryEnabled ?? false,
      endpointConfigured: true,
      payload: {
        schema: "openadminos-usage-1" as const,
        installId: "oao_test_install",
        appVersion: appState.appVersion,
        os: "linux",
        arch: "x64",
        providerClass: appState.trust.isLocal ? "local" as const : "hosted" as const,
        tenants: "1",
        agents: "1",
        runs: "0",
        retrievalIndex: false,
      },
    })),
    setUsageTelemetryEnabled: vi.fn(async (enabled: boolean) =>
      updateState({ ...appState, usageTelemetryEnabled: enabled }),
    ),
    sendUsageTelemetryTest: vi.fn(async () => ({
      sent: appState.usageTelemetryEnabled ?? false,
    })),
    getRetrievalStatus: vi.fn(async () => ({
      available: false,
      reason: "not documentation-grounded yet",
    })),
    refreshRetrievalIndex: vi.fn(async () => ({
      available: false,
      reason: "not documentation-grounded yet",
    })),
    listInstalledAgents: vi.fn(async () => appState.installedAgents),
    listAgents: vi.fn(async () => appState.installedAgents),
    listProviders: vi.fn(async () => appState.providers),
    testProvider: vi.fn(async (providerId: ProviderId) => ({
      providerId,
      ok: true,
      message: "Provider test passed.",
      durationMs: 125,
    })),
    getAzureOpenAIConfig: vi.fn(async () => azureOpenAIConfig),
    setAzureOpenAIConfig: vi.fn(async (input) => {
      azureOpenAIConfig = {
        endpoint: input.endpoint,
        deployment: input.deployment,
        apiVersion: input.apiVersion || DEFAULT_AZURE_OPENAI_API_VERSION,
        hasKey:
          input.apiKey === null
            ? false
            : typeof input.apiKey === "string"
              ? input.apiKey.trim().length > 0
              : azureOpenAIConfig.hasKey,
      };
      return azureOpenAIConfig;
    }),
    listIntuneChatConversations: vi.fn(async () => []),
    searchIntuneChatConversations: vi.fn(async () => []),
    renameIntuneChatConversation: vi.fn(async (conversationId: string, title: string) => ({
      id: conversationId,
      title,
      createdAt: now,
      updatedAt: now,
      tenantId: appState.activeTenantId,
      scopeKind: "single-tenant" as const,
    })),
    setIntuneChatConversationPinned: vi.fn(async (conversationId: string) => ({
      id: conversationId,
      title: "Pinned conversation",
      createdAt: now,
      updatedAt: now,
      tenantId: appState.activeTenantId,
      pinnedAt: now,
      scopeKind: "single-tenant" as const,
    })),
    deleteIntuneChatConversation: vi.fn(async () => undefined),
    getIntuneChatMessages: vi.fn(async () => []),
    sendIntuneChatMessage: vi.fn(async (input: SendIntuneChatMessageInput) =>
      createChatResult(input, appState),
    ),
    streamIntuneChatMessage: vi.fn(async (input: SendIntuneChatMessageInput) =>
      createChatResult(input, appState),
    ),
    cancelIntuneChatStream: vi.fn(async () => undefined),
    listTenantGroups: vi.fn(async () => []),
    saveTenantGroup: vi.fn(async (input) => ({
      id: input.id ?? "group-1",
      name: input.name,
      tenantIds: input.tenantIds,
      createdAt: now,
      updatedAt: now,
    })),
    deleteTenantGroup: vi.fn(async () => undefined),
    listSavedMultiTenantQueries: vi.fn(async () => []),
    preflightMultiTenantIntuneChat: vi.fn(async () => {
      throw new Error("preflightMultiTenantIntuneChat is not implemented in this test.");
    }),
    runMultiTenantIntuneChat: vi.fn(async () => {
      throw new Error("runMultiTenantIntuneChat is not implemented in this test.");
    }),
    streamMultiTenantIntuneChat: vi.fn(async () => {
      throw new Error("streamMultiTenantIntuneChat is not implemented in this test.");
    }),
    cancelMultiTenantIntuneChatStream: vi.fn(async () => undefined),
    listMultiTenantChatJobs: vi.fn(async () => []),
    getMultiTenantChatJob: vi.fn(async () => undefined),
    queueMultiTenantAgentBatch: vi.fn(async () => {
      throw new Error("queueMultiTenantAgentBatch is not implemented in this test.");
    }),
    listMultiTenantAgentBatches: vi.fn(async () => []),
    getMultiTenantAgentBatch: vi.fn(async () => undefined),
    refreshGraphCache: vi.fn(async () => ({
      tenantId: appState.activeTenantId ?? mockTenant.id,
      startedAt: now,
      finishedAt: now,
      resources: [],
    })),
    getGraphCacheStatus: vi.fn(async () => createGraphCacheStatus(appState.activeTenantId)),
    getGraphCacheRefreshSchedule: vi.fn(async () => ({
      enabled: false,
      intervalMinutes: 240,
    })),
    setGraphCacheRefreshSchedule: vi.fn(async (input) => ({
      enabled: input.enabled,
      intervalMinutes: input.intervalMinutes ?? 240,
      tenantId: input.tenantId,
    })),
    getLocalDataSummary: vi.fn(async () =>
      createLocalDataSummary(appState.activeTenantId, {
        runHistoryCount: appState.runs.length,
        runHistoryRetention,
        driftRetention,
      }),
    ),
    clearIntuneChatHistory: vi.fn(async () =>
      createLocalDataSummary(appState.activeTenantId, {
        runHistoryCount: appState.runs.length,
        runHistoryRetention,
        driftRetention,
      }),
    ),
    clearGraphCache: vi.fn(async () =>
      createLocalDataSummary(appState.activeTenantId, {
        runHistoryCount: appState.runs.length,
        runHistoryRetention,
        driftRetention,
      }),
    ),
    getRunHistoryRetentionSettings: vi.fn(async () => runHistoryRetention),
    setRunHistoryRetentionSettings: vi.fn(async (input) => {
      runHistoryRetention = {
        neverPrune: input.neverPrune,
        ...(input.keepLastRuns !== undefined && input.keepLastRuns !== null
          ? { keepLastRuns: input.keepLastRuns }
          : {}),
        ...(input.keepDays !== undefined && input.keepDays !== null
          ? { keepDays: input.keepDays }
          : {}),
        updatedAt: now,
      };
      return runHistoryRetention;
    }),
    pruneRunHistoryNow: vi.fn(async () => ({
      prunedAt: now,
      trigger: "manual" as const,
      policy: runHistoryRetention,
      beforeCount: appState.runs.length,
      afterCount: appState.runs.length,
      eligibleCount: appState.runs.length,
      prunedCount: 0,
      protectedCount: 0,
      protectedWorkspaceCount: 0,
      protectedActiveCount: 0,
      protectedAwaitingConfirmationCount: 0,
      reason: "No eligible runs exceeded the retention policy.",
    })),
    getDriftRetentionSettings: vi.fn(async () => driftRetention),
    setDriftRetentionSettings: vi.fn(async (input) => {
      driftRetention = {
        neverPrune: input.neverPrune,
        ...(input.keepDays !== undefined && input.keepDays !== null
          ? { keepDays: input.keepDays }
          : {}),
        updatedAt: now,
      };
      return driftRetention;
    }),
    pruneDriftHistoryNow: vi.fn(async () => ({
      prunedAt: now,
      trigger: "manual" as const,
      policy: driftRetention,
      snapshotsDeleted: 0,
      versionsDeleted: 0,
      reason: "No drift history exceeded the retention policy.",
    })),
    exportAuditLog: vi.fn(async (input) => ({
      format: input.format,
      suggestedName: `openadminos-audit-log.${input.format}`,
      mimeType: input.format === "json" ? "application/json" as const : "text/csv" as const,
      content:
        input.format === "json"
          ? `${JSON.stringify({
              schemaVersion: 1,
              generatedAt: now,
              hashChain: {
                algorithm: "sha256",
                startHash: "0".repeat(64),
                finalHash: "0".repeat(64),
              },
              eventCount: 0,
              events: [],
            })}\n`
          : "sha256,timestamp,type,source\n",
      generatedAt: now,
      eventCount: 0,
      hashChain: {
        algorithm: "sha256" as const,
        startHash: "0".repeat(64),
        finalHash: "0".repeat(64),
      },
      ...(input.from ? { from: input.from } : {}),
      ...(input.to ? { to: input.to } : {}),
    })),
    getChatInvestigationSettings: vi.fn(async () => ({ mode: "auto" as const })),
    setChatInvestigationMode: vi.fn(async (mode) => ({ mode, updatedAt: now })),
    getSelfTrainingSettings: vi.fn(async () => ({ enabled: false })),
    setSelfTrainingEnabled: vi.fn(async (enabled: boolean) => ({ enabled, updatedAt: now })),
    listSelfTrainingSuggestions: vi.fn(async () => []),
    approveSelfTrainingSuggestion: vi.fn(async () => {
      throw new Error("approveSelfTrainingSuggestion is not implemented in this test.");
    }),
    rejectSelfTrainingSuggestion: vi.fn(async () => {
      throw new Error("rejectSelfTrainingSuggestion is not implemented in this test.");
    }),
    resetSelfTrainingSuggestions: vi.fn(async () => []),
    listWorkspaces: vi.fn(async () => []),
    getWorkspace: vi.fn(async () => undefined),
    createWorkspace: vi.fn(async () => {
      throw new Error("createWorkspace is not implemented in this test.");
    }),
    updateWorkspace: vi.fn(async () => {
      throw new Error("updateWorkspace is not implemented in this test.");
    }),
    archiveWorkspace: vi.fn(async () => {
      throw new Error("archiveWorkspace is not implemented in this test.");
    }),
    deleteWorkspace: vi.fn(async () => undefined),
    addWorkspaceNote: vi.fn(async () => {
      throw new Error("addWorkspaceNote is not implemented in this test.");
    }),
    updateWorkspaceNote: vi.fn(async () => {
      throw new Error("updateWorkspaceNote is not implemented in this test.");
    }),
    pinWorkspaceEvidence: vi.fn(async () => {
      throw new Error("pinWorkspaceEvidence is not implemented in this test.");
    }),
    linkWorkspaceConversation: vi.fn(async () => {
      throw new Error("linkWorkspaceConversation is not implemented in this test.");
    }),
    linkWorkspaceRun: vi.fn(async () => {
      throw new Error("linkWorkspaceRun is not implemented in this test.");
    }),
    importMultiTenantResultToWorkspaces: vi.fn(async () => ({
      workspaces: [],
      evidence: [],
    })),
    exportWorkspaceDossier: vi.fn(async () => "/tmp/workspace.md"),
    listConnectors: vi.fn(async () => []),
    testConnector: vi.fn(async () => {
      throw new Error("testConnector is not implemented in this test.");
    }),
    setConnectorConfig: vi.fn(async () => {
      throw new Error("setConnectorConfig is not implemented in this test.");
    }),
    setConnectorSecret: vi.fn(async () => {
      throw new Error("setConnectorSecret is not implemented in this test.");
    }),
    listConnectorTeams: vi.fn(async () => []),
    listConnectorChannels: vi.fn(async () => []),
    getWhatsAppWebStatus: vi.fn(async () => ({
      state: "not-linked" as const,
      message: "WhatsApp Web is not linked.",
    })),
    startWhatsAppWebLogin: vi.fn(async () => ({
      state: "not-linked" as const,
      message: "WhatsApp Web is not linked.",
    })),
    disconnectWhatsAppWeb: vi.fn(async () => ({
      state: "not-linked" as const,
      message: "WhatsApp Web is not linked.",
    })),
    listWhatsAppWebGroups: vi.fn(async () => []),
    sendWhatsAppWebTestMessage: vi.fn(async () => ({
      ok: true,
      messageId: "whatsapp-message-1",
      targetLabel: "My WhatsApp",
    })),
    onConnectorConfirmRequest: vi.fn(() => () => undefined),
    onRegistryRefreshed: vi.fn(() => () => undefined),
    onAppStateChanged: vi.fn(() => () => undefined),
    respondToConnectorConfirm: vi.fn(async () => undefined),
    installAgent: vi.fn(async () => appState),
    uninstallAgent: vi.fn(async () => appState),
    getAgentUpdateReview: vi.fn(async () => ({
      slug: "device-offboard",
      fromVersion: "0.1.0",
      toVersion: "0.1.1",
      manifestUrl: "https://raw.githubusercontent.com/OpenAdminOS/OpenAdminOS/main/agents/device-offboard/manifest.yaml",
      manifestSha256: "sha256:mock",
      requiresConfirmation: false,
      changes: [],
    })),
    updateAgent: vi.fn(async () => appState),
    setActiveProvider: vi.fn(async (id: ProviderId) =>
      updateState({
        ...appState,
        activeProviderId: id,
        trust: deriveTrustState({
          provider: appState.providers.find((provider) => provider.id === id),
          activeTenant: appState.tenants.find(
            (tenant) => tenant.id === appState.activeTenantId,
          ),
          model: appState.activeModelByProviderId?.[id],
        }),
      }),
    ),
    setActiveModel: vi.fn(async (providerId: ProviderId, model: string | null) =>
      updateState({
        ...appState,
        activeProviderId: providerId,
        activeModelByProviderId: {
          ...appState.activeModelByProviderId,
          [providerId]: model ?? undefined,
        },
      }),
    ),
    startRun: vi.fn(async (agentSlug: string) => ({
      id: "run-new-1",
      agentSlug,
      status: "queued" as const,
      queuedAt: now,
      steps: [],
      logs: [],
      tenantId: appState.activeTenantId,
      providerId: appState.activeProviderId,
      model: appState.activeModelByProviderId?.[appState.activeProviderId],
    })),
    getRun: vi.fn(async (id: string) => appState.runs.find((run) => run.id === id)),
    confirmRun: vi.fn(async (runId: string, phrase: string) => {
      const confirmedRun = appState.runs.find((run) => run.id === runId) ?? createAwaitingConfirmationRun({ id: runId });
      return {
        ...confirmedRun,
        status: "completed" as const,
        confirmedAt: now,
        summary: `Confirmed with ${phrase}.`,
      };
    }),
    rejectRun: vi.fn(async (runId: string) => {
      const rejectedRun = appState.runs.find((run) => run.id === runId) ?? createAwaitingConfirmationRun({ id: runId });
      return { ...rejectedRun, status: "rejected" as const, rejectedAt: now };
    }),
    cancelRun: vi.fn(async (runId: string) => {
      const cancelledRun = appState.runs.find((run) => run.id === runId) ?? createAwaitingConfirmationRun({ id: runId });
      return { ...cancelledRun, status: "cancelled" as const };
    }),
    listTenants: vi.fn(async () => appState.tenants),
    getRequestedScopes: vi.fn(async () => []),
    connectTenant: vi.fn(async () => appState),
    cancelConnectTenant: vi.fn(async () => undefined),
    setActiveTenant: vi.fn(async (id: string) =>
      updateState({ ...appState, activeTenantId: id }),
    ),
    disconnectTenant: vi.fn(async (id: string) =>
      updateState({
        ...appState,
        tenants: appState.tenants.filter((tenant) => tenant.id !== id),
      }),
    ),
    getAgentManifest: vi.fn(async () => undefined),
    updateAgentSettings: vi.fn(async () => appState),
    updateAgentSchedule: vi.fn(async () => appState),
    updateAgentTeamsDelivery: vi.fn(async () => appState),
    updateAgentWhatsAppWebDelivery: vi.fn(async () => appState),
    updateAgentOutlookDelivery: vi.fn(async () => appState),
    updateAgentSlackDelivery: vi.fn(async () => appState),
    updateAgentDiscordDelivery: vi.fn(async () => appState),
    updateAgentSignalDelivery: vi.fn(async () => appState),
    draftAgentManifest: vi.fn(async () => createAgentDraft()),
    validateAgentDraft: vi.fn(async () => createAgentDraft()),
    preflightAgentDraft: vi.fn(async () => createAgentDraftPreflightResult()),
    saveAgentDraft: vi.fn(async () => appState),
    updateUserAgentDraft: vi.fn(async () => appState),
    exportAgentDraftBundle: vi.fn(async () => ({
      canceled: false,
      directoryPath: "/tmp/agent-bundle",
    })),
    prepareAgentCommunitySubmission: vi.fn(async () => ({
      ok: true,
      issueTitle: "[New Agent] Device Offboard",
      issueBody: "Generated review.",
      checks: [],
      package: {
        manifestYaml: "id: device-offboard\n",
        readmeMarkdown: "# Device Offboard\n",
        metadataJson: "{}",
      },
    })),
    submitAgentCommunitySubmission: vi.fn(async () => ({
      issueUrl: "https://github.com/OpenAdminOS/OpenAdminOS/issues/2",
      issueNumber: 2,
      duplicate: false,
    })),
    openExternal: vi.fn(async () => undefined),
    saveTextFile: vi.fn(async () => ({ canceled: true })),
    getUpdateState: vi.fn(async () => createUpdateState()),
    checkForUpdatesNow: vi.fn(async () => ({ status: "checking" as const })),
    onUpdateStateChanged: vi.fn(() => () => undefined),
    onFocusRun: vi.fn(() => () => undefined),
    onNavigate: vi.fn(() => () => undefined),
    onOpenCommandPalette: vi.fn(() => () => undefined),
    applyUpdateNow: vi.fn(async () => undefined),
  };

  return {
    ...bridge,
    ...overrides,
  };
}

export function installMockBridge(bridge: OpenAdminOSApi = makeMockBridge()) {
  window.openAdminOS = bridge;
  return bridge;
}

export function renderWithAppState(
  ui: ReactElement,
  options: RenderOptions & { route?: string; bridge?: OpenAdminOSApi } = {},
) {
  const { route = "/", bridge = makeMockBridge(), ...renderOptions } = options;
  installMockBridge(bridge);
  return render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <AppStateProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={[route]}>
            <SetupFlowProvider>{children}</SetupFlowProvider>
          </MemoryRouter>
        </ToastProvider>
      </AppStateProvider>
    ),
    ...renderOptions,
  });
}

export function renderRoute(
  element: ReactElement,
  options: RenderOptions & { path: string; route: string; bridge?: OpenAdminOSApi },
) {
  const { path, route, bridge, ...renderOptions } = options;
  return renderWithAppState(
    <Routes>
      <Route path={path} element={element} />
    </Routes>,
    { route, bridge, ...renderOptions },
  );
}

function createGraphCacheStatus(tenantId?: string): GraphCacheStatus {
  return {
    tenantId,
    resources: [],
  };
}

function createChatResult(
  input: SendIntuneChatMessageInput,
  state: AppState,
): SendIntuneChatMessageResult {
  const conversationId = input.conversationId ?? "conversation-1";
  const tenantId = state.activeTenantId;
  return {
    conversation: {
      id: conversationId,
      title: input.content,
      createdAt: now,
      updatedAt: now,
      tenantId,
      scopeKind: "single-tenant",
    },
    userMessage: {
      id: "message-user-1",
      conversationId,
      role: "user",
      content: input.content,
      status: "completed",
      createdAt: now,
    },
    assistantMessage: {
      id: "message-assistant-1",
      conversationId,
      role: "assistant",
      content: "Mock hosted answer.",
      status: "completed",
      createdAt: now,
      providerId: state.activeProviderId,
      model: state.activeModelByProviderId?.[state.activeProviderId],
    },
    cacheStatus: createGraphCacheStatus(tenantId),
  };
}

function createLocalDataSummary(
  activeTenantId?: string,
  overrides: Partial<LocalDataSummary> = {},
): LocalDataSummary {
  return {
    sqliteBytes: 0,
    chatConversationCount: 0,
    chatMessageCount: 0,
    chatToolCallCount: 0,
    graphRowCount: 0,
    graphCacheStatusCount: 0,
    learningEventCount: 0,
    selfTrainingSuggestionCount: 0,
    activeTenantId,
    activeTenantGraphRowCount: 0,
    activeTenantCacheResources: [],
    runHistoryCount: 0,
    runHistoryRetention: { ...DEFAULT_RUN_HISTORY_RETENTION_SETTINGS },
    driftRetention: { ...DEFAULT_DRIFT_RETENTION_SETTINGS },
    ...overrides,
  };
}

function createSchedulerLaunchSettings(
  overrides: Partial<SchedulerLaunchSettings> = {},
): SchedulerLaunchSettings {
  return {
    supported: true,
    enabled: false,
    activeScheduleCount: 0,
    ...overrides,
  };
}

function createCompanionLaunchSettings(
  overrides: Partial<CompanionLaunchSettings> = {},
): CompanionLaunchSettings {
  return {
    supported: false,
    enabled: false,
    detail: "Menu bar companion is unavailable in tests.",
    ...overrides,
  };
}

function createCompanionSnapshot(state: AppState): CompanionSnapshot {
  const provider = state.providers.find((entry) => entry.id === state.activeProviderId);
  const tenant = state.tenants.find((entry) => entry.id === state.activeTenantId);
  return {
    activeTenant: tenant ? { id: tenant.id, displayName: tenant.displayName } : null,
    provider: provider
      ? {
          id: provider.id,
          label: provider.name,
          isLocal: provider.isLocal,
          trustLabel: provider.isLocal ? "Local-only" : `${provider.name} hosted`,
          model: state.activeModelByProviderId?.[provider.id],
          status: provider.status,
        }
      : null,
    cache: { stale: false, refreshing: false },
    scheduler: createSchedulerLaunchSettings(),
    companion: createCompanionLaunchSettings(),
    inFlight: [],
    upcomingSchedules: [],
    recentActivity: [],
    attention: [],
  };
}

function createReleaseDiagnostics(): ReleaseDiagnostics {
  return {
    appVersion: "0.2.5",
    packaged: false,
    signed: false,
    platform: "linux",
    notificationSupported: false,
    notificationPermission: "unknown",
    scheduler: createSchedulerLaunchSettings(),
    companion: createCompanionLaunchSettings(),
    sandbox: createSandboxSettings().diagnostics,
  };
}

function createSandboxSettings(overrides: Partial<SandboxSettings> = {}): SandboxSettings {
  return {
    enabled: false,
    diagnostics: {
      backend: "mxc",
      status: "disabled",
      experimentalEnabled: false,
      supported: false,
      detail: "Sandbox disabled in tests.",
    },
    ...overrides,
  };
}

function createUpdateState(): UpdateState {
  return { status: "idle" };
}

function createAgentDraft(): AgentDraft {
  return {
    yamlSource: "id: device-offboard\n",
    validationErrors: [],
  };
}

function createAgentDraftPreflightResult(): AgentDraftPreflightResult {
  return {
    ok: true,
    checks: [],
  };
}
