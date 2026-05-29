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
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { AppStateStore } from "./state.js";
import { SafeStorageTokenCacheStore } from "./secret-store.js";
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
  ReleaseDiagnostics,
  RunRecord,
  SaveTextFileArgs,
  SchedulerLaunchSettings,
  StartRunOptions,
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
// Do not let Chromium initialize macOS Keychain for the default
// Electron profile. We don't store passwords/cookies in the renderer,
// and the prompt wording ("Electron wants to use your confidential
// information...") is unacceptable as a first-run trust signal.
if (process.platform === "darwin" && !app.isPackaged) {
  app.commandLine.appendSwitch("use-mock-keychain");
}

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? "http://localhost:5173";
const allowedExternalProtocols = new Set(["http:", "https:", "mailto:"]);
const BACKGROUND_SCHEDULER_ARG = "--background-scheduler";
const isBackgroundSchedulerLaunch = process.argv.includes(BACKGROUND_SCHEDULER_ARG);
const MACOS_SCHEDULER_LABEL = "com.openadminos.scheduler";
const WINDOWS_SCHEDULER_TASK = "OpenAdminOS Scheduler";

let mainWindow: BrowserWindow | null = null;
let store: AppStateStore;
const activeNotifications = new Set<Notification>();
// Wall-clock timestamp of the most recent background registry refresh
// attempt. Used to rate-limit focus-triggered refreshes so alt-tabbing
// doesn't hammer GitHub. Manual refreshes from Agent Hub don't update
// this — the user explicitly asked for a fresh fetch.
let lastBackgroundRefreshAt = 0;

function schedulerProgramArguments(): string[] {
  if (app.isPackaged) {
    return [process.execPath, BACKGROUND_SCHEDULER_ARG];
  }

  // In dev, the executable is Electron itself, so the app path must be
  // passed explicitly before our scheduler arg.
  return [process.execPath, app.getAppPath(), BACKGROUND_SCHEDULER_ARG];
}

function escapePlistValue(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function macosSchedulerPlistPath(): string {
  return join(app.getPath("home"), "Library", "LaunchAgents", `${MACOS_SCHEDULER_LABEL}.plist`);
}

function writeMacosLaunchAgent(): void {
  const plistPath = macosSchedulerPlistPath();
  const logDir = join(app.getPath("userData"), "logs");
  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(logDir, { recursive: true });

  const programArguments = schedulerProgramArguments()
    .map((arg) => `    <string>${escapePlistValue(arg)}</string>`)
    .join("\n");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MACOS_SCHEDULER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>${escapePlistValue(join(logDir, "scheduler.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlistValue(join(logDir, "scheduler.error.log"))}</string>
</dict>
</plist>
`;

  writeFileSync(plistPath, plist, { encoding: "utf8", mode: 0o644 });
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const domain = uid === undefined ? "gui" : `gui/${uid}`;
  try {
    execFileSync("launchctl", ["bootout", domain, plistPath], { stdio: "ignore" });
  } catch {
    // The agent may not be loaded yet.
  }
  execFileSync("launchctl", ["bootstrap", domain, plistPath], { stdio: "ignore" });
  execFileSync("launchctl", ["enable", `${domain}/${MACOS_SCHEDULER_LABEL}`], {
    stdio: "ignore",
  });
}

function removeMacosLaunchAgent(): void {
  const plistPath = macosSchedulerPlistPath();
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const domain = uid === undefined ? "gui" : `gui/${uid}`;
  try {
    execFileSync("launchctl", ["bootout", domain, plistPath], { stdio: "ignore" });
  } catch {
    // Already unloaded.
  }
  rmSync(plistPath, { force: true });
}

function isWindowsSchedulerTaskRegistered(): boolean {
  try {
    execFileSync("schtasks.exe", ["/Query", "/TN", WINDOWS_SCHEDULER_TASK], {
      stdio: "ignore",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function registerWindowsSchedulerTask(): void {
  const [command, ...args] = schedulerProgramArguments();
  const taskRun = [`"${command}"`, ...args.map((arg) => `"${arg}"`)].join(" ");
  execFileSync(
    "schtasks.exe",
    [
      "/Create",
      "/F",
      "/SC",
      "MINUTE",
      "/MO",
      "1",
      "/TN",
      WINDOWS_SCHEDULER_TASK,
      "/TR",
      taskRun,
    ],
    { stdio: "ignore", windowsHide: true },
  );
}

function removeWindowsSchedulerTask(): void {
  try {
    execFileSync("schtasks.exe", ["/Delete", "/F", "/TN", WINDOWS_SCHEDULER_TASK], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    // Already removed.
  }
}

async function getSchedulerLaunchSettings(): Promise<SchedulerLaunchSettings> {
  if (process.platform === "linux") {
    return {
      supported: false,
      enabled: false,
      detail: "Linux OS scheduler registration is not wired yet.",
    };
  }

  try {
    const hasTenant = store ? await store.hasConnectedTenant() : false;
    const status = store ? await store.getSchedulerStatus() : undefined;
    const enabled =
      process.platform === "darwin"
        ? existsSync(macosSchedulerPlistPath())
        : isWindowsSchedulerTaskRegistered();
    return {
      supported: true,
      enabled,
      detail:
        process.platform === "win32"
          ? "Uses Windows Task Scheduler to run due agents while you are signed in to Windows."
          : "Uses a per-user macOS LaunchAgent to run due agents while you are signed in to macOS.",
      requiresTenant: !hasTenant,
      activeScheduleCount: status?.activeScheduleCount,
      lastWakeAt: status?.lastWakeAt,
      lastSuccessAt: status?.lastSuccessAt,
      lastError: status?.lastError,
      nextDueAt: status?.nextDueAt,
      nextDueAgentName: status?.nextDueAgentName,
    };
  } catch (error) {
    return {
      supported: false,
      enabled: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getReleaseDiagnostics(): Promise<ReleaseDiagnostics> {
  const platform =
    process.platform === "darwin"
      ? "macos"
      : process.platform === "win32"
        ? "windows"
        : process.platform === "linux"
          ? "linux"
          : "unknown";
  const notificationPermission =
    process.platform === "darwin" || process.platform === "win32"
      ? "granted"
      : "unknown";
  return {
    appVersion: app.getVersion(),
    packaged: app.isPackaged,
    signed: app.isPackaged,
    platform,
    notificationSupported: Notification.isSupported(),
    notificationPermission,
    scheduler: await getSchedulerLaunchSettings(),
  };
}

async function setSchedulerLaunchEnabled(enabled: boolean): Promise<SchedulerLaunchSettings> {
  if (process.platform === "linux") {
    return getSchedulerLaunchSettings();
  }

  if (enabled && !(await store.hasConnectedTenant())) {
    throw new Error(
      "Connect at least one Microsoft 365 tenant before enabling scheduled background runs.",
    );
  }

  if (process.platform === "darwin") {
    if (enabled) writeMacosLaunchAgent();
    else removeMacosLaunchAgent();
  } else if (process.platform === "win32") {
    if (enabled) registerWindowsSchedulerTask();
    else removeWindowsSchedulerTask();
  }

  return getSchedulerLaunchSettings();
}

async function registerSchedulerIfReady(trigger: "tenant" | "schedule"): Promise<void> {
  try {
    if (!(await store.hasConnectedTenant())) return;
    if (!(await store.hasEnabledSchedule())) return;
    const settings = await getSchedulerLaunchSettings();
    if (!settings.supported || settings.enabled) return;
    await setSchedulerLaunchEnabled(true);
  } catch (error) {
    console.warn(`[scheduler] OS registration after ${trigger} failed:`, error);
  }
}

async function unregisterSchedulerIfUnused(): Promise<void> {
  try {
    if (await store.hasEnabledSchedule()) return;
    const settings = await getSchedulerLaunchSettings();
    if (!settings.supported || !settings.enabled) return;
    await setSchedulerLaunchEnabled(false);
  } catch (error) {
    console.warn("[scheduler] OS unregistration after schedule removal failed:", error);
  }
}

function showRunNotification(run: RunRecord): void {
  if (!Notification.isSupported()) {
    console.warn("[notification] OS notifications are not supported on this system.");
    return;
  }

  // Skip notifications if the user is already focused on the app — they
  // will see the result without being interrupted. Scheduled runs are
  // the exception: they are ambient background work, so completion/failure
  // should still surface.
  if (run.trigger !== "schedule" && mainWindow && mainWindow.isFocused()) return;

  const title =
    run.status === "completed"
      ? run.trigger === "schedule"
        ? "Scheduled agent run completed"
        : "Agent run completed"
      : run.status === "failed"
        ? run.trigger === "schedule"
          ? "Scheduled agent run failed"
          : "Agent run failed"
        : run.status === "cancelled"
          ? "Agent run cancelled"
          : "Agent run rejected";
  const notification = new Notification({
    id: run.id,
    groupId: run.agentSlug,
    title,
    subtitle: run.agentSlug,
    body: notificationBodyForRun(run),
    silent: false,
  });

  activeNotifications.add(notification);
  const release = () => activeNotifications.delete(notification);
  notification.on("show", () => {
    console.info(`[notification] shown for run ${run.id}`);
  });
  notification.on("failed", (_event, error) => {
    console.warn(`[notification] failed for run ${run.id}: ${error}`);
    release();
  });
  notification.on("close", release);
  notification.on("click", () => {
    release();
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.send("openadminos:focus-run", run.id);
  });
  notification.show();
}

async function maybeShowRunNotification(run: RunRecord): Promise<void> {
  if (run.trigger === "schedule") {
    const schedule = await store.getAgentSchedule(run.agentSlug);
    const isFailure = run.status === "failed" || run.status === "cancelled" || run.status === "rejected";
    const successAllowed = schedule?.notifyOnSuccess ?? true;
    const failureAllowed = schedule?.notifyOnFailure ?? true;
    const changeOnly = schedule?.notifyOnChangeOnly ?? false;
    if (isFailure && !failureAllowed) return;
    if (!isFailure && !successAllowed) return;
    if (!isFailure && changeOnly && run.changeState === "unchanged") return;
  }

  showRunNotification(run);
}

function notificationBodyForRun(run: RunRecord): string {
  const statusSuffix =
    run.changeState === "new"
      ? "new finding"
      : run.changeState === "changed"
        ? "findings changed"
        : run.changeState === "unchanged"
          ? "no change"
          : run.status;
  const raw = run.error ?? run.summary ?? "";
  const cleaned = raw
    .replace(/[`*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const excerpt =
    cleaned.length > 120 ? `${cleaned.slice(0, 117).trim()}...` : cleaned;
  return excerpt ? `${run.agentSlug} · ${statusSuffix} · ${excerpt}` : `${run.agentSlug} · ${statusSuffix}`;
}

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

async function createWindow({ show = true }: { show?: boolean } = {}) {
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
    if (show) {
      mainWindow?.show();
    }
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
  ipcMain.handle("openadminos:get-scheduler-launch-settings", () =>
    getSchedulerLaunchSettings(),
  );
  ipcMain.handle("openadminos:get-release-diagnostics", () =>
    getReleaseDiagnostics(),
  );
  ipcMain.handle(
    "openadminos:set-scheduler-launch-enabled",
    (_event, enabled: boolean) => setSchedulerLaunchEnabled(Boolean(enabled)),
  );
  ipcMain.handle("openadminos:list-agents", () => store.listAgents());
  ipcMain.handle("openadminos:list-registry-agents", () =>
    store.listRegistryAgents(),
  );
  ipcMain.handle("openadminos:refresh-registry", () => store.initRegistry());
  ipcMain.handle("openadminos:set-registry-source", (_event, url: string) =>
    store.setRegistrySource(url),
  );
  ipcMain.handle(
    "openadminos:set-registry-install-counts-enabled",
    (_event, enabled: boolean) => store.setRegistryInstallCountsEnabled(Boolean(enabled)),
  );
  ipcMain.handle("openadminos:list-providers", () => store.listProviders());
  ipcMain.handle(
    "openadminos:test-provider",
    (_event, providerId: ProviderId, model?: string) =>
      store.testProvider(providerId, model),
  );
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
  ipcMain.handle("openadminos:uninstall-agent", async (_event, slug: string) => {
    const state = await store.uninstallAgent(slug);
    void unregisterSchedulerIfUnused();
    return state;
  });
  ipcMain.handle("openadminos:get-agent-update-review", (_event, slug: string) =>
    store.getAgentUpdateReview(slug),
  );
  ipcMain.handle(
    "openadminos:update-agent",
    (_event, slug: string, options?: { confirmTrustChanges?: boolean }) =>
      store.updateAgent(slug, options),
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
    (_event, agentSlug: string, options?: StartRunOptions) =>
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
  ipcMain.handle("openadminos:connect-tenant", async () => {
    const state = await store.connectTenant();
    void registerSchedulerIfReady("tenant");
    return state;
  });
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
    async (_event, slug: string, schedule) => {
      const state = await store.updateAgentSchedule(slug, schedule);
      if (schedule?.enabled === true) void registerSchedulerIfReady("schedule");
      else void unregisterSchedulerIfUnused();
      return state;
    },
  );
  ipcMain.handle(
    "openadminos:update-agent-teams-delivery",
    (_event, slug: string, delivery) =>
      store.updateAgentTeamsDelivery(slug, delivery),
  );
  ipcMain.handle(
    "openadminos:draft-agent-manifest",
    (_event, prompt: string) => store.draftAgentManifest(prompt),
  );
  ipcMain.handle(
    "openadminos:validate-agent-draft",
    (_event, yamlSource: string, allowedSlug?: string) =>
      store.validateAgentDraft(yamlSource, allowedSlug),
  );
  ipcMain.handle(
    "openadminos:preflight-agent-draft",
    (_event, yamlSource: string, allowedSlug?: string) =>
      store.preflightAgentDraft(yamlSource, allowedSlug),
  );
  ipcMain.handle(
    "openadminos:save-agent-draft",
    (_event, yamlSource: string) => store.saveAgentDraft(yamlSource),
  );
  ipcMain.handle(
    "openadminos:update-user-agent-draft",
    (_event, slug: string, yamlSource: string) =>
      store.updateUserAgentDraft(slug, yamlSource),
  );
  ipcMain.handle(
    "openadminos:export-agent-draft-bundle",
    async (_event, yamlSource: string) => {
      const parent = mainWindow ?? undefined;
      const result = parent
        ? await dialog.showOpenDialog(parent, {
            title: "Export agent bundle",
            buttonLabel: "Export here",
            properties: ["openDirectory", "createDirectory"],
          })
        : await dialog.showOpenDialog({
            title: "Export agent bundle",
            buttonLabel: "Export here",
            properties: ["openDirectory", "createDirectory"],
          });
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
      }
      return store.exportAgentDraftBundle(yamlSource, result.filePaths[0]);
    },
  );
  ipcMain.handle(
    "openadminos:prepare-agent-community-submission",
    (_event, yamlSource: string, metadata, allowedSlug?: string) =>
      store.prepareAgentCommunitySubmission(yamlSource, metadata, allowedSlug),
  );
  ipcMain.handle(
    "openadminos:submit-agent-community-submission",
    (_event, yamlSource: string, metadata, allowedSlug?: string) =>
      store.submitAgentCommunitySubmission(yamlSource, metadata, allowedSlug),
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
  app.on("second-instance", (_event, argv) => {
    if (argv.includes(BACKGROUND_SCHEDULER_ARG)) {
      void store?.fireDueSchedules();
      return;
    }

    if (!mainWindow || mainWindow.isDestroyed()) {
      if (app.dock) app.dock.show();
      void createWindow({ show: true });
      return;
    }

    if (app.dock) app.dock.show();
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
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
    const tokenStore = new SafeStorageTokenCacheStore(join(userDataDir, "tokens.bin"));

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
        void maybeShowRunNotification(run);
      },
    });
    registerIpcHandlers();
    installSecurityGuards();
    Menu.setApplicationMenu(buildAppMenu());
    if (isBackgroundSchedulerLaunch && app.dock) {
      app.dock.hide();
    }
    if (!isBackgroundSchedulerLaunch) {
      void createWindow({ show: true });
    }
    // Fetch registry index in the background after the window is ready.
    // Falls back to local filesystem agents until the fetch completes.
    void refreshRegistryInBackground("startup");
    startAutoUpdater(() => mainWindow ?? undefined);

    // Agent scheduler: for normal visible launches, wait for the
    // regular minute tick instead of immediately catching up. Immediate
    // catch-up can touch the MSAL token cache and trigger a macOS
    // Keychain prompt before the user has done anything. Hidden
    // background launches are explicitly scheduler work, so they catch
    // up immediately.
    if (isBackgroundSchedulerLaunch) {
      void store.fireDueSchedules();
    }
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
        if (app.dock) app.dock.show();
        void createWindow({ show: true });
      } else if (mainWindow && !mainWindow.isDestroyed()) {
        if (app.dock) app.dock.show();
        mainWindow.show();
        mainWindow.focus();
      }
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
