import type { BrowserWindow } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const FIRST_RUN_CAPTURE_WIDTH = 1280;
export const FIRST_RUN_CAPTURE_HEIGHT = 800;

type FirstRunCaptureAction =
  | "wait-first-run"
  | "add-sample-chat"
  | "open-sample-switcher"
  | "open-own-registration"
  | "close-setup"
  | "open-paused-schedules";

export async function captureFirstRunShots(
  window: BrowserWindow,
  outDir: string,
  preparePausedSchedules: () => Promise<void>,
): Promise<void> {
  await mkdir(join(outDir, "app"), { recursive: true });
  window.setContentSize(FIRST_RUN_CAPTURE_WIDTH, FIRST_RUN_CAPTURE_HEIGHT);
  window.webContents.setBackgroundThrottling(false);
  await waitForViewport(window);

  await runStep(window, "wait-first-run");
  await captureReloadedFirstRunThemes(window, outDir);

  await runStep(window, "add-sample-chat");
  await captureThemes(window, outDir, "sample-chat");

  await runStep(window, "open-sample-switcher");
  await captureThemes(window, outDir, "sample-switcher");

  await runStep(window, "open-own-registration");
  await captureThemes(window, outDir, "own-registration");
  await runStep(window, "close-setup");

  await preparePausedSchedules();
  const loaded = new Promise<void>((resolve) =>
    window.webContents.once("did-finish-load", () => resolve()),
  );
  window.webContents.reload();
  await loaded;
  await waitForViewport(window);
  await runStep(window, "open-paused-schedules");
  await captureThemes(window, outDir, "schedules-paused");

  console.log("[first-run-capture] wrote 10 screenshots");
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

async function captureReloadedFirstRunThemes(
  window: BrowserWindow,
  outDir: string,
): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await setCaptureTheme(window, theme);
    const loaded = new Promise<void>((resolve) =>
      window.webContents.once("did-finish-load", () => resolve()),
    );
    window.webContents.reload();
    await loaded;
    await waitForViewport(window);
    await runStep(window, "wait-first-run");
    await prepareCaptureSurface(window);
    await writeCapture(window, outDir, "first-run", theme);
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
      await new Promise((resolve) => setTimeout(resolve, 500));
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

  if (action === "wait-first-run") {
    await waitFor(
      () =>
        bodyText().includes("Choose how to start") &&
        bodyText().includes("Try with sample data") &&
        bodyText().includes("Use your organization's app registration"),
      "first-run choice",
    );
    return;
  }

  if (action === "add-sample-chat") {
    await clickButton("Try with sample data");
    await waitFor(
      () => !bodyText().includes("Choose how to start"),
      "sample tenant activation",
    );
    await navigate("/chat");
    await waitFor(
      () =>
        Boolean(document.querySelector('[id^="intune-chat-composer"]')) &&
        bodyText().includes("Sample data. Answers describe the fictional Contoso tenant."),
      "sample Chat composer",
    );
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '[id^="intune-chat-composer"]',
    );
    if (!textarea) throw new Error("Sample Chat textarea was not found.");
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(
      textarea,
      "Which managed devices have not synced in the last 7 days?",
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await clickButton("Send");
    await waitFor(
      () =>
        bodyText().includes("17 managed devices have not synced in more than 7 days.") &&
        bodyText().includes("Shown without an LLM summary."),
      "computed sample answer",
    );
    return;
  }

  if (action === "open-sample-switcher") {
    const trigger = buttons().find((button) =>
      button.getAttribute("aria-label")?.startsWith("Switch tenant, Contoso (sample data)"),
    );
    if (!trigger) throw new Error("Sample tenant switcher was not found.");
    trigger.click();
    await waitFor(
      () =>
        Boolean(document.querySelector('[role="menu"][aria-label="Connected tenants"]')) &&
        bodyText().includes("Fictional tenant"),
      "sample tenant menu",
    );
    return;
  }

  if (action === "open-own-registration") {
    const connect = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((button) => button.textContent?.trim() === "Connect tenant");
    if (!connect) throw new Error("Connect tenant menu item was not found.");
    connect.click();
    await waitFor(
      () => bodyText().includes("Connect a Microsoft 365 tenant"),
      "tenant setup dialog",
    );
    await clickButton("Connect with your own app registration");
    await waitFor(
      () =>
        Boolean(document.querySelector('input[name="tenant-client-id"]')) &&
        Boolean(document.querySelector('input[name="tenant-directory-id"]')) &&
        bodyText().includes("No client secret is used."),
      "own registration form",
    );
    const clientId = document.querySelector<HTMLElement>(
      'input[name="tenant-client-id"]',
    );
    let scrollParent = clientId?.parentElement;
    while (
      scrollParent &&
      !["auto", "scroll"].includes(getComputedStyle(scrollParent).overflowY)
    ) {
      scrollParent = scrollParent.parentElement;
    }
    if (scrollParent) scrollParent.scrollTop = scrollParent.scrollHeight;
    await delay(250);
    return;
  }

  if (action === "close-setup") {
    await clickButton("Close");
    await waitFor(
      () => !bodyText().includes("Connect a Microsoft 365 tenant"),
      "setup dialog close",
    );
    return;
  }

  await navigate("/agents?filter=scheduled");
  await waitFor(
    () =>
      bodyText().includes(
        "Schedules are paused while the sample tenant is active. Switch to a connected tenant to resume.",
      ) &&
      bodyText().includes("Switch to Contoso Production"),
    "paused schedules notice",
  );
}
