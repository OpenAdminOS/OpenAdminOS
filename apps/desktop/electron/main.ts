import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import { writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { AppStateStore } from "./state.js";
import { EncryptedSecretStore } from "./secret-store.js";
import {
  applyUpdateNow,
  getUpdateState,
  startAutoUpdater,
  subscribeToUpdateState,
} from "./updates.js";
import {
  attachWindowStatePersistence,
  loadWindowState,
} from "./window-state.js";
import type { ProviderId, SaveTextFileArgs } from "@openagents/agent-sdk";

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

function navigate(path: string): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  mainWindow.webContents.send("openagents:navigate", path);
}

function buildAppMenu(): Menu {
  const isMac = process.platform === "darwin";

  const appMenu: MenuItemConstructorOptions = isMac
    ? {
        label: "Open Agents",
        submenu: [
          { role: "about" },
          { type: "separator" },
          {
            label: "Settings…",
            accelerator: "Cmd+,",
            click: () => navigate("/settings"),
          },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      }
    : { label: "File", submenu: [{ role: "quit" }] };

  const editMenu: MenuItemConstructorOptions = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      {
        label: "Agents",
        accelerator: "CmdOrCtrl+1",
        click: () => navigate("/"),
      },
      {
        label: "Agent Hub",
        accelerator: "CmdOrCtrl+2",
        click: () => navigate("/hub"),
      },
      {
        label: "Activity",
        accelerator: "CmdOrCtrl+3",
        click: () => navigate("/activity"),
      },
      {
        label: "Settings",
        accelerator: "CmdOrCtrl+,",
        click: () => navigate("/settings"),
      },
      { type: "separator" },
      { role: "reload" },
      { role: "togglefullscreen" },
      ...(app.isPackaged
        ? []
        : ([{ role: "toggleDevTools" }] as MenuItemConstructorOptions[])),
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      ...(isMac
        ? ([
            { type: "separator" },
            { role: "front" },
          ] as MenuItemConstructorOptions[])
        : ([{ role: "close" }] as MenuItemConstructorOptions[])),
    ],
  };

  const helpMenu: MenuItemConstructorOptions = {
    role: "help",
    submenu: [
      {
        label: "Open Agents on GitHub",
        click: () => {
          void shell.openExternal("https://github.com/ugurkocde/OpenAgents");
        },
      },
      {
        label: "Report an issue",
        click: () => {
          void shell.openExternal(
            "https://github.com/ugurkocde/OpenAgents/issues/new",
          );
        },
      },
      { type: "separator" },
      {
        label: "Open app data folder",
        click: () => {
          void shell.openPath(app.getPath("userData"));
        },
      },
      {
        label: "Open logs folder",
        click: () => {
          void shell.openPath(app.getPath("logs"));
        },
      },
    ],
  };

  return Menu.buildFromTemplate([appMenu, editMenu, viewMenu, windowMenu, helpMenu]);
}

async function createWindow() {
  const persisted = await loadWindowState();
  mainWindow = new BrowserWindow({
    ...(typeof persisted.x === "number" ? { x: persisted.x } : {}),
    ...(typeof persisted.y === "number" ? { y: persisted.y } : {}),
    width: persisted.width,
    height: persisted.height,
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

  attachWindowStatePersistence(mainWindow);

  if (persisted.maximized) {
    mainWindow.maximize();
  }
  if (persisted.fullscreen) {
    mainWindow.setFullScreen(true);
  }

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
  ipcMain.handle("openagents:uninstall-agent", (_event, slug: string) =>
    store.uninstallAgent(slug),
  );
  ipcMain.handle("openagents:set-active-provider", (_event, id: ProviderId) =>
    store.setActiveProvider(id),
  );
  ipcMain.handle(
    "openagents:set-active-model",
    (_event, providerId: ProviderId, model: string | null) =>
      store.setActiveModel(providerId, model),
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
  ipcMain.handle("openagents:cancel-run", (_event, runId: string) =>
    store.cancelRun(runId),
  );
  ipcMain.handle("openagents:list-tenants", () => store.listTenants());
  ipcMain.handle("openagents:connect-tenant", () => store.connectTenant());
  ipcMain.handle("openagents:set-active-tenant", (_event, id: string) =>
    store.setActiveTenant(id),
  );
  ipcMain.handle("openagents:disconnect-tenant", (_event, id: string) =>
    store.disconnectTenant(id),
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
    "openagents:update-agent-schedule",
    (_event, slug: string, schedule) => store.updateAgentSchedule(slug, schedule),
  );
  ipcMain.handle(
    "openagents:draft-agent-manifest",
    (_event, prompt: string) => store.draftAgentManifest(prompt),
  );
  ipcMain.handle(
    "openagents:save-agent-draft",
    (_event, yamlSource: string) => store.saveAgentDraft(yamlSource),
  );
  ipcMain.handle("openagents:open-external", (_event, url: string) => {
    openExternalUrl(url);
  });
  ipcMain.handle("openagents:get-update-state", () => getUpdateState());
  ipcMain.handle("openagents:apply-update-now", () => applyUpdateNow());
  subscribeToUpdateState((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("openagents:update-state", state);
    }
  });
  ipcMain.handle(
    "openagents:save-text-file",
    async (_event, args: SaveTextFileArgs) => {
      const parent = mainWindow ?? undefined;
      const result = parent
        ? await dialog.showSaveDialog(parent, {
            defaultPath: args.suggestedName,
            filters: args.filters,
          })
        : await dialog.showSaveDialog({
            defaultPath: args.suggestedName,
            filters: args.filters,
          });
      if (result.canceled || !result.filePath) {
        return { canceled: true };
      }
      await writeFile(result.filePath, args.content, "utf8");
      return { canceled: false, filePath: result.filePath };
    },
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
      // Only packaged production builds report installs to the public
      // stats aggregator. Dev/CLI builds default to the empty string,
      // which disables the POST entirely.
      statsApiUrl: app.isPackaged
        ? process.env.OPENAGENTS_STATS_API ?? undefined
        : process.env.OPENAGENTS_STATS_API ?? "",
      appVersion: app.getVersion(),
      openBrowser: async (url: string) => {
        await shell.openExternal(url);
      },
      onRunFinished: (run) => {
        if (!Notification.isSupported()) return;
        // Skip notifications if the user is already focused on the
        // app — they will see the result without being interrupted.
        if (mainWindow && mainWindow.isFocused()) return;
        const title =
          run.status === "completed"
            ? "Agent run completed"
            : run.status === "failed"
              ? "Agent run failed"
              : run.status === "cancelled"
                ? "Agent run cancelled"
                : "Agent run rejected";
        const notification = new Notification({
          title,
          body: run.summary ?? `${run.agentSlug} · ${run.status}`,
          silent: false,
        });
        notification.on("click", () => {
          if (!mainWindow) return;
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.focus();
          mainWindow.webContents.send("openagents:focus-run", run.id);
        });
        notification.show();
      },
    });
    registerIpcHandlers();
    Menu.setApplicationMenu(buildAppMenu());
    void createWindow();
    startAutoUpdater(() => mainWindow ?? undefined);

    // In-process agent scheduler: ticks every 60s, fires any installed
    // agent whose schedule is enabled + due. Honest by design — runs
    // only fire while the user has the app open.
    const SCHEDULER_TICK_MS = 60_000;
    setInterval(() => {
      void store.fireDueSchedules();
    }, SCHEDULER_TICK_MS);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
      }
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
