import type { BrowserWindow } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const FIRST_RUN_CAPTURE_WIDTH = 1280;
export const FIRST_RUN_CAPTURE_HEIGHT = 800;

type FirstRunCaptureAction =
  | "wait-first-run-scan"
  | "leave-scan"
  | "pick-services"
  | "leave-microsoft-step"
  | "open-connect-permissions"
  | "open-own-registration"
  | "close-setup";

export const FIRST_RUN_CAPTURE_SHOTS = [
  "first-run-scan",
  "first-run-microsoft",
  "first-run-microsoft-picked",
  "connect-permissions",
  "own-registration",
] as const;

// Theme changes animate colors; wait for the transition before capturing.
const THEME_SETTLE_MS = 1500;

export async function captureFirstRunShots(window: BrowserWindow, outDir: string): Promise<void> {
  await mkdir(join(outDir, "app"), { recursive: true });
  window.setContentSize(FIRST_RUN_CAPTURE_WIDTH, FIRST_RUN_CAPTURE_HEIGHT);
  window.webContents.setBackgroundThrottling(false);
  await waitForViewport(window);

  await runStep(window, "wait-first-run-scan");
  await captureThemes(window, outDir, "first-run-scan");
  await runStep(window, "leave-scan");
  await captureThemes(window, outDir, "first-run-microsoft");
  await runStep(window, "pick-services");
  await captureThemes(window, outDir, "first-run-microsoft-picked");
  await runStep(window, "leave-microsoft-step");

  await runStep(window, "open-connect-permissions");
  await captureThemes(window, outDir, "connect-permissions");
  await runStep(window, "close-setup");

  await runStep(window, "open-own-registration");
  await captureThemes(window, outDir, "own-registration");
  await runStep(window, "close-setup");

  console.log(`[first-run-capture] wrote ${FIRST_RUN_CAPTURE_SHOTS.length * 2} screenshots`);
}

/**
 * The first frame after a reload can fail with UnknownVizError while the
 * compositor has no surface yet; a few short retries wait for it.
 */
async function capturePage(window: BrowserWindow): Promise<Electron.NativeImage> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await window.webContents.capturePage();
    } catch (error) {
      lastError = error;
      window.webContents.invalidate();
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw lastError;
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
    await capturePage(window);
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
  await capturePage(window);
  await new Promise((resolve) => setTimeout(resolve, 100));
  window.webContents.invalidate();
  const image = await capturePage(window);
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

  const scrollIntoDialogView = async (selector: string) => {
    document.querySelector<HTMLElement>(selector)?.scrollIntoView({ block: "center" });
    await delay(250);
  };

  if (action === "wait-first-run-scan") {
    // The scan has settled (its stage reports the phase) and its exits are on screen.
    await waitFor(
      () =>
        document.querySelector('[data-phase="settled"]') !== null &&
        Boolean(findButton("Continue without a model")),
      "first-run model scan settled",
    );
    return;
  }

  if (action === "leave-scan") {
    // On a fresh install the scan hands over to Connect Microsoft 365.
    await clickButton("Continue without a model");
    await waitFor(
      () => document.querySelector("#microsoft-step-heading") !== null && Boolean(findButton("Not now")),
      "Connect Microsoft 365 step",
    );
    (document.activeElement as HTMLElement | null)?.blur();
    return;
  }

  if (action === "pick-services") {
    for (const service of ["intune", "entra"]) {
      const input = document.querySelector<HTMLInputElement>(`#microsoft-step-${service}`);
      if (!input) throw new Error(`The ${service} checkbox was not found.`);
      if (!input.checked) input.click();
    }
    await waitFor(
      () => bodyText().includes("read-only Microsoft Graph permissions") && !findButton("Sign in with Microsoft")?.disabled,
      "picked services with their permissions",
    );
    (document.activeElement as HTMLElement | null)?.blur();
    await delay(200);
    return;
  }

  if (action === "leave-microsoft-step") {
    await clickButton("Not now");
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
  }
}
