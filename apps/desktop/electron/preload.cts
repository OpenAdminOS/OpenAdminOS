const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");
import type {
  HostPlatform,
  OpenAdminOSApi,
  AgentCommunitySubmissionMetadata,
  PendingConnectorConfirmation,
  PendingConnectorDecision,
  ProviderId,
  SaveTextFileArgs,
  SupportBundleInput,
  SupportIssueSubmissionInput,
  StartRunOptions,
  UpdateState,
  IntuneChatStreamEvent,
  MultiTenantChatStreamEvent,
} from "@openadminos/agent-sdk";

const platform: HostPlatform = detectPlatform();
const activeIntuneChatStreamIds = new Set<string>();
const activeMultiTenantChatStreamIds = new Set<string>();

function detectPlatform(): HostPlatform {
  const userAgent = navigator.userAgent.toLowerCase();
  if (userAgent.includes("mac os")) return "macos";
  if (userAgent.includes("windows")) return "windows";
  if (userAgent.includes("linux")) return "linux";
  return "unknown";
}

const api: OpenAdminOSApi = {
  platform,
  getCompanionSnapshot: () =>
    ipcRenderer.invoke("openadminos:get-companion-snapshot"),
  getCompanionLaunchSettings: () =>
    ipcRenderer.invoke("openadminos:get-companion-launch-settings"),
  getAppState: () => ipcRenderer.invoke("openadminos:get-app-state"),
  getSchedulerLaunchSettings: () =>
    ipcRenderer.invoke("openadminos:get-scheduler-launch-settings"),
  getSandboxSettings: () =>
    ipcRenderer.invoke("openadminos:get-sandbox-settings"),
  getReleaseDiagnostics: () =>
    ipcRenderer.invoke("openadminos:get-release-diagnostics"),
  exportSupportBundle: (input: SupportBundleInput) =>
    ipcRenderer.invoke("openadminos:export-support-bundle", input),
  submitSupportIssue: (input: SupportIssueSubmissionInput) =>
    ipcRenderer.invoke("openadminos:submit-support-issue", input),
  writeClipboardText: (text: string) =>
    ipcRenderer.invoke("openadminos:write-clipboard-text", text),
  openMainWindow: (route?: string) =>
    ipcRenderer.invoke("openadminos:open-main-window", route),
  runDueReadSchedules: () =>
    ipcRenderer.invoke("openadminos:run-due-read-schedules"),
  setCompanionLaunchEnabled: (enabled: boolean) =>
    ipcRenderer.invoke("openadminos:set-companion-launch-enabled", enabled),
  setSandboxedCodeEnabled: (enabled: boolean) =>
    ipcRenderer.invoke("openadminos:set-sandboxed-code-enabled", enabled),
  setSchedulerLaunchEnabled: (enabled: boolean) =>
    ipcRenderer.invoke("openadminos:set-scheduler-launch-enabled", enabled),
  listAgents: () => ipcRenderer.invoke("openadminos:list-agents"),
  listInstalledAgents: () => ipcRenderer.invoke("openadminos:list-agents"),
  listRegistryAgents: () =>
    ipcRenderer.invoke("openadminos:list-registry-agents"),
  refreshRegistry: () => ipcRenderer.invoke("openadminos:refresh-registry"),
  setRegistrySource: (url: string, options?: { confirmExternalSource?: boolean }) =>
    ipcRenderer.invoke("openadminos:set-registry-source", url, options),
  setRegistryInstallCountsEnabled: (enabled: boolean) =>
    ipcRenderer.invoke("openadminos:set-registry-install-counts-enabled", enabled),
  listProviders: () => ipcRenderer.invoke("openadminos:list-providers"),
  testProvider: (providerId: ProviderId, model?: string) =>
    ipcRenderer.invoke("openadminos:test-provider", providerId, model),
  listIntuneChatConversations: () =>
    ipcRenderer.invoke("openadminos:list-intune-chat-conversations"),
  searchIntuneChatConversations: (query: string) =>
    ipcRenderer.invoke("openadminos:search-intune-chat-conversations", query),
  renameIntuneChatConversation: (conversationId: string, title: string) =>
    ipcRenderer.invoke(
      "openadminos:rename-intune-chat-conversation",
      conversationId,
      title,
    ),
  setIntuneChatConversationPinned: (conversationId: string, pinned: boolean) =>
    ipcRenderer.invoke(
      "openadminos:set-intune-chat-conversation-pinned",
      conversationId,
      pinned,
    ),
  deleteIntuneChatConversation: (conversationId: string) =>
    ipcRenderer.invoke("openadminos:delete-intune-chat-conversation", conversationId),
  getIntuneChatMessages: (conversationId: string) =>
    ipcRenderer.invoke("openadminos:get-intune-chat-messages", conversationId),
  sendIntuneChatMessage: (input) =>
    ipcRenderer.invoke("openadminos:send-intune-chat-message", input),
  streamIntuneChatMessage: (input, onEvent) => {
    const streamId = crypto.randomUUID();
    let cleanedUp = false;
    let terminalEventSeen = false;
    activeIntuneChatStreamIds.add(streamId);
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      activeIntuneChatStreamIds.delete(streamId);
      ipcRenderer.removeListener("openadminos:intune-chat-stream-event", handler);
    };
    const handler = (
      _event: unknown,
      payload: { streamId: string; event: IntuneChatStreamEvent },
    ) => {
      if (payload.streamId === streamId) {
        onEvent(payload.event);
        if (
          payload.event.type === "completed" ||
          payload.event.type === "failed" ||
          payload.event.type === "cancelled"
        ) {
          terminalEventSeen = true;
          window.setTimeout(cleanup, 0);
        }
      }
    };
    ipcRenderer.on("openadminos:intune-chat-stream-event", handler);
    return ipcRenderer
      .invoke("openadminos:stream-intune-chat-message", streamId, input)
      .finally(() => {
        if (!terminalEventSeen) {
          window.setTimeout(cleanup, 1000);
        }
      });
  },
  cancelIntuneChatStream: async () => {
    const streamIds = [...activeIntuneChatStreamIds];
    await Promise.all(
      streamIds.map((streamId) =>
        ipcRenderer.invoke("openadminos:cancel-intune-chat-stream", streamId),
      ),
    );
  },
  listTenantGroups: () => ipcRenderer.invoke("openadminos:list-tenant-groups"),
  saveTenantGroup: (input) =>
    ipcRenderer.invoke("openadminos:save-tenant-group", input),
  deleteTenantGroup: (id: string) =>
    ipcRenderer.invoke("openadminos:delete-tenant-group", id),
  listSavedMultiTenantQueries: () =>
    ipcRenderer.invoke("openadminos:list-saved-multi-tenant-queries"),
  preflightMultiTenantIntuneChat: (input) =>
    ipcRenderer.invoke("openadminos:preflight-multi-tenant-intune-chat", input),
  runMultiTenantIntuneChat: (input) =>
    ipcRenderer.invoke("openadminos:run-multi-tenant-intune-chat", input),
  streamMultiTenantIntuneChat: (input, onEvent) => {
    const streamId = crypto.randomUUID();
    let cleanedUp = false;
    let terminalEventSeen = false;
    activeMultiTenantChatStreamIds.add(streamId);
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      activeMultiTenantChatStreamIds.delete(streamId);
      ipcRenderer.removeListener(
        "openadminos:multi-tenant-chat-stream-event",
        handler,
      );
    };
    const handler = (
      _event: unknown,
      payload: { streamId: string; event: MultiTenantChatStreamEvent },
    ) => {
      if (payload.streamId === streamId) {
        onEvent(payload.event);
        if (
          payload.event.type === "completed" ||
          payload.event.type === "failed" ||
          payload.event.type === "cancelled"
        ) {
          terminalEventSeen = true;
          window.setTimeout(cleanup, 0);
        }
      }
    };
    ipcRenderer.on("openadminos:multi-tenant-chat-stream-event", handler);
    return ipcRenderer
      .invoke("openadminos:stream-multi-tenant-intune-chat", streamId, input)
      .finally(() => {
        if (!terminalEventSeen) {
          window.setTimeout(cleanup, 1000);
        }
      });
  },
  cancelMultiTenantIntuneChatStream: async () => {
    const streamIds = [...activeMultiTenantChatStreamIds];
    await Promise.all(
      streamIds.map((streamId) =>
        ipcRenderer.invoke(
          "openadminos:cancel-multi-tenant-intune-chat-stream",
          streamId,
        ),
      ),
    );
  },
  listMultiTenantChatJobs: () =>
    ipcRenderer.invoke("openadminos:list-multi-tenant-chat-jobs"),
  getMultiTenantChatJob: (id: string) =>
    ipcRenderer.invoke("openadminos:get-multi-tenant-chat-job", id),
  queueMultiTenantAgentBatch: (input) =>
    ipcRenderer.invoke("openadminos:queue-multi-tenant-agent-batch", input),
  listMultiTenantAgentBatches: () =>
    ipcRenderer.invoke("openadminos:list-multi-tenant-agent-batches"),
  getMultiTenantAgentBatch: (id: string) =>
    ipcRenderer.invoke("openadminos:get-multi-tenant-agent-batch", id),
  refreshGraphCache: (options) =>
    ipcRenderer.invoke("openadminos:refresh-graph-cache", options),
  getGraphCacheStatus: (tenantId?: string) =>
    ipcRenderer.invoke("openadminos:get-graph-cache-status", tenantId),
  getGraphCacheRefreshSchedule: (tenantId?: string) =>
    ipcRenderer.invoke("openadminos:get-graph-cache-refresh-schedule", tenantId),
  setGraphCacheRefreshSchedule: (input) =>
    ipcRenderer.invoke("openadminos:set-graph-cache-refresh-schedule", input),
  getLocalDataSummary: (tenantId?: string) =>
    ipcRenderer.invoke("openadminos:get-local-data-summary", tenantId),
  clearIntuneChatHistory: () =>
    ipcRenderer.invoke("openadminos:clear-intune-chat-history"),
  clearGraphCache: (tenantId?: string) =>
    ipcRenderer.invoke("openadminos:clear-graph-cache", tenantId),
  getSelfTrainingSettings: () =>
    ipcRenderer.invoke("openadminos:get-self-training-settings"),
  setSelfTrainingEnabled: (enabled: boolean) =>
    ipcRenderer.invoke("openadminos:set-self-training-enabled", enabled),
  listSelfTrainingSuggestions: (status) =>
    ipcRenderer.invoke("openadminos:list-self-training-suggestions", status),
  approveSelfTrainingSuggestion: (id: string) =>
    ipcRenderer.invoke("openadminos:approve-self-training-suggestion", id),
  rejectSelfTrainingSuggestion: (id: string) =>
    ipcRenderer.invoke("openadminos:reject-self-training-suggestion", id),
  resetSelfTrainingSuggestions: (input) =>
    ipcRenderer.invoke("openadminos:reset-self-training-suggestions", input),
  listWorkspaces: (tenantId?: string) =>
    ipcRenderer.invoke("openadminos:list-workspaces", tenantId),
  getWorkspace: (id: string) => ipcRenderer.invoke("openadminos:get-workspace", id),
  createWorkspace: (input) =>
    ipcRenderer.invoke("openadminos:create-workspace", input),
  updateWorkspace: (id, input) =>
    ipcRenderer.invoke("openadminos:update-workspace", id, input),
  archiveWorkspace: (id: string) =>
    ipcRenderer.invoke("openadminos:archive-workspace", id),
  deleteWorkspace: (id: string) =>
    ipcRenderer.invoke("openadminos:delete-workspace", id),
  addWorkspaceNote: (workspaceId: string, content: string) =>
    ipcRenderer.invoke("openadminos:add-workspace-note", workspaceId, content),
  updateWorkspaceNote: (noteId: string, content: string) =>
    ipcRenderer.invoke("openadminos:update-workspace-note", noteId, content),
  pinWorkspaceEvidence: (input) =>
    ipcRenderer.invoke("openadminos:pin-workspace-evidence", input),
  linkWorkspaceConversation: (workspaceId: string, conversationId: string) =>
    ipcRenderer.invoke(
      "openadminos:link-workspace-conversation",
      workspaceId,
      conversationId,
    ),
  linkWorkspaceRun: (workspaceId: string, runId: string) =>
    ipcRenderer.invoke("openadminos:link-workspace-run", workspaceId, runId),
  importMultiTenantResultToWorkspaces: (input) =>
    ipcRenderer.invoke("openadminos:import-multi-tenant-result-to-workspaces", input),
  exportWorkspaceDossier: (id: string) =>
    ipcRenderer.invoke("openadminos:export-workspace-dossier", id),
  listConnectors: () => ipcRenderer.invoke("openadminos:list-connectors"),
  testConnector: (id: string) =>
    ipcRenderer.invoke("openadminos:test-connector", id),
  setConnectorConfig: (id: string, config: Record<string, unknown>) =>
    ipcRenderer.invoke("openadminos:set-connector-config", id, config),
  setConnectorSecret: (id: string, key: string, value: string | null) =>
    ipcRenderer.invoke("openadminos:set-connector-secret", id, key, value),
  listConnectorTeams: (id: string) =>
    ipcRenderer.invoke("openadminos:list-connector-teams", id),
  listConnectorChannels: (id: string, teamId: string) =>
    ipcRenderer.invoke("openadminos:list-connector-channels", id, teamId),
  getWhatsAppWebStatus: () =>
    ipcRenderer.invoke("openadminos:get-whatsapp-web-status"),
  startWhatsAppWebLogin: () =>
    ipcRenderer.invoke("openadminos:start-whatsapp-web-login"),
  disconnectWhatsAppWeb: () =>
    ipcRenderer.invoke("openadminos:disconnect-whatsapp-web"),
  listWhatsAppWebGroups: () =>
    ipcRenderer.invoke("openadminos:list-whatsapp-web-groups"),
  sendWhatsAppWebTestMessage: (to: string) =>
    ipcRenderer.invoke("openadminos:send-whatsapp-web-test-message", to),
  onConnectorConfirmRequest: (
    listener: (request: PendingConnectorConfirmation) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: PendingConnectorConfirmation) =>
      listener(payload);
    ipcRenderer.on("openadminos:connector-confirm-request", handler);
    return () => {
      ipcRenderer.removeListener(
        "openadminos:connector-confirm-request",
        handler,
      );
    };
  },
  onRegistryRefreshed: (
    listener: (info: { trigger: "startup" | "interval" | "focus"; cachedAt: string | null }) => void,
  ): (() => void) => {
    const handler = (
      _event: unknown,
      payload: { trigger: "startup" | "interval" | "focus"; cachedAt: string | null },
    ) => listener(payload);
    ipcRenderer.on("openadminos:registry-refreshed", handler);
    return () => {
      ipcRenderer.removeListener("openadminos:registry-refreshed", handler);
    };
  },
  onAppStateChanged: (
    listener: (info: { reason: string; runId?: string }) => void,
  ): (() => void) => {
    const handler = (
      _event: unknown,
      payload: { reason: string; runId?: string },
    ) => listener(payload);
    ipcRenderer.on("openadminos:app-state-changed", handler);
    return () => {
      ipcRenderer.removeListener("openadminos:app-state-changed", handler);
    };
  },
  respondToConnectorConfirm: (
    requestId: string,
    decision: PendingConnectorDecision,
  ) =>
    ipcRenderer.invoke(
      "openadminos:respond-to-connector-confirm",
      requestId,
      decision,
    ),
  installAgent: (agentId: string) =>
    ipcRenderer.invoke("openadminos:install-agent", agentId),
  uninstallAgent: (slug: string) =>
    ipcRenderer.invoke("openadminos:uninstall-agent", slug),
  getAgentUpdateReview: (slug: string) =>
    ipcRenderer.invoke("openadminos:get-agent-update-review", slug),
  updateAgent: (slug: string, options?: { confirmTrustChanges?: boolean }) =>
    ipcRenderer.invoke("openadminos:update-agent", slug, options),
  setActiveProvider: (id: ProviderId) =>
    ipcRenderer.invoke("openadminos:set-active-provider", id),
  setActiveModel: (providerId: ProviderId, model: string | null) =>
    ipcRenderer.invoke("openadminos:set-active-model", providerId, model),
  startRun: (agentSlug: string, options?: StartRunOptions) =>
    ipcRenderer.invoke("openadminos:start-run", agentSlug, options),
  getRun: (id: string) => ipcRenderer.invoke("openadminos:get-run", id),
  confirmRun: (runId: string, phrase: string) =>
    ipcRenderer.invoke("openadminos:confirm-run", runId, phrase),
  rejectRun: (runId: string) => ipcRenderer.invoke("openadminos:reject-run", runId),
  cancelRun: (runId: string) => ipcRenderer.invoke("openadminos:cancel-run", runId),
  listTenants: () => ipcRenderer.invoke("openadminos:list-tenants"),
  getRequestedScopes: () =>
    ipcRenderer.invoke("openadminos:get-requested-scopes"),
  connectTenant: () => ipcRenderer.invoke("openadminos:connect-tenant"),
  setActiveTenant: (id: string) =>
    ipcRenderer.invoke("openadminos:set-active-tenant", id),
  disconnectTenant: (id: string) =>
    ipcRenderer.invoke("openadminos:disconnect-tenant", id),
  getAgentManifest: (slug: string) =>
    ipcRenderer.invoke("openadminos:get-agent-manifest", slug),
  updateAgentSettings: (slug: string, values: Record<string, unknown>) =>
    ipcRenderer.invoke("openadminos:update-agent-settings", slug, values),
  updateAgentSchedule: (slug, schedule) =>
    ipcRenderer.invoke("openadminos:update-agent-schedule", slug, schedule),
  updateAgentTeamsDelivery: (slug, delivery) =>
    ipcRenderer.invoke("openadminos:update-agent-teams-delivery", slug, delivery),
  updateAgentWhatsAppWebDelivery: (slug, delivery) =>
    ipcRenderer.invoke(
      "openadminos:update-agent-whatsapp-web-delivery",
      slug,
      delivery,
    ),
  updateAgentOutlookDelivery: (slug, delivery) =>
    ipcRenderer.invoke("openadminos:update-agent-outlook-delivery", slug, delivery),
  updateAgentSlackDelivery: (slug, delivery) =>
    ipcRenderer.invoke("openadminos:update-agent-slack-delivery", slug, delivery),
  updateAgentDiscordDelivery: (slug, delivery) =>
    ipcRenderer.invoke("openadminos:update-agent-discord-delivery", slug, delivery),
  updateAgentSignalDelivery: (slug, delivery) =>
    ipcRenderer.invoke("openadminos:update-agent-signal-delivery", slug, delivery),
  draftAgentManifest: (prompt: string) =>
    ipcRenderer.invoke("openadminos:draft-agent-manifest", prompt),
  validateAgentDraft: (yamlSource: string, allowedSlug?: string) =>
    ipcRenderer.invoke("openadminos:validate-agent-draft", yamlSource, allowedSlug),
  preflightAgentDraft: (yamlSource: string, allowedSlug?: string) =>
    ipcRenderer.invoke("openadminos:preflight-agent-draft", yamlSource, allowedSlug),
  saveAgentDraft: (yamlSource: string) =>
    ipcRenderer.invoke("openadminos:save-agent-draft", yamlSource),
  updateUserAgentDraft: (slug: string, yamlSource: string) =>
    ipcRenderer.invoke("openadminos:update-user-agent-draft", slug, yamlSource),
  exportAgentDraftBundle: (yamlSource: string) =>
    ipcRenderer.invoke("openadminos:export-agent-draft-bundle", yamlSource),
  prepareAgentCommunitySubmission: (
    yamlSource: string,
    metadata: AgentCommunitySubmissionMetadata,
    allowedSlug?: string,
  ) =>
    ipcRenderer.invoke(
      "openadminos:prepare-agent-community-submission",
      yamlSource,
      metadata,
      allowedSlug,
    ),
  submitAgentCommunitySubmission: (
    yamlSource: string,
    metadata: AgentCommunitySubmissionMetadata,
    allowedSlug?: string,
  ) =>
    ipcRenderer.invoke(
      "openadminos:submit-agent-community-submission",
      yamlSource,
      metadata,
      allowedSlug,
    ),
  openExternal: (url: string) =>
    ipcRenderer.invoke("openadminos:open-external", url),
  saveTextFile: (args: SaveTextFileArgs) =>
    ipcRenderer.invoke("openadminos:save-text-file", args),
  getUpdateState: () => ipcRenderer.invoke("openadminos:get-update-state"),
  applyUpdateNow: () => ipcRenderer.invoke("openadminos:apply-update-now"),
  onUpdateStateChanged: (listener: (state: UpdateState) => void) => {
    const wrapped = (_event: unknown, state: UpdateState) => listener(state);
    ipcRenderer.on("openadminos:update-state", wrapped);
    return () => ipcRenderer.off("openadminos:update-state", wrapped);
  },
  onFocusRun: (listener: (runId: string) => void) => {
    const wrapped = (_event: unknown, runId: string) => listener(runId);
    ipcRenderer.on("openadminos:focus-run", wrapped);
    return () => ipcRenderer.off("openadminos:focus-run", wrapped);
  },
  onNavigate: (listener: (path: string) => void) => {
    const wrapped = (_event: unknown, path: string) => listener(path);
    ipcRenderer.on("openadminos:navigate", wrapped);
    return () => ipcRenderer.off("openadminos:navigate", wrapped);
  },
};

contextBridge.exposeInMainWorld("openAdminOS", api);
