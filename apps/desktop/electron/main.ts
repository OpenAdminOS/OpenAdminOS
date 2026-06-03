import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  Notification,
  session,
  shell,
  type IpcMainInvokeEvent,
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
  AgentCommunitySubmissionMetadata,
  AgentSchedule,
  AgentTeamsDelivery,
  PendingConnectorDecision,
  ProviderId,
  RefreshGraphCacheOptions,
  ReleaseDiagnostics,
  ResetSelfTrainingInput,
  RunGraphApi,
  RunLlmApi,
  RunRecord,
  SaveTextFileArgs,
  SchedulerLaunchSettings,
  SelfTrainingSuggestionStatus,
  SetGraphCacheRefreshScheduleInput,
  SendIntuneChatMessageInput,
  IntuneChatStreamEvent,
  StartRunOptions,
} from "@openadminos/agent-sdk";
import { providerCatalog } from "@openadminos/agent-sdk";
import {
  installConnectorConfirmBridge,
  respondConnectorConfirm,
} from "./connector-confirm-bridge.js";
import { listRegisteredConnectors } from "@openadminos/runtime";
import { GRAPH_CACHE_RESOURCES } from "./intune-chat/planner.js";

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
const isIntuneChatSmokeLaunch =
  !app.isPackaged && process.env.OPENADMINOS_INTUNE_CHAT_SMOKE === "1";
const intuneChatSmokeUserData = process.env.OPENADMINOS_INTUNE_CHAT_SMOKE_USER_DATA;
const MACOS_SCHEDULER_LABEL = "com.openadminos.scheduler";
const WINDOWS_SCHEDULER_TASK = "OpenAdminOS Scheduler";
const providerIds = new Set(providerCatalog.map((provider) => provider.id));
const graphCacheResourceKinds = new Set<string>(
  GRAPH_CACHE_RESOURCES.map((resource) => resource.resource),
);
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

if (isIntuneChatSmokeLaunch && intuneChatSmokeUserData) {
  mkdirSync(intuneChatSmokeUserData, { recursive: true });
  app.setPath("userData", intuneChatSmokeUserData);
}

if (process.platform === "darwin" && isBackgroundSchedulerLaunch) {
  // Apply before `whenReady()` so a LaunchAgent scheduler wake does not
  // briefly flash OpenAdminOS in the Dock while the hidden process starts.
  app.setActivationPolicy("accessory");
}

let mainWindow: BrowserWindow | null = null;
let store: AppStateStore;
const activeNotifications = new Set<Notification>();
// Wall-clock timestamp of the most recent background registry refresh
// attempt. Used to rate-limit focus-triggered refreshes so alt-tabbing
// doesn't hammer GitHub. Manual refreshes from Agent Hub don't update
// this — the user explicitly asked for a fresh fetch.
let lastBackgroundRefreshAt = 0;

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
        label: "Intune Chat",
        accelerator: "CmdOrCtrl+3",
        click: () => navigate("/chat"),
      },
      {
        label: "Activity",
        accelerator: "CmdOrCtrl+4",
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
    const loadPromise = mainWindow.loadFile(join(app.getAppPath(), "dist/index.html"));
    if (isIntuneChatSmokeLaunch) {
      void loadPromise.then(runIntuneChatSmoke).catch(failIntuneChatSmoke);
    }
  } else {
    const loadPromise = mainWindow.loadURL(devServerUrl);
    if (isIntuneChatSmokeLaunch) {
      void loadPromise.then(runIntuneChatSmoke).catch(failIntuneChatSmoke);
    }
  }
}

function registerIpcHandlers() {
  ipcMain.handle("openadminos:get-app-state", handleTrusted(() => store.getAppState()));
  ipcMain.handle(
    "openadminos:get-scheduler-launch-settings",
    handleTrusted(() => getSchedulerLaunchSettings()),
  );
  ipcMain.handle(
    "openadminos:get-release-diagnostics",
    handleTrusted(() => getReleaseDiagnostics()),
  );
  ipcMain.handle(
    "openadminos:write-clipboard-text",
    handleTrusted((_event, text: unknown) => {
      clipboard.writeText(requireBoundedString(text, "clipboard text", 200_000));
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
    openExternalUrl(requireBoundedString(url, "url", 2_000));
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

if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (argv.includes(BACKGROUND_SCHEDULER_ARG)) {
      void store?.fireDueSchedules();
      void store?.refreshDueGraphCaches();
      return;
    }

    if (!mainWindow || mainWindow.isDestroyed()) {
      showDockForInteractiveSession();
      void createWindow({ show: true });
      return;
    }

    showDockForInteractiveSession();
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
    seedIntuneChatSmokeState(userDataDir);

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
      openBrowser: async (url: string) => {
        await shell.openExternal(url);
      },
      onRunFinished: (run) => {
        void maybeShowRunNotification(run);
      },
      ...(isIntuneChatSmokeLaunch
        ? {
            graphFactory: () => createIntuneChatSmokeGraph(),
            llmFactory: () => createIntuneChatSmokeLlm(),
          }
        : {}),
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
      void store.refreshDueGraphCaches();
    }
    const SCHEDULER_TICK_MS = 60_000;
    setInterval(() => {
      void store.fireDueSchedules();
      void store.refreshDueGraphCaches();
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
        showDockForInteractiveSession();
        void createWindow({ show: true });
      } else if (mainWindow && !mainWindow.isDestroyed()) {
        showDockForInteractiveSession();
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
