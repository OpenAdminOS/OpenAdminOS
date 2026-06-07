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
import { writeFile } from "node:fs/promises";
import { arch as osArch, release as osRelease } from "node:os";
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
  CompanionRunDueReadSchedulesResult,
  CompanionSnapshot,
  PendingConnectorDecision,
  ProviderId,
  RefreshGraphCacheOptions,
  ReleaseDiagnostics,
  ResetSelfTrainingInput,
  RunGraphApi,
  RunLlmApi,
  RunRecord,
  SandboxSettings,
  SaveTextFileArgs,
  SchedulerLaunchSettings,
  SelfTrainingSuggestionStatus,
  SetGraphCacheRefreshScheduleInput,
  SendIntuneChatMessageInput,
  SupportBundleInput,
  SupportIssueSubmissionInput,
  SupportIssueSubmissionResult,
  IntuneChatStreamEvent,
  StartRunOptions,
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
import { DEFAULT_REGISTRY_SOURCE } from "./registry-client.js";

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
const supportIssueSources = new Set([
  "sidebar",
  "run-failure",
  "settings-about",
  "native-menu",
]);
const intuneChatStreamControllers = new Map<string, AbortController>();
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
const DEFAULT_SUPPORT_API_URL = "https://openadminos.com";
const COMPANION_WINDOW_WIDTH = 390;
const COMPANION_WINDOW_HEIGHT = 520;
const launchSandboxedCodeDefault = process.env[OPENADMINOS_MXC_FLAG] === "1";

const smokeUserData = isIntuneChatSmokeLaunch
  ? intuneChatSmokeUserData
  : isReportIssueSmokeLaunch
    ? reportIssueSmokeUserData
    : undefined;

const overrideUserData = smokeUserData ?? devUserDataDir;

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
        activeModelByProviderId: { ollama: "smoke-local-model" },
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
    defaultModel: "smoke-local-model",
    async complete() {
      return {
        text: "WIN-01 is stale based on cached Intune and Entra device evidence.",
        model: "smoke-local-model",
      };
    },
    async *stream(options) {
      if (options.prompt.includes("Hold response for cancellation smoke")) {
        yield {
          delta: "Partial response",
          accumulated: "Partial response",
          done: false,
          model: "smoke-local-model",
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
        model: "smoke-local-model",
      };
      yield {
        delta: " based on cached Intune and Entra device evidence.",
        accumulated: "WIN-01 is stale based on cached Intune and Entra device evidence.",
        done: true,
        model: "smoke-local-model",
      };
    },
  };
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

  location.hash = "/onboarding";
  await waitFor(() => bodyText().includes("Welcome to OpenAdminOS."), "onboarding welcome");
  await clickButton("Get started");
  await waitFor(
    () =>
      bodyText().includes("Connect a Microsoft 365 tenant") &&
      bodyText().includes("Smoke Tenant"),
    "onboarding tenant step",
  );
  await clickButton("Continue with this tenant");
  await waitFor(() => bodyText().includes("Pick an LLM provider"), "onboarding provider step");
  await clickButton("Continue");
  await waitFor(
    () =>
      bodyText().includes("Choose where to start") &&
      bodyText().includes("Ask Intune Chat") &&
      bodyText().includes("Browse Agent Hub") &&
      bodyText().includes("Optional starter agent"),
    "onboarding workspace choice",
  );
  const sawOnboardingWorkspaceChoice = bodyText().includes("Open Intune Chat");
  await clickButton("Open Intune Chat");
  await waitFor(() => location.hash === "#/chat", "onboarding chat navigation");

  location.hash = "/settings";
  await waitFor(() => bodyText().includes("Settings"), "Settings route");
  await clickButton("Intune Chat");
  await waitFor(() => bodyText().includes("Tenant cache"), "Intune Chat settings");
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
  const smokeAnswer =
    "WIN-01 is stale based on cached Intune and Entra device evidence.";
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
    await waitFor(
      () => textOccurrenceCount(smokeAnswer) >= expectedResponseCount,
      `chat response ${expectedResponseCount}`,
    );
    await waitFor(() => !bodyText().includes("Thinking"), "chat send settled");
    responseCount = expectedResponseCount;
  }
  await waitFor(() => bodyText().includes("WIN-01 is stale"), "chat answer");
  await waitFor(() => bodyText().includes("Offboarding agent"), "agent suggestion");
  await clickSummary("Source details");
  await waitFor(
    () => bodyText().includes("/deviceManagement/managedDevices"),
    "source details endpoint",
  );
  await clickButton("Regenerate");
  await waitFor(
    () =>
      bodyText().includes("Check cached tenant data") ||
      bodyText().includes("Generate response"),
    "regenerate progress checklist",
    2500,
  );
  await waitFor(
    () => textOccurrenceCount(smokeAnswer) >= responseCount + 1,
    "regenerated chat response",
  );
  await waitFor(() => !bodyText().includes("Thinking"), "regenerate send settled");
  const sawRegenerate = textOccurrenceCount(smokeAnswer) >= responseCount + 1;
  await clickButton("Edit");
  await waitFor(() => {
    const textarea = document.querySelector("textarea");
    return textarea instanceof HTMLTextAreaElement &&
      textarea.value.includes("Which managed devices have not synced");
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
  const sawAgentSuggestion = bodyText().includes("Offboarding agent");
  const sawConversationLifecycle =
    bodyText().includes("Smoke lifecycle review") && bodyText().includes("Unpin");
  const sawSourceDetails = bodyText().includes("/deviceManagement/managedDevices");
  const sawEditResend = (() => {
    const textarea = document.querySelector("textarea");
    return textarea instanceof HTMLTextAreaElement &&
      textarea.value.includes("Which managed devices have not synced");
  })();

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

  location.hash = "/settings";
  await waitFor(() => bodyText().includes("Settings"), "Settings route");
  await clickButton("Intune Chat");
  await waitFor(() => bodyText().includes("Accept"), "self-training suggestion");
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
    hasOnboardingWorkspaceChoice: sawOnboardingWorkspaceChoice,
    hasConversationLifecycle: sawConversationLifecycle,
    hasSourceDetails: sawSourceDetails,
    hasEditResend: sawEditResend,
    hasRegenerate: sawRegenerate,
    hasStopGeneration: sawStopGeneration,
    hasPinnedCategory: sawPinnedCategory,
    hasContextMenuDelete: sawContextMenuDelete,
    hasAcceptedLearning: bodyText().includes("Active overlays"),
    hasScheduledRefresh: bodyText().includes("Enabled"),
    hasLocalDataControls: sawLocalDataControls,
    hasLocalDataClearModal: sawLocalDataClearModal,
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
    () => bodyText().includes("Report issue") && bodyText().includes("Public GitHub issue"),
    "sidebar report issue action",
  );
  await clickButton("Report issue");
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
    "1. Open the sidebar report action.\n2. Fill the modal.\n3. Confirm public issue creation.",
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
    hasSidebarAction: bodyText().includes("Public GitHub issue"),
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
  return {
    tenantId: requireBoundedString(value.tenantId, "hostedProviderConsent.tenantId", 256),
    providerId: validateProviderId(value.providerId, "hostedProviderConsent.providerId"),
    acknowledgedAt,
    ...(typeof value.remember === "boolean" ? { remember: value.remember } : {}),
  };
}

function validateSendIntuneChatMessageInput(value: unknown): SendIntuneChatMessageInput {
  if (!isPlainRecord(value)) {
    throw new Error("Intune Chat message input must be an object.");
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
  };
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
            accelerator: "Cmd+,",
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
        label: "Agents",
        accelerator: "CmdOrCtrl+1",
        click: () => {
          void openMainWindow("/");
        },
      },
      {
        label: "Agent Hub",
        accelerator: "CmdOrCtrl+2",
        click: () => {
          void openMainWindow("/hub");
        },
      },
      {
        label: "Intune Chat",
        accelerator: "CmdOrCtrl+3",
        click: () => {
          void openMainWindow("/chat");
        },
      },
      {
        label: "Activity",
        accelerator: "CmdOrCtrl+4",
        click: () => {
          void openMainWindow("/activity");
        },
      },
      {
        label: "Settings",
        accelerator: "CmdOrCtrl+,",
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

async function createWindow({ show = true, route }: { show?: boolean; route?: string } = {}) {
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
      preload: join(currentDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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
    const loadPromise = mainWindow.loadFile(join(app.getAppPath(), "dist/index.html"), {
      ...(routeHash(route) ? { hash: routeHash(route) } : {}),
    });
    if (isIntuneChatSmokeLaunch) {
      void loadPromise.then(runIntuneChatSmoke).catch(failIntuneChatSmoke);
    }
    if (isReportIssueSmokeLaunch) {
      void loadPromise.then(runReportIssueSmoke).catch(failReportIssueSmoke);
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
      });
    }),
  );
  ipcMain.handle(
    "openadminos:cancel-intune-chat-stream",
    handleTrusted((_event, streamId: unknown) => {
      const safeStreamId = requireBoundedString(streamId, "streamId", 128);
      intuneChatStreamControllers.get(safeStreamId)?.abort();
    }),
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
    "openadminos:get-self-training-settings",
    handleTrusted(() => store.getSelfTrainingSettings()),
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
  ipcMain.handle("openadminos:connect-tenant", handleTrusted(async () => {
    const state = await store.connectTenant();
    void registerSchedulerIfReady("tenant");
    return state;
  }));
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
    seedIntuneChatSmokeState(userDataDir);
    seedReportIssueSmokeState(userDataDir);

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
      ...(isIntuneChatSmokeLaunch
        ? {
            graphFactory: () => createIntuneChatSmokeGraph(),
            llmFactory: () => createIntuneChatSmokeLlm(),
          }
        : {}),
    });
    applySandboxedCodeEnabled(await store.getSandboxedCodeEnabled());
    registerIpcHandlers();
    void store.processPendingRunDeliveries();
    debugStartupLog("registered ipc handlers");
    void store.processPendingRunDeliveries();
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
        void createWindow({ show: true });
        debugStartupLog("created main window");
      }
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
      void store.refreshDueGraphCaches();
    }
    const SCHEDULER_TICK_MS = 60_000;
    setInterval(() => {
      void store.fireDueSchedules();
      void store.refreshDueGraphCaches();
      void store.processPendingRunDeliveries();
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
