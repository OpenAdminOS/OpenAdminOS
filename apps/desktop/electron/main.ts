import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  session,
  shell,
  screen,
  Tray,
  type IpcMainInvokeEvent,
  type LoginItemSettingsOptions,
  type MenuItemConstructorOptions,
} from "electron";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { arch as osArch, release as osRelease } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { AppStateStore } from "./state.js";
import { SafeStorageTokenCacheStore } from "./secret-store.js";
import {
  applyUpdateNow,
  checkForUpdatesNow,
  getUpdateState,
  startAutoUpdater,
  subscribeToUpdateState,
} from "./updates.js";
import {
  attachWindowStatePersistence,
  loadWindowState,
} from "./window-state.js";
import { redactSupportPublicText } from "./support-secret-redaction.js";
import type {
  AgentCommunitySubmissionMetadata,
  CompanionLaunchSettings,
  AgentDiscordDelivery,
  AgentOutlookDelivery,
  AgentSchedule,
  AgentSignalDelivery,
  AgentSlackDelivery,
  AgentTeamsDelivery,
  AgentWhatsAppWebDelivery,
  ChatInvestigationMode,
  CompanionRunDueReadSchedulesResult,
  CompanionSnapshot,
  CreateWorkspaceInput,
  DriftBaselineDriftInput,
  DriftEntryDetailInput,
  ConnectTenantOptions,
  DriftBaselineExportBundle,
  DriftBundleCompareInput,
  DriftTenantCompareInput,
  DriftTimeCompareInput,
  StartBaselineRollbackInput,
  DriftObjectHistoryInput,
  DriftTimelineInput,
  ExportAuditLogInput,
  GraphCacheResourceKind,
  ImportMultiTenantResultToWorkspacesInput,
  MultiTenantChatStreamEvent,
  PendingConnectorDecision,
  PinWorkspaceEvidenceInput,
  PreflightMultiTenantChatInput,
  ProviderId,
  ProviderSummary,
  QueueMultiTenantAgentBatchInput,
  RefreshGraphCacheOptions,
  ReleaseDiagnostics,
  ResetSelfTrainingInput,
  RunMultiTenantChatInput,
  RunGraphApi,
  RunLlmApi,
  RunRecord,
  SandboxSettings,
  SaveTextFileArgs,
  SchedulerLaunchSettings,
  SelfTrainingSuggestionStatus,
  SetAzureOpenAIProviderConfigInput,
  SetDriftRetentionSettingsInput,
  SetGraphCacheRefreshScheduleInput,
  SetRunHistoryRetentionSettingsInput,
  SendIntuneChatMessageInput,
  SupportBundleInput,
  SupportIssueSubmissionInput,
  SupportIssueSubmissionResult,
  IntuneChatStreamEvent,
  StartRunOptions,
  TenantScope,
  UpdateWorkspaceInput,
  WorkspaceEvidenceSourceType,
  WorkspaceStatus,
} from "@openadminos/agent-sdk";
import { providerCatalog } from "@openadminos/agent-sdk";
import {
  installConnectorConfirmBridge,
  respondConnectorConfirm,
} from "./connector-confirm-bridge.js";
import {
  OPENADMINOS_MXC_FLAG,
  listRegisteredConnectors,
  probeMxcSandbox,
} from "@openadminos/runtime";
import { GRAPH_CACHE_RESOURCES } from "./intune-chat/planner.js";
import { DRIFT_TRACKED_RESOURCES } from "./intune-chat/drift/tracked-resources.js";
import { DEFAULT_REGISTRY_SOURCE } from "./registry-client.js";
import { electronAccelerator } from "../src/shared/shortcuts.js";

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
if (process.platform === "linux") {
  // Linux preview builds need to run reliably in VMs and desktops without
  // working 3D/VAAPI. Chromium GPU probing can leave packaged AppImages with
  // a libva error and no visible window, so prefer software rendering.
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-features", "VaapiVideoDecoder,VaapiVideoEncoder");
}
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
const MENU_BAR_ARG = "--menu-bar";
const isBackgroundSchedulerLaunch = process.argv.includes(BACKGROUND_SCHEDULER_ARG);
const isMenuBarLaunch = process.argv.includes(MENU_BAR_ARG);
const isMacosLoginItemLaunch = wasOpenedByMacosLoginItem();
const isIntuneChatSmokeLaunch =
  !app.isPackaged && process.env.OPENADMINOS_INTUNE_CHAT_SMOKE === "1";
const intuneChatSmokeUserData = process.env.OPENADMINOS_INTUNE_CHAT_SMOKE_USER_DATA;
const isReportIssueSmokeLaunch =
  !app.isPackaged && process.env.OPENADMINOS_REPORT_ISSUE_SMOKE === "1";
const reportIssueSmokeUserData = process.env.OPENADMINOS_REPORT_ISSUE_SMOKE_USER_DATA;
const isScreenshotCaptureLaunch =
  !app.isPackaged && process.env.OPENADMINOS_SCREENSHOT_CAPTURE === "1";
const screenshotCaptureUserData =
  process.env.OPENADMINOS_SCREENSHOT_CAPTURE_USER_DATA;
const screenshotCaptureOutDir = !app.isPackaged
  ? process.env.OPENADMINOS_SCREENSHOT_OUT_DIR
  : undefined;
const capturedExternalUrlFile = !app.isPackaged
  ? process.env.OPENADMINOS_CAPTURE_EXTERNAL_URL
  : undefined;
const supportBundleExportFile = !app.isPackaged
  ? process.env.OPENADMINOS_SUPPORT_BUNDLE_EXPORT_PATH
  : undefined;
const debugStartup = process.env.OPENADMINOS_DEBUG_STARTUP === "1";
const devUserDataDir = !app.isPackaged
  ? process.env.OPENADMINOS_USER_DATA_DIR
  : undefined;
const MACOS_SCHEDULER_LABEL = "com.openadminos.scheduler";
const MACOS_COMPANION_LOGIN_ITEM_ID = "com.openadminos.desktop.menubar-helper";
const MACOS_COMPANION_HELPER_APP = "OpenAdminOS Menu Bar Helper.app";
const WINDOWS_SCHEDULER_TASK = "OpenAdminOS Scheduler";
const providerIds = new Set(providerCatalog.map((provider) => provider.id));
const graphCacheResourceKinds = new Set<string>(
  GRAPH_CACHE_RESOURCES.map((resource) => resource.resource),
);
const driftTrackedResourceKinds = new Set<string>(DRIFT_TRACKED_RESOURCES);
const supportIssueSources = new Set([
  "sidebar",
  "run-failure",
  "settings-about",
  "native-menu",
]);
const intuneChatStreamControllers = new Map<string, AbortController>();
const pendingIntuneChatStreamCancellations = new Set<string>();
const multiTenantChatStreamControllers = new Map<string, AbortController>();
const agentSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const agentCategories = new Set([
  "devices",
  "apps",
  "policies",
  "compliance",
  "updates",
]);
const selfTrainingSuggestionStatuses = new Set<SelfTrainingSuggestionStatus>([
  "pending",
  "accepted",
  "rejected",
  "reset",
]);
const chatInvestigationModes = new Set<ChatInvestigationMode>([
  "auto",
  "always-agentic",
  "always-deterministic",
]);
const workspaceStatuses = new Set<WorkspaceStatus>(["active", "archived"]);
const workspaceEvidenceSourceTypes = new Set<WorkspaceEvidenceSourceType>([
  "multi-tenant-chat-result",
  "chat-message",
  "graph-cache-row",
  "run-result",
  "manual",
]);
const DEFAULT_SUPPORT_API_URL = "https://openadminos.com";
const COMPANION_WINDOW_WIDTH = 390;
const COMPANION_WINDOW_HEIGHT = 520;
const SCREENSHOT_CAPTURE_WIDTH = 1600;
const SCREENSHOT_CAPTURE_HEIGHT = 1000;
const SCREENSHOT_CAPTURE_WIDTHS = [900, 1100, 1600] as const;
const launchSandboxedCodeDefault = process.env[OPENADMINOS_MXC_FLAG] === "1";

const smokeUserData = isIntuneChatSmokeLaunch
  ? intuneChatSmokeUserData
  : isReportIssueSmokeLaunch
    ? reportIssueSmokeUserData
    : isScreenshotCaptureLaunch
      ? screenshotCaptureUserData
      : undefined;

const overrideUserData = smokeUserData ?? devUserDataDir;

if (
  isScreenshotCaptureLaunch &&
  (!screenshotCaptureUserData || !screenshotCaptureOutDir)
) {
  console.error(
    "[screenshot-capture] failed OPENADMINOS_SCREENSHOT_CAPTURE_USER_DATA and OPENADMINOS_SCREENSHOT_OUT_DIR are required.",
  );
  process.exit(1);
}

if (overrideUserData) {
  mkdirSync(overrideUserData, { recursive: true });
  app.setPath("userData", overrideUserData);
}

if (
  process.platform === "darwin" &&
  (isBackgroundSchedulerLaunch || isMenuBarLaunch || isMacosLoginItemLaunch)
) {
  // Apply before `whenReady()` so a LaunchAgent scheduler wake does not
  // briefly flash OpenAdminOS in the Dock while the hidden process starts.
  app.setActivationPolicy("accessory");
}

let mainWindow: BrowserWindow | null = null;
let companionWindow: BrowserWindow | null = null;
let menuBarTray: Tray | null = null;
let store: AppStateStore;
const activeNotifications = new Set<Notification>();
// Wall-clock timestamp of the most recent background registry refresh
// attempt. Used to rate-limit focus-triggered refreshes so alt-tabbing
// doesn't hammer GitHub. Manual refreshes from Agent Hub don't update
// this — the user explicitly asked for a fresh fetch.
let lastBackgroundRefreshAt = 0;

function debugStartupLog(message: string, detail?: unknown): void {
  if (!debugStartup) return;
  if (detail === undefined) {
    console.error(`[openadminos-startup] ${message}`);
  } else {
    console.error(`[openadminos-startup] ${message}`, detail);
  }
}

if (debugStartup) {
  process.on("uncaughtException", (error) => {
    console.error("[openadminos-startup] uncaughtException", error);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[openadminos-startup] unhandledRejection", reason);
  });
}

function wasOpenedByMacosLoginItem(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    return app.getLoginItemSettings().wasOpenedAtLogin;
  } catch {
    return false;
  }
}

function showDockForInteractiveSession(): void {
  if (process.platform === "darwin") {
    app.setActivationPolicy("regular");
  }
  if (app.dock) app.dock.show();
}

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

function seedIntuneChatSmokeState(userDataDir: string): void {
  if (!isIntuneChatSmokeLaunch) return;
  mkdirSync(userDataDir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(userDataDir, "state.json"),
    JSON.stringify(
      {
        activeProviderId: "ollama",
        activeModelByProviderId: { ollama: "test-smoke-local-model" },
        installedAgents: [
          {
            id: "offboarding-agent",
            slug: "offboarding-agent",
            name: "Offboarding agent",
            description: "Builds stale-device offboarding plans from Intune device evidence.",
            mode: "write",
            category: "devices",
            tier: "agent",
            requiresEntraTier: "free",
            scopes: ["DeviceManagementManagedDevices.Read.All", "Device.Read.All"],
            author: { name: "OpenAdminOS" },
            version: "1.0.0",
            installedAt: now,
          },
        ],
        runs: [],
        tenants: [
          {
            id: "smoke-tenant",
            displayName: "Smoke Tenant",
            username: "admin@smoke.invalid",
            homeAccountId: "smoke-home-account",
            addedAt: now,
            entraTier: "p1",
          },
        ],
        activeTenantId: "smoke-tenant",
        registryInstallCountsEnabled: false,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function seedReportIssueSmokeState(userDataDir: string): void {
  if (!isReportIssueSmokeLaunch) return;
  mkdirSync(userDataDir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(userDataDir, "state.json"),
    JSON.stringify(
      {
        activeProviderId: "ollama",
        activeModelByProviderId: { ollama: "report-smoke-model" },
        installedAgents: [
          {
            id: "report-smoke-agent",
            slug: "report-smoke-agent",
            name: "Report smoke agent",
            description: "Used only by the report issue smoke test.",
            mode: "read",
            category: "devices",
            tier: "agent",
            requiresEntraTier: "free",
            scopes: ["DeviceManagementManagedDevices.Read.All"],
            author: { name: "OpenAdminOS" },
            version: "1.0.0",
            installedAt: now,
          },
        ],
        runs: [
          {
            id: "report-smoke-run",
            agentSlug: "report-smoke-agent",
            status: "failed",
            queuedAt: now,
            startedAt: now,
            finishedAt: now,
            providerId: "ollama",
            trigger: "manual",
            error: "Ollama not reachable for report smoke.",
            steps: [],
            logs: [],
          },
        ],
        tenants: [
          {
            id: "report-smoke-tenant",
            displayName: "Report Smoke Tenant",
            username: "admin@report-smoke.invalid",
            homeAccountId: "report-smoke-home-account",
            addedAt: now,
            entraTier: "p1",
          },
        ],
        activeTenantId: "report-smoke-tenant",
        registryInstallCountsEnabled: false,
      },
      null,
      2,
    ),
    "utf8",
  );
}

interface ScreenshotRegistryEntry {
  id: string;
  slug: string;
  name: string;
  description: string;
  version: string;
  mode: "read" | "write";
  category: string;
  tier?: string;
  requiresEntraTier?: string;
  author: {
    name: string;
    handle?: string;
    verified?: boolean;
  };
  scopes: string[];
  minAppVersion?: string;
  manifestUrl?: string;
  execution?: unknown;
}

function seedScreenshotCaptureState(userDataDir: string): void {
  if (!isScreenshotCaptureLaunch) return;
  mkdirSync(userDataDir, { recursive: true });
  const now = new Date().toISOString();
  const entries = loadScreenshotRegistryEntries();
  const installedSlugs = new Set([
    "compliance-overview",
    "find-inactive-devices",
    "offboarding-agent",
  ]);
  const installedEntries = entries.filter((entry) => installedSlugs.has(entry.slug));
  const fallbackInstalledEntries =
    installedEntries.length > 0 ? installedEntries : entries.slice(0, 3);
  const installedAgents = fallbackInstalledEntries.map((entry) => ({
    id: entry.id,
    slug: entry.slug,
    name: entry.name,
    description: entry.description,
    mode: entry.mode,
    category: entry.category,
    tier: entry.tier ?? "agent",
    requiresEntraTier: entry.requiresEntraTier ?? "free",
    scopes: entry.scopes,
    author: entry.author,
    version: entry.version,
    installedAt: now,
    registryId: entry.id,
    minAppVersion: entry.minAppVersion,
    ...(entry.execution ? { execution: entry.execution } : {}),
  }));

  writeFileSync(
    join(userDataDir, "state.json"),
    JSON.stringify(
      {
        activeProviderId: "ollama",
        activeModelByProviderId: {
          ollama: "screenshot-local-model-with-a-deliberately-long-identifier",
        },
        installedAgents,
        runs: [
          {
            id: "screenshot-write-run",
            agentSlug: "offboarding-agent",
            status: "awaiting-confirmation",
            queuedAt: now,
            startedAt: now,
            providerId: "ollama",
            model: "screenshot-local-model-with-a-deliberately-long-identifier",
            tenantId: "contoso-demo-tenant",
            summary: "Write plan is ready for review.",
            steps: [],
            logs: [],
            plan: {
              summary: "Retire two stale Windows devices after offboarding review.",
              confirmationPhrase: "RETIRE 2 DEVICES",
              actions: [
                {
                  id: "screenshot-action-1",
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
                  id: "screenshot-action-2",
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
          },
        ],
        tenants: [
          {
            id: "contoso-demo-tenant",
            displayName: "Contoso Demo — European Endpoint Administration and Security",
            username: "admin@contoso-demo.invalid",
            homeAccountId: "contoso-demo-home-account",
            addedAt: now,
            entraTier: "p2",
          },
        ],
        activeTenantId: "contoso-demo-tenant",
        registryInstallCountsEnabled: false,
      },
      null,
      2,
    ),
    "utf8",
  );

  const registryCacheDir = join(userDataDir, "registry-cache");
  mkdirSync(registryCacheDir, { recursive: true });
  writeFileSync(
    join(registryCacheDir, "index.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        agents: entries,
        cachedAt: now,
        sourceUrl: DEFAULT_REGISTRY_SOURCE,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

function loadScreenshotRegistryEntries(): ScreenshotRegistryEntry[] {
  const indexPath = findScreenshotRegistryIndexPath();
  const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as {
    agents?: unknown;
  };
  if (!Array.isArray(parsed.agents)) {
    throw new Error(`Screenshot registry index has no agents array: ${indexPath}`);
  }
  return parsed.agents.map((entry, index) =>
    normalizeScreenshotRegistryEntry(entry, index, indexPath),
  );
}

function normalizeScreenshotRegistryEntry(
  entry: unknown,
  index: number,
  indexPath: string,
): ScreenshotRegistryEntry {
  if (!entry || typeof entry !== "object") {
    throw new Error(`Screenshot registry entry ${index} is not an object in ${indexPath}.`);
  }
  const candidate = entry as Record<string, unknown>;
  const mode = candidate.mode;
  const author = candidate.author;
  const scopes = candidate.scopes;
  if (mode !== "read" && mode !== "write") {
    throw new Error(`Screenshot registry entry ${index} has invalid mode.`);
  }
  if (!author || typeof author !== "object") {
    throw new Error(`Screenshot registry entry ${index} has invalid author.`);
  }
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")) {
    throw new Error(`Screenshot registry entry ${index} has invalid scopes.`);
  }
  const normalized: ScreenshotRegistryEntry = {
    id: requireStringField(candidate, "id", index, indexPath),
    slug: requireStringField(candidate, "slug", index, indexPath),
    name: requireStringField(candidate, "name", index, indexPath),
    description: requireStringField(candidate, "description", index, indexPath),
    version: requireStringField(candidate, "version", index, indexPath),
    mode,
    category: requireStringField(candidate, "category", index, indexPath),
    author: {
      name: requireStringField(
        author as Record<string, unknown>,
        "name",
        index,
        indexPath,
      ),
      ...(typeof (author as Record<string, unknown>).handle === "string"
        ? { handle: (author as Record<string, unknown>).handle as string }
        : {}),
      ...(typeof (author as Record<string, unknown>).verified === "boolean"
        ? { verified: (author as Record<string, unknown>).verified as boolean }
        : {}),
    },
    scopes: scopes as string[],
  };
  if (typeof candidate.tier === "string" && candidate.tier) {
    normalized.tier = candidate.tier;
  }
  if (typeof candidate.requiresEntraTier === "string" && candidate.requiresEntraTier) {
    normalized.requiresEntraTier = candidate.requiresEntraTier;
  }
  if (typeof candidate.minAppVersion === "string") {
    normalized.minAppVersion = candidate.minAppVersion;
  }
  if (typeof candidate.manifestUrl === "string") {
    normalized.manifestUrl = candidate.manifestUrl;
  }
  if (candidate.execution) {
    normalized.execution = candidate.execution;
  }
  return normalized;
}

function requireStringField(
  record: Record<string, unknown>,
  field: string,
  index: number,
  indexPath: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Screenshot registry entry ${index} is missing string field "${field}" in ${indexPath}.`,
    );
  }
  return value;
}

function findScreenshotRegistryIndexPath(): string {
  const candidates = [
    join(process.cwd(), "agents", "index.json"),
    join(app.getAppPath(), "..", "..", "agents", "index.json"),
    join(currentDir, "..", "..", "..", "agents", "index.json"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Unable to find agents/index.json for screenshot capture.");
}

function createIntuneChatSmokeGraph(): RunGraphApi {
  return {
    async listManagedDevices() {
      return [];
    },
    async retireManagedDevice() {
      throw new Error("The Intune Chat smoke test must not perform write actions.");
    },
    async request(input) {
      if (input.path === "/deviceManagement/managedDevices") {
        return {
          value: [
            {
              id: "managed-device-1",
              deviceName: "WIN-01",
              userPrincipalName: "user@smoke.invalid",
              operatingSystem: "Windows",
              osVersion: "10.0.22631",
              complianceState: "noncompliant",
              lastSyncDateTime: "2026-01-01T00:00:00.000Z",
              managementState: "managed",
            },
          ],
        };
      }
      if (input.path === "/devices") {
        return {
          value: [
            {
              id: "entra-device-1",
              deviceId: "entra-device-1",
              displayName: "WIN-01",
              operatingSystem: "Windows",
              isManaged: true,
              approximateLastSignInDateTime: "2026-01-02T00:00:00.000Z",
            },
          ],
        };
      }
      return { value: [] };
    },
  };
}

function createIntuneChatSmokeLlm(): RunLlmApi {
  return {
    available: true,
    defaultModel: "test-smoke-local-model",
    async complete() {
      return {
        text: "WIN-01 is stale based on cached Intune and Entra device evidence.",
        model: "test-smoke-local-model",
      };
    },
    async *stream(options) {
      if (options.prompt.includes("Hold response for cancellation smoke")) {
        yield {
          delta: "Partial response",
          accumulated: "Partial response",
          done: false,
          model: "test-smoke-local-model",
        };
        const started = Date.now();
        while (!options.signal?.aborted && Date.now() - started < 5000) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (options.signal?.aborted) {
          throw new Error("Smoke stream stopped by user.");
        }
      }
      yield {
        delta: "WIN-01 is stale",
        accumulated: "WIN-01 is stale",
        done: false,
        model: "test-smoke-local-model",
      };
      yield {
        delta: " based on cached Intune and Entra device evidence.",
        accumulated: "WIN-01 is stale based on cached Intune and Entra device evidence.",
        done: true,
        model: "test-smoke-local-model",
      };
    },
  };
}

function createIntuneChatSmokeProviders(): ProviderSummary[] {
  return providerCatalog.map((provider) =>
    provider.id === "ollama"
      ? {
          ...provider,
          status: "connected",
          detail: "Deterministic local provider fixture for Electron smoke tests.",
          models: ["test-smoke-local-model"],
          defaultModel: "test-smoke-local-model",
        }
      : { ...provider },
  );
}

function failIntuneChatSmoke(error: unknown): void {
  console.error(
    "[intune-chat-smoke] failed",
    error instanceof Error ? error.stack ?? error.message : error,
  );
  app.exit(1);
}

function failReportIssueSmoke(error: unknown): void {
  console.error(
    "[report-issue-smoke] failed",
    error instanceof Error ? error.stack ?? error.message : error,
  );
  app.exit(1);
}

function failScreenshotCapture(error: unknown): void {
  console.error(
    "[screenshot-capture] failed",
    error instanceof Error ? error.stack ?? error.message : error,
  );
  app.exit(1);
}

async function runIntuneChatSmoke(): Promise<void> {
  if (!isIntuneChatSmokeLaunch) return;
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    throw new Error("Intune Chat smoke window was not available.");
  }
  const result = await window.webContents.executeJavaScript(
    `(${intuneChatSmokeScript.toString()})()`,
    true,
  );
  console.log("[intune-chat-smoke] passed", JSON.stringify(result));
  app.exit(0);
}

async function runReportIssueSmoke(): Promise<void> {
  if (!isReportIssueSmokeLaunch) return;
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    throw new Error("Report issue smoke window was not available.");
  }
  const result = await window.webContents.executeJavaScript(
    `(${reportIssueSmokeScript.toString()})()`,
    true,
  );
  if (!capturedExternalUrlFile) {
    throw new Error("OPENADMINOS_CAPTURE_EXTERNAL_URL is required for report smoke.");
  }
  if (!supportBundleExportFile) {
    throw new Error("OPENADMINOS_SUPPORT_BUNDLE_EXPORT_PATH is required for report smoke.");
  }

  const capturedUrl = readFileSync(capturedExternalUrlFile, "utf8");
  if (capturedUrl.trim() !== "https://github.com/OpenAdminOS/OpenAdminOS/issues/12345") {
    throw new Error(`Report smoke opened unexpected URL: ${capturedUrl}`);
  }

  const exported = JSON.parse(readFileSync(supportBundleExportFile, "utf8")) as Record<
    string,
    unknown
  >;
  const exportedText = JSON.stringify(exported);
  for (const forbidden of [
    "Report Smoke Tenant",
    "admin@report-smoke.invalid",
    "report-smoke-agent",
    "report-smoke-run",
  ]) {
    if (exportedText.includes(forbidden)) {
      throw new Error(`Report smoke leaked ${forbidden} into the diagnostics JSON.`);
    }
  }
  const privacy = exported.privacy as Record<string, unknown> | undefined;
  if (
    privacy?.automaticUploadByOpenAdminOS !== false ||
    privacy?.publicIssueSubmissionRequiresConfirmation !== true ||
    privacy?.tenantIdentifiersIncluded !== false ||
    privacy?.promptsIncluded !== false ||
    privacy?.graphResponsesIncluded !== false ||
    privacy?.runResultsIncluded !== false ||
    privacy?.runLogsIncluded !== false
  ) {
    throw new Error("Report smoke diagnostics privacy flags were not false.");
  }

  console.log(
    "[report-issue-smoke] passed",
    JSON.stringify({ ...result, issueUrl: capturedUrl }),
  );
  app.exit(0);
}

async function runScreenshotCapture(): Promise<void> {
  if (!isScreenshotCaptureLaunch) return;
  if (!screenshotCaptureOutDir) {
    throw new Error("OPENADMINOS_SCREENSHOT_OUT_DIR is required.");
  }
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    throw new Error("Screenshot capture window was not available.");
  }

  window.show();
  window.focus();

  const entries = loadScreenshotRegistryEntries();
  const appShots: Array<{
    route: string;
    name: string;
    file: string;
    waitFor: string[];
    prepare?: "chat-empty" | "chat-transcript" | "write-confirmation";
    heading?: string;
    selector?: string;
  }> = [
    {
      route: "/agents",
      name: "agents-home",
      file: "app/agents-home.png",
      waitFor: ["Installed", "Schedules", "Search installed agents"],
      heading: "Agents",
    },
    {
      route: "/agents/hub",
      name: "hub-grid",
      file: "app/hub-grid.png",
      waitFor: ["Hub", `${entries.length} shown`],
      heading: "Agent Hub",
    },
    {
      route: "/chat",
      name: "chat-empty",
      file: "app/chat-empty.png",
      waitFor: ["Chat", "Ollama"],
      prepare: "chat-empty",
      selector: "#intune-chat-composer",
    },
    {
      route: "/chat",
      name: "chat-transcript",
      file: "app/chat-transcript.png",
      waitFor: ["Chat", "Ollama"],
      prepare: "chat-transcript",
      selector: "#intune-chat-composer",
    },
    {
      route: "/changes",
      name: "changes",
      file: "app/changes.png",
      waitFor: ["Changes"],
      heading: "Changes",
    },
    {
      route: "/runs/screenshot-write-run",
      name: "write-confirmation",
      file: "app/write-confirmation.png",
      waitFor: [
        "Write operation paused for confirmation",
        "RETIRE 2 DEVICES",
        "Microsoft Graph changes may not be reversible",
      ],
      prepare: "write-confirmation",
    },
    {
      route: "/settings",
      name: "settings",
      file: "app/settings.png",
      waitFor: ["Settings", "LLM Providers"],
      heading: "Settings",
    },
  ];

  let count = 0;
  const chatEmptyShot = appShots.find((shot) => shot.name === "chat-empty");
  if (!chatEmptyShot) {
    throw new Error("Screenshot matrix is missing the Chat empty-state fixture.");
  }
  const remainingShots = appShots.filter((shot) => shot !== chatEmptyShot);
  let transcriptRoute: string | undefined;

  const captureAppShot = async (
    shot: (typeof appShots)[number],
    width: (typeof SCREENSHOT_CAPTURE_WIDTHS)[number],
    reducedMotion: boolean,
  ) => {
    const height = width === 900 ? 800 : width === 1100 ? 850 : SCREENSHOT_CAPTURE_HEIGHT;
    let actualWidth = window.getContentSize()[0];
    for (let attempt = 0; attempt < 20 && actualWidth !== width; attempt += 1) {
      window.setContentSize(width, height);
      await new Promise((resolve) => setTimeout(resolve, 50));
      actualWidth = window.getContentSize()[0];
    }
    if (actualWidth !== width) {
      throw new Error(`Screenshot width mismatch: requested ${width}px, received ${actualWidth}px.`);
    }
    const reuseTranscript = shot.prepare === "chat-transcript" && transcriptRoute;
    const prepare = reuseTranscript ? undefined : shot.prepare;
    const waitFor = reuseTranscript
        ? [
            ...shot.waitFor,
            "WIN-01 is stale based on cached Intune and Entra device evidence.",
          ]
        : shot.waitFor;
    const finalHash = await runScreenshotCaptureStep(window, {
      kind: "route",
      route: reuseTranscript ? transcriptRoute! : shot.route,
      waitFor,
      ...(prepare ? { prepare } : {}),
      ...(shot.heading ? { heading: shot.heading } : {}),
      ...(shot.selector ? { selector: shot.selector } : {}),
      reducedMotion,
    });
    if (prepare === "chat-transcript" && finalHash.startsWith("#/chat/")) {
      transcriptRoute = finalHash.slice(1);
    }
    const mode = reducedMotion ? "reduced-motion" : "default";
    await captureScreenshotPng(
      window,
      `app/width-${width}/${mode}/${shot.name}.png`,
    );
    if (width === SCREENSHOT_CAPTURE_WIDTH && !reducedMotion) {
      await captureScreenshotPng(window, shot.file);
    }
    count += 1;
  };

  // Record every empty-state width before transcript capture creates local history.
  for (const width of SCREENSHOT_CAPTURE_WIDTHS) {
    const height = width === 900 ? 800 : width === 1100 ? 850 : SCREENSHOT_CAPTURE_HEIGHT;
    window.setContentSize(width, height);
    for (const reducedMotion of [false, true]) {
      await captureAppShot(chatEmptyShot, width, reducedMotion);
    }
  }

  for (const width of SCREENSHOT_CAPTURE_WIDTHS) {
    const height = width === 900 ? 800 : width === 1100 ? 850 : SCREENSHOT_CAPTURE_HEIGHT;
    window.setContentSize(width, height);
    for (const reducedMotion of [false, true]) {
      for (const shot of remainingShots) {
        await captureAppShot(shot, width, reducedMotion);
      }
    }
  }

  window.setContentSize(SCREENSHOT_CAPTURE_WIDTH, SCREENSHOT_CAPTURE_HEIGHT);

  if (process.env.OPENADMINOS_SCREENSHOT_HUB_DETAILS === "1") {
    for (const entry of entries) {
      try {
        await runScreenshotCaptureStep(window, {
          kind: "hub-detail",
          route: "/agents/hub",
          slug: entry.slug,
          name: entry.name,
          expectedCount: entries.length,
        });
        await captureScreenshotPng(window, `hub/${entry.slug}.png`);
        count += 1;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Hub detail failed for ${entry.slug}: ${detail}`);
      }
    }
  }

  console.log(`[screenshot-capture] passed ${count}`);
  app.exit(0);
}

async function runScreenshotCaptureStep(
  window: BrowserWindow,
  step: ScreenshotCaptureStep,
): Promise<string> {
  return window.webContents.executeJavaScript(
    `(${screenshotCaptureStepScript.toString()})(${JSON.stringify(step)})`,
    true,
  );
}

async function captureScreenshotPng(
  window: BrowserWindow,
  relativePath: string,
): Promise<void> {
  if (!screenshotCaptureOutDir) {
    throw new Error("OPENADMINOS_SCREENSHOT_OUT_DIR is required.");
  }
  if (
    !/^(?:app\/(?:width-(?:900|1100|1600)\/(?:default|reduced-motion)\/)?|hub\/)[a-z0-9-]+\.png$/.test(
      relativePath,
    )
  ) {
    throw new Error(`Invalid screenshot output path: ${relativePath}`);
  }
  const outputPath = join(screenshotCaptureOutDir, relativePath);
  mkdirSync(dirname(outputPath), { recursive: true });
  // Chromium can return the previous compositor frame immediately after a
  // client-side route change under Xvfb. Force and discard one frame so the
  // persisted artifact always reflects the route whose DOM was verified.
  window.webContents.invalidate();
  await window.webContents.capturePage();
  await new Promise((resolve) => setTimeout(resolve, 100));
  window.webContents.invalidate();
  const image = await window.webContents.capturePage();
  await writeFile(outputPath, image.toPNG());
  console.log(`[screenshot-capture] wrote ${outputPath}`);
}

type ScreenshotCaptureStep =
  | {
      kind: "route";
      route: string;
      waitFor: string[];
      prepare?: "chat-empty" | "chat-transcript" | "write-confirmation";
      reducedMotion?: boolean;
      heading?: string;
      selector?: string;
    }
  | {
      kind: "hub-detail";
      route: string;
      slug: string;
      name: string;
      expectedCount: number;
    };

async function screenshotCaptureStepScript(
  step: ScreenshotCaptureStep,
): Promise<string> {
  const waitFor = async (
    predicate: () => boolean,
    label: string,
    timeoutMs = 12000,
  ) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `Timed out waiting for ${label}. Current page text: ${(document.body.textContent ?? "").slice(0, 1800)}`,
    );
  };
  const delay = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const bodyText = () => document.body.textContent ?? "";
  const closeModal = async () => {
    const close = document.querySelector<HTMLButtonElement>(
      '.fixed button[aria-label="Close"]',
    );
    if (!close) return;
    close.click();
    await waitFor(() => !document.querySelector(".fixed"), "modal close", 4000);
  };
  const resetScroll = () => {
    window.scrollTo(0, 0);
    for (const element of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      if (element.scrollTop > 0) element.scrollTop = 0;
    }
  };
  const navigateHash = async (route: string) => {
    const expected = `#${route}`;
    if (location.hash !== expected) {
      location.hash = route;
    }
    await waitFor(() => location.hash === expected, `${route} hash`);
    await delay(150);
  };
  const textIncludesAll = (needles: string[]) =>
    needles.every((needle) => bodyText().includes(needle));
  const findButton = (label: string): HTMLButtonElement | undefined =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) =>
        button.textContent?.trim() === label ||
        button.getAttribute("aria-label") === label,
    );
  const setTextarea = (value: string) => {
    const textarea = document.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("Chat textarea was not found for screenshot capture.");
    }
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    return textarea;
  };

  document.documentElement.toggleAttribute(
    "data-reduced-motion",
    "reducedMotion" in step && step.reducedMotion === true,
  );

  await closeModal();
  await navigateHash(step.route);
  resetScroll();

  if (step.kind === "route") {
    await waitFor(
      () =>
        textIncludesAll(step.waitFor) &&
        (!step.heading ||
          Array.from(document.querySelectorAll("h1, h2")).some((heading) =>
            heading.textContent?.trim().includes(step.heading!),
          )) &&
        (!step.selector || Boolean(document.querySelector(step.selector))),
      `${step.route} route content`,
    );
    if (step.prepare === "chat-empty") {
      await waitFor(
        () =>
          Boolean(
            (findButton("New") ?? findButton("New conversation")) &&
              !(findButton("New") ?? findButton("New conversation"))?.disabled,
          ),
        "enabled New conversation action",
      );
      const newConversation = findButton("New") ?? findButton("New conversation");
      newConversation?.click();
      window.dispatchEvent(new CustomEvent("openadminos:new-conversation"));
      await waitFor(
        () => bodyText().includes("What do you want to inspect?"),
        "empty Chat state",
      );
    } else if (step.prepare === "chat-transcript") {
      const newConversation = findButton("New") ?? findButton("New conversation");
      newConversation?.click();
      window.dispatchEvent(new CustomEvent("openadminos:new-conversation"));
      await waitFor(
        () => bodyText().includes("What do you want to inspect?"),
        "new Chat transcript fixture",
      );
      const textarea = setTextarea(
        "Which managed devices have not synced in the last 7 days, and what evidence supports the answer?",
      );
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
        }),
      );
      await waitFor(
        () => bodyText().includes("WIN-01 is stale based on cached Intune and Entra device evidence."),
        "Chat transcript answer",
      );
      await waitFor(
        () => Boolean(findButton("Send")) && !findButton("Stop"),
        "settled Chat transcript",
      );
      await waitFor(
        () => !bodyText().includes("Chat answer ready."),
        "completed Chat progress cleared",
        4500,
      );
    } else if (step.prepare === "write-confirmation") {
      await waitFor(
        () => Boolean(document.querySelector('input[placeholder="Type here to enable Apply"]')),
        "write confirmation phrase input",
      );
      document
        .querySelector('input[placeholder="Type here to enable Apply"]')
        ?.scrollIntoView({ block: "center", behavior: "auto" });
      await delay(150);
    }
    await delay(250);
    for (const animation of document.getAnimations()) {
      try {
        if (animation.effect?.getTiming().iterations !== Infinity) {
          animation.finish();
        }
      } catch {
        // Infinite progress indicators cannot be finished; route readiness is
        // asserted separately and their motion is disabled in reduced mode.
      }
    }
    await delay(50);
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth) {
      throw new Error(
        `Horizontal overflow at ${step.route}: ${document.documentElement.scrollWidth}px > ${document.documentElement.clientWidth}px.`,
      );
    }
    return location.hash;
  }

  await waitFor(
    () =>
      bodyText().includes(`${step.expectedCount} shown`) &&
      bodyText().includes(step.name),
    `Hub grid for ${step.slug}`,
  );
  await navigateHash(`${step.route}?agent=${encodeURIComponent(step.slug)}`);
  await waitFor(
    () => {
      const modal = document.querySelector(".fixed");
      const text = modal?.textContent ?? "";
      return (
        text.includes(step.name) &&
        text.includes("Tenant impact") &&
        text.includes("Required scopes")
      );
    },
    `Hub detail modal for ${step.slug}`,
  );
  await delay(300);
  return location.hash;
}

async function intuneChatSmokeScript(): Promise<Record<string, unknown>> {
  const waitFor = async (
    predicate: () => boolean,
    label: string,
    timeoutMs = 12000,
  ) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `Timed out waiting for ${label}. Current page text: ${(document.body.textContent ?? "").slice(0, 1400)}`,
    );
  };
  const bodyText = () => document.body.textContent ?? "";
  const textOccurrenceCount = (needle: string): number =>
    bodyText().split(needle).length - 1;
  const findButton = (label: string): HTMLButtonElement | undefined => {
    const buttons = Array.from(document.querySelectorAll("button"));
    return (
      buttons.find((button) => button.textContent?.trim() === label) ??
      buttons.find((button) => button.textContent?.trim().includes(label))
    );
  };
  const findNamedButton = (name: string): HTMLButtonElement | undefined =>
    Array.from(document.querySelectorAll("button")).find(
      (button) =>
        button.getAttribute("aria-label") === name || button.title === name,
    );
  const clickButton = async (label: string) => {
    await waitFor(() => {
      const button = findButton(label);
      return Boolean(button && !button.disabled);
    }, `${label} button`);
    findButton(label)?.click();
  };
  const clickModalButton = async (label: string) => {
    await waitFor(() => {
      const button = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".fixed button"),
      ).find((candidate) => candidate.textContent?.trim().includes(label));
      return Boolean(button && !button.disabled);
    }, `${label} modal button`);
    (
      Array.from(document.querySelectorAll<HTMLButtonElement>(".fixed button")).find(
        (candidate) => candidate.textContent?.trim().includes(label),
      )
    )?.click();
  };
  const clickNamedButton = async (name: string) => {
    await waitFor(() => {
      const button = findNamedButton(name);
      return Boolean(button && !button.disabled);
    }, `${name} button`);
    findNamedButton(name)?.click();
  };
  const rightClickConversation = async (title: string) => {
    await waitFor(() => {
      const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim().includes(title),
      );
      return Boolean(button);
    }, `${title} conversation row`);
    const button = Array.from(document.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.trim().includes(title),
    );
    button?.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 180,
        clientY: 180,
      }),
    );
  };
  const clickSummary = async (label: string) => {
    await waitFor(() => {
      const summary = Array.from(document.querySelectorAll("summary")).find(
        (candidate) => candidate.textContent?.trim().includes(label),
      );
      return Boolean(summary);
    }, `${label} disclosure`);
    Array.from(document.querySelectorAll("summary"))
      .find((candidate) => candidate.textContent?.trim().includes(label))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  };
  const setModalInput = async (value: string) => {
    await waitFor(() => Boolean(document.querySelector(".fixed input")), "modal input");
    const input = document.querySelector(".fixed input");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("Modal input was not found.");
    }
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.focus();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => input.value === value, "modal input value");
  };
  const setTextarea = async (value: string) => {
    await waitFor(() => Boolean(document.querySelector("textarea")), "chat input");
    const textarea = document.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("Chat textarea was not found.");
    }
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(textarea, value);
    textarea.focus();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => textarea.value === value, "chat input value");
  };
  const findSelectByAccessibleName = (name: string): HTMLSelectElement | undefined => {
    const byAriaLabel = document.querySelector(`select[aria-label="${name}"]`);
    if (byAriaLabel instanceof HTMLSelectElement) return byAriaLabel;
    const label = Array.from(document.querySelectorAll("label")).find(
      (candidate) => candidate.textContent?.trim() === name && candidate.htmlFor,
    );
    const byLabel = label ? document.getElementById(label.htmlFor) : null;
    return byLabel instanceof HTMLSelectElement ? byLabel : undefined;
  };
  const selectFirstOption = async (accessibleName: string) => {
    await waitFor(
      () => Boolean(findSelectByAccessibleName(accessibleName)),
      `${accessibleName} select`,
    );
    const select = findSelectByAccessibleName(accessibleName);
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error(`${accessibleName} select was not found.`);
    }
    const option = Array.from(select.options).find((candidate) => candidate.value);
    if (!option) {
      throw new Error(`${accessibleName} has no selectable option.`);
    }
    const setter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set;
    setter?.call(select, option.value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => select.value === option.value, `${accessibleName} selected`);
  };
  const clickFirstEnabledCheckbox = async (label: string) => {
    await waitFor(
      () => Boolean(document.querySelector('input[type="checkbox"]:not(:disabled)')),
      label,
    );
    const checkbox = document.querySelector('input[type="checkbox"]:not(:disabled)');
    if (!(checkbox instanceof HTMLInputElement)) {
      throw new Error(`${label} checkbox was not found.`);
    }
    checkbox.click();
    await waitFor(() => checkbox.checked, `${label} checked`);
  };
  const pressEnterInTextarea = async () => {
    await waitFor(() => Boolean(document.querySelector("textarea")), "chat input");
    const textarea = document.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("Chat textarea was not found.");
    }
    textarea.focus();
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }),
    );
  };

  location.hash = "/chat";
  await waitFor(
    () =>
      bodyText().includes("What do you want to inspect?") &&
      bodyText().includes("Smoke Tenant"),
    "direct Chat front door",
  );
  const sawDirectChatFrontDoor = location.hash === "#/chat";

  location.hash = "/settings/chat";
  await waitFor(
    () => bodyText().includes("Settings") && bodyText().includes("Tenant cache"),
    "Chat settings route",
  );
  await clickButton("Enable");
  await waitFor(() => bodyText().includes("Next cache refresh"), "periodic refresh enabled");
  await clickButton("Enable");
  await waitFor(() => bodyText().includes("Local self-training"), "self-training setting");

  location.hash = "/chat";
  await waitFor(() => bodyText().includes("What do you want to inspect?"), "Intune Chat route");
  await waitFor(
    () => bodyText().includes("Smoke Tenant") && bodyText().includes("New conversation"),
    "tenant-connected chat shell",
  );
  await clickNamedButton("Hide chat history");
  await waitFor(() => Boolean(findNamedButton("Show chat history")), "collapsed chat history");
  await waitFor(
    () => Boolean(findNamedButton("New conversation")),
    "collapsed new conversation action",
  );
  await clickNamedButton("Show chat history");
  await waitFor(() => bodyText().includes("Smoke Tenant"), "expanded chat history");

  await selectFirstOption("Saved multi-tenant query");
  await waitFor(() => {
    const textarea = document.querySelector("textarea");
    return textarea instanceof HTMLTextAreaElement &&
      textarea.value.includes("List all compliant and non-compliant Windows devices");
  }, "saved multi-tenant query loaded");
  await clickButton("Send");
  await waitFor(() => bodyText().includes("Review multi-tenant scope"), "scope review");
  const sawMultiTenantScopeReview =
    bodyText().includes("Review multi-tenant scope") &&
    bodyText().includes("Smoke Tenant");
  await clickButton("Run read-only query");
  await waitFor(() => bodyText().includes("Multi-tenant result"), "multi-tenant result");
  const sawMultiTenantResult = bodyText().includes("Multi-tenant result");
  await clickButton("Split to Workspaces");
  await waitFor(() => bodyText().includes("Split result to Workspaces"), "split to workspaces modal");
  await clickModalButton("Create evidence");
  await waitFor(() => bodyText().includes("Created") && bodyText().includes("evidence"), "split workspace evidence");
  const sawSplitToWorkspaces = bodyText().includes("workspace evidence");
  await clickModalButton("Close");
  await clickButton("New");
  await waitFor(
    () => bodyText().includes("New conversation") && bodyText().includes("Ready"),
    "new conversation after multi-tenant result",
  );

  await setTextarea("Hold response for cancellation smoke.");
  await pressEnterInTextarea();
  await waitFor(() => Boolean(findButton("Stop")), "chat stop action", 2500);
  await clickButton("Stop");
  await waitFor(
    () => bodyText().includes("Response stopped by user"),
    "stopped chat response",
  );
  await waitFor(() => !bodyText().includes("Thinking"), "stopped chat send settled");
  const sawStopGeneration = bodyText().includes("Response stopped by user");
  await clickButton("New");
  await waitFor(
    () => bodyText().includes("New conversation") && bodyText().includes("Ready"),
    "new conversation after stopped response",
  );

  const testPrompts = [
    "Always retire stale Windows devices that have not synced.",
    "Which managed devices have not synced in the last 7 days?",
    "Which devices are stale in Intune but still active in Entra?",
    "Which Windows devices are not encrypted?",
    "Which Autopilot devices are in failed enrollment state?",
    "Which required apps are assigned but not installed on targeted devices?",
    "Which recent sign-ins failed because of Conditional Access?",
    "Which endpoint security policies are assigned to all devices?",
    "Which remediation scripts have not reported results recently?",
    "Which Windows devices are below the supported OS build?",
  ];

  let responseCount = 0;
  let sawAgentSuggestion = false;
  const smokeAnswer =
    "WIN-01 is stale based on cached Intune and Entra device evidence.";
  const writeBlockedAnswer = "I cannot perform tenant changes directly from chat.";
  for (const [index, prompt] of testPrompts.entries()) {
    if (index === 1) {
      await clickButton("New");
      await waitFor(
        () => bodyText().includes("New conversation") && bodyText().includes("Ready"),
        "visible new conversation draft",
      );
      responseCount = 0;
    }
    const expectedResponseCount = responseCount + 1;
    await setTextarea(prompt);
    await pressEnterInTextarea();
    await waitFor(
      () =>
        bodyText().includes("Check cached tenant data") ||
        bodyText().includes("Generate response"),
      "immediate chat progress checklist",
      2500,
    );
    await waitFor(() => bodyText().includes(prompt), "optimistic user prompt", 2500);
    if (index === 0) {
      // Write-intent prompts are blocked before any LLM call; expect the
      // designed refusal plus a write-agent handoff instead of a model answer.
      await waitFor(
        () => bodyText().includes(writeBlockedAnswer),
        "write-intent blocked response",
      );
      await waitFor(
        () => bodyText().includes("Offboarding agent"),
        "write-intent agent handoff",
      );
      sawAgentSuggestion = bodyText().includes("Offboarding agent");
      await waitFor(() => !bodyText().includes("Thinking"), "chat send settled");
      continue;
    }
    await waitFor(
      () => textOccurrenceCount(smokeAnswer) >= expectedResponseCount,
      `chat response ${expectedResponseCount}`,
    );
    await waitFor(() => !bodyText().includes("Thinking"), "chat send settled");
    responseCount = expectedResponseCount;
  }
  await waitFor(() => bodyText().includes("WIN-01 is stale"), "chat answer");
  await clickSummary("Source details");
  await waitFor(
    () => bodyText().includes("/deviceManagement/managedDevices"),
    "source details endpoint",
  );
  // The agent suggestion card lives in the write-intent conversation; switch
  // to it for the details assertions, then return to the read conversation.
  await clickButton("Always retire stale Windows devices");
  await waitFor(
    () => bodyText().includes(writeBlockedAnswer),
    "write-intent conversation transcript",
  );
  await clickButton("Details");
  await waitFor(
      () =>
        bodyText().includes("Why suggested") &&
        bodyText().includes("Required scopes") &&
        bodyText().includes("Write intent") &&
        bodyText().includes("DeviceManagementManagedDevices.Read.All") &&
        bodyText().includes("Write actions still use the normal plan and confirmation flow."),
    "agent suggestion details",
  );
  await clickButton("Which managed devices have not synced in the last 7");
  await waitFor(
    () => bodyText().includes(smokeAnswer),
    "read conversation transcript restored",
  );
  await clickButton("Workspace");
  await waitFor(
    () => bodyText().includes("Created workspace") && bodyText().includes("linked this conversation"),
    "workspace created from conversation",
  );
  await clickButton("Pin answer");
  await waitFor(() => bodyText().includes("Pin answer to workspace"), "pin answer modal");
  await clickModalButton("Pin answer");
  await waitFor(() => bodyText().includes("Pinned evidence to"), "pinned answer evidence");
  const sawWorkspacePin = bodyText().includes("Pinned evidence to");
  await clickButton("New");
  await waitFor(
    () => bodyText().includes("New conversation") && bodyText().includes("Ready"),
    "new conversation for workspace context",
  );
  await selectFirstOption("Attach workspace context");
  await waitFor(() => bodyText().includes("Chat answer"), "workspace evidence option");
  await clickFirstEnabledCheckbox("workspace context evidence");
  await waitFor(
    () => bodyText().includes("Workspace context selected: 1 evidence"),
    "workspace context attached",
  );
  await setTextarea("Use the attached workspace context to summarize the device evidence.");
  await pressEnterInTextarea();
  await waitFor(
    () => bodyText().includes(smokeAnswer),
    "workspace context chat response",
  );
  const workspaceResponseCount = textOccurrenceCount(smokeAnswer);
  const sawWorkspaceContextAttachment =
    bodyText().includes("Workspace context selected: 1 evidence") ||
    bodyText().includes("Use the attached workspace context");
  await clickButton("Regenerate");
  await waitFor(
    () =>
      bodyText().includes("Check cached tenant data") ||
      bodyText().includes("Generate response"),
    "regenerate progress checklist",
    2500,
  );
  await waitFor(
    () => textOccurrenceCount(smokeAnswer) >= workspaceResponseCount + 1,
    "regenerated chat response",
  );
  await waitFor(() => !bodyText().includes("Thinking"), "regenerate send settled");
  const sawRegenerate = textOccurrenceCount(smokeAnswer) >= workspaceResponseCount + 1;
  await clickButton("Edit");
  await waitFor(() => {
    const textarea = document.querySelector("textarea");
    return textarea instanceof HTMLTextAreaElement &&
      textarea.value.includes("Use the attached workspace context");
  }, "edit prompt loaded into composer");
  await clickButton("Pin");
  await waitFor(
    () => bodyText().includes("Unpin") && bodyText().includes("Pinned"),
    "pinned conversation action",
  );
  await clickButton("Rename");
  await waitFor(() => bodyText().includes("Rename conversation"), "rename conversation modal");
  await setModalInput("Smoke lifecycle review");
  await clickModalButton("Rename");
  await waitFor(() => bodyText().includes("Smoke lifecycle review"), "renamed conversation");
  const sawPinnedCategory = bodyText().includes("Pinned");
  await rightClickConversation("Smoke lifecycle review");
  await waitFor(
    () =>
      bodyText().includes("Local conversation") &&
      bodyText().includes("Delete conversation"),
    "conversation context delete menu",
  );
  const sawContextMenuDelete = bodyText().includes("Local conversation");
  await clickButton("Delete conversation");
  await waitFor(
    () => bodyText().includes("This removes the conversation"),
    "right-click delete confirmation modal",
  );
  await clickModalButton("Cancel");
  await clickNamedButton("Copy response");
  await waitFor(() => bodyText().includes("Copied"), "copied response feedback");
  const sawAnswer = bodyText().includes("WIN-01 is stale");
  const sawConversationLifecycle =
    bodyText().includes("Smoke lifecycle review") && bodyText().includes("Unpin");
  const sawSourceDetails = bodyText().includes("/deviceManagement/managedDevices");
  const sawEditResend = (() => {
    const textarea = document.querySelector("textarea");
    return textarea instanceof HTMLTextAreaElement &&
      textarea.value.includes("Use the attached workspace context");
  })();

  location.hash = "/settings/chat";
  await waitFor(
    () => bodyText().includes("Settings") && bodyText().includes("Accept"),
    "self-training suggestion",
  );
  await clickButton("Accept");
  await waitFor(() => bodyText().includes("Active overlays"), "accepted self-training overlay");
  await waitFor(
    () =>
      bodyText().includes("Local data") &&
      bodyText().includes("SQLite store") &&
      bodyText().includes("Clear active tenant cache"),
    "local data controls",
  );
  const sawLocalDataControls =
    bodyText().includes("Local data") &&
    bodyText().includes("SQLite store") &&
    bodyText().includes("Clear chat history");
  await clickButton("Clear active tenant cache");
  await waitFor(
    () =>
      bodyText().includes("Local SQLite cleanup") &&
      bodyText().includes("cached Graph rows and cache status"),
    "clear active tenant cache modal",
  );
  const sawLocalDataClearModal =
    bodyText().includes("Local SQLite cleanup") &&
    bodyText().includes("cached Graph rows and cache status");
  await clickModalButton("Cancel");

  return {
    hash: location.hash,
    hasAnswer: sawAnswer,
    hasAgentSuggestion: sawAgentSuggestion,
    hasDirectChatFrontDoor: sawDirectChatFrontDoor,
    hasConversationLifecycle: sawConversationLifecycle,
    hasSourceDetails: sawSourceDetails,
    hasEditResend: sawEditResend,
    hasRegenerate: sawRegenerate,
    hasStopGeneration: sawStopGeneration,
    hasWorkspacePin: sawWorkspacePin,
    hasWorkspaceContextAttachment: sawWorkspaceContextAttachment,
    hasPinnedCategory: sawPinnedCategory,
    hasContextMenuDelete: sawContextMenuDelete,
    hasAcceptedLearning: bodyText().includes("Active overlays"),
    hasScheduledRefresh: bodyText().includes("Enabled"),
    hasLocalDataControls: sawLocalDataControls,
    hasLocalDataClearModal: sawLocalDataClearModal,
    hasMultiTenantScopeReview: sawMultiTenantScopeReview,
    hasMultiTenantResult: sawMultiTenantResult,
    hasSplitToWorkspaces: sawSplitToWorkspaces,
  };
}

async function reportIssueSmokeScript(): Promise<Record<string, unknown>> {
  const waitFor = async (
    predicate: () => boolean,
    label: string,
    timeoutMs = 12000,
  ) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `Timed out waiting for ${label}. Current page text: ${(document.body.textContent ?? "").slice(0, 1400)}`,
    );
  };
  const bodyText = () => document.body.textContent ?? "";
  const findButton = (label: string): HTMLButtonElement | undefined =>
    Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.trim().includes(label),
    );
  const clickButton = async (label: string) => {
    await waitFor(() => {
      const button = findButton(label);
      return Boolean(button && !button.disabled);
    }, `${label} button`);
    findButton(label)?.click();
  };
  const setInput = async (value: string) => {
    await waitFor(
      () => Boolean(document.querySelector(".fixed input[type='text'], .fixed input:not([type])")),
      "modal title input",
    );
    const input = document.querySelector(".fixed input[type='text'], .fixed input:not([type])");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("Report title input was not found.");
    }
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.focus();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => input.value === value, "report title value");
  };
  const setTextarea = async (index: number, value: string) => {
    await waitFor(
      () => document.querySelectorAll(".fixed textarea").length > index,
      `modal textarea ${index}`,
    );
    const textarea = document.querySelectorAll(".fixed textarea")[index];
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error(`Report textarea ${index} was not found.`);
    }
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(textarea, value);
    textarea.focus();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => textarea.value === value, `report textarea ${index} value`);
  };
  const clickCheckbox = async (index: number) => {
    await waitFor(
      () => document.querySelectorAll(".fixed input[type='checkbox']").length > index,
      `modal checkbox ${index}`,
    );
    const checkbox = document.querySelectorAll(".fixed input[type='checkbox']")[index];
    if (!(checkbox instanceof HTMLInputElement)) {
      throw new Error(`Report checkbox ${index} was not found.`);
    }
    checkbox.click();
    await waitFor(() => checkbox.checked, `modal checkbox ${index} checked`);
  };

  await waitFor(
    () => bodyText().includes("What do you want to inspect?"),
    "initial Chat route",
  );
  location.hash = "/settings/about";
  await waitFor(() => location.hash === "#/settings/about", "About settings hash");
  await waitFor(
    () =>
      bodyText().includes("Settings") &&
      bodyText().includes("OpenAdminOS is open-source and community-driven."),
    "About settings",
  );
  await clickButton("Create issue");
  await waitFor(
    () =>
      bodyText().includes("Submit a public GitHub issue") &&
      bodyText().includes("This creates a public GitHub issue") &&
      bodyText().includes("repo-scoped token"),
    "report issue modal",
  );
  await setInput("Smoke report issue");
  await setTextarea(0, "The report issue smoke flow should submit a public GitHub issue.");
  await setTextarea(
    1,
    "1. Open Settings and select About.\n2. Select Create issue and fill the modal.\n3. Confirm public issue creation.",
  );
  await setTextarea(
    2,
    "A public GitHub issue is created after explicit confirmation.",
  );
  await setTextarea(3, "The public issue was not created.");
  await clickButton("Export diagnostics JSON");
  await waitFor(
    () => bodyText().includes("Diagnostics file exported locally"),
    "diagnostics export notice",
  );
  await clickCheckbox(1);
  await clickButton("Submit public issue");
  await waitFor(
    () =>
      bodyText().includes("Public GitHub issue #12345 created") &&
      bodyText().includes("Open issue"),
    "public issue created notice",
  );

  return {
    hasSettingsAction: bodyText().includes("Public GitHub issue"),
    hasModalPrivacyCopy: bodyText().includes("This creates a public GitHub issue"),
    hasPublicConfirmation: bodyText().includes("I understand this creates a public GitHub issue"),
    hasCreatedIssueNotice: bodyText().includes("Public GitHub issue #12345 created"),
  };
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

function macosCompanionHelperBundlePath(): string {
  return join(
    dirname(process.execPath),
    "..",
    "Library",
    "LoginItems",
    MACOS_COMPANION_HELPER_APP,
  );
}

function hasPackagedCompanionHelper(): boolean {
  if (process.platform !== "darwin" || !app.isPackaged) return false;
  return existsSync(
    join(
      macosCompanionHelperBundlePath(),
      "Contents",
      "Info.plist",
    ),
  );
}

function companionLoginItemOptions(): LoginItemSettingsOptions | undefined {
  if (!hasPackagedCompanionHelper()) return undefined;
  return {
    type: "loginItemService",
    serviceName: MACOS_COMPANION_LOGIN_ITEM_ID,
  };
}

function getCompanionLaunchSettings(): CompanionLaunchSettings {
  if (process.platform !== "darwin") {
    return {
      supported: false,
      enabled: false,
      detail: "The menu bar companion is bundled for macOS only.",
    };
  }

  try {
    const helperBundled = hasPackagedCompanionHelper();
    const options = companionLoginItemOptions();
    const settings = options
      ? app.getLoginItemSettings(options)
      : app.getLoginItemSettings();
    const enabled =
      settings.openAtLogin ||
      settings.status === "enabled" ||
      settings.status === "requires-approval";
    return {
      supported: true,
      enabled,
      status: settings.status,
      helperBundled,
      startedAtLogin: settings.wasOpenedAtLogin,
      detail:
        settings.status === "requires-approval"
          ? "macOS has registered OpenAdminOS but still requires approval in Login Items before it can start automatically."
          : helperBundled
            ? enabled
              ? "OpenAdminOS Menu Bar Helper starts at login and opens the signed app in menu bar mode."
              : "OpenAdminOS can register the bundled menu bar helper as a macOS Login Item."
            : enabled
              ? "OpenAdminOS starts at login and keeps the menu bar companion available without opening the main window."
              : "OpenAdminOS can start at login and keep the menu bar companion available from the signed app package.",
    };
  } catch (error) {
    return {
      supported: false,
      enabled: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function setCompanionLaunchEnabled(enabled: boolean): CompanionLaunchSettings {
  if (process.platform !== "darwin") {
    throw new Error("The menu bar companion is available on macOS only.");
  }
  const options = companionLoginItemOptions();
  app.setLoginItemSettings(
    options
      ? {
          openAtLogin: enabled,
          ...options,
        }
      : {
          openAtLogin: enabled,
        },
  );
  if (enabled) createMenuBarCompanion();
  return getCompanionLaunchSettings();
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
  const sandboxSettings = await getSandboxSettings();
  return {
    appVersion: app.getVersion(),
    packaged: app.isPackaged,
    signed: app.isPackaged,
    platform,
    notificationSupported: Notification.isSupported(),
    notificationPermission,
    scheduler: await getSchedulerLaunchSettings(),
    companion: getCompanionLaunchSettings(),
    sandbox: sandboxSettings.diagnostics,
  };
}

async function getSandboxSettings(): Promise<SandboxSettings> {
  const enabled = await store.getSandboxedCodeEnabled();
  applySandboxedCodeEnabled(enabled);
  return {
    enabled,
    diagnostics: await probeMxcSandbox(),
  };
}

async function setSandboxedCodeEnabled(enabled: boolean): Promise<SandboxSettings> {
  await store.setSandboxedCodeEnabled(enabled);
  applySandboxedCodeEnabled(enabled);
  return getSandboxSettings();
}

function applySandboxedCodeEnabled(enabled: boolean): void {
  if (enabled) {
    process.env[OPENADMINOS_MXC_FLAG] = "1";
  } else {
    delete process.env[OPENADMINOS_MXC_FLAG];
  }
}

async function getCompanionSnapshot(): Promise<CompanionSnapshot> {
  const state = await store.getAppState();
  const activeTenant = state.activeTenantId
    ? state.tenants.find((tenant) => tenant.id === state.activeTenantId) ?? null
    : null;
  const activeProvider =
    state.providers.find((provider) => provider.id === state.activeProviderId) ?? null;
  const activeModel = activeProvider
    ? state.activeModelByProviderId?.[activeProvider.id] ?? activeProvider.defaultModel
    : undefined;
  const scheduler = await getSchedulerLaunchSettings();
  const cacheStatus = activeTenant
    ? await store.getGraphCacheStatus(activeTenant.id).catch(() => null)
    : null;
  const refreshedAt = cacheStatus?.resources
    .map((resource) => resource.refreshedAt)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  const nowMs = Date.now();
  const inFlight = state.runs
    .filter((run) =>
      run.status === "queued" ||
      run.status === "running" ||
      run.status === "awaiting-confirmation"
    )
    .slice(0, 5)
    .map((run) => ({
      id: run.id,
      kind: "run" as const,
      label: agentNameForRun(state.installedAgents, run),
      status: run.status,
      route: `/runs/${run.id}`,
    }));
  const upcomingSchedules = state.installedAgents
    .filter((agent) => agent.schedule?.enabled === true)
    .map((agent) => {
      const latest = latestScheduledRunForAgent(state.runs, agent.slug);
      return {
        agentSlug: agent.slug,
        agentName: agent.name,
        mode: agent.mode,
        nextRunAt: new Date(nextRunTimeForSchedule(agent.schedule, nowMs)).toISOString(),
        intervalSeconds: agent.schedule?.intervalSeconds ?? 3600,
        ...(latest?.status ? { lastStatus: latest.status } : {}),
        ...(latest?.changeState ? { changeState: latest.changeState } : {}),
        route: `/agents/${agent.slug}`,
      };
    })
    .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))
    .slice(0, 5);
  const recentActivity = state.runs
    .filter((run) => run.status !== "failed")
    .slice(0, 6)
    .map((run) => ({
      id: run.id,
      label: agentNameForRun(state.installedAgents, run),
      status: run.status,
      queuedAt: run.queuedAt,
      ...(run.summary ? { summary: run.summary } : {}),
      route: `/runs/${run.id}`,
    }));

  return {
    activeTenant: activeTenant
      ? { id: activeTenant.id, displayName: activeTenant.displayName }
      : null,
    provider: activeProvider
      ? {
          id: activeProvider.id,
          label: activeProvider.name,
          isLocal: activeProvider.isLocal,
          trustLabel: state.trust.label,
          ...(activeModel ? { model: activeModel } : {}),
          status: activeProvider.status,
        }
      : null,
    cache: {
      ...(refreshedAt ? { latestRefreshAt: refreshedAt } : {}),
      stale: !refreshedAt || nowMs - Date.parse(refreshedAt) > 24 * 60 * 60 * 1000,
      refreshing: false,
    },
    scheduler,
    companion: getCompanionLaunchSettings(),
    inFlight,
    upcomingSchedules,
    recentActivity,
    attention: [],
  };
}

async function runDueReadSchedules(): Promise<CompanionRunDueReadSchedulesResult> {
  const state = await store.getAppState();
  const nowMs = Date.now();
  const result: CompanionRunDueReadSchedulesResult = {
    queued: 0,
    skippedWrite: 0,
    skippedInFlight: 0,
    skippedNotDue: 0,
    errors: [],
  };

  for (const agent of state.installedAgents) {
    const schedule = agent.schedule;
    if (!schedule?.enabled) continue;
    if (agent.mode === "write") {
      result.skippedWrite += 1;
      continue;
    }
    const dueAt = nextRunTimeForSchedule(schedule, nowMs);
    if (dueAt > nowMs) {
      result.skippedNotDue += 1;
      continue;
    }
    const inFlight = state.runs.some(
      (run) =>
        run.agentSlug === agent.slug &&
        (run.status === "queued" ||
          run.status === "running" ||
          run.status === "awaiting-confirmation"),
    );
    if (inFlight) {
      result.skippedInFlight += 1;
      continue;
    }

    try {
      await store.startRun(agent.slug, { trigger: "schedule" });
      await store.updateAgentSchedule(agent.slug, {
        enabled: true,
        intervalSeconds: schedule.intervalSeconds,
        notifyOnSuccess: schedule.notifyOnSuccess,
        notifyOnFailure: schedule.notifyOnFailure,
        notifyOnChangeOnly: schedule.notifyOnChangeOnly,
        lastScheduledRunAt: new Date(nowMs).toISOString(),
      });
      result.queued += 1;
    } catch (error) {
      result.errors.push({
        agentSlug: agent.slug,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

function nextRunTimeForSchedule(
  schedule: AgentSchedule | undefined,
  nowMs = Date.now(),
): number {
  if (!schedule?.enabled) return Number.POSITIVE_INFINITY;
  const lastFired = schedule.lastScheduledRunAt
    ? new Date(schedule.lastScheduledRunAt).getTime()
    : 0;
  if (lastFired <= 0) return nowMs;
  return lastFired + schedule.intervalSeconds * 1000;
}

function latestScheduledRunForAgent(
  runs: RunRecord[],
  agentSlug: string,
): RunRecord | undefined {
  return runs
    .filter((run) => run.agentSlug === agentSlug && run.trigger === "schedule")
    .sort((a, b) => Date.parse(b.queuedAt) - Date.parse(a.queuedAt))[0];
}

function agentNameForRun(
  agents: Array<{ slug: string; name: string }>,
  run: RunRecord,
): string {
  return agents.find((agent) => agent.slug === run.agentSlug)?.name ?? run.agentSlug;
}

async function exportSupportBundle(
  input: SupportBundleInput,
): Promise<{ canceled: boolean; filePath?: string }> {
  if (supportBundleExportFile) {
    const bundle = await createSupportBundle(input);
    await writeFile(supportBundleExportFile, JSON.stringify(bundle, null, 2), "utf8");
    return { canceled: false, filePath: supportBundleExportFile };
  }

  const parent = mainWindow ?? undefined;
  const defaultPath = `openadminos-diagnostics-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.json`;
  const result = parent
    ? await dialog.showSaveDialog(parent, {
        title: "Export diagnostics",
        defaultPath,
        filters: [{ name: "JSON diagnostics", extensions: ["json"] }],
      })
    : await dialog.showSaveDialog({
        title: "Export diagnostics",
        defaultPath,
        filters: [{ name: "JSON diagnostics", extensions: ["json"] }],
      });
  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

  const bundle = await createSupportBundle(input);
  await writeFile(result.filePath, JSON.stringify(bundle, null, 2), "utf8");
  return { canceled: false, filePath: result.filePath };
}

async function submitSupportIssue(
  input: SupportIssueSubmissionInput,
): Promise<SupportIssueSubmissionResult> {
  const baseUrl = supportApiBaseUrl();
  if (!baseUrl) {
    throw new Error("Support issue endpoint is not configured in this build.");
  }

  const diagnostics = input.includeDiagnostics
    ? await createSupportBundle(input)
    : undefined;
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/support-issues`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      confirmPublic: true,
      issue: {
        title: input.title,
        description: input.description,
        stepsToReproduce: input.stepsToReproduce,
        expectedBehavior: input.expectedBehavior,
        actualBehavior: input.actualBehavior,
        source: input.source ?? "sidebar",
        appVersion: app.getVersion(),
      },
      diagnostics,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const message =
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof parsed.error === "string"
        ? parsed.error
        : `Support issue submission failed with HTTP ${response.status}.`;
    throw new Error(message);
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("issueUrl" in parsed) ||
    typeof parsed.issueUrl !== "string" ||
    !("issueNumber" in parsed) ||
    typeof parsed.issueNumber !== "number"
  ) {
    throw new Error("Support issue endpoint returned an invalid response.");
  }

  return {
    issueUrl: parsed.issueUrl,
    issueNumber: parsed.issueNumber,
  };
}

function supportApiBaseUrl(): string {
  if (typeof process.env.OPENAGENTS_STATS_API === "string") {
    return process.env.OPENAGENTS_STATS_API;
  }
  return app.isPackaged ? DEFAULT_SUPPORT_API_URL : "";
}

async function createSupportBundle(input: SupportBundleInput) {
  const state = await store.getAppState();
  const releaseDiagnostics = await getReleaseDiagnostics();
  const activeProvider = state.providers.find(
    (provider) => provider.id === state.activeProviderId,
  );
  const runFailures = state.runs
    .filter((run) => run.status === "failed")
    .sort(
      (a, b) =>
        Date.parse(b.finishedAt ?? b.queuedAt) -
        Date.parse(a.finishedAt ?? a.queuedAt),
    )
    .slice(0, 5);

  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    notice:
      "Generated locally by OpenAdminOS for support review. Exported files stay local; public issue submission sends this summary only after explicit confirmation.",
    issueContext: {
      source: input.source ?? "sidebar",
      titleLength: input.title.length,
      descriptionLength: input.description.length,
      hasStepsToReproduce: Boolean(input.stepsToReproduce?.trim()),
      hasExpectedBehavior: Boolean(input.expectedBehavior?.trim()),
      hasActualBehavior: Boolean(input.actualBehavior?.trim()),
      ...(input.agentSlug ? { agentSlugHash: diagnosticHash(input.agentSlug) } : {}),
      ...(input.runId ? { runIdHash: diagnosticHash(input.runId) } : {}),
    },
    app: {
      version: releaseDiagnostics.appVersion,
      packaged: releaseDiagnostics.packaged,
      signed: releaseDiagnostics.signed,
      platform: releaseDiagnostics.platform,
      processPlatform: process.platform,
      processArch: process.arch,
      osArch: osArch(),
      osRelease: osRelease(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
    },
    privacy: {
      tenantIdentifiersIncluded: false,
      promptsIncluded: false,
      graphResponsesIncluded: false,
      runResultsIncluded: false,
      runLogsIncluded: false,
      screenshotsIncluded: false,
      automaticUploadByOpenAdminOS: false,
      publicIssueSubmissionRequiresConfirmation: true,
    },
    state: {
      activeProvider: activeProvider
        ? {
            id: activeProvider.id,
            isLocal: activeProvider.isLocal,
            status: activeProvider.status,
            modelCount: activeProvider.models.length,
            hasDefaultModel: Boolean(activeProvider.defaultModel),
            detailCategory: classifyDiagnosticText(activeProvider.detail),
            detailHash: diagnosticHash(activeProvider.detail),
          }
        : null,
      providers: state.providers.map((provider) => ({
        id: provider.id,
        isLocal: provider.isLocal,
        status: provider.status,
        modelCount: provider.models.length,
        hasDefaultModel: Boolean(provider.defaultModel),
        detailCategory: classifyDiagnosticText(provider.detail),
        detailHash: diagnosticHash(provider.detail),
      })),
      tenants: {
        connectedCount: state.tenants.length,
        hasActiveTenant: Boolean(state.activeTenantId),
      },
      agents: {
        installedCount: state.installedAgents.length,
        registryCount: state.registryAgents.length,
        scheduledCount: state.installedAgents.filter(
          (agent) => agent.schedule?.enabled === true,
        ).length,
      },
      registry: {
        sourceKind:
          state.registrySource === DEFAULT_REGISTRY_SOURCE ? "official" : "custom",
        lastRefresh: state.lastRegistryRefresh,
        refreshErrorCategory: classifyDiagnosticText(state.registryRefreshError),
        refreshErrorHash: diagnosticHash(state.registryRefreshError),
        installCountsEnabled: state.registryInstallCountsEnabled,
      },
      scheduler: {
        supported: state.schedulerStatus?.supported ?? releaseDiagnostics.scheduler.supported,
        enabled: releaseDiagnostics.scheduler.enabled,
        requiresTenant: releaseDiagnostics.scheduler.requiresTenant,
        activeScheduleCount:
          state.schedulerStatus?.activeScheduleCount ??
          releaseDiagnostics.scheduler.activeScheduleCount,
        lastWakeAt:
          state.schedulerStatus?.lastWakeAt ?? releaseDiagnostics.scheduler.lastWakeAt,
        lastSuccessAt:
          state.schedulerStatus?.lastSuccessAt ??
          releaseDiagnostics.scheduler.lastSuccessAt,
        nextDueAt:
          state.schedulerStatus?.nextDueAt ?? releaseDiagnostics.scheduler.nextDueAt,
        lastErrorCategory: classifyDiagnosticText(
          state.schedulerStatus?.lastError ?? releaseDiagnostics.scheduler.lastError,
        ),
        lastErrorHash: diagnosticHash(
          state.schedulerStatus?.lastError ?? releaseDiagnostics.scheduler.lastError,
        ),
      },
      companion: {
        supported: releaseDiagnostics.companion.supported,
        enabled: releaseDiagnostics.companion.enabled,
        status: releaseDiagnostics.companion.status,
        helperBundled: releaseDiagnostics.companion.helperBundled,
        startedAtLogin: releaseDiagnostics.companion.startedAtLogin,
      },
      runs: summarizeRuns(state.runs),
      recentFailures: runFailures.map((run) => ({
        runIdHash: diagnosticHash(run.id),
        agentSlugHash: diagnosticHash(run.agentSlug),
        trigger: run.trigger ?? "manual",
        providerId: run.providerId,
        queuedAt: run.queuedAt,
        finishedAt: run.finishedAt,
        failedStepCount: run.steps.filter((step) => step.status === "failed").length,
        errorLogCount: run.logs.filter((log) => log.level === "error").length,
        errorCategory: classifyDiagnosticText(run.error),
        errorHash: diagnosticHash(run.error),
      })),
      graphCache: await graphCacheDiagnostics(state.activeTenantId),
    },
    excluded:
      [
        "tenant ids, tenant names, tenant domains, account usernames, and UPNs",
        "Microsoft Graph response bodies and cached rows",
        "LLM prompts, LLM outputs, chat transcripts, run reports, and raw run logs",
        "provider API keys, MSAL tokens, keychain values, local SQLite databases",
        "screenshots and session replay",
      ],
  };
}

async function graphCacheDiagnostics(activeTenantId: string | undefined) {
  if (!activeTenantId) {
    return { available: false, reason: "no-active-tenant" };
  }
  try {
    const cache = await store.getGraphCacheStatus(activeTenantId);
    return {
      available: true,
      resourceCount: cache.resources.length,
      schedule: cache.schedule
        ? {
            enabled: cache.schedule.enabled,
            intervalMinutes: cache.schedule.intervalMinutes,
            updatedAt: cache.schedule.updatedAt,
            lastRunAt: cache.schedule.lastRunAt,
            lastSuccessAt: cache.schedule.lastSuccessAt,
            nextRunAt: cache.schedule.nextRunAt,
            lastErrorCategory: classifyDiagnosticText(cache.schedule.lastError),
            lastErrorHash: diagnosticHash(cache.schedule.lastError),
          }
        : undefined,
      resources: cache.resources.map((resource) => ({
        resource: resource.resource,
        rows: resource.rows,
        pages: resource.pages,
        pageLimitReached: resource.pageLimitReached,
        refreshedAt: resource.refreshedAt,
        scopeCount: resource.scopeSet.length,
        lastErrorCategory: classifyDiagnosticText(resource.lastError),
        lastErrorHash: diagnosticHash(resource.lastError),
      })),
    };
  } catch (error) {
    return {
      available: false,
      reason: "status-unavailable",
      errorCategory: classifyDiagnosticText(error),
      errorHash: diagnosticHash(error),
    };
  }
}

function summarizeRuns(runs: RunRecord[]) {
  const byStatus: Record<RunRecord["status"], number> = {
    queued: 0,
    running: 0,
    "awaiting-confirmation": 0,
    completed: 0,
    failed: 0,
    rejected: 0,
    cancelled: 0,
  };
  const byTrigger: Record<"manual" | "schedule", number> = {
    manual: 0,
    schedule: 0,
  };
  let latestRunAt: string | undefined;

  for (const run of runs) {
    byStatus[run.status] += 1;
    byTrigger[run.trigger ?? "manual"] += 1;
    const stamp = run.finishedAt ?? run.startedAt ?? run.queuedAt;
    if (!latestRunAt || Date.parse(stamp) > Date.parse(latestRunAt)) {
      latestRunAt = stamp;
    }
  }

  return {
    total: runs.length,
    byStatus,
    byTrigger,
    latestRunAt,
  };
}

function classifyDiagnosticText(value: unknown): string | undefined {
  const text = redactedDiagnosticText(value, 500).toLowerCase();
  if (!text) return undefined;
  if (/ollama/.test(text)) return "ollama";
  if (/codex|openai/.test(text)) return "openai-codex";
  if (/apple foundation|foundation model/.test(text)) return "apple-foundation";
  if (/401|unauthor|expired|interaction_required|token/.test(text)) return "auth";
  if (/403|forbidden|insufficient|scope|consent/.test(text)) return "permission";
  if (/429|throttl|rate limit/.test(text)) return "rate-limit";
  if (/timeout|timed out|abort/.test(text)) return "timeout";
  if (/network|offline|econn|enotfound|fetch|dns/.test(text)) return "network";
  if (/yaml|manifest|schema|invalid|parse/.test(text)) return "validation";
  if (/scheduler|launchagent|task scheduler|launchctl/.test(text)) return "scheduler";
  if (/registry|github|manifesturl/.test(text)) return "registry";
  return "other";
}

function diagnosticHash(value: unknown): string | undefined {
  const text = redactedDiagnosticText(value, 1_000);
  if (!text) return undefined;
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function redactedDiagnosticText(value: unknown, maxLength: number): string {
  const raw =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : "";
  if (!raw.trim()) return "";
  const home = app.getPath("home");
  return raw
    .replaceAll(home, "~")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[guid]")
    .replace(/\b[A-Za-z0-9-]+\.onmicrosoft\.com\b/gi, "[tenant-domain]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g, "[domain]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
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
    if (!(await store.hasEnabledBackgroundWork())) return;
    const settings = await getSchedulerLaunchSettings();
    if (!settings.supported || settings.enabled) return;
    await setSchedulerLaunchEnabled(true);
  } catch (error) {
    console.warn(`[scheduler] OS registration after ${trigger} failed:`, error);
  }
}

async function unregisterSchedulerIfUnused(): Promise<void> {
  try {
    if (await store.hasEnabledBackgroundWork()) return;
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
      if (capturedExternalUrlFile) {
        writeFileSync(capturedExternalUrlFile, parsed.toString(), "utf8");
        return;
      }
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

function requireTrustedIpcSender(event: IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  if (!isAllowedAppNavigation(senderUrl)) {
    throw new Error("Rejected IPC call from an untrusted renderer frame.");
  }
}

function handleTrusted<TArgs extends unknown[], TResult>(
  handler: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult,
): (event: IpcMainInvokeEvent, ...args: TArgs) => TResult {
  return (event, ...args) => {
    requireTrustedIpcSender(event);
    return handler(event, ...args);
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function requireBoundedString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${name} must not be empty.`);
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${name} is too long.`);
  }
  return trimmed;
}

function requireAgentSlug(value: unknown, name = "agentSlug"): string {
  const slug = requireBoundedString(value, name, 128);
  if (!agentSlugPattern.test(slug)) {
    throw new Error(`${name} must be a lowercase agent slug.`);
  }
  return slug;
}

function optionalBoundedString(
  value: unknown,
  name: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireBoundedString(value, name, maxLength);
}

function optionalTextString(
  value: unknown,
  name: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string.`);
  }
  if (value.length > maxLength) {
    throw new Error(`${name} is too long.`);
  }
  return value;
}

function boundedTextString(
  value: unknown,
  name: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string.`);
  }
  if (value.length > maxLength) {
    throw new Error(`${name} is too long.`);
  }
  return value;
}

function validateAzureOpenAIConfigInput(
  value: unknown,
): SetAzureOpenAIProviderConfigInput {
  if (!isPlainRecord(value)) {
    throw new Error("Azure OpenAI config must be an object.");
  }
  const input: SetAzureOpenAIProviderConfigInput = {
    endpoint: boundedTextString(value.endpoint, "Azure OpenAI endpoint", 500),
    deployment: boundedTextString(value.deployment, "Azure OpenAI deployment", 200),
    apiVersion: boundedTextString(value.apiVersion, "Azure OpenAI API version", 64),
  };
  if (Object.prototype.hasOwnProperty.call(value, "apiKey")) {
    if (value.apiKey === null) {
      input.apiKey = null;
    } else {
      input.apiKey = boundedTextString(value.apiKey, "Azure OpenAI API key", 20_000);
    }
  }
  return input;
}

function validateSetRegistrySourceOptions(
  value: unknown,
): { confirmExternalSource?: boolean } {
  if (value === undefined || value === null) return {};
  if (!isPlainRecord(value)) {
    throw new Error("registry source options must be an object.");
  }
  return value.confirmExternalSource === true
    ? { confirmExternalSource: true }
    : {};
}

function validateJsonRecord(
  value: unknown,
  name: string,
  maxBytes: number,
): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new Error(`${name} must be an object.`);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${name} must be JSON-serializable.`);
  }
  if (serialized === undefined) {
    throw new Error(`${name} must be JSON-serializable.`);
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new Error(`${name} is too large.`);
  }
  return value;
}

function validateConnectorSecretValue(value: unknown): string | null {
  if (value === null) return null;
  return requireBoundedString(value, "connector secret", 20_000);
}

function validateConnectorDecision(value: unknown): PendingConnectorDecision {
  if (!isPlainRecord(value)) {
    throw new Error("connector decision must be an object.");
  }
  if (value.approved === true) {
    return { approved: true };
  }
  if (value.approved === false) {
    return {
      approved: false,
      reason: requireBoundedString(value.reason, "connector decision reason", 500),
    };
  }
  throw new Error("connector decision must include approved true or false.");
}

function validateAgentUpdateOptions(
  value: unknown,
): { confirmTrustChanges?: boolean } | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainRecord(value)) {
    throw new Error("agent update options must be an object.");
  }
  return value.confirmTrustChanges === true
    ? { confirmTrustChanges: true }
    : {};
}

function validateActiveModel(value: unknown): string | null {
  if (value === null) return null;
  return requireBoundedString(value, "model", 256);
}

function validateStartRunOptions(value: unknown): StartRunOptions | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainRecord(value)) {
    throw new Error("start run options must be an object.");
  }
  const options: StartRunOptions = {};
  if (value.tenantId !== undefined) {
    options.tenantId = requireBoundedString(value.tenantId, "startRun.tenantId", 256);
  }
  if (value.providerId !== undefined) {
    options.providerId = validateProviderId(value.providerId, "startRun.providerId");
  }
  if (value.model !== undefined) {
    options.model = requireBoundedString(value.model, "startRun.model", 256);
  }
  if (value.trigger !== undefined) {
    if (value.trigger !== "manual" && value.trigger !== "schedule") {
      throw new Error("startRun.trigger must be manual or schedule.");
    }
    options.trigger = value.trigger;
  }
  if (value.source !== undefined) {
    if (!isPlainRecord(value.source)) {
      throw new Error("startRun.source must be an object.");
    }
    if (value.source.type !== "intune-chat") {
      throw new Error("startRun.source.type is not supported.");
    }
    options.source = {
      type: "intune-chat",
      conversationId: requireBoundedString(
        value.source.conversationId,
        "startRun.source.conversationId",
        256,
      ),
      ...(value.source.messageId !== undefined
        ? {
            messageId: requireBoundedString(
              value.source.messageId,
              "startRun.source.messageId",
              256,
            ),
          }
        : {}),
    };
  }
  return options;
}

function validateAgentSchedule(value: unknown): AgentSchedule | null {
  if (value === null) return null;
  if (!isPlainRecord(value)) {
    throw new Error("agent schedule must be an object or null.");
  }
  const intervalSeconds = value.intervalSeconds;
  if (
    typeof intervalSeconds !== "number" ||
    !Number.isFinite(intervalSeconds) ||
    intervalSeconds < 60 ||
    intervalSeconds > 31_536_000
  ) {
    throw new Error("agent schedule intervalSeconds must be between 60 and 31536000.");
  }
  if (typeof value.enabled !== "boolean") {
    throw new Error("agent schedule enabled must be a boolean.");
  }
  const schedule: AgentSchedule = {
    enabled: value.enabled,
    intervalSeconds,
  };
  for (const key of ["notifyOnSuccess", "notifyOnFailure", "notifyOnChangeOnly"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "boolean") {
        throw new Error(`agent schedule ${key} must be a boolean.`);
      }
      schedule[key] = value[key];
    }
  }
  if (value.lastScheduledRunAt !== undefined) {
    const lastScheduledRunAt = requireBoundedString(
      value.lastScheduledRunAt,
      "agent schedule lastScheduledRunAt",
      64,
    );
    if (!Number.isFinite(Date.parse(lastScheduledRunAt))) {
      throw new Error("agent schedule lastScheduledRunAt must be an ISO timestamp.");
    }
    schedule.lastScheduledRunAt = lastScheduledRunAt;
  }
  return schedule;
}

function validateAgentTeamsDelivery(value: unknown): AgentTeamsDelivery | null {
  if (value === null) return null;
  if (!isPlainRecord(value)) {
    throw new Error("agent Teams delivery must be an object or null.");
  }
  const delivery: AgentTeamsDelivery = {
    enabled: value.enabled === true,
  };
  for (const key of [
    "useDefaultTarget",
    "includeManualRuns",
    "includeScheduledRuns",
    "notifyOnSuccess",
    "notifyOnFailure",
    "notifyOnChangeOnly",
  ] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "boolean") {
        throw new Error(`agent Teams delivery ${key} must be a boolean.`);
      }
      delivery[key] = value[key];
    }
  }
  for (const key of ["teamId", "channelId", "teamName", "channelName"] as const) {
    if (value[key] !== undefined) {
      delivery[key] = requireBoundedString(
        value[key],
        `agent Teams delivery ${key}`,
        256,
      );
    }
  }
  return delivery;
}

function validateAgentWhatsAppWebDelivery(
  value: unknown,
): AgentWhatsAppWebDelivery | null {
  if (value === null) return null;
  if (!isPlainRecord(value)) {
    throw new Error("agent WhatsApp Web delivery must be an object or null.");
  }
  const delivery: AgentWhatsAppWebDelivery = {
    enabled: value.enabled === true,
  };
  for (const key of [
    "useDefaultRecipient",
    "includeManualRuns",
    "includeScheduledRuns",
    "notifyOnSuccess",
    "notifyOnFailure",
    "notifyOnChangeOnly",
  ] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "boolean") {
        throw new Error(`agent WhatsApp Web delivery ${key} must be a boolean.`);
      }
      delivery[key] = value[key];
    }
  }
  for (const key of ["recipient", "recipientLabel"] as const) {
    if (value[key] !== undefined) {
      delivery[key] = requireBoundedString(
        value[key],
        `agent WhatsApp Web delivery ${key}`,
        256,
      );
    }
  }
  if (value.recipientType !== undefined) {
    if (
      value.recipientType !== "self" &&
      value.recipientType !== "group" &&
      value.recipientType !== "manual"
    ) {
      throw new Error("agent WhatsApp Web delivery recipientType is invalid.");
    }
    delivery.recipientType = value.recipientType;
  }
  return delivery;
}

type ValidatedAgentDeliveryBase = {
  enabled: boolean;
  includeManualRuns?: boolean;
  includeScheduledRuns?: boolean;
  notifyOnSuccess?: boolean;
  notifyOnFailure?: boolean;
  notifyOnChangeOnly?: boolean;
};

function validateAgentDeliveryRecord(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new Error(`${name} must be an object or null.`);
  }
  return value;
}

function readAgentDeliveryBase(
  value: Record<string, unknown>,
  name: string,
): ValidatedAgentDeliveryBase {
  const delivery: ValidatedAgentDeliveryBase = {
    enabled: value.enabled === true,
  };
  for (const key of [
    "includeManualRuns",
    "includeScheduledRuns",
    "notifyOnSuccess",
    "notifyOnFailure",
    "notifyOnChangeOnly",
  ] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "boolean") {
        throw new Error(`${name} ${key} must be a boolean.`);
      }
      delivery[key] = value[key];
    }
  }
  return delivery;
}

function assignOptionalBoolean(
  delivery: object,
  value: Record<string, unknown>,
  key: string,
  name: string,
): void {
  if (value[key] === undefined) return;
  if (typeof value[key] !== "boolean") {
    throw new Error(`${name} ${key} must be a boolean.`);
  }
  (delivery as Record<string, unknown>)[key] = value[key];
}

function assignOptionalStrings(
  delivery: object,
  value: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): void {
  for (const key of keys) {
    if (value[key] !== undefined) {
      (delivery as Record<string, unknown>)[key] = requireBoundedString(
        value[key],
        `${name} ${key}`,
        256,
      );
    }
  }
}

function validateAgentOutlookDelivery(value: unknown): AgentOutlookDelivery | null {
  if (value === null) return null;
  const record = validateAgentDeliveryRecord(value, "agent Outlook delivery");
  const delivery: AgentOutlookDelivery = readAgentDeliveryBase(
    record,
    "agent Outlook delivery",
  );
  assignOptionalBoolean(delivery, record, "useDefaultRecipients", "agent Outlook delivery");
  if (record.recipients !== undefined) {
    if (!Array.isArray(record.recipients)) {
      throw new Error("agent Outlook delivery recipients must be an array.");
    }
    delivery.recipients = record.recipients.map((recipient, index) =>
      requireBoundedString(
        recipient,
        `agent Outlook delivery recipients[${index}]`,
        256,
      ),
    );
  }
  assignOptionalStrings(delivery, record, ["recipientLabel"], "agent Outlook delivery");
  return delivery;
}

function validateAgentSlackDelivery(value: unknown): AgentSlackDelivery | null {
  if (value === null) return null;
  const record = validateAgentDeliveryRecord(value, "agent Slack delivery");
  const delivery: AgentSlackDelivery = readAgentDeliveryBase(
    record,
    "agent Slack delivery",
  );
  assignOptionalBoolean(delivery, record, "useDefaultChannel", "agent Slack delivery");
  assignOptionalStrings(
    delivery,
    record,
    ["channel", "channelLabel"],
    "agent Slack delivery",
  );
  return delivery;
}

function validateAgentDiscordDelivery(value: unknown): AgentDiscordDelivery | null {
  if (value === null) return null;
  const record = validateAgentDeliveryRecord(value, "agent Discord delivery");
  const delivery: AgentDiscordDelivery = readAgentDeliveryBase(
    record,
    "agent Discord delivery",
  );
  assignOptionalBoolean(delivery, record, "useDefaultWebhook", "agent Discord delivery");
  assignOptionalStrings(
    delivery,
    record,
    ["threadId", "targetLabel"],
    "agent Discord delivery",
  );
  return delivery;
}

function validateAgentSignalDelivery(value: unknown): AgentSignalDelivery | null {
  if (value === null) return null;
  const record = validateAgentDeliveryRecord(value, "agent Signal delivery");
  const delivery: AgentSignalDelivery = readAgentDeliveryBase(
    record,
    "agent Signal delivery",
  );
  assignOptionalBoolean(delivery, record, "useDefaultRecipient", "agent Signal delivery");
  assignOptionalStrings(
    delivery,
    record,
    ["recipient", "recipientLabel"],
    "agent Signal delivery",
  );
  return delivery;
}

function validateCommunitySubmissionMetadata(
  value: unknown,
): AgentCommunitySubmissionMetadata {
  if (!isPlainRecord(value)) {
    throw new Error("community submission metadata must be an object.");
  }
  const category = requireBoundedString(value.category, "metadata.category", 64);
  if (!agentCategories.has(category)) {
    throw new Error("metadata.category is not a known agent category.");
  }
  if (typeof value.licenseConfirmed !== "boolean") {
    throw new Error("metadata.licenseConfirmed must be a boolean.");
  }
  return {
    name: requireBoundedString(value.name, "metadata.name", 120),
    description: requireBoundedString(value.description, "metadata.description", 1_000),
    category: category as AgentCommunitySubmissionMetadata["category"],
    maintainerName: requireBoundedString(value.maintainerName, "metadata.maintainerName", 120),
    supportUrl: requireBoundedString(value.supportUrl, "metadata.supportUrl", 300),
    licenseConfirmed: value.licenseConfirmed,
    privacyNotes: requireBoundedString(value.privacyNotes, "metadata.privacyNotes", 2_000),
    changelog: requireBoundedString(value.changelog, "metadata.changelog", 2_000),
  };
}

function validateSaveTextFileArgs(value: unknown): SaveTextFileArgs {
  if (!isPlainRecord(value)) {
    throw new Error("saveTextFile args must be an object.");
  }
  const suggestedName = requireBoundedString(value.suggestedName, "suggestedName", 160);
  const content = requireBoundedString(value.content, "content", 2_000_000);
  const args: SaveTextFileArgs = { suggestedName, content };
  if (value.filters !== undefined) {
    if (!Array.isArray(value.filters) || value.filters.length > 10) {
      throw new Error("saveTextFile filters must be an array with at most 10 entries.");
    }
    args.filters = value.filters.map((filter, index) => {
      if (!isPlainRecord(filter)) {
        throw new Error(`saveTextFile filters[${index}] must be an object.`);
      }
      if (!Array.isArray(filter.extensions) || filter.extensions.length === 0 || filter.extensions.length > 20) {
        throw new Error(`saveTextFile filters[${index}].extensions is invalid.`);
      }
      return {
        name: requireBoundedString(filter.name, `saveTextFile filters[${index}].name`, 80),
        extensions: filter.extensions.map((extension, extensionIndex) => {
          const value = requireBoundedString(
            extension,
            `saveTextFile filters[${index}].extensions[${extensionIndex}]`,
            24,
          );
          if (!/^[a-z0-9]+$/i.test(value)) {
            throw new Error("saveTextFile filter extensions must be alphanumeric.");
          }
          return value;
        }),
      };
    });
  }
  return args;
}

function validateSupportBundleInput(value: unknown): SupportBundleInput {
  if (!isPlainRecord(value)) {
    throw new Error("support bundle input must be an object.");
  }
  const source = optionalBoundedString(value.source, "source", 64);
  if (source !== undefined && !supportIssueSources.has(source)) {
    throw new Error("support bundle source is not known.");
  }
  return {
    title: sanitizeSupportPublicText(requireBoundedString(value.title, "title", 160)),
    description: sanitizeSupportPublicText(
      requireBoundedString(value.description, "description", 2_000),
    ),
    stepsToReproduce: optionalSupportText(value.stepsToReproduce, "stepsToReproduce", 2_000),
    expectedBehavior: optionalSupportText(value.expectedBehavior, "expectedBehavior", 1_200),
    actualBehavior: optionalSupportText(value.actualBehavior, "actualBehavior", 1_200),
    source: source as SupportBundleInput["source"],
    runId: optionalBoundedString(value.runId, "runId", 160),
    agentSlug:
      value.agentSlug === undefined || value.agentSlug === null
        ? undefined
        : requireAgentSlug(value.agentSlug, "agentSlug"),
  };
}

function validateSupportIssueSubmissionInput(
  value: unknown,
): SupportIssueSubmissionInput {
  if (!isPlainRecord(value)) {
    throw new Error("support issue input must be an object.");
  }
  if (value.confirmPublic !== true) {
    throw new Error("Public issue confirmation is required.");
  }
  if (typeof value.includeDiagnostics !== "boolean") {
    throw new Error("includeDiagnostics must be a boolean.");
  }
  return {
    ...validateSupportBundleInput(value),
    confirmPublic: true,
    includeDiagnostics: value.includeDiagnostics,
  };
}

function optionalSupportText(
  value: unknown,
  name: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) {
    throw new Error(`${name} is too long.`);
  }
  return sanitizeSupportPublicText(trimmed);
}

function sanitizeSupportPublicText(value: string): string {
  return redactSupportPublicText(value).replace(/\s+\n/g, "\n").trim();
}

function validateProviderId(value: unknown, name = "providerId"): ProviderId {
  const providerId = requireBoundedString(value, name, 64);
  if (!providerIds.has(providerId as ProviderId)) {
    throw new Error(`${name} is not a known provider.`);
  }
  return providerId as ProviderId;
}

function validateHostedProviderConsent(
  value: unknown,
): SendIntuneChatMessageInput["hostedProviderConsent"] | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    throw new Error("hostedProviderConsent must be an object.");
  }
  const acknowledgedAt = requireBoundedString(
    value.acknowledgedAt,
    "hostedProviderConsent.acknowledgedAt",
    64,
  );
  if (!Number.isFinite(Date.parse(acknowledgedAt))) {
    throw new Error("hostedProviderConsent.acknowledgedAt must be an ISO timestamp.");
  }
  if (value.remember !== undefined && typeof value.remember !== "boolean") {
    throw new Error("hostedProviderConsent.remember must be a boolean.");
  }
  let workspaceContext:
    | NonNullable<SendIntuneChatMessageInput["hostedProviderConsent"]>["workspaceContext"]
    | undefined;
  if (value.workspaceContext !== undefined) {
    if (!isPlainRecord(value.workspaceContext)) {
      throw new Error("hostedProviderConsent.workspaceContext must be an object.");
    }
    const evidenceCount = Number(value.workspaceContext.evidenceCount);
    const noteCount = Number(value.workspaceContext.noteCount);
    if (
      !Number.isInteger(evidenceCount) ||
      evidenceCount < 0 ||
      evidenceCount > 250 ||
      !Number.isInteger(noteCount) ||
      noteCount < 0 ||
      noteCount > 250
    ) {
      throw new Error("hostedProviderConsent.workspaceContext counts must be non-negative integers.");
    }
    if (typeof value.workspaceContext.includesInstructions !== "boolean") {
      throw new Error("hostedProviderConsent.workspaceContext.includesInstructions must be a boolean.");
    }
    workspaceContext = {
      workspaceId: requireBoundedString(
        value.workspaceContext.workspaceId,
        "hostedProviderConsent.workspaceContext.workspaceId",
        128,
      ),
      workspaceTitle: requireBoundedString(
        value.workspaceContext.workspaceTitle,
        "hostedProviderConsent.workspaceContext.workspaceTitle",
        140,
      ),
      tenantId: requireBoundedString(
        value.workspaceContext.tenantId,
        "hostedProviderConsent.workspaceContext.tenantId",
        256,
      ),
      evidenceCount,
      noteCount,
      includesInstructions: value.workspaceContext.includesInstructions,
    };
  }
  return {
    tenantId: requireBoundedString(value.tenantId, "hostedProviderConsent.tenantId", 256),
    providerId: validateProviderId(value.providerId, "hostedProviderConsent.providerId"),
    acknowledgedAt,
    ...(typeof value.remember === "boolean" ? { remember: value.remember } : {}),
    ...(workspaceContext ? { workspaceContext } : {}),
  };
}

function validateWorkspacePromptContextInput(
  value: unknown,
): NonNullable<SendIntuneChatMessageInput["workspaceContext"]> {
  if (!isPlainRecord(value)) {
    throw new Error("workspaceContext must be an object.");
  }
  if (
    value.includeInstructions !== undefined &&
    typeof value.includeInstructions !== "boolean"
  ) {
    throw new Error("workspaceContext.includeInstructions must be a boolean.");
  }
  return {
    workspaceId: requireBoundedString(value.workspaceId, "workspaceContext.workspaceId", 128),
    ...(value.evidenceIds !== undefined
      ? {
          evidenceIds: validateStringArray(
            value.evidenceIds,
            "workspaceContext.evidenceIds",
            50,
            128,
          ),
        }
      : {}),
    ...(value.noteIds !== undefined
      ? {
          noteIds: validateStringArray(value.noteIds, "workspaceContext.noteIds", 50, 128),
        }
      : {}),
    ...(typeof value.includeInstructions === "boolean"
      ? { includeInstructions: value.includeInstructions }
      : {}),
  };
}

function validateSendIntuneChatMessageInput(value: unknown): SendIntuneChatMessageInput {
  if (!isPlainRecord(value)) {
    throw new Error("Chat message input must be an object.");
  }
  if (value.refreshIfStale !== undefined && typeof value.refreshIfStale !== "boolean") {
    throw new Error("refreshIfStale must be a boolean.");
  }
  return {
    content: requireBoundedString(value.content, "content", 20_000),
    ...(value.conversationId !== undefined
      ? { conversationId: requireBoundedString(value.conversationId, "conversationId", 256) }
      : {}),
    ...(typeof value.refreshIfStale === "boolean"
      ? { refreshIfStale: value.refreshIfStale }
      : {}),
    ...(value.hostedProviderConsent !== undefined
      ? { hostedProviderConsent: validateHostedProviderConsent(value.hostedProviderConsent) }
      : {}),
    ...(value.workspaceContext !== undefined
      ? { workspaceContext: validateWorkspacePromptContextInput(value.workspaceContext) }
      : {}),
  };
}

function validateTenantScope(value: unknown): TenantScope {
  if (!isPlainRecord(value)) {
    throw new Error("tenantScope must be an object.");
  }
  const kind = requireBoundedString(value.kind, "tenantScope.kind", 32);
  if (kind === "active") return { kind };
  const groupIds = validateOptionalStringArray(value.groupIds, "tenantScope.groupIds", 100, 256);
  if (kind === "all") {
    return { kind, ...(groupIds ? { groupIds } : {}) };
  }
  if (kind === "selected") {
    const tenantIds = validateStringArray(value.tenantIds, "tenantScope.tenantIds", 250, 256);
    return { kind, tenantIds, ...(groupIds ? { groupIds } : {}) };
  }
  throw new Error("tenantScope.kind must be active, selected, or all.");
}

function validatePreflightMultiTenantChatInput(
  value: unknown,
): PreflightMultiTenantChatInput {
  if (!isPlainRecord(value)) {
    throw new Error("Multi-tenant preflight input must be an object.");
  }
  return {
    prompt: requireBoundedString(value.prompt, "prompt", 20_000),
    tenantScope: validateTenantScope(value.tenantScope),
    ...(value.savedQueryId !== undefined
      ? { savedQueryId: requireBoundedString(value.savedQueryId, "savedQueryId", 128) }
      : {}),
  };
}

function validateHostedProviderBatchConsent(
  value: unknown,
): RunMultiTenantChatInput["hostedProviderConsent"] | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    throw new Error("hostedProviderConsent must be an object.");
  }
  const acknowledgedAt = requireBoundedString(
    value.acknowledgedAt,
    "hostedProviderConsent.acknowledgedAt",
    64,
  );
  if (!Number.isFinite(Date.parse(acknowledgedAt))) {
    throw new Error("hostedProviderConsent.acknowledgedAt must be an ISO timestamp.");
  }
  if (value.remember !== undefined && typeof value.remember !== "boolean") {
    throw new Error("hostedProviderConsent.remember must be a boolean.");
  }
  return {
    tenantIds: validateStringArray(
      value.tenantIds,
      "hostedProviderConsent.tenantIds",
      250,
      256,
    ),
    providerId: validateProviderId(value.providerId, "hostedProviderConsent.providerId"),
    acknowledgedAt,
    ...(typeof value.remember === "boolean" ? { remember: value.remember } : {}),
  };
}

function validateRunMultiTenantChatInput(value: unknown): RunMultiTenantChatInput {
  const preflight = validatePreflightMultiTenantChatInput(value);
  if (!isPlainRecord(value)) {
    throw new Error("Multi-tenant chat input must be an object.");
  }
  if (value.refreshIfStale !== undefined && typeof value.refreshIfStale !== "boolean") {
    throw new Error("refreshIfStale must be a boolean.");
  }
  return {
    ...preflight,
    ...(typeof value.refreshIfStale === "boolean"
      ? { refreshIfStale: value.refreshIfStale }
      : {}),
    ...(value.hostedProviderConsent !== undefined
      ? { hostedProviderConsent: validateHostedProviderBatchConsent(value.hostedProviderConsent) }
      : {}),
  };
}

function validateQueueMultiTenantAgentBatchInput(
  value: unknown,
): QueueMultiTenantAgentBatchInput {
  if (!isPlainRecord(value)) {
    throw new Error("Multi-tenant agent batch input must be an object.");
  }
  return {
    agentSlug: requireBoundedString(value.agentSlug, "agentSlug", 160),
    tenantScope: validateTenantScope(value.tenantScope),
    ...(value.savedQueryId !== undefined
      ? { savedQueryId: requireBoundedString(value.savedQueryId, "savedQueryId", 128) }
      : {}),
    ...(value.prompt !== undefined
      ? { prompt: requireBoundedString(value.prompt, "prompt", 20_000) }
      : {}),
  };
}

function validateTenantGroupInput(value: unknown): {
  id?: string;
  name: string;
  tenantIds: string[];
} {
  if (!isPlainRecord(value)) throw new Error("Tenant group input must be an object.");
  return {
    ...(value.id !== undefined ? { id: requireBoundedString(value.id, "id", 128) } : {}),
    name: requireBoundedString(value.name, "name", 80),
    tenantIds: validateStringArray(value.tenantIds, "tenantIds", 250, 256),
  };
}

function validateCreateWorkspaceInput(value: unknown): CreateWorkspaceInput {
  if (!isPlainRecord(value)) throw new Error("Workspace input must be an object.");
  return {
    title: requireBoundedString(value.title, "workspace title", 140),
    ...(value.tenantId !== undefined
      ? { tenantId: requireBoundedString(value.tenantId, "tenantId", 256) }
      : {}),
    ...(value.instructions !== undefined
      ? { instructions: optionalTextString(value.instructions, "instructions", 10_000) }
      : {}),
    ...(value.conversationId !== undefined
      ? { conversationId: requireBoundedString(value.conversationId, "conversationId", 256) }
      : {}),
  };
}

function validateUpdateWorkspaceInput(value: unknown): UpdateWorkspaceInput {
  if (!isPlainRecord(value)) throw new Error("Workspace update input must be an object.");
  const status =
    value.status === undefined
      ? undefined
      : requireBoundedString(value.status, "workspace status", 32);
  if (status !== undefined && !workspaceStatuses.has(status as WorkspaceStatus)) {
    throw new Error("Unknown workspace status.");
  }
  return {
    ...(value.title !== undefined
      ? { title: requireBoundedString(value.title, "workspace title", 140) }
      : {}),
    ...(value.instructions !== undefined
      ? { instructions: optionalTextString(value.instructions, "instructions", 10_000) }
      : {}),
    ...(status !== undefined ? { status: status as WorkspaceStatus } : {}),
  };
}

function validatePinWorkspaceEvidenceInput(value: unknown): PinWorkspaceEvidenceInput {
  if (!isPlainRecord(value)) {
    throw new Error("Workspace evidence input must be an object.");
  }
  const sourceType = requireBoundedString(value.sourceType, "sourceType", 64);
  if (!workspaceEvidenceSourceTypes.has(sourceType as WorkspaceEvidenceSourceType)) {
    throw new Error("Unknown workspace evidence source type.");
  }
  return {
    workspaceId: requireBoundedString(value.workspaceId, "workspaceId", 128),
    ...(value.tenantId !== undefined
      ? { tenantId: requireBoundedString(value.tenantId, "tenantId", 256) }
      : {}),
    title: requireBoundedString(value.title, "evidence title", 140),
    sourceType: sourceType as WorkspaceEvidenceSourceType,
    ...(value.sourceRef !== undefined
      ? { sourceRef: validateJsonRecord(value.sourceRef, "sourceRef", 20_000) }
      : {}),
    content: validateJsonValue(value.content, "content", 500_000),
    ...(value.freshness !== undefined
      ? { freshness: validateJsonRecord(value.freshness, "freshness", 20_000) }
      : {}),
  };
}

function validateImportMultiTenantResultToWorkspacesInput(
  value: unknown,
): ImportMultiTenantResultToWorkspacesInput {
  if (!isPlainRecord(value)) throw new Error("Workspace import input must be an object.");
  if (!Array.isArray(value.tenantMappings) || value.tenantMappings.length > 250) {
    throw new Error("tenantMappings must be an array with at most 250 entries.");
  }
  return {
    jobId: requireBoundedString(value.jobId, "jobId", 128),
    tenantMappings: value.tenantMappings.map((mapping, index) => {
      if (!isPlainRecord(mapping)) {
        throw new Error(`tenantMappings[${index}] must be an object.`);
      }
      return {
        tenantId: requireBoundedString(
          mapping.tenantId,
          `tenantMappings[${index}].tenantId`,
          256,
        ),
        ...(mapping.workspaceId !== undefined
          ? {
              workspaceId: requireBoundedString(
                mapping.workspaceId,
                `tenantMappings[${index}].workspaceId`,
                128,
              ),
            }
          : {}),
        ...(mapping.title !== undefined
          ? { title: requireBoundedString(mapping.title, `tenantMappings[${index}].title`, 140) }
          : {}),
      };
    }),
  };
}

function validateStringArray(
  value: unknown,
  name: string,
  maxItems: number,
  maxLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${name} must be an array with at most ${maxItems} entries.`);
  }
  return [...new Set(value.map((entry, index) =>
    requireBoundedString(entry, `${name}[${index}]`, maxLength),
  ))];
}

function validateOptionalStringArray(
  value: unknown,
  name: string,
  maxItems: number,
  maxLength: number,
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  return validateStringArray(value, name, maxItems, maxLength);
}

function validateJsonValue<T>(value: T, name: string, maxBytes: number): T {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${name} must be JSON-serializable.`);
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new Error(`${name} is too large.`);
  }
  return value;
}

function validateRefreshGraphCacheOptions(
  value: unknown,
): RefreshGraphCacheOptions | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainRecord(value)) {
    throw new Error("Graph cache refresh options must be an object.");
  }
  let resources: RefreshGraphCacheOptions["resources"] | undefined;
  if (value.resources !== undefined) {
    if (!Array.isArray(value.resources)) {
      throw new Error("Graph cache resources must be an array.");
    }
    resources = Array.from(new Set(value.resources.map((resource) => {
      const resourceKind = requireBoundedString(resource, "Graph cache resource", 128);
      if (!graphCacheResourceKinds.has(resourceKind)) {
        throw new Error(`Unknown Graph cache resource: ${resourceKind}`);
      }
      return resourceKind as NonNullable<RefreshGraphCacheOptions["resources"]>[number];
    })));
  }
  return {
    ...(value.tenantId !== undefined
      ? { tenantId: requireBoundedString(value.tenantId, "tenantId", 256) }
      : {}),
    ...(resources ? { resources } : {}),
  };
}

function validateDriftTimelineInput(value: unknown): DriftTimelineInput {
  if (!isPlainRecord(value)) {
    throw new Error("Drift timeline input must be an object.");
  }
  const from = validateOptionalDriftBoundary(value.from, "from");
  const to = validateOptionalDriftBoundary(value.to, "to");
  if (from !== undefined && to !== undefined && Date.parse(from) > Date.parse(to)) {
    throw new Error("Drift timeline from date must be before the to date.");
  }
  const input: DriftTimelineInput = {
    tenantId: requireBoundedString(value.tenantId, "tenantId", 256),
  };
  if (from !== undefined) input.from = from;
  if (to !== undefined) input.to = to;
  if (value.resources !== undefined) {
    input.resources = validateDriftResourceArray(value.resources, "resources");
  }
  if (value.query !== undefined) {
    input.query = requireBoundedString(value.query, "drift timeline query", 200);
  }
  if (value.limit !== undefined) {
    input.limit = requireBoundedInteger(value.limit, "drift timeline limit", 1, 5_000);
  }
  return input;
}

function validateDriftEntryDetailInput(value: unknown): DriftEntryDetailInput {
  if (!isPlainRecord(value)) {
    throw new Error("Drift entry detail input must be an object.");
  }
  return {
    tenantId: requireBoundedString(value.tenantId, "tenantId", 256),
    snapshotId: requireBoundedString(value.snapshotId, "snapshotId", 300),
    resource: validateDriftResource(value.resource, "resource"),
    graphId: requireBoundedString(value.graphId, "graphId", 512),
  };
}

function validateDriftObjectHistoryInput(value: unknown): DriftObjectHistoryInput {
  if (!isPlainRecord(value)) {
    throw new Error("Drift object history input must be an object.");
  }
  const input: DriftObjectHistoryInput = {
    tenantId: requireBoundedString(value.tenantId, "tenantId", 256),
    resource: validateDriftResource(value.resource, "resource"),
    graphId: requireBoundedString(value.graphId, "graphId", 512),
  };
  if (value.limit !== undefined) {
    input.limit = requireBoundedInteger(value.limit, "drift object history limit", 1, 500);
  }
  return input;
}

function validateDriftBaselineDriftInput(value: unknown): DriftBaselineDriftInput {
  if (!isPlainRecord(value)) {
    throw new Error("Baseline drift input must be an object.");
  }
  const input: DriftBaselineDriftInput = {
    tenantId: requireBoundedString(value.tenantId, "tenantId", 256),
  };
  if (value.baselineId !== undefined) {
    input.baselineId = requireBoundedString(value.baselineId, "baselineId", 300);
  }
  if (value.resources !== undefined) {
    input.resources = validateDriftResourceArray(value.resources, "resources");
  }
  if (value.limit !== undefined) {
    input.limit = requireBoundedInteger(value.limit, "baseline drift limit", 1, 5_000);
  }
  return input;
}

function validateDriftTimeCompareInput(value: unknown): DriftTimeCompareInput {
  if (!isPlainRecord(value)) {
    throw new Error("Time compare input must be an object.");
  }
  const from = validateOptionalDriftBoundary(value.from, "from");
  const to = validateOptionalDriftBoundary(value.to, "to");
  if (from === undefined || to === undefined) {
    throw new Error("Time compare requires both from and to timestamps.");
  }
  if (Date.parse(from) >= Date.parse(to)) {
    throw new Error("Time compare from date must be before the to date.");
  }
  const input: DriftTimeCompareInput = {
    tenantId: requireBoundedString(value.tenantId, "tenantId", 256),
    from,
    to,
  };
  if (value.resources !== undefined) {
    input.resources = validateDriftResourceArray(value.resources, "resources");
  }
  if (value.limit !== undefined) {
    input.limit = requireBoundedInteger(value.limit, "time compare limit", 1, 5_000);
  }
  return input;
}

function validateDriftBundle(value: unknown): DriftBaselineExportBundle {
  if (!isPlainRecord(value)) {
    throw new Error("Baseline export bundle must be an object.");
  }
  if (value.format !== "openadminos-baseline-export" || value.version !== 1) {
    throw new Error("This file is not an OpenAdminOS baseline export.");
  }
  const sourceTenantName = requireBoundedString(
    value.sourceTenantName,
    "sourceTenantName",
    200,
  );
  const baselineName = requireBoundedString(value.baselineName, "baselineName", 80);
  const exportedAt = requireBoundedString(value.exportedAt, "exportedAt", 80);
  if (!Array.isArray(value.resources) || value.resources.length > 100) {
    throw new Error("Baseline export resources must be an array with at most 100 entries.");
  }
  const resources = value.resources.map((entry, index) => {
    if (!isPlainRecord(entry)) {
      throw new Error(`resources[${index}] must be an object.`);
    }
    const resource = validateDriftResource(entry.resource, `resources[${index}].resource`);
    if (!Array.isArray(entry.objects) || entry.objects.length > 5_000) {
      throw new Error(
        `resources[${index}].objects must be an array with at most 5000 entries.`,
      );
    }
    const objects = entry.objects.map((object, objectIndex) => {
      if (!isPlainRecord(object) || !isPlainRecord(object.body)) {
        throw new Error(
          `resources[${index}].objects[${objectIndex}] must carry an object body.`,
        );
      }
      return {
        ...(typeof object.displayName === "string" && object.displayName.length <= 512
          ? { displayName: object.displayName }
          : {}),
        body: object.body as Record<string, unknown>,
      };
    });
    return { resource, objects };
  });
  return {
    format: "openadminos-baseline-export",
    version: 1,
    exportedAt,
    sourceTenantName,
    baselineName,
    resources,
  };
}

function validateConnectTenantOptions(value: unknown): ConnectTenantOptions {
  if (value === undefined || value === null) return {};
  if (!isPlainRecord(value)) {
    throw new Error("Connect tenant options must be an object.");
  }
  if (value.appRegistration === undefined) return {};
  if (!isPlainRecord(value.appRegistration)) {
    throw new Error("appRegistration must be an object.");
  }
  const registration = value.appRegistration;
  const options: ConnectTenantOptions = {
    appRegistration: {
      clientId: requireBoundedString(registration.clientId, "clientId", 64),
    },
  };
  if (
    registration.directoryTenantId !== undefined &&
    registration.directoryTenantId !== ""
  ) {
    options.appRegistration!.directoryTenantId = requireBoundedString(
      registration.directoryTenantId,
      "directoryTenantId",
      128,
    );
  }
  return options;
}

function validateStartBaselineRollbackInput(
  value: unknown,
): StartBaselineRollbackInput {
  if (!isPlainRecord(value)) {
    throw new Error("Rollback input must be an object.");
  }
  const input: StartBaselineRollbackInput = {
    tenantId: requireBoundedString(value.tenantId, "tenantId", 256),
  };
  if (value.baselineId !== undefined) {
    input.baselineId = requireBoundedString(value.baselineId, "baselineId", 300);
  }
  if (value.selections !== undefined) {
    if (!Array.isArray(value.selections) || value.selections.length > 500) {
      throw new Error("Rollback selections must be an array with at most 500 entries.");
    }
    input.selections = value.selections.map((entry, index) => {
      if (!isPlainRecord(entry)) {
        throw new Error(`selections[${index}] must be an object.`);
      }
      return {
        resource: validateDriftResource(entry.resource, `selections[${index}].resource`),
        graphId: requireBoundedString(entry.graphId, `selections[${index}].graphId`, 512),
      };
    });
  }
  return input;
}

function validateDriftTenantCompareInput(value: unknown): DriftTenantCompareInput {
  if (!isPlainRecord(value)) {
    throw new Error("Tenant compare input must be an object.");
  }
  const input: DriftTenantCompareInput = {
    tenantIdA: requireBoundedString(value.tenantIdA, "tenantIdA", 256),
    tenantIdB: requireBoundedString(value.tenantIdB, "tenantIdB", 256),
  };
  if (input.tenantIdA === input.tenantIdB) {
    throw new Error("Tenant compare requires two different tenants.");
  }
  if (value.resources !== undefined) {
    input.resources = validateDriftResourceArray(value.resources, "resources");
  }
  if (value.limit !== undefined) {
    input.limit = requireBoundedInteger(value.limit, "tenant compare limit", 1, 5_000);
  }
  if (value.includeAssignments !== undefined) {
    if (typeof value.includeAssignments !== "boolean") {
      throw new Error("includeAssignments must be a boolean.");
    }
    input.includeAssignments = value.includeAssignments;
  }
  return input;
}

function validateOptionalDriftBoundary(
  value: unknown,
  label: "from" | "to",
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const boundary = requireBoundedString(value, `drift ${label}`, 80);
  if (!Number.isFinite(Date.parse(boundary))) {
    throw new Error(`Drift ${label} date must be an ISO timestamp.`);
  }
  return boundary;
}

function validateDriftResourceArray(value: unknown, name: string): GraphCacheResourceKind[] {
  if (!Array.isArray(value) || value.length > DRIFT_TRACKED_RESOURCES.size) {
    throw new Error(
      `${name} must be an array with at most ${DRIFT_TRACKED_RESOURCES.size} entries.`,
    );
  }
  return [...new Set(value.map((entry, index) =>
    validateDriftResource(entry, `${name}[${index}]`),
  ))];
}

function validateDriftResource(value: unknown, name: string): GraphCacheResourceKind {
  const resource = requireBoundedString(value, name, 128);
  if (!driftTrackedResourceKinds.has(resource)) {
    throw new Error(`Unknown drift-tracked resource: ${resource}`);
  }
  return resource as GraphCacheResourceKind;
}

function validateSetGraphCacheRefreshScheduleInput(
  value: unknown,
): SetGraphCacheRefreshScheduleInput {
  if (!isPlainRecord(value)) {
    throw new Error("Graph cache refresh schedule input must be an object.");
  }
  if (typeof value.enabled !== "boolean") {
    throw new Error("Graph cache refresh schedule enabled must be a boolean.");
  }
  let intervalMinutes: number | undefined;
  if (value.intervalMinutes !== undefined) {
    if (
      typeof value.intervalMinutes !== "number" ||
      !Number.isFinite(value.intervalMinutes) ||
      value.intervalMinutes < 15 ||
      value.intervalMinutes > 10_080
    ) {
      throw new Error("Graph cache refresh interval must be between 15 minutes and 7 days.");
    }
    intervalMinutes = Math.round(value.intervalMinutes);
  }
  return {
    enabled: value.enabled,
    ...(value.tenantId !== undefined
      ? { tenantId: requireBoundedString(value.tenantId, "tenantId", 256) }
      : {}),
    ...(intervalMinutes !== undefined ? { intervalMinutes } : {}),
  };
}

function validateSetRunHistoryRetentionSettingsInput(
  value: unknown,
): SetRunHistoryRetentionSettingsInput {
  if (!isPlainRecord(value)) {
    throw new Error("Run history retention settings must be an object.");
  }
  if (typeof value.neverPrune !== "boolean") {
    throw new Error("Run history never-prune setting must be a boolean.");
  }
  const input: SetRunHistoryRetentionSettingsInput = {
    neverPrune: value.neverPrune,
  };
  if (value.keepLastRuns !== undefined) {
    input.keepLastRuns =
      value.keepLastRuns === null
        ? null
        : requireBoundedInteger(value.keepLastRuns, "Run history count", 1, 100_000);
  }
  if (value.keepDays !== undefined) {
    input.keepDays =
      value.keepDays === null
        ? null
        : requireBoundedInteger(value.keepDays, "Run history age", 1, 3_650);
  }
  if (
    !input.neverPrune &&
    (input.keepLastRuns === null || input.keepLastRuns === undefined) &&
    (input.keepDays === null || input.keepDays === undefined)
  ) {
    throw new Error("Enable at least one run-history retention rule, or choose never prune.");
  }
  return input;
}

function validateSetDriftRetentionSettingsInput(
  value: unknown,
): SetDriftRetentionSettingsInput {
  if (!isPlainRecord(value)) {
    throw new Error("Change history retention settings must be an object.");
  }
  if (typeof value.neverPrune !== "boolean") {
    throw new Error("Change history never-prune setting must be a boolean.");
  }
  const input: SetDriftRetentionSettingsInput = {
    neverPrune: value.neverPrune,
  };
  if (value.keepDays !== undefined) {
    input.keepDays =
      value.keepDays === null
        ? null
        : requireBoundedInteger(value.keepDays, "Change history retention days", 30, 730);
  }
  if (
    !input.neverPrune &&
    (input.keepDays === null || input.keepDays === undefined)
  ) {
    throw new Error("Set change-history retention days, or choose never prune.");
  }
  return input;
}

function validateExportAuditLogInput(value: unknown): ExportAuditLogInput {
  if (!isPlainRecord(value)) {
    throw new Error("Audit log export input must be an object.");
  }
  if (value.format !== "json" && value.format !== "csv") {
    throw new Error("Audit log export format must be json or csv.");
  }
  const input: ExportAuditLogInput = { format: value.format };
  const from = validateOptionalAuditLogBoundary(value.from, "from");
  const to = validateOptionalAuditLogBoundary(value.to, "to");
  if (from !== undefined) input.from = from;
  if (to !== undefined) input.to = to;
  if (
    from !== undefined &&
    to !== undefined &&
    Date.parse(from) > Date.parse(to)
  ) {
    throw new Error("Audit log export from date must be before the to date.");
  }
  return input;
}

function validateOptionalAuditLogBoundary(
  value: unknown,
  label: "from" | "to",
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const boundary = requireBoundedString(value, `audit log ${label}`, 80);
  const parsed = Date.parse(boundary);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Audit log ${label} date must be an ISO timestamp.`);
  }
  return boundary;
}

function requireBoundedInteger(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function validateSelfTrainingSuggestionStatus(
  value: unknown,
): SelfTrainingSuggestionStatus | undefined {
  if (value === undefined || value === null) return undefined;
  const status = requireBoundedString(value, "self-training suggestion status", 32);
  if (!selfTrainingSuggestionStatuses.has(status as SelfTrainingSuggestionStatus)) {
    throw new Error("Unknown self-training suggestion status.");
  }
  return status as SelfTrainingSuggestionStatus;
}

function validateChatInvestigationMode(value: unknown): ChatInvestigationMode {
  const mode = requireBoundedString(value, "chat investigation mode", 32);
  if (!chatInvestigationModes.has(mode as ChatInvestigationMode)) {
    throw new Error("Unknown chat investigation mode.");
  }
  return mode as ChatInvestigationMode;
}

function validateResetSelfTrainingInput(value: unknown): ResetSelfTrainingInput {
  if (!isPlainRecord(value)) {
    throw new Error("Self-training reset input must be an object.");
  }
  return {
    agentSlug: requireBoundedString(value.agentSlug, "agentSlug", 128),
    ...(value.tenantId !== undefined
      ? { tenantId: requireBoundedString(value.tenantId, "tenantId", 256) }
      : {}),
  };
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

async function openMainWindow(route?: string): Promise<void> {
  showDockForInteractiveSession();
  const safeRoute = routeHash(route);
  if (!mainWindow || mainWindow.isDestroyed()) {
    await createWindow({ show: true, route: safeRoute });
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (safeRoute) navigate(safeRoute);
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
            accelerator: electronAccelerator("settings"),
            click: () => {
              void openMainWindow("/settings");
            },
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
        label: "Chat",
        accelerator: "CmdOrCtrl+1",
        click: () => {
          void openMainWindow("/chat");
        },
      },
      {
        label: "Agents",
        accelerator: "CmdOrCtrl+2",
        click: () => {
          void openMainWindow("/agents");
        },
      },
      {
        label: "Changes",
        accelerator: "CmdOrCtrl+3",
        click: () => {
          void openMainWindow("/changes");
        },
      },
      {
        label: "New conversation",
        accelerator: electronAccelerator("newConversation"),
        click: () => {
          void openMainWindow("/chat?new=1");
        },
      },
      {
        label: "Command Palette",
        accelerator: electronAccelerator("commandPalette"),
        click: () => {
          mainWindow?.webContents.send("openadminos:open-command-palette");
        },
      },
      {
        label: "Settings",
        accelerator: electronAccelerator("settings"),
        click: () => {
          void openMainWindow("/settings");
        },
      },
      {
        label: "Menu Bar Companion",
        accelerator: "CmdOrCtrl+Shift+M",
        enabled: process.platform === "darwin",
        click: () => {
          createMenuBarCompanion();
          void toggleCompanionWindow();
        },
      },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
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

function routeHash(route?: string): string | undefined {
  if (!route) return undefined;
  return route.startsWith("/") ? route : `/${route}`;
}

function armMainWindowRevealFallback(window: BrowserWindow, show: boolean): void {
  if (!show) return;
  let revealed = false;
  const reveal = (reason: string) => {
    if (revealed || window.isDestroyed()) return;
    revealed = true;
    debugStartupLog("showing main window", { reason });
    window.show();
  };
  window.once("ready-to-show", () => reveal("ready-to-show"));
  window.webContents.once("did-finish-load", () => {
    const delayMs = process.platform === "linux" ? 250 : 0;
    setTimeout(() => reveal("did-finish-load"), delayMs);
  });
  window.webContents.once(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL) => {
      debugStartupLog("main window load failed", {
        errorCode,
        errorDescription,
        validatedURL,
      });
      setTimeout(() => reveal("did-fail-load"), 500);
    },
  );
  const timeout = setTimeout(
    () => reveal("startup-timeout"),
    process.platform === "linux" ? 4_000 : 8_000,
  );
  timeout.unref();
  window.once("closed", () => clearTimeout(timeout));
}

async function createWindow({ show = true, route }: { show?: boolean; route?: string } = {}) {
  const persisted = await loadWindowState();
  mainWindow = new BrowserWindow({
    ...(!isScreenshotCaptureLaunch && typeof persisted.x === "number"
      ? { x: persisted.x }
      : {}),
    ...(!isScreenshotCaptureLaunch && typeof persisted.y === "number"
      ? { y: persisted.y }
      : {}),
    width: isScreenshotCaptureLaunch ? SCREENSHOT_CAPTURE_WIDTH : persisted.width,
    height: isScreenshotCaptureLaunch ? SCREENSHOT_CAPTURE_HEIGHT : persisted.height,
    minWidth: isScreenshotCaptureLaunch ? 800 : 960,
    minHeight: isScreenshotCaptureLaunch ? SCREENSHOT_CAPTURE_HEIGHT : 680,
    ...(isScreenshotCaptureLaunch
      ? {
          resizable: true,
        }
      : {}),
    title: "OpenAdminOS",
    backgroundColor: "#0a0c10",
    show: false,
    // Windows: draw our own chrome and overlay the system buttons on it,
    // so the app header replaces the native title bar instead of stacking
    // under it. macOS keeps the inset traffic lights. Linux keeps the
    // native frame because titleBarOverlay is not supported there.
    titleBarStyle:
      process.platform === "darwin"
        ? "hiddenInset"
        : process.platform === "win32"
          ? "hidden"
          : "default",
    ...(process.platform === "win32"
      ? {
          titleBarOverlay: {
            color: "#0a0c10",
            symbolColor: "#9b958a",
            height: 32,
          },
        }
      : {}),
    // The menu is reachable with Alt on Windows and Linux; showing it
    // permanently costs a full row above a UI that already has its own
    // navigation.
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: {
      preload: join(currentDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      webviewTag: false,
    },
  });

  if (!isScreenshotCaptureLaunch) {
    attachWindowStatePersistence(mainWindow);
  }

  if (!isScreenshotCaptureLaunch && persisted.maximized) {
    mainWindow.maximize();
  }
  if (!isScreenshotCaptureLaunch && persisted.fullscreen) {
    mainWindow.setFullScreen(true);
  }

  armMainWindowRevealFallback(mainWindow, show);

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
    const loadPromise = mainWindow.loadFile(join(app.getAppPath(), "dist/index.html"), {
      ...(routeHash(route) ? { hash: routeHash(route) } : {}),
    });
    if (isIntuneChatSmokeLaunch) {
      void loadPromise.then(runIntuneChatSmoke).catch(failIntuneChatSmoke);
    }
    if (isReportIssueSmokeLaunch) {
      void loadPromise.then(runReportIssueSmoke).catch(failReportIssueSmoke);
    }
    if (isScreenshotCaptureLaunch) {
      void loadPromise.then(runScreenshotCapture).catch(failScreenshotCapture);
    }
  } else {
    const initialRoute = routeHash(route);
    const loadPromise = mainWindow.loadURL(
      initialRoute ? `${devServerUrl}/#${initialRoute}` : devServerUrl,
    );
    if (isIntuneChatSmokeLaunch) {
      void loadPromise.then(runIntuneChatSmoke).catch(failIntuneChatSmoke);
    }
    if (isReportIssueSmokeLaunch) {
      void loadPromise.then(runReportIssueSmoke).catch(failReportIssueSmoke);
    }
    if (isScreenshotCaptureLaunch) {
      void loadPromise.then(runScreenshotCapture).catch(failScreenshotCapture);
    }
  }

  return mainWindow;
}

async function createCompanionWindow(): Promise<BrowserWindow> {
  if (companionWindow && !companionWindow.isDestroyed()) {
    return companionWindow;
  }

  companionWindow = new BrowserWindow({
    width: COMPANION_WINDOW_WIDTH,
    height: COMPANION_WINDOW_HEIGHT,
    minWidth: 360,
    minHeight: 520,
    maxWidth: 460,
    maxHeight: 720,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    title: "OpenAdminOS Menu Bar",
    backgroundColor: "#1c1917",
    vibrancy: process.platform === "darwin" ? "menu" : undefined,
    visualEffectState: "active",
    webPreferences: {
      preload: join(currentDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      webviewTag: false,
    },
  });

  companionWindow.on("blur", () => {
    companionWindow?.hide();
  });
  companionWindow.on("closed", () => {
    companionWindow = null;
  });
  companionWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: "deny" };
  });
  companionWindow.webContents.on("will-navigate", (event, url) => {
    if (isAllowedAppNavigation(url)) return;
    event.preventDefault();
    openExternalUrl(url);
  });

  if (app.isPackaged) {
    await companionWindow.loadFile(join(app.getAppPath(), "dist/index.html"), {
      hash: "/companion",
    });
  } else {
    await companionWindow.loadURL(`${devServerUrl}/#/companion`);
  }

  return companionWindow;
}

function createMenuBarIcon() {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, "app-icon.png")
    : join(app.getAppPath(), "build/icon.png");
  const image = nativeImage.createFromPath(iconPath);
  const resized = image.resize({ width: 20, height: 20, quality: "best" });
  resized.setTemplateImage(false);
  return resized;
}

function positionCompanionWindow(window: BrowserWindow): void {
  const trayBounds = menuBarTray?.getBounds();
  const currentBounds = window.getBounds();
  if (!trayBounds) return;
  const display = screen.getDisplayNearestPoint({
    x: Math.round(trayBounds.x + trayBounds.width / 2),
    y: Math.round(trayBounds.y + trayBounds.height / 2),
  });
  const padding = 8;
  const width = currentBounds.width;
  const height = currentBounds.height;
  const minX = display.workArea.x + padding;
  const maxX = display.workArea.x + display.workArea.width - width - padding;
  const x = Math.min(
    Math.max(Math.round(trayBounds.x + trayBounds.width / 2 - width / 2), minX),
    maxX,
  );
  const belowY = Math.round(trayBounds.y + trayBounds.height + 8);
  const wouldOverflow = belowY + height > display.workArea.y + display.workArea.height;
  const y = wouldOverflow
    ? Math.max(display.workArea.y + padding, trayBounds.y - height - 8)
    : belowY;
  window.setPosition(x, y, false);
}

async function toggleCompanionWindow(): Promise<void> {
  const window = await createCompanionWindow();
  if (window.isVisible()) {
    window.hide();
    return;
  }
  positionCompanionWindow(window);
  window.show();
  window.focus();
}

function createMenuBarCompanion(): void {
  if (process.platform !== "darwin" || menuBarTray) return;
  menuBarTray = new Tray(createMenuBarIcon());
  menuBarTray.setToolTip("OpenAdminOS - click for the menu bar companion");
  menuBarTray.on("click", () => {
    void toggleCompanionWindow();
  });
  menuBarTray.on("double-click", () => {
    void openMainWindow("/chat");
  });
  menuBarTray.on("right-click", () => {
    const companionLaunch = getCompanionLaunchSettings();
    menuBarTray?.popUpContextMenu(
      Menu.buildFromTemplate([
        {
          label: "Show Companion",
          click: () => {
            void toggleCompanionWindow();
          },
        },
        {
          label: "Open OpenAdminOS",
          click: () => {
            void openMainWindow("/chat");
          },
        },
        {
          label: "Schedules",
          click: () => {
            void openMainWindow("/agents/schedules");
          },
        },
        {
          label: "Settings",
          click: () => {
            void openMainWindow("/settings");
          },
        },
        { type: "separator" },
        {
          label: "Launch at Login",
          type: "checkbox",
          enabled: companionLaunch.supported,
          checked: companionLaunch.enabled,
          click: (menuItem) => {
            setCompanionLaunchEnabled(menuItem.checked);
          },
        },
        { type: "separator" },
        {
          label: "Quit OpenAdminOS",
          click: () => {
            app.quit();
          },
        },
      ]),
    );
  });
}

function createMenuBarCompanionForInteractiveLaunch(): void {
  if (process.platform === "darwin") {
    createMenuBarCompanion();
  }
}

function registerIpcHandlers() {
  ipcMain.handle(
    "openadminos:get-companion-snapshot",
    handleTrusted(() => getCompanionSnapshot()),
  );
  ipcMain.handle(
    "openadminos:get-companion-launch-settings",
    handleTrusted(() => getCompanionLaunchSettings()),
  );
  ipcMain.handle("openadminos:get-app-state", handleTrusted(() => store.getAppState()));
  ipcMain.handle(
    "openadminos:get-scheduler-launch-settings",
    handleTrusted(() => getSchedulerLaunchSettings()),
  );
  ipcMain.handle(
    "openadminos:get-sandbox-settings",
    handleTrusted(() => getSandboxSettings()),
  );
  ipcMain.handle(
    "openadminos:get-release-diagnostics",
    handleTrusted(() => getReleaseDiagnostics()),
  );
  ipcMain.handle(
    "openadminos:export-support-bundle",
    handleTrusted((_event, input: unknown) =>
      exportSupportBundle(validateSupportBundleInput(input)),
    ),
  );
  ipcMain.handle(
    "openadminos:submit-support-issue",
    handleTrusted((_event, input: unknown) =>
      submitSupportIssue(validateSupportIssueSubmissionInput(input)),
    ),
  );
  ipcMain.handle(
    "openadminos:write-clipboard-text",
    handleTrusted((_event, text: unknown) => {
      clipboard.writeText(requireBoundedString(text, "clipboard text", 200_000));
    }),
  );
  ipcMain.handle(
    "openadminos:open-main-window",
    handleTrusted((_event, route?: unknown) =>
      openMainWindow(optionalBoundedString(route, "route", 500)),
    ),
  );
  ipcMain.handle(
    "openadminos:run-due-read-schedules",
    handleTrusted(() => runDueReadSchedules()),
  );
  ipcMain.handle(
    "openadminos:set-companion-launch-enabled",
    handleTrusted((_event, enabled: unknown) => {
      if (typeof enabled !== "boolean") {
        throw new Error("companion launch enabled must be a boolean.");
      }
      return setCompanionLaunchEnabled(enabled);
    }),
  );
  ipcMain.handle(
    "openadminos:set-scheduler-launch-enabled",
    handleTrusted((_event, enabled: unknown) => {
      if (typeof enabled !== "boolean") {
        throw new Error("scheduler enabled must be a boolean.");
      }
      return setSchedulerLaunchEnabled(enabled);
    }),
  );
  ipcMain.handle(
    "openadminos:set-sandboxed-code-enabled",
    handleTrusted((_event, enabled: unknown) => {
      if (typeof enabled !== "boolean") {
        throw new Error("sandboxed code enabled must be a boolean.");
      }
      return setSandboxedCodeEnabled(enabled);
    }),
  );
  ipcMain.handle("openadminos:list-agents", handleTrusted(() => store.listAgents()));
  ipcMain.handle(
    "openadminos:list-registry-agents",
    handleTrusted(() => store.listRegistryAgents()),
  );
  ipcMain.handle(
    "openadminos:refresh-registry",
    handleTrusted(() => store.initRegistry()),
  );
  ipcMain.handle(
    "openadminos:set-registry-source",
    handleTrusted((_event, url: unknown, options?: unknown) =>
      store.setRegistrySource(
        requireBoundedString(url, "registrySource", 500),
        validateSetRegistrySourceOptions(options),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:set-registry-install-counts-enabled",
    handleTrusted((_event, enabled: unknown) => {
      if (typeof enabled !== "boolean") {
        throw new Error("registry install counts enabled must be a boolean.");
      }
      return store.setRegistryInstallCountsEnabled(enabled);
    }),
  );
  ipcMain.handle("openadminos:list-providers", handleTrusted(() => store.listProviders()));
  ipcMain.handle(
    "openadminos:test-provider",
    handleTrusted((_event, providerId: unknown, model?: unknown) =>
      store.testProvider(
        validateProviderId(providerId),
        optionalBoundedString(model, "model", 256),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:get-azure-openai-config",
    handleTrusted(() => store.getAzureOpenAIConfig()),
  );
  ipcMain.handle(
    "openadminos:set-azure-openai-config",
    handleTrusted((_event, input: unknown) =>
      store.setAzureOpenAIConfig(validateAzureOpenAIConfigInput(input)),
    ),
  );
  ipcMain.handle(
    "openadminos:list-intune-chat-conversations",
    handleTrusted(() => store.listIntuneChatConversations()),
  );
  ipcMain.handle(
    "openadminos:search-intune-chat-conversations",
    handleTrusted((_event, query: unknown) =>
      store.searchIntuneChatConversations(
        requireBoundedString(query, "conversation search query", 500),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:rename-intune-chat-conversation",
    handleTrusted((_event, conversationId: unknown, title: unknown) =>
      store.renameIntuneChatConversation(
        requireBoundedString(conversationId, "conversationId", 256),
        requireBoundedString(title, "conversation title", 200),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:set-intune-chat-conversation-pinned",
    handleTrusted((_event, conversationId: unknown, pinned: unknown) => {
      if (typeof pinned !== "boolean") {
        throw new Error("conversation pinned must be a boolean.");
      }
      return store.setIntuneChatConversationPinned(
        requireBoundedString(conversationId, "conversationId", 256),
        pinned,
      );
    }),
  );
  ipcMain.handle(
    "openadminos:delete-intune-chat-conversation",
    handleTrusted((_event, conversationId: unknown) =>
      store.deleteIntuneChatConversation(
        requireBoundedString(conversationId, "conversationId", 256),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:get-intune-chat-messages",
    handleTrusted((_event, conversationId: unknown) =>
      store.getIntuneChatMessages(
        requireBoundedString(conversationId, "conversationId", 256),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:send-intune-chat-message",
    handleTrusted((_event, input: unknown) =>
      store.sendIntuneChatMessage(validateSendIntuneChatMessageInput(input)),
    ),
  );
  ipcMain.handle(
    "openadminos:stream-intune-chat-message",
    handleTrusted((event, streamId: unknown, input: unknown) => {
      const safeStreamId = requireBoundedString(streamId, "streamId", 128);
      const controller = new AbortController();
      intuneChatStreamControllers.set(safeStreamId, controller);
      if (pendingIntuneChatStreamCancellations.delete(safeStreamId)) {
        controller.abort();
      }
      return store.streamIntuneChatMessage(
        validateSendIntuneChatMessageInput(input),
        (streamEvent: IntuneChatStreamEvent) => {
          event.sender.send("openadminos:intune-chat-stream-event", {
            streamId: safeStreamId,
            event: streamEvent,
          });
        },
        { signal: controller.signal },
      ).finally(() => {
        intuneChatStreamControllers.delete(safeStreamId);
        pendingIntuneChatStreamCancellations.delete(safeStreamId);
      });
    }),
  );
  ipcMain.handle(
    "openadminos:cancel-intune-chat-stream",
    handleTrusted((_event, streamId: unknown) => {
      const safeStreamId = requireBoundedString(streamId, "streamId", 128);
      const controller = intuneChatStreamControllers.get(safeStreamId);
      if (controller) {
        controller.abort();
        return;
      }
      // The renderer exposes Stop as soon as it dispatches a stream. Its
      // cancellation IPC can arrive before the stream handler has registered
      // the AbortController, so remember that bounded request briefly.
      if (pendingIntuneChatStreamCancellations.size >= 128) {
        const oldest = pendingIntuneChatStreamCancellations.values().next().value;
        if (oldest) pendingIntuneChatStreamCancellations.delete(oldest);
      }
      pendingIntuneChatStreamCancellations.add(safeStreamId);
      const expiry = setTimeout(
        () => pendingIntuneChatStreamCancellations.delete(safeStreamId),
        10_000,
      );
      expiry.unref();
    }),
  );
  ipcMain.handle(
    "openadminos:list-tenant-groups",
    handleTrusted(() => store.listTenantGroups()),
  );
  ipcMain.handle(
    "openadminos:save-tenant-group",
    handleTrusted((_event, input: unknown) =>
      store.saveTenantGroup(validateTenantGroupInput(input)),
    ),
  );
  ipcMain.handle(
    "openadminos:delete-tenant-group",
    handleTrusted((_event, id: unknown) =>
      store.deleteTenantGroup(requireBoundedString(id, "tenant group id", 128)),
    ),
  );
  ipcMain.handle(
    "openadminos:list-saved-multi-tenant-queries",
    handleTrusted(() => store.listSavedMultiTenantQueries()),
  );
  ipcMain.handle(
    "openadminos:preflight-multi-tenant-intune-chat",
    handleTrusted((_event, input: unknown) =>
      store.preflightMultiTenantIntuneChat(
        validatePreflightMultiTenantChatInput(input),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:run-multi-tenant-intune-chat",
    handleTrusted((_event, input: unknown) =>
      store.runMultiTenantIntuneChat(validateRunMultiTenantChatInput(input)),
    ),
  );
  ipcMain.handle(
    "openadminos:stream-multi-tenant-intune-chat",
    handleTrusted((event, streamId: unknown, input: unknown) => {
      const safeStreamId = requireBoundedString(streamId, "streamId", 128);
      const controller = new AbortController();
      multiTenantChatStreamControllers.set(safeStreamId, controller);
      return store.streamMultiTenantIntuneChat(
        validateRunMultiTenantChatInput(input),
        (streamEvent: MultiTenantChatStreamEvent) => {
          event.sender.send("openadminos:multi-tenant-chat-stream-event", {
            streamId: safeStreamId,
            event: streamEvent,
          });
        },
        { signal: controller.signal },
      ).finally(() => {
        multiTenantChatStreamControllers.delete(safeStreamId);
      });
    }),
  );
  ipcMain.handle(
    "openadminos:cancel-multi-tenant-intune-chat-stream",
    handleTrusted((_event, streamId: unknown) => {
      const safeStreamId = requireBoundedString(streamId, "streamId", 128);
      multiTenantChatStreamControllers.get(safeStreamId)?.abort();
    }),
  );
  ipcMain.handle(
    "openadminos:list-multi-tenant-chat-jobs",
    handleTrusted(() => store.listMultiTenantChatJobs()),
  );
  ipcMain.handle(
    "openadminos:get-multi-tenant-chat-job",
    handleTrusted((_event, id: unknown) =>
      store.getMultiTenantChatJob(requireBoundedString(id, "jobId", 128)),
    ),
  );
  ipcMain.handle(
    "openadminos:queue-multi-tenant-agent-batch",
    handleTrusted((_event, input: unknown) =>
      store.queueMultiTenantAgentBatch(
        validateQueueMultiTenantAgentBatchInput(input),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:list-multi-tenant-agent-batches",
    handleTrusted(() => store.listMultiTenantAgentBatches()),
  );
  ipcMain.handle(
    "openadminos:get-multi-tenant-agent-batch",
    handleTrusted((_event, id: unknown) =>
      store.getMultiTenantAgentBatch(requireBoundedString(id, "batchId", 128)),
    ),
  );
  ipcMain.handle(
    "openadminos:refresh-graph-cache",
    handleTrusted((_event, options?: unknown) =>
      store.refreshGraphCache(validateRefreshGraphCacheOptions(options)),
    ),
  );
  ipcMain.handle(
    "openadminos:get-graph-cache-status",
    handleTrusted((_event, tenantId?: unknown) =>
      store.getGraphCacheStatus(optionalBoundedString(tenantId, "tenantId", 256)),
    ),
  );
  ipcMain.handle(
    "openadminos:get-drift-timeline",
    handleTrusted((_event, input: unknown) =>
      store.getDriftTimeline(validateDriftTimelineInput(input)),
    ),
  );
  ipcMain.handle(
    "openadminos:get-drift-entry-detail",
    handleTrusted((_event, input: unknown) =>
      store.getDriftEntryDetail(validateDriftEntryDetailInput(input)),
    ),
  );
  ipcMain.handle(
    "openadminos:get-drift-object-history",
    handleTrusted((_event, input: unknown) =>
      store.getDriftObjectHistory(validateDriftObjectHistoryInput(input)),
    ),
  );
  ipcMain.handle(
    "openadminos:get-drift-status",
    handleTrusted((_event, tenantId: unknown) =>
      store.getDriftStatus(requireBoundedString(tenantId, "tenantId", 256)),
    ),
  );
  ipcMain.handle(
    "openadminos:list-drift-baselines",
    handleTrusted((_event, input: unknown) => {
      if (!isPlainRecord(input)) {
        throw new Error("List baselines input must be an object.");
      }
      return store.listDriftBaselines({
        tenantId: requireBoundedString(input.tenantId, "tenantId", 256),
      });
    }),
  );
  ipcMain.handle(
    "openadminos:create-drift-baseline",
    handleTrusted((_event, input: unknown) => {
      if (!isPlainRecord(input)) {
        throw new Error("Create baseline input must be an object.");
      }
      return store.createDriftBaseline({
        tenantId: requireBoundedString(input.tenantId, "tenantId", 256),
        name: requireBoundedString(input.name, "baseline name", 80),
      });
    }),
  );
  ipcMain.handle(
    "openadminos:rename-drift-baseline",
    handleTrusted((_event, input: unknown) => {
      if (!isPlainRecord(input)) {
        throw new Error("Rename baseline input must be an object.");
      }
      return store.renameDriftBaseline({
        tenantId: requireBoundedString(input.tenantId, "tenantId", 256),
        baselineId: requireBoundedString(input.baselineId, "baselineId", 300),
        name: requireBoundedString(input.name, "baseline name", 80),
      });
    }),
  );
  ipcMain.handle(
    "openadminos:retire-drift-baseline",
    handleTrusted((_event, input: unknown) => {
      if (!isPlainRecord(input)) {
        throw new Error("Retire baseline input must be an object.");
      }
      return store.retireDriftBaseline({
        tenantId: requireBoundedString(input.tenantId, "tenantId", 256),
        baselineId: requireBoundedString(input.baselineId, "baselineId", 300),
      });
    }),
  );
  ipcMain.handle(
    "openadminos:get-drift-baseline-drift",
    handleTrusted((_event, input: unknown) =>
      store.getDriftBaselineDrift(validateDriftBaselineDriftInput(input)),
    ),
  );
  ipcMain.handle(
    "openadminos:get-drift-time-compare",
    handleTrusted((_event, input: unknown) =>
      store.getDriftTimeCompare(validateDriftTimeCompareInput(input)),
    ),
  );
  ipcMain.handle(
    "openadminos:get-drift-tenant-compare",
    handleTrusted((_event, input: unknown) =>
      store.getDriftTenantCompare(validateDriftTenantCompareInput(input)),
    ),
  );
  ipcMain.handle(
    "openadminos:start-baseline-rollback",
    handleTrusted((_event, input: unknown) =>
      store.startBaselineRollback(validateStartBaselineRollbackInput(input)),
    ),
  );
  ipcMain.handle(
    "openadminos:export-drift-baseline",
    handleTrusted(async (_event, input: unknown) => {
      if (!isPlainRecord(input)) {
        throw new Error("Baseline export input must be an object.");
      }
      const bundle = await store.buildDriftBaselineExport({
        tenantId: requireBoundedString(input.tenantId, "tenantId", 256),
        ...(input.baselineId !== undefined
          ? { baselineId: requireBoundedString(input.baselineId, "baselineId", 300) }
          : {}),
      });
      const objectCount = bundle.resources.reduce(
        (sum, entry) => sum + entry.objects.length,
        0,
      );
      const parent = mainWindow ?? undefined;
      const defaultPath = `openadminos-baseline-${bundle.baselineName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")}-${bundle.exportedAt.slice(0, 10)}.json`;
      const dialogOptions = {
        title: "Export baseline",
        defaultPath,
        filters: [{ name: "OpenAdminOS baseline export", extensions: ["json"] }],
      };
      const result = parent
        ? await dialog.showSaveDialog(parent, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);
      if (result.canceled || !result.filePath) {
        return { canceled: true };
      }
      await writeFile(result.filePath, JSON.stringify(bundle, null, 2), "utf8");
      return { canceled: false, filePath: result.filePath, objectCount };
    }),
  );
  ipcMain.handle(
    "openadminos:read-drift-bundle-file",
    handleTrusted(async () => {
      const parent = mainWindow ?? undefined;
      const dialogOptions = {
        title: "Open baseline export",
        filters: [{ name: "OpenAdminOS baseline export", extensions: ["json"] }],
        properties: ["openFile" as const],
      };
      const result = parent
        ? await dialog.showOpenDialog(parent, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      const filePath = result.filePaths[0];
      if (result.canceled || !filePath) {
        return { canceled: true };
      }
      const fileStat = await stat(filePath);
      if (fileStat.size > 25 * 1024 * 1024) {
        throw new Error("Baseline export files larger than 25 MB are not supported.");
      }
      const raw = await readFile(filePath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("This file is not valid JSON.");
      }
      return { canceled: false, bundle: validateDriftBundle(parsed) };
    }),
  );
  ipcMain.handle(
    "openadminos:get-drift-bundle-compare",
    handleTrusted((_event, input: unknown) => {
      if (!isPlainRecord(input)) {
        throw new Error("Bundle compare input must be an object.");
      }
      const compare: DriftBundleCompareInput = {
        tenantId: requireBoundedString(input.tenantId, "tenantId", 256),
        bundle: validateDriftBundle(input.bundle),
      };
      if (input.resources !== undefined) {
        compare.resources = validateDriftResourceArray(input.resources, "resources");
      }
      if (input.limit !== undefined) {
        compare.limit = requireBoundedInteger(input.limit, "bundle compare limit", 1, 5_000);
      }
      if (input.includeAssignments !== undefined) {
        if (typeof input.includeAssignments !== "boolean") {
          throw new Error("includeAssignments must be a boolean.");
        }
        compare.includeAssignments = input.includeAssignments;
      }
      return store.getDriftBundleCompare(compare);
    }),
  );
  ipcMain.handle(
    "openadminos:get-usage-telemetry-preview",
    handleTrusted(() => store.getUsageTelemetryPreview()),
  );
  ipcMain.handle(
    "openadminos:set-usage-telemetry-enabled",
    handleTrusted((_event, enabled: unknown) => {
      if (typeof enabled !== "boolean") {
        throw new Error("Usage telemetry enabled must be a boolean.");
      }
      return store.setUsageTelemetryEnabled(enabled);
    }),
  );
  ipcMain.handle(
    "openadminos:send-usage-telemetry-test",
    handleTrusted(() => store.sendUsageTelemetry()),
  );
  ipcMain.handle(
    "openadminos:get-retrieval-status",
    handleTrusted(() => store.getRetrievalStatus()),
  );
  ipcMain.handle(
    "openadminos:refresh-retrieval-index",
    handleTrusted(() => store.refreshRetrievalIndex()),
  );
  ipcMain.handle(
    "openadminos:get-gateway-status",
    handleTrusted(() => store.getGatewayStatus()),
  );
  ipcMain.handle(
    "openadminos:enable-gateway",
    handleTrusted((_event, input: unknown) => {
      if (!isPlainRecord(input)) {
        throw new Error("Enable gateway input must be an object.");
      }
      return store.enableGateway({
        boundTenantId: requireBoundedString(input.boundTenantId, "boundTenantId", 256),
        ...(input.port !== undefined
          ? { port: requireBoundedInteger(input.port, "port", 1024, 65_535) }
          : {}),
      });
    }),
  );
  ipcMain.handle(
    "openadminos:disable-gateway",
    handleTrusted(() => store.disableGateway()),
  );
  ipcMain.handle(
    "openadminos:regenerate-gateway-token",
    handleTrusted(() => store.regenerateGatewayToken()),
  );
  ipcMain.handle(
    "openadminos:revoke-gateway-client",
    handleTrusted((_event, clientId: unknown) =>
      store.revokeGatewayClient(requireBoundedString(clientId, "clientId", 128)),
    ),
  );
  ipcMain.handle(
    "openadminos:get-fleet-drift-status",
    handleTrusted((_event, input: unknown) => {
      if (input !== undefined && !isPlainRecord(input)) {
        throw new Error("Fleet drift status input must be an object.");
      }
      const groupId =
        input !== undefined
          ? optionalBoundedString((input as Record<string, unknown>).groupId, "groupId", 128)
          : undefined;
      return store.getFleetDriftStatus(groupId ? { groupId } : {});
    }),
  );
  ipcMain.handle(
    "openadminos:get-graph-cache-refresh-schedule",
    handleTrusted((_event, tenantId?: unknown) =>
      store.getGraphCacheRefreshSchedule(
        optionalBoundedString(tenantId, "tenantId", 256),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:set-graph-cache-refresh-schedule",
    handleTrusted(async (_event, input: unknown) => {
      const schedule = await store.setGraphCacheRefreshSchedule(
        validateSetGraphCacheRefreshScheduleInput(input),
      );
      if (schedule.enabled) void registerSchedulerIfReady("schedule");
      else void unregisterSchedulerIfUnused();
      return schedule;
    }),
  );
  ipcMain.handle(
    "openadminos:get-local-data-summary",
    handleTrusted((_event, tenantId?: unknown) =>
      store.getLocalDataSummary(optionalBoundedString(tenantId, "tenantId", 256)),
    ),
  );
  ipcMain.handle(
    "openadminos:clear-intune-chat-history",
    handleTrusted(() => store.clearIntuneChatHistory()),
  );
  ipcMain.handle(
    "openadminos:clear-graph-cache",
    handleTrusted((_event, tenantId?: unknown) =>
      store.clearGraphCache(optionalBoundedString(tenantId, "tenantId", 256)),
    ),
  );
  ipcMain.handle(
    "openadminos:get-run-history-retention-settings",
    handleTrusted(() => store.getRunHistoryRetentionSettings()),
  );
  ipcMain.handle(
    "openadminos:set-run-history-retention-settings",
    handleTrusted((_event, input: unknown) =>
      store.setRunHistoryRetentionSettings(
        validateSetRunHistoryRetentionSettingsInput(input),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:prune-run-history-now",
    handleTrusted(() => store.pruneRunHistoryNow()),
  );
  ipcMain.handle(
    "openadminos:get-drift-retention-settings",
    handleTrusted(() => store.getDriftRetentionSettings()),
  );
  ipcMain.handle(
    "openadminos:set-drift-retention-settings",
    handleTrusted((_event, input: unknown) =>
      store.setDriftRetentionSettings(
        validateSetDriftRetentionSettingsInput(input),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:prune-drift-history-now",
    handleTrusted(() => store.pruneDriftHistoryNow()),
  );
  ipcMain.handle(
    "openadminos:export-audit-log",
    handleTrusted((_event, input: unknown) =>
      store.exportAuditLog(validateExportAuditLogInput(input)),
    ),
  );
  ipcMain.handle(
    "openadminos:get-self-training-settings",
    handleTrusted(() => store.getSelfTrainingSettings()),
  );
  ipcMain.handle(
    "openadminos:get-chat-investigation-settings",
    handleTrusted(() => store.getChatInvestigationSettings()),
  );
  ipcMain.handle(
    "openadminos:set-chat-investigation-mode",
    handleTrusted((_event, mode: unknown) =>
      store.setChatInvestigationMode(validateChatInvestigationMode(mode)),
    ),
  );
  ipcMain.handle(
    "openadminos:set-self-training-enabled",
    handleTrusted((_event, enabled: unknown) => {
      if (typeof enabled !== "boolean") {
        throw new Error("Self-training enabled must be a boolean.");
      }
      return store.setSelfTrainingEnabled(enabled);
    }),
  );
  ipcMain.handle(
    "openadminos:list-self-training-suggestions",
    handleTrusted((_event, status?: unknown) =>
      store.listSelfTrainingSuggestions(validateSelfTrainingSuggestionStatus(status)),
    ),
  );
  ipcMain.handle(
    "openadminos:approve-self-training-suggestion",
    handleTrusted((_event, id: unknown) =>
      store.approveSelfTrainingSuggestion(
        requireBoundedString(id, "self-training suggestion id", 128),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:reject-self-training-suggestion",
    handleTrusted((_event, id: unknown) =>
      store.rejectSelfTrainingSuggestion(
        requireBoundedString(id, "self-training suggestion id", 128),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:reset-self-training-suggestions",
    handleTrusted((_event, input: unknown) =>
      store.resetSelfTrainingSuggestions(validateResetSelfTrainingInput(input)),
    ),
  );
  ipcMain.handle(
    "openadminos:list-workspaces",
    handleTrusted((_event, tenantId?: unknown) =>
      store.listWorkspaces(optionalBoundedString(tenantId, "tenantId", 256)),
    ),
  );
  ipcMain.handle(
    "openadminos:get-workspace",
    handleTrusted((_event, id: unknown) =>
      store.getWorkspace(requireBoundedString(id, "workspaceId", 128)),
    ),
  );
  ipcMain.handle(
    "openadminos:create-workspace",
    handleTrusted((_event, input: unknown) =>
      store.createWorkspace(validateCreateWorkspaceInput(input)),
    ),
  );
  ipcMain.handle(
    "openadminos:update-workspace",
    handleTrusted((_event, id: unknown, input: unknown) =>
      store.updateWorkspace(
        requireBoundedString(id, "workspaceId", 128),
        validateUpdateWorkspaceInput(input),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:archive-workspace",
    handleTrusted((_event, id: unknown) =>
      store.archiveWorkspace(requireBoundedString(id, "workspaceId", 128)),
    ),
  );
  ipcMain.handle(
    "openadminos:delete-workspace",
    handleTrusted((_event, id: unknown) =>
      store.deleteWorkspace(requireBoundedString(id, "workspaceId", 128)),
    ),
  );
  ipcMain.handle(
    "openadminos:add-workspace-note",
    handleTrusted((_event, workspaceId: unknown, content: unknown) =>
      store.addWorkspaceNote(
        requireBoundedString(workspaceId, "workspaceId", 128),
        requireBoundedString(content, "note content", 20_000),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:update-workspace-note",
    handleTrusted((_event, noteId: unknown, content: unknown) =>
      store.updateWorkspaceNote(
        requireBoundedString(noteId, "noteId", 128),
        requireBoundedString(content, "note content", 20_000),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:pin-workspace-evidence",
    handleTrusted((_event, input: unknown) =>
      store.pinWorkspaceEvidence(validatePinWorkspaceEvidenceInput(input)),
    ),
  );
  ipcMain.handle(
    "openadminos:link-workspace-conversation",
    handleTrusted((_event, workspaceId: unknown, conversationId: unknown) =>
      store.linkWorkspaceConversation(
        requireBoundedString(workspaceId, "workspaceId", 128),
        requireBoundedString(conversationId, "conversationId", 256),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:link-workspace-run",
    handleTrusted((_event, workspaceId: unknown, runId: unknown) =>
      store.linkWorkspaceRun(
        requireBoundedString(workspaceId, "workspaceId", 128),
        requireBoundedString(runId, "runId", 128),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:import-multi-tenant-result-to-workspaces",
    handleTrusted((_event, input: unknown) =>
      store.importMultiTenantResultToWorkspaces(
        validateImportMultiTenantResultToWorkspacesInput(input),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:export-workspace-dossier",
    handleTrusted((_event, id: unknown) =>
      store.exportWorkspaceDossier(requireBoundedString(id, "workspaceId", 128)),
    ),
  );
  ipcMain.handle(
    "openadminos:list-connectors",
    handleTrusted(() => store.listConnectors()),
  );
  ipcMain.handle("openadminos:test-connector", handleTrusted((_event, id: unknown) =>
    store.testConnector(requireBoundedString(id, "connectorId", 128)),
  ),
  );
  ipcMain.handle(
    "openadminos:set-connector-config",
    handleTrusted((_event, id: unknown, config: unknown) =>
      store.setConnectorConfig(
        requireBoundedString(id, "connectorId", 128),
        validateJsonRecord(config, "connector config", 20_000),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:set-connector-secret",
    handleTrusted((_event, id: unknown, key: unknown, value: unknown) =>
      store.setConnectorSecret(
        requireBoundedString(id, "connectorId", 128),
        requireBoundedString(key, "connector secret key", 128),
        validateConnectorSecretValue(value),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:list-connector-teams",
    handleTrusted((_event, id: unknown) =>
      store.listConnectorTeams(requireBoundedString(id, "connectorId", 128)),
    ),
  );
  ipcMain.handle(
    "openadminos:list-connector-channels",
    handleTrusted((_event, id: unknown, teamId: unknown) =>
      store.listConnectorChannels(
        requireBoundedString(id, "connectorId", 128),
        requireBoundedString(teamId, "teamId", 256),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:get-whatsapp-web-status",
    handleTrusted(() => store.getWhatsAppWebStatus()),
  );
  ipcMain.handle(
    "openadminos:start-whatsapp-web-login",
    handleTrusted(() => store.startWhatsAppWebLogin()),
  );
  ipcMain.handle(
    "openadminos:disconnect-whatsapp-web",
    handleTrusted(() => store.disconnectWhatsAppWeb()),
  );
  ipcMain.handle(
    "openadminos:list-whatsapp-web-groups",
    handleTrusted(() => store.listWhatsAppWebGroups()),
  );
  ipcMain.handle(
    "openadminos:send-whatsapp-web-test-message",
    handleTrusted((_event, to: unknown) =>
      store.sendWhatsAppWebTestMessage(
        requireBoundedString(to, "WhatsApp recipient", 256),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:respond-to-connector-confirm",
    handleTrusted((_event, requestId: unknown, decision: unknown) => {
      respondConnectorConfirm(
        requireBoundedString(requestId, "requestId", 128),
        validateConnectorDecision(decision),
      );
    }),
  );
  ipcMain.handle("openadminos:install-agent", handleTrusted((_event, agentId: unknown) =>
    store.installAgent(requireAgentSlug(agentId, "agentId")),
  ),
  );
  ipcMain.handle("openadminos:uninstall-agent", handleTrusted(async (_event, slug: unknown) => {
    const state = await store.uninstallAgent(requireAgentSlug(slug, "slug"));
    void unregisterSchedulerIfUnused();
    return state;
  }));
  ipcMain.handle("openadminos:get-agent-update-review", handleTrusted((_event, slug: unknown) =>
    store.getAgentUpdateReview(requireAgentSlug(slug, "slug")),
  ),
  );
  ipcMain.handle(
    "openadminos:update-agent",
    handleTrusted((_event, slug: unknown, options?: unknown) =>
      store.updateAgent(
        requireAgentSlug(slug, "slug"),
        validateAgentUpdateOptions(options),
      ),
    ),
  );
  ipcMain.handle("openadminos:set-active-provider", handleTrusted((_event, id: unknown) =>
    store.setActiveProvider(validateProviderId(id)),
  ),
  );
  ipcMain.handle(
    "openadminos:set-active-model",
    handleTrusted((_event, providerId: unknown, model: unknown) =>
      store.setActiveModel(validateProviderId(providerId), validateActiveModel(model)),
    ),
  );
  ipcMain.handle(
    "openadminos:start-run",
    handleTrusted((_event, agentSlug: unknown, options?: unknown) =>
      store.startRun(
        requireAgentSlug(agentSlug, "agentSlug"),
        validateStartRunOptions(options),
      ),
    ),
  );
  ipcMain.handle("openadminos:get-run", handleTrusted((_event, id: unknown) =>
    store.getRun(requireBoundedString(id, "runId", 128)),
  ));
  ipcMain.handle(
    "openadminos:confirm-run",
    handleTrusted((_event, runId: unknown, phrase: unknown) =>
      store.confirmRun(
        requireBoundedString(runId, "runId", 128),
        requireBoundedString(phrase, "confirmation phrase", 500),
      ),
    ),
  );
  ipcMain.handle("openadminos:reject-run", handleTrusted((_event, runId: unknown) =>
    store.rejectRun(requireBoundedString(runId, "runId", 128)),
  ),
  );
  ipcMain.handle("openadminos:cancel-run", handleTrusted((_event, runId: unknown) =>
    store.cancelRun(requireBoundedString(runId, "runId", 128)),
  ),
  );
  ipcMain.handle("openadminos:list-tenants", handleTrusted(() => store.listTenants()));
  ipcMain.handle(
    "openadminos:get-requested-scopes",
    handleTrusted(() => store.listRequestedScopes()),
  );
  ipcMain.handle("openadminos:connect-tenant", handleTrusted(async (_event, input?: unknown) => {
    const state = await store.connectTenant(validateConnectTenantOptions(input));
    void registerSchedulerIfReady("tenant");
    return state;
  }));
  ipcMain.handle(
    "openadminos:cancel-connect-tenant",
    handleTrusted(() => store.cancelConnectTenant()),
  );
  ipcMain.handle("openadminos:set-active-tenant", handleTrusted((_event, id: unknown) =>
    store.setActiveTenant(requireBoundedString(id, "tenantId", 256)),
  ),
  );
  ipcMain.handle("openadminos:disconnect-tenant", handleTrusted((_event, id: unknown) =>
    store.disconnectTenant(requireBoundedString(id, "tenantId", 256)),
  ),
  );
  ipcMain.handle("openadminos:get-agent-manifest", handleTrusted((_event, slug: unknown) =>
    store.getAgentManifest(requireAgentSlug(slug, "slug")),
  ),
  );
  ipcMain.handle(
    "openadminos:update-agent-settings",
    handleTrusted((_event, slug: unknown, values: unknown) =>
      store.updateAgentSettings(
        requireAgentSlug(slug, "slug"),
        validateJsonRecord(values, "agent settings", 50_000),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:update-agent-schedule",
    handleTrusted(async (_event, slug: unknown, schedule: unknown) => {
      const validatedSchedule = validateAgentSchedule(schedule);
      const state = await store.updateAgentSchedule(
        requireAgentSlug(slug, "slug"),
        validatedSchedule,
      );
      if (validatedSchedule?.enabled === true) void registerSchedulerIfReady("schedule");
      else void unregisterSchedulerIfUnused();
      return state;
    }),
  );
  ipcMain.handle(
    "openadminos:update-agent-teams-delivery",
    handleTrusted((_event, slug: unknown, delivery: unknown) =>
      store.updateAgentTeamsDelivery(
        requireAgentSlug(slug, "slug"),
        validateAgentTeamsDelivery(delivery),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:update-agent-whatsapp-web-delivery",
    handleTrusted((_event, slug: unknown, delivery: unknown) =>
      store.updateAgentWhatsAppWebDelivery(
        requireAgentSlug(slug, "slug"),
        validateAgentWhatsAppWebDelivery(delivery),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:update-agent-outlook-delivery",
    handleTrusted((_event, slug: unknown, delivery: unknown) =>
      store.updateAgentOutlookDelivery(
        requireAgentSlug(slug, "slug"),
        validateAgentOutlookDelivery(delivery),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:update-agent-slack-delivery",
    handleTrusted((_event, slug: unknown, delivery: unknown) =>
      store.updateAgentSlackDelivery(
        requireAgentSlug(slug, "slug"),
        validateAgentSlackDelivery(delivery),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:update-agent-discord-delivery",
    handleTrusted((_event, slug: unknown, delivery: unknown) =>
      store.updateAgentDiscordDelivery(
        requireAgentSlug(slug, "slug"),
        validateAgentDiscordDelivery(delivery),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:update-agent-signal-delivery",
    handleTrusted((_event, slug: unknown, delivery: unknown) =>
      store.updateAgentSignalDelivery(
        requireAgentSlug(slug, "slug"),
        validateAgentSignalDelivery(delivery),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:draft-agent-manifest",
    handleTrusted((_event, prompt: unknown) =>
      store.draftAgentManifest(requireBoundedString(prompt, "prompt", 20_000)),
    ),
  );
  ipcMain.handle(
    "openadminos:validate-agent-draft",
    handleTrusted((_event, yamlSource: unknown, allowedSlug?: unknown) =>
      store.validateAgentDraft(
        requireBoundedString(yamlSource, "yamlSource", 300_000),
        allowedSlug === undefined ? undefined : requireAgentSlug(allowedSlug, "allowedSlug"),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:preflight-agent-draft",
    handleTrusted((_event, yamlSource: unknown, allowedSlug?: unknown) =>
      store.preflightAgentDraft(
        requireBoundedString(yamlSource, "yamlSource", 300_000),
        allowedSlug === undefined ? undefined : requireAgentSlug(allowedSlug, "allowedSlug"),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:save-agent-draft",
    handleTrusted((_event, yamlSource: unknown) =>
      store.saveAgentDraft(requireBoundedString(yamlSource, "yamlSource", 300_000)),
    ),
  );
  ipcMain.handle(
    "openadminos:update-user-agent-draft",
    handleTrusted((_event, slug: unknown, yamlSource: unknown) =>
      store.updateUserAgentDraft(
        requireAgentSlug(slug, "slug"),
        requireBoundedString(yamlSource, "yamlSource", 300_000),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:export-agent-draft-bundle",
    handleTrusted(async (_event, yamlSource: unknown) => {
      const validatedYaml = requireBoundedString(yamlSource, "yamlSource", 300_000);
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
      return store.exportAgentDraftBundle(validatedYaml, result.filePaths[0]);
    }),
  );
  ipcMain.handle(
    "openadminos:prepare-agent-community-submission",
    handleTrusted((_event, yamlSource: unknown, metadata: unknown, allowedSlug?: unknown) =>
      store.prepareAgentCommunitySubmission(
        requireBoundedString(yamlSource, "yamlSource", 300_000),
        validateCommunitySubmissionMetadata(metadata),
        allowedSlug === undefined ? undefined : requireAgentSlug(allowedSlug, "allowedSlug"),
      ),
    ),
  );
  ipcMain.handle(
    "openadminos:submit-agent-community-submission",
    handleTrusted((_event, yamlSource: unknown, metadata: unknown, allowedSlug?: unknown) =>
      store.submitAgentCommunitySubmission(
        requireBoundedString(yamlSource, "yamlSource", 300_000),
        validateCommunitySubmissionMetadata(metadata),
        allowedSlug === undefined ? undefined : requireAgentSlug(allowedSlug, "allowedSlug"),
      ),
    ),
  );
  ipcMain.handle("openadminos:open-external", handleTrusted((_event, url: unknown) => {
    openExternalUrl(requireBoundedString(url, "url", 12_000));
  }));
  ipcMain.handle("openadminos:get-update-state", handleTrusted(() => getUpdateState()));
  ipcMain.handle("openadminos:check-for-updates-now", handleTrusted(() => checkForUpdatesNow()));
  ipcMain.handle("openadminos:apply-update-now", handleTrusted(() => applyUpdateNow()));
  subscribeToUpdateState((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("openadminos:update-state", state);
    }
  });
  ipcMain.handle(
    "openadminos:save-text-file",
    handleTrusted(async (_event, args: unknown) => {
      const validatedArgs = validateSaveTextFileArgs(args);
      const parent = mainWindow ?? undefined;
      const result = parent
        ? await dialog.showSaveDialog(parent, {
            defaultPath: validatedArgs.suggestedName,
            filters: validatedArgs.filters,
          })
        : await dialog.showSaveDialog({
            defaultPath: validatedArgs.suggestedName,
            filters: validatedArgs.filters,
          });
      if (result.canceled || !result.filePath) {
        return { canceled: true };
      }
      await writeFile(result.filePath, validatedArgs.content, "utf8");
      return { canceled: false, filePath: result.filePath };
    }),
  );
}

const gotLock = app.requestSingleInstanceLock();
debugStartupLog("single instance lock", {
  gotLock,
  argv: process.argv,
  isBackgroundSchedulerLaunch,
  isMenuBarLaunch,
  isMacosLoginItemLaunch,
});

if (!gotLock) {
  debugStartupLog("quitting because single instance lock was not acquired");
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (argv.includes(BACKGROUND_SCHEDULER_ARG)) {
      void store?.fireDueSchedules();
      void store?.refreshDueGraphCaches();
      return;
    }
    if (argv.includes(MENU_BAR_ARG)) {
      createMenuBarCompanion();
      void toggleCompanionWindow();
      return;
    }

    if (!mainWindow || mainWindow.isDestroyed()) {
      showDockForInteractiveSession();
      createMenuBarCompanionForInteractiveLaunch();
      void createWindow({ show: true });
      return;
    }

    showDockForInteractiveSession();
    createMenuBarCompanionForInteractiveLaunch();
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  });

  void app.whenReady().then(async () => {
    debugStartupLog("app ready");
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
    // Bring-your-own registrations get an isolated token cache: MSAL
    // binds tokens to a client id, so mixing caches would surface
    // accounts that the active client can never refresh.
    const tokenStoreFor = (clientId: string) =>
      new SafeStorageTokenCacheStore(
        join(userDataDir, `tokens-${clientId.replace(/[^0-9a-zA-Z-]/g, "")}.bin`),
      );
    seedIntuneChatSmokeState(userDataDir);
    seedReportIssueSmokeState(userDataDir);
    try {
      seedScreenshotCaptureState(userDataDir);
    } catch (error) {
      if (isScreenshotCaptureLaunch) {
        failScreenshotCapture(error);
        return;
      }
      throw error;
    }

    installConnectorConfirmBridge({
      getMainWindow: () => mainWindow,
      connectorNameLookup: (id) =>
        listRegisteredConnectors().find((d) => d.id === id)?.name ?? id,
      connectorConfigLookup: (id) => store.getConnectorConfigCached(id),
    });

    store = new AppStateStore({
      filePath: join(userDataDir, "state.json"),
      tokenStore,
      tokenStoreFor,
      userDataPath: userDataDir,
      userAgentsDir: join(userDataDir, "agents"),
      // Only packaged production builds report installs to the public
      // stats aggregator. Dev/CLI builds default to the empty string,
      // which disables the POST entirely.
      statsApiUrl: app.isPackaged
        ? process.env.OPENAGENTS_STATS_API ?? undefined
        : process.env.OPENAGENTS_STATS_API ?? "",
      appVersion: app.getVersion(),
      allowDevRegistrySource:
        !app.isPackaged && process.env.OPENADMINOS_ALLOW_DEV_REGISTRY_SOURCE === "1",
      sandboxedCodeDefault: launchSandboxedCodeDefault,
      openBrowser: async (url: string) => {
        await shell.openExternal(url);
      },
      onRunFinished: (run) => {
        void maybeShowRunNotification(run);
      },
      onStateChanged: (info) => {
        mainWindow?.webContents.send("openadminos:app-state-changed", info);
      },
      ...(isIntuneChatSmokeLaunch || isScreenshotCaptureLaunch
        ? {
            graphFactory: () => createIntuneChatSmokeGraph(),
            llmFactory: () => createIntuneChatSmokeLlm(),
            providerListFactory: () => createIntuneChatSmokeProviders(),
          }
        : {}),
    });
    applySandboxedCodeEnabled(await store.getSandboxedCodeEnabled());
    registerIpcHandlers();
    void store.processPendingRunDeliveries();
    debugStartupLog("registered ipc handlers");
    void store.processPendingRunDeliveries();
    void store.startGatewayIfEnabled().catch((error) => {
      console.error("[gateway] failed to start on launch", error);
    });
    debugStartupLog("registered ipc handlers");
    installSecurityGuards();
    Menu.setApplicationMenu(buildAppMenu());
    const companionOnlyLaunch =
      isMenuBarLaunch || isMacosLoginItemLaunch || wasOpenedByMacosLoginItem();
    debugStartupLog("launch mode", {
      companionOnlyLaunch,
      isBackgroundSchedulerLaunch,
      isMenuBarLaunch,
      isMacosLoginItemLaunch,
    });
    if ((isBackgroundSchedulerLaunch || companionOnlyLaunch) && app.dock) {
      app.dock.hide();
    }
    if (process.platform === "darwin" && !isBackgroundSchedulerLaunch) {
      createMenuBarCompanion();
      debugStartupLog("created menu bar companion", {
        hasTray: Boolean(menuBarTray),
      });
    }
    if (!isBackgroundSchedulerLaunch) {
      if (companionOnlyLaunch) {
        void createCompanionWindow();
        debugStartupLog("created hidden companion window");
      } else {
        const smokeRoute = isIntuneChatSmokeLaunch
          ? "/chat"
          : isReportIssueSmokeLaunch
            ? "/chat"
            : undefined;
        void createWindow({
          show: true,
          ...(smokeRoute ? { route: smokeRoute } : {}),
        });
        debugStartupLog("created main window");
      }
    }
    // Fetch registry index in the background after the window is ready.
    // Falls back to local filesystem agents until the fetch completes.
    void refreshRegistryInBackground("startup");
    void store.pruneRunHistory("startup").catch((error) => {
      console.warn("[run-history] startup prune failed:", error);
    });
    void store.pruneDriftHistory("startup").catch((error) => {
      console.warn("[drift-history] startup prune failed:", error);
    });
    startAutoUpdater(() => mainWindow ?? undefined);

    // Agent scheduler: for normal visible launches, wait for the
    // regular minute tick instead of immediately catching up. Immediate
    // catch-up can touch the MSAL token cache and trigger a macOS
    // Keychain prompt before the user has done anything. Hidden
    // background launches are explicitly scheduler work, so they catch
    // up immediately.
    if (isBackgroundSchedulerLaunch) {
      void store.fireDueSchedules();
      void store.refreshDueGraphCaches();
    }
    const SCHEDULER_TICK_MS = 60_000;
    setInterval(() => {
      void store.fireDueSchedules();
      void store.refreshDueGraphCaches();
      void store.processPendingRunDeliveries();
      void store.pruneRunHistory("scheduler").catch((error) => {
        console.warn("[run-history] scheduler prune failed:", error);
      });
      void store.pruneDriftHistory("scheduler").catch((error) => {
        console.warn("[drift-history] scheduler prune failed:", error);
      });
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
      if (!mainWindow || mainWindow.isDestroyed()) {
        showDockForInteractiveSession();
        createMenuBarCompanionForInteractiveLaunch();
        void createWindow({ show: true });
      } else {
        showDockForInteractiveSession();
        createMenuBarCompanionForInteractiveLaunch();
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
