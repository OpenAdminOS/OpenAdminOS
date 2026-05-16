import { app, BrowserWindow, ipcMain, shell } from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { AppStateStore } from "./state.js";
import { EncryptedSecretStore } from "./secret-store.js";
import { startAutoUpdater } from "./updates.js";
import type { ProviderId } from "@openagents/agent-sdk";

// Set the app name BEFORE anything else that could touch the macOS
// Keychain. Electron's safeStorage uses `app.getName()` to construct
// the Keychain service name ("<name> Safe Storage"). In a signed
// production build that name comes from CFBundleName ("Open Agents")
// via Info.plist, but in dev (`npm run dev`, unpackaged Electron) it
// falls back to package.json's `name` field — which is the npm
// package id "@openagents/desktop" and ends up as the user-visible
// string in Keychain prompts. Pinning it explicitly here keeps the
// two paths consistent and gives users a single "Open Agents Safe
// Storage" entry regardless of how they're running the app.
app.setName("Open Agents");

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? "http://localhost:5173";
const allowedExternalProtocols = new Set(["http:", "https:", "mailto:"]);

let mainWindow: BrowserWindow | null = null;
let store: AppStateStore;

function openExternalUrl(url: string): void {
  try {
    const parsed = new URL(url);

    if (allowedExternalProtocols.has(parsed.protocol)) {
      void shell.openExternal(parsed.toString());
    }
  } catch {
    // Ignore malformed navigation targets from untrusted renderer input.
  }
}

function isAllowedAppNavigation(url: string): boolean {
  try {
    const parsed = new URL(url);

    if (app.isPackaged) {
      const rendererDistUrl = pathToFileURL(
        join(app.getAppPath(), "dist"),
      ).toString();
      const rendererBaseUrl = rendererDistUrl.endsWith("/")
        ? rendererDistUrl
        : `${rendererDistUrl}/`;

      return parsed.protocol === "file:" && parsed.toString().startsWith(rendererBaseUrl);
    }

    return parsed.origin === new URL(devServerUrl).origin;
  } catch {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 680,
    title: "Open Agents",
    backgroundColor: "#0a0c10",
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(currentDir, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isAllowedAppNavigation(url)) {
      return;
    }

    event.preventDefault();
    openExternalUrl(url);
  });

  if (app.isPackaged) {
    void mainWindow.loadFile(join(app.getAppPath(), "dist/index.html"));
  } else {
    void mainWindow.loadURL(devServerUrl);
  }
}

function registerIpcHandlers() {
  ipcMain.handle("openagents:get-app-state", () => store.getAppState());
  ipcMain.handle("openagents:list-agents", () => store.listAgents());
  ipcMain.handle("openagents:list-registry-agents", () =>
    store.listRegistryAgents(),
  );
  ipcMain.handle("openagents:list-providers", () => store.listProviders());
  ipcMain.handle("openagents:install-agent", (_event, agentId: string) =>
    store.installAgent(agentId),
  );
  ipcMain.handle("openagents:set-active-provider", (_event, id: ProviderId) =>
    store.setActiveProvider(id),
  );
  ipcMain.handle(
    "openagents:start-run",
    (_event, agentSlug: string, options?: { tenantId?: string | null }) =>
      store.startRun(agentSlug, options),
  );
  ipcMain.handle("openagents:get-run", (_event, id: string) => store.getRun(id));
  ipcMain.handle(
    "openagents:confirm-run",
    (_event, runId: string, phrase: string) => store.confirmRun(runId, phrase),
  );
  ipcMain.handle("openagents:reject-run", (_event, runId: string) =>
    store.rejectRun(runId),
  );
  ipcMain.handle("openagents:list-tenants", () => store.listTenants());
  ipcMain.handle("openagents:connect-tenant", () => store.connectTenant());
  ipcMain.handle("openagents:set-active-tenant", (_event, id: string) =>
    store.setActiveTenant(id),
  );
  ipcMain.handle("openagents:disconnect-tenant", (_event, id: string) =>
    store.disconnectTenant(id),
  );
  ipcMain.handle(
    "openagents:set-real-writes-enabled",
    (_event, enabled: boolean) => store.setRealWritesEnabled(enabled),
  );
  ipcMain.handle("openagents:get-agent-manifest", (_event, slug: string) =>
    store.getAgentManifest(slug),
  );
  ipcMain.handle(
    "openagents:update-agent-settings",
    (_event, slug: string, values: Record<string, unknown>) =>
      store.updateAgentSettings(slug, values),
  );
  ipcMain.handle(
    "openagents:draft-agent-manifest",
    (_event, prompt: string) => store.draftAgentManifest(prompt),
  );
  ipcMain.handle(
    "openagents:save-agent-draft",
    (_event, yamlSource: string) => store.saveAgentDraft(yamlSource),
  );
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) {
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    const userDataDir = app.getPath("userData");
    const tokenStore = new EncryptedSecretStore(join(userDataDir, "tokens.bin"));
    store = new AppStateStore({
      filePath: join(userDataDir, "state.json"),
      tokenStore,
      userAgentsDir: join(userDataDir, "agents"),
      openBrowser: async (url: string) => {
        await shell.openExternal(url);
      },
    });
    registerIpcHandlers();
    createWindow();
    startAutoUpdater(() => mainWindow ?? undefined);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
