import { contextBridge, ipcRenderer } from "electron";
import type {
  HostPlatform,
  OpenAgentsApi,
  PendingConnectorConfirmation,
  PendingConnectorDecision,
  ProviderId,
  SaveTextFileArgs,
  StartRunOptions,
  UpdateState,
} from "@openagents/agent-sdk";

const platform: HostPlatform =
  process.platform === "darwin"
    ? "macos"
    : process.platform === "win32"
      ? "windows"
      : process.platform === "linux"
        ? "linux"
        : "unknown";

const api: OpenAgentsApi = {
  platform,
  getAppState: () => ipcRenderer.invoke("openagents:get-app-state"),
  listAgents: () => ipcRenderer.invoke("openagents:list-agents"),
  listInstalledAgents: () => ipcRenderer.invoke("openagents:list-agents"),
  listRegistryAgents: () =>
    ipcRenderer.invoke("openagents:list-registry-agents"),
  refreshRegistry: () => ipcRenderer.invoke("openagents:refresh-registry"),
  setRegistrySource: (url: string) =>
    ipcRenderer.invoke("openagents:set-registry-source", url),
  listProviders: () => ipcRenderer.invoke("openagents:list-providers"),
  listConnectors: () => ipcRenderer.invoke("openagents:list-connectors"),
  testConnector: (id: string) =>
    ipcRenderer.invoke("openagents:test-connector", id),
  setConnectorConfig: (id: string, config: Record<string, unknown>) =>
    ipcRenderer.invoke("openagents:set-connector-config", id, config),
  listConnectorTeams: (id: string) =>
    ipcRenderer.invoke("openagents:list-connector-teams", id),
  listConnectorChannels: (id: string, teamId: string) =>
    ipcRenderer.invoke("openagents:list-connector-channels", id, teamId),
  onConnectorConfirmRequest: (
    listener: (request: PendingConnectorConfirmation) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: PendingConnectorConfirmation) =>
      listener(payload);
    ipcRenderer.on("openagents:connector-confirm-request", handler);
    return () => {
      ipcRenderer.removeListener(
        "openagents:connector-confirm-request",
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
    ipcRenderer.on("openagents:registry-refreshed", handler);
    return () => {
      ipcRenderer.removeListener("openagents:registry-refreshed", handler);
    };
  },
  respondToConnectorConfirm: (
    requestId: string,
    decision: PendingConnectorDecision,
  ) =>
    ipcRenderer.invoke(
      "openagents:respond-to-connector-confirm",
      requestId,
      decision,
    ),
  installAgent: (agentId: string) =>
    ipcRenderer.invoke("openagents:install-agent", agentId),
  uninstallAgent: (slug: string) =>
    ipcRenderer.invoke("openagents:uninstall-agent", slug),
  setActiveProvider: (id: ProviderId) =>
    ipcRenderer.invoke("openagents:set-active-provider", id),
  setActiveModel: (providerId: ProviderId, model: string | null) =>
    ipcRenderer.invoke("openagents:set-active-model", providerId, model),
  startRun: (agentSlug: string, options?: StartRunOptions) =>
    ipcRenderer.invoke("openagents:start-run", agentSlug, options),
  getRun: (id: string) => ipcRenderer.invoke("openagents:get-run", id),
  confirmRun: (runId: string, phrase: string) =>
    ipcRenderer.invoke("openagents:confirm-run", runId, phrase),
  rejectRun: (runId: string) => ipcRenderer.invoke("openagents:reject-run", runId),
  cancelRun: (runId: string) => ipcRenderer.invoke("openagents:cancel-run", runId),
  listTenants: () => ipcRenderer.invoke("openagents:list-tenants"),
  getRequestedScopes: () =>
    ipcRenderer.invoke("openagents:get-requested-scopes"),
  connectTenant: () => ipcRenderer.invoke("openagents:connect-tenant"),
  setActiveTenant: (id: string) =>
    ipcRenderer.invoke("openagents:set-active-tenant", id),
  disconnectTenant: (id: string) =>
    ipcRenderer.invoke("openagents:disconnect-tenant", id),
  getAgentManifest: (slug: string) =>
    ipcRenderer.invoke("openagents:get-agent-manifest", slug),
  updateAgentSettings: (slug: string, values: Record<string, unknown>) =>
    ipcRenderer.invoke("openagents:update-agent-settings", slug, values),
  updateAgentSchedule: (slug, schedule) =>
    ipcRenderer.invoke("openagents:update-agent-schedule", slug, schedule),
  draftAgentManifest: (prompt: string) =>
    ipcRenderer.invoke("openagents:draft-agent-manifest", prompt),
  saveAgentDraft: (yamlSource: string) =>
    ipcRenderer.invoke("openagents:save-agent-draft", yamlSource),
  openExternal: (url: string) =>
    ipcRenderer.invoke("openagents:open-external", url),
  saveTextFile: (args: SaveTextFileArgs) =>
    ipcRenderer.invoke("openagents:save-text-file", args),
  getUpdateState: () => ipcRenderer.invoke("openagents:get-update-state"),
  applyUpdateNow: () => ipcRenderer.invoke("openagents:apply-update-now"),
  onUpdateStateChanged: (listener: (state: UpdateState) => void) => {
    const wrapped = (_event: unknown, state: UpdateState) => listener(state);
    ipcRenderer.on("openagents:update-state", wrapped);
    return () => ipcRenderer.off("openagents:update-state", wrapped);
  },
  onFocusRun: (listener: (runId: string) => void) => {
    const wrapped = (_event: unknown, runId: string) => listener(runId);
    ipcRenderer.on("openagents:focus-run", wrapped);
    return () => ipcRenderer.off("openagents:focus-run", wrapped);
  },
  onNavigate: (listener: (path: string) => void) => {
    const wrapped = (_event: unknown, path: string) => listener(path);
    ipcRenderer.on("openagents:navigate", wrapped);
    return () => ipcRenderer.off("openagents:navigate", wrapped);
  },
};

contextBridge.exposeInMainWorld("openAgents", api);
