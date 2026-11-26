const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");
import type { NovaActivity, OpenAdminOSApi } from "@openadminos/agent-sdk";

type BubbleApi = Pick<OpenAdminOSApi, "platform" | "getAppState" | "getGraphCacheStatus" | "nova" | "novaWindow" | "onAppStateChanged">;
const platform = navigator.userAgent.toLowerCase();
const api: BubbleApi = {
  platform: platform.includes("mac os") ? "macos" : platform.includes("windows") ? "windows" : platform.includes("linux") ? "linux" : "unknown",
  getAppState: () => ipcRenderer.invoke("openadminos:get-app-state"),
  getGraphCacheStatus: (tenantId) => ipcRenderer.invoke("openadminos:get-graph-cache-status", tenantId),
  nova: (input, onActivity) => {
    if (!onActivity || input.action !== "answer") return ipcRenderer.invoke("openadminos:nova", input);
    const streamId = crypto.randomUUID();
    const handler = (_event: unknown, payload: { streamId: string; activity: NovaActivity }) => {
      if (payload.streamId === streamId) onActivity(payload.activity);
    };
    ipcRenderer.on("openadminos:nova-activity", handler);
    return ipcRenderer.invoke("openadminos:nova", input, streamId)
      .finally(() => ipcRenderer.removeListener("openadminos:nova-activity", handler));
  },
  novaWindow: (action, payload) => ipcRenderer.invoke("openadminos:nova-window", action, payload),
  onAppStateChanged: (listener) => {
    const handler = (_event: unknown, payload: { reason: string; runId?: string }) => listener(payload);
    ipcRenderer.on("openadminos:app-state-changed", handler);
    return () => ipcRenderer.removeListener("openadminos:app-state-changed", handler);
  },
};
contextBridge.exposeInMainWorld("openAdminOS", api);
