import { contextBridge, ipcRenderer } from "electron";
import type {
  OpenAgentsApi,
  ProviderId,
  SaveTextFileArgs,
  StartRunOptions,
  UpdateState,
} from "@openagents/agent-sdk";

const api: OpenAgentsApi = {
  getAppState: () => ipcRenderer.invoke("openagents:get-app-state"),
  listAgents: () => ipcRenderer.invoke("openagents:list-agents"),
  listInstalledAgents: () => ipcRenderer.invoke("openagents:list-agents"),
  listRegistryAgents: () =>
    ipcRenderer.invoke("openagents:list-registry-agents"),
  listProviders: () => ipcRenderer.invoke("openagents:list-providers"),
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
  connectTenant: () => ipcRenderer.invoke("openagents:connect-tenant"),
  setActiveTenant: (id: string) =>
    ipcRenderer.invoke("openagents:set-active-tenant", id),
  disconnectTenant: (id: string) =>
    ipcRenderer.invoke("openagents:disconnect-tenant", id),
  setRealWritesEnabled: (enabled: boolean) =>
    ipcRenderer.invoke("openagents:set-real-writes-enabled", enabled),
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
