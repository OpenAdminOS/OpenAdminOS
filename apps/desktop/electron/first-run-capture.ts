import type { BrowserWindow } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const FIRST_RUN_CAPTURE_WIDTH = 1280;
export const FIRST_RUN_CAPTURE_HEIGHT = 800;

type FirstRunCaptureAction =
  | "wait-first-run-scan"
  | "leave-scan"
  | "open-connect-permissions"
  | "open-own-registration"
  | "close-setup"
  | "start-pilot-chat"
  | "open-pilot-agents"
  | "run-inactive-devices"
  | "open-write-confirm"
  | "open-hidden-route"
  | "open-paused-schedules";

export const FIRST_RUN_CAPTURE_SHOTS = [
  "first-run-scan",
  "connect-permissions",
  "own-registration",
  "pilot-chat",
  "pilot-agents",
  "pilot-agent-report",
  "pilot-write-confirm",
  "pilot-hidden-route",
  "schedules-paused",
] as const;

// Theme changes animate colors; wait for the transition before capturing.
const THEME_SETTLE_MS = 1500;

export async function captureFirstRunShots(
  window: BrowserWindow,
  outDir: string,
  preparePausedSchedules: () => Promise<void>,
): Promise<void> {
  await mkdir(join(outDir, "app"), { recursive: true });
  window.setContentSize(FIRST_RUN_CAPTURE_WIDTH, FIRST_RUN_CAPTURE_HEIGHT);
  window.webContents.setBackgroundThrottling(false);
  await waitForViewport(window);

  await runStep(window, "wait-first-run-scan");
  await captureThemes(window, outDir, "first-run-scan");
  await runStep(window, "leave-scan");

  await runStep(window, "open-connect-permissions");
  await captureThemes(window, outDir, "connect-permissions");
  await runStep(window, "close-setup");

  await runStep(window, "open-own-registration");
  await captureThemes(window, outDir, "own-registration");
  await runStep(window, "close-setup");

  await runStep(window, "start-pilot-chat");
  await captureThemes(window, outDir, "pilot-chat");

  await runStep(window, "open-pilot-agents");
  await captureThemes(window, outDir, "pilot-agents");

  await runStep(window, "run-inactive-devices");
  await captureThemes(window, outDir, "pilot-agent-report");

  await runStep(window, "open-write-confirm");
  await captureThemes(window, outDir, "pilot-write-confirm");

  await runStep(window, "open-hidden-route");
  await captureThemes(window, outDir, "pilot-hidden-route");

  await preparePausedSchedules();
  const loaded = new Promise<void>((resolve) =>
    window.webContents.once("did-finish-load", () => resolve()),
  );
  window.webContents.reload();
  await loaded;
  await waitForViewport(window);
  await runStep(window, "open-paused-schedules");
  await captureThemes(window, outDir, "schedules-paused");

  console.log(`[first-run-capture] wrote ${FIRST_RUN_CAPTURE_SHOTS.length * 2} screenshots`);
}

async function captureThemes(
  window: BrowserWindow,
  outDir: string,
  name: string,
): Promise<void> {
  await prepareCaptureSurface(window);
  for (const theme of ["light", "dark"] as const) {
    await setCaptureTheme(window, theme);
    await writeCapture(window, outDir, name, theme);
  }
}

async function prepareCaptureSurface(window: BrowserWindow): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 600));
  await window.webContents.executeJavaScript(
    'document.documentElement.setAttribute("data-reduced-motion", "")',
    true,
  );
  for (let frame = 0; frame < 3; frame += 1) {
    window.webContents.invalidate();
    await window.webContents.capturePage();
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function setCaptureTheme(
  window: BrowserWindow,
  theme: "light" | "dark",
): Promise<void> {
  await window.webContents.executeJavaScript(
    `(async () => {
      await window.openAdminOS.setAppearance(${JSON.stringify(theme)});
      localStorage.setItem("openadminos:appearance:v1", ${JSON.stringify(theme)});
      window.dispatchEvent(new StorageEvent("storage", { key: "openadminos:appearance:v1" }));
      await document.fonts.ready;
      await new Promise((resolve) => setTimeout(resolve, ${THEME_SETTLE_MS}));
    })()`,
    true,
  );
}

async function writeCapture(
  window: BrowserWindow,
  outDir: string,
  name: string,
  theme: "light" | "dark",
): Promise<void> {
  window.webContents.invalidate();
  await window.webContents.capturePage();
  await new Promise((resolve) => setTimeout(resolve, 100));
  window.webContents.invalidate();
  const image = await window.webContents.capturePage();
  const size = image.getSize();
  if (
    size.width !== FIRST_RUN_CAPTURE_WIDTH ||
    size.height !== FIRST_RUN_CAPTURE_HEIGHT
  ) {
    throw new Error(
      `First-run capture ${name}-${theme} is ${size.width}x${size.height}; expected ${FIRST_RUN_CAPTURE_WIDTH}x${FIRST_RUN_CAPTURE_HEIGHT}.`,
    );
  }
  const outputPath = join(outDir, "app", `${name}-${theme}.png`);
  await writeFile(outputPath, image.toPNG());
  console.log(`[first-run-capture] wrote ${outputPath}`);
}

async function waitForViewport(window: BrowserWindow): Promise<void> {
  const expected = `${FIRST_RUN_CAPTURE_WIDTH}x${FIRST_RUN_CAPTURE_HEIGHT}`;
  let actual = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    actual = await window.webContents.executeJavaScript(
      '`${window.innerWidth}x${window.innerHeight}`',
      true,
    );
    if (actual === expected) return;
    window.setContentSize(FIRST_RUN_CAPTURE_WIDTH, FIRST_RUN_CAPTURE_HEIGHT);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`First-run capture viewport is ${actual}; expected ${expected}.`);
}

async function runStep(
  window: BrowserWindow,
  action: FirstRunCaptureAction,
): Promise<void> {
  await window.webContents.executeJavaScript(
    `(${firstRunCaptureStepScript.toString()})(${JSON.stringify(action)})`,
    true,
  );
}

async function firstRunCaptureStepScript(
  action: FirstRunCaptureAction,
): Promise<void> {
  const delay = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const bodyText = () => document.body.textContent ?? "";
  const waitFor = async (
    predicate: () => boolean,
    label: string,
    timeoutMs = 20000,
  ) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (predicate()) return;
      await delay(100);
    }
    throw new Error(
      `Timed out waiting for ${label}. Current page text: ${bodyText().slice(0, 2200)}`,
    );
  };
  const buttons = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
  const findButton = (label: string) =>
    buttons().find(
      (button) =>
        button.textContent?.trim() === label ||
        button.getAttribute("aria-label") === label,
    );
  const clickButton = async (label: string) => {
    await waitFor(() => Boolean(findButton(label)), `button ${label}`);
    findButton(label)!.click();
    await delay(150);
  };
  const navigate = async (route: string) => {
    const expected = `#${route}`;
    if (location.hash !== expected) location.hash = route;
    await waitFor(() => location.hash === expected, `${route} hash`);
    await delay(200);
  };

  const scrollIntoDialogView = async (selector: string) => {
    document.querySelector<HTMLElement>(selector)?.scrollIntoView({ block: "center" });
    await delay(250);
  };

  if (action === "wait-first-run-scan") {
    // The scan has settled (its stage reports the phase) and its exits are on screen.
    await waitFor(
      () =>
        document.querySelector('[data-phase="settled"]') !== null &&
        Boolean(findButton("Continue to Chat without a model")) &&
        Boolean(findButton("Preview with sample data")),
      "first-run model scan settled",
    );
    return;
  }

  if (action === "leave-scan") {
    await clickButton("Continue to Chat without a model");
    await waitFor(() => bodyText().includes("Choose a model to answer with"), "Chat with no model");
    return;
  }

  if (action === "open-connect-permissions") {
    await clickButton("Connect a tenant");
    await clickButton("Connect tenant");
    await waitFor(
      () =>
        bodyText().includes("Connect a Microsoft 365 tenant") &&
        buttons().some((button) => {
          const text = button.textContent?.trim() ?? "";
          return text.startsWith("Approve") && text.endsWith("continue to Microsoft");
        }),
      "permissions stage",
    );
    (document.activeElement as HTMLElement | null)?.blur();
    await delay(400);
    return;
  }

  if (action === "open-own-registration") {
    await clickButton("Connect a tenant");
    await clickButton("Connect tenant");
    const own = document.querySelector<HTMLInputElement>('input[type="radio"][value="own"]') ??
      Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find((input) => input.closest("label")?.textContent?.includes("Your own app registration"));
    if (!own) throw new Error("Own registration choice was not found.");
    own.click();
    await waitFor(
      () =>
        Boolean(document.querySelector('input[name="tenant-client-id"]')) &&
        Boolean(document.querySelector('input[name="tenant-directory-id"]')) &&
        bodyText().includes("No client secret is used."),
      "own registration form",
    );
    await scrollIntoDialogView('input[name="tenant-client-id"]');
    (document.activeElement as HTMLElement | null)?.blur();
    await delay(200);
    return;
  }

  if (action === "close-setup") {
    await clickButton("Cancel");
    await waitFor(
      () => !bodyText().includes("Connect a Microsoft 365 tenant"),
      "setup dialog close",
    );
    return;
  }

  if (action === "start-pilot-chat") {
    await clickButton("Preview with sample data");
    await waitFor(
      () =>
        Boolean(document.querySelector('[role="group"][aria-label="Prepared prompts"]')),
      "pilot Chat",
    );
    const chip = document.querySelector<HTMLButtonElement>(
      '[role="group"][aria-label="Prepared prompts"] button',
    );
    if (!chip) throw new Error("Pilot prompt chip was not found.");
    chip.click();
    await waitFor(
      () =>
        bodyText().includes("managed devices have not checked in with Intune") &&
        Boolean(document.querySelector('[role="group"][aria-label="Follow-up prompts"]')) &&
        bodyText().includes("In production, answers come from your tenant and the model you choose."),
      "prepared pilot answer",
    );
    // Pilot Chat keeps the prompt bubble at the top when the answer
    // arrives, so the narrative is on screen. Capture what the app shows.
    await delay(400);
    return;
  }

  if (action === "open-pilot-agents") {
    await navigate("/agents");
    await waitFor(
      () =>
        bodyText().includes("Available in pilot mode") &&
        bodyText().includes("Available in production") &&
        Boolean(findButton("Run Find inactive devices")),
      "pilot agents",
    );
    return;
  }

  if (action === "run-inactive-devices") {
    await clickButton("Run Find inactive devices");
    await waitFor(
      () =>
        location.hash.startsWith("#/runs/") &&
        bodyText().includes("Prepared sample report.") &&
        bodyText().includes("Pilot (prepared)"),
      "completed pilot run",
      40000,
    );
    await delay(500);
    return;
  }

  if (action === "open-write-confirm") {
    await navigate("/agents/stale-guest-cleanup/confirm");
    await clickButton("Start run");
    await waitFor(
      () =>
        location.hash.startsWith("#/runs/") &&
        bodyText().includes("DISABLE 5 GUESTS") &&
        bodyText().includes("Type the phrase below to confirm"),
      "write confirmation",
      40000,
    );
    await delay(500);
    return;
  }

  if (action === "open-hidden-route") {
    await navigate("/office");
    await waitFor(
      () => bodyText().includes("Agent Team is available in production. Connect your tenant to use it."),
      "pilot hidden route",
    );
    return;
  }

  await navigate("/agents");
  await waitFor(
    () =>
      bodyText().includes(
        "Schedules are paused while pilot mode is active. Switch to a connected tenant to resume.",
      ) &&
      bodyText().includes("Switch to Contoso Production"),
    "paused schedules notice",
  );
}
