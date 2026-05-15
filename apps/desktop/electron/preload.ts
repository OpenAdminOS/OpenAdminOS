import { contextBridge, ipcRenderer } from "electron";
import type {
  OpenAgentsApi,
  ProviderId,
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
  setActiveProvider: (id: ProviderId) =>
    ipcRenderer.invoke("openagents:set-active-provider", id),
  startRun: (agentSlug: string) =>
    ipcRenderer.invoke("openagents:start-run", agentSlug),
  getRun: (id: string) => ipcRenderer.invoke("openagents:get-run", id),
  confirmRun: (runId: string, phrase: string) =>
    ipcRenderer.invoke("openagents:confirm-run", runId, phrase),
  rejectRun: (runId: string) => ipcRenderer.invoke("openagents:reject-run", runId),
};

contextBridge.exposeInMainWorld("openAgents", api);
