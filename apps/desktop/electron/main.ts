import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  session,
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
import type {
  PendingConnectorDecision,
  ProviderId,
  SaveTextFileArgs,
} from "@openadminos/agent-sdk";
import {
  installConnectorConfirmBridge,
  respondConnectorConfirm,
} from "./connector-confirm-bridge.js";
import { listRegisteredConnectors } from "@openadminos/runtime";

// Set the app name BEFORE anything else that could touch the macOS
// Keychain. Electron's safeStorage uses `app.getName()` to construct
// the Keychain service name ("<name> Safe Storage"). In a signed
// production build that name comes from CFBundleName ("OpenAdminOS")
// via Info.plist, but in dev (`npm run dev`, unpackaged Electron) it
// falls back to package.json's `name` field — which is the npm
// package id "@openadminos/desktop" and ends up as the user-visible
// string in Keychain prompts. Pinning it explicitly here keeps the
// two paths consistent and gives users a single "OpenAdminOS Safe
// Storage" entry regardless of how they're running the app.
app.setName("OpenAdminOS");

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? "http://localhost:5173";
const allowedExternalProtocols = new Set(["http:", "https:", "mailto:"]);

let mainWindow: BrowserWindow | null = null;
let store: AppStateStore;
// Wall-clock timestamp of the most recent background registry refresh
// attempt. Used to rate-limit focus-triggered refreshes so alt-tabbing
// doesn't hammer GitHub. Manual refreshes from Agent Hub don't update
// this — the user explicitly asked for a fresh fetch.
let lastBackgroundRefreshAt = 0;

/**
 * Drive a registry index refresh from a non-user trigger (startup,
 * 6h interval, or window focus). On a successful fetch with a newly
 * stamped timestamp, push `openadminos:registry-refreshed` to the
 * renderer so the Agent Hub state can swap in the new list without
 * the user clicking refresh. Failures are silent — the user only
 * sees an error when they manually click refresh.
 */
async function refreshRegistryInBackground(
  trigger: "startup" | "interval" | "focus",
): Promise<void> {
  lastBackgroundRefreshAt = Date.now();
  try {
    const result = await store.initRegistry();
    if (result.error || result.fromCache) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("openadminos:registry-refreshed", {
      trigger,
      cachedAt: result.cachedAt,
    });
  } catch {
    // Background refresh failures are intentionally swallowed.
  }
}

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

function installSecurityGuards(): void {
  // Deny every renderer-initiated permission request. The app has no
  // legitimate need for camera, mic, geolocation, notifications-from-web,
  // clipboard-read, etc. — anything we do need is wired through IPC.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  // Defense in depth: even though webviewTag is off and we deny new windows
  // on the main BrowserWindow, harden any webContents that does get created
  // (e.g. devtools in dev) so a hypothetical bug can't open arbitrary URLs
  // or attach a <webview>.
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url }) => {
      openExternalUrl(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (isAllowedAppNavigation(url)) return;
      event.preventDefault();
      openExternalUrl(url);
    });
  });
}

function navigate(path: string): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  mainWindow.webContents.send("openadminos:navigate", path);
}

function buildAppMenu(): Menu {
  const isMac = process.platform === "darwin";

  const appMenu: MenuItemConstructorOptions = isMac
    ? {
        label: "OpenAdminOS",
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
        label: "OpenAdminOS on GitHub",
        click: () => {
          void shell.openExternal("https://github.com/OpenAdminOS/OpenAdminOS");
        },
      },
      {
        label: "Report an issue",
        click: () => {
          void shell.openExternal(
            "https://github.com/OpenAdminOS/OpenAdminOS/issues/new",
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
    title: "OpenAdminOS",
    backgroundColor: "#0a0c10",
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(currentDir, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: !app.isPackaged,
      webviewTag: false,
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
  ipcMain.handle("openadminos:get-app-state", () => store.getAppState());
  ipcMain.handle("openadminos:list-agents", () => store.listAgents());
  ipcMain.handle("openadminos:list-registry-agents", () =>
    store.listRegistryAgents(),
  );
  ipcMain.handle("openadminos:refresh-registry", () => store.initRegistry());
  ipcMain.handle("openadminos:set-registry-source", (_event, url: string) =>
    store.setRegistrySource(url),
  );
  ipcMain.handle("openadminos:list-providers", () => store.listProviders());
  ipcMain.handle("openadminos:list-connectors", () => store.listConnectors());
  ipcMain.handle("openadminos:test-connector", (_event, id: string) =>
    store.testConnector(id),
  );
  ipcMain.handle(
    "openadminos:set-connector-config",
    (_event, id: string, config: Record<string, unknown>) =>
      store.setConnectorConfig(id, config),
  );
  ipcMain.handle(
    "openadminos:list-connector-teams",
    (_event, id: string) => store.listConnectorTeams(id),
  );
  ipcMain.handle(
    "openadminos:list-connector-channels",
    (_event, id: string, teamId: string) =>
      store.listConnectorChannels(id, teamId),
  );
  ipcMain.handle(
    "openadminos:respond-to-connector-confirm",
    (_event, requestId: string, decision: PendingConnectorDecision) => {
      respondConnectorConfirm(requestId, decision);
    },
  );
  ipcMain.handle("openadminos:install-agent", (_event, agentId: string) =>
    store.installAgent(agentId),
  );
  ipcMain.handle("openadminos:uninstall-agent", (_event, slug: string) =>
    store.uninstallAgent(slug),
  );
  ipcMain.handle("openadminos:set-active-provider", (_event, id: ProviderId) =>
    store.setActiveProvider(id),
  );
  ipcMain.handle(
    "openadminos:set-active-model",
    (_event, providerId: ProviderId, model: string | null) =>
      store.setActiveModel(providerId, model),
  );
  ipcMain.handle(
    "openadminos:start-run",
    (_event, agentSlug: string, options?: { tenantId?: string }) =>
      store.startRun(agentSlug, options),
  );
  ipcMain.handle("openadminos:get-run", (_event, id: string) => store.getRun(id));
  ipcMain.handle(
    "openadminos:confirm-run",
    (_event, runId: string, phrase: string) => store.confirmRun(runId, phrase),
  );
  ipcMain.handle("openadminos:reject-run", (_event, runId: string) =>
    store.rejectRun(runId),
  );
  ipcMain.handle("openadminos:cancel-run", (_event, runId: string) =>
    store.cancelRun(runId),
  );
  ipcMain.handle("openadminos:list-tenants", () => store.listTenants());
  ipcMain.handle("openadminos:get-requested-scopes", () =>
    store.listRequestedScopes(),
  );
  ipcMain.handle("openadminos:connect-tenant", () => store.connectTenant());
  ipcMain.handle("openadminos:set-active-tenant", (_event, id: string) =>
    store.setActiveTenant(id),
  );
  ipcMain.handle("openadminos:disconnect-tenant", (_event, id: string) =>
    store.disconnectTenant(id),
  );
  ipcMain.handle("openadminos:get-agent-manifest", (_event, slug: string) =>
    store.getAgentManifest(slug),
  );
  ipcMain.handle(
    "openadminos:update-agent-settings",
    (_event, slug: string, values: Record<string, unknown>) =>
      store.updateAgentSettings(slug, values),
  );
  ipcMain.handle(
    "openadminos:update-agent-schedule",
    (_event, slug: string, schedule) => store.updateAgentSchedule(slug, schedule),
  );
  ipcMain.handle(
    "openadminos:draft-agent-manifest",
    (_event, prompt: string) => store.draftAgentManifest(prompt),
  );
  ipcMain.handle(
    "openadminos:save-agent-draft",
    (_event, yamlSource: string) => store.saveAgentDraft(yamlSource),
  );
  ipcMain.handle("openadminos:open-external", (_event, url: string) => {
    openExternalUrl(url);
  });
  ipcMain.handle("openadminos:get-update-state", () => getUpdateState());
  ipcMain.handle("openadminos:apply-update-now", () => applyUpdateNow());
  subscribeToUpdateState((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("openadminos:update-state", state);
    }
  });
  ipcMain.handle(
    "openadminos:save-text-file",
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
    // In dev the app runs from the unsigned `electron` binary, so macOS
    // shows the default Electron logo in the dock. Override it with the
    // production icon so the dev window looks like the shipped app.
    // Packaged builds get the icon from the bundle's Info.plist and
    // don't need this.
    if (process.platform === "darwin" && !app.isPackaged && app.dock) {
      try {
        app.dock.setIcon(join(currentDir, "../../build/icon.png"));
      } catch {
        // Non-fatal — dock icon is cosmetic in dev.
      }
    }

    const userDataDir = app.getPath("userData");
    const tokenStore = new EncryptedSecretStore(join(userDataDir, "tokens.bin"));

    installConnectorConfirmBridge({
      getMainWindow: () => mainWindow,
      connectorNameLookup: (id) =>
        listRegisteredConnectors().find((d) => d.id === id)?.name ?? id,
      connectorConfigLookup: (id) => store.getConnectorConfigCached(id),
    });

    store = new AppStateStore({
      filePath: join(userDataDir, "state.json"),
      tokenStore,
      userDataPath: userDataDir,
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
          mainWindow.webContents.send("openadminos:focus-run", run.id);
        });
        notification.show();
      },
    });
    registerIpcHandlers();
    installSecurityGuards();
    Menu.setApplicationMenu(buildAppMenu());
    void createWindow();
    // Fetch registry index in the background after the window is ready.
    // Falls back to local filesystem agents until the fetch completes.
    void refreshRegistryInBackground("startup");
    // Re-probe tenant tiers + license panels for every persisted
    // tenant. Existing tenants from before the licenses panel landed
    // need this to populate; new tenants get probed at connect time.
    void store.probeAllTenants().catch(() => undefined);
    startAutoUpdater(() => mainWindow ?? undefined);

    // In-process agent scheduler: ticks every 60s, fires any installed
    // agent whose schedule is enabled + due. Honest by design — runs
    // only fire while the user has the app open.
    const SCHEDULER_TICK_MS = 60_000;
    setInterval(() => {
      void store.fireDueSchedules();
    }, SCHEDULER_TICK_MS);

    // Periodic registry refresh: every 6 hours, silently re-fetch the
    // remote index so users sitting on the app for days stay current.
    // Failures are silent — the user only sees errors when they
    // explicitly click the Refresh button in Agent Hub.
    const REGISTRY_TICK_MS = 6 * 60 * 60 * 1000;
    setInterval(() => {
      void refreshRegistryInBackground("interval");
    }, REGISTRY_TICK_MS);

    // Focus-triggered refresh: when the user re-activates the app
    // after >1h of being unfocused, pull the index in case anything
    // landed in the meantime. Cheap; bounded by the 1h gate.
    const FOCUS_REFRESH_THRESHOLD_MS = 60 * 60 * 1000;
    app.on("browser-window-focus", () => {
      const elapsed = Date.now() - lastBackgroundRefreshAt;
      if (elapsed < FOCUS_REFRESH_THRESHOLD_MS) return;
      void refreshRegistryInBackground("focus");
    });

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
