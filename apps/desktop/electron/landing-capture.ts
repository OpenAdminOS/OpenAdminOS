/**
 * Development-only capture of the website landing screenshots, called behind
 * the unpackaged screenshot guard. The app lays out at 1280 x 800 and renders
 * at 2x, so the product reads at landing-page sizes, in light and dark.
 *
 * 2x comes from page zoom in a 2560 x 1600 window rather than a forced device
 * scale factor, which Chromium clamps to the display size under Xvfb.
 */
import type { BrowserWindow } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const LANDING_CAPTURE_WIDTH = 1280;
export const LANDING_CAPTURE_HEIGHT = 800;
export const LANDING_CAPTURE_SCALE = 2;

type Prepare = "chat-empty" | "chat-transcript" | "write-confirmation";

export interface LandingCaptureStep {
  route: string;
  waitFor: string[];
  prepare?: Prepare;
  heading?: string;
  selector?: string;
}

const SHOTS: Array<LandingCaptureStep & { name: string }> = [
  {
    name: "chat-transcript",
    route: "/chat",
    waitFor: ["Ollama"],
    prepare: "chat-transcript",
    selector: '[id^="intune-chat-composer"]',
  },
  {
    name: "hub-grid",
    route: "/agents?source=hub",
    waitFor: ["Library", "hub agents"],
    heading: "Agents",
  },
  {
    name: "agent-team",
    route: "/office",
    waitFor: ["Agent Team", "Review inbox"],
    heading: "Agent Team",
  },
  {
    name: "write-confirmation",
    route: "/runs/screenshot-write-run",
    waitFor: [
      "Write operation paused for confirmation",
      "RETIRE 2 DEVICES",
      "Microsoft Graph changes may not be reversible",
    ],
    prepare: "write-confirmation",
  },
  {
    name: "settings",
    route: "/settings/providers",
    waitFor: ["Settings", "Providers"],
    heading: "Settings",
  },
];

export async function captureLandingShots(
  window: BrowserWindow,
  outDir: string,
  navigate: (step: LandingCaptureStep) => Promise<string>,
) {
  await mkdir(outDir, { recursive: true });
  const pixelWidth = LANDING_CAPTURE_WIDTH * LANDING_CAPTURE_SCALE;
  const pixelHeight = LANDING_CAPTURE_HEIGHT * LANDING_CAPTURE_SCALE;
  window.setContentSize(pixelWidth, pixelHeight);
  window.webContents.setBackgroundThrottling(false);
  const applyZoom = async () => {
    window.webContents.setZoomFactor(LANDING_CAPTURE_SCALE);
    // The zoom reaches the page asynchronously; wait for the layout viewport.
    const expected = JSON.stringify([LANDING_CAPTURE_WIDTH, LANDING_CAPTURE_HEIGHT]);
    let viewport = "";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      viewport = await window.webContents.executeJavaScript(
        "JSON.stringify([innerWidth, innerHeight])",
      );
      if (viewport === expected) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (viewport !== expected) {
      throw new Error(
        `Landing capture viewport is ${viewport}; expected ${LANDING_CAPTURE_WIDTH}x${LANDING_CAPTURE_HEIGHT}. Use a display of at least ${pixelWidth}x${pixelHeight}.`,
      );
    }
  };

  // A staffed Agent Team reads as the product; the empty state does not.
  await window.webContents.executeJavaScript(`(async () => {
    const state = await window.openAdminOS.getAppState();
    if (state.office.personas.length) return;
    for (const [name, avatar, color, agentSlugs, responsibility] of [
      ['Chief of Staff', 'robot', 'amber', ['compliance-overview','team-evidence-review'], 'Coordinate checks and review findings.'],
      ['Policy Watcher', 'fox', 'sage', ['compliance-overview'], 'Review compliance posture and flag changes.'],
      ['Device Investigator', 'owl', 'blue', ['find-inactive-devices'], 'Investigate inactive devices and stale inventory.'],
    ]) await window.openAdminOS.saveOfficePersona({name,avatar,color,agentSlugs,responsibility,tenantId:state.activeTenantId,providerId:'ollama',intervalMinutes:null,maxMinutes:30,enabled:true});
  })()`);
  const loaded = new Promise<void>((resolve) =>
    window.webContents.once("did-finish-load", () => resolve()),
  );
  window.webContents.reload();
  await loaded;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await applyZoom();

  // The transcript is prepared once and revisited, so the sidebar holds one
  // conversation instead of one per theme.
  let transcriptRoute: string | undefined;
  for (const theme of ["light", "dark"] as const) {
    await window.webContents.executeJavaScript(
      `window.openAdminOS.setAppearance(${JSON.stringify(theme)})`,
    );
    await window.webContents.executeJavaScript(
      `localStorage.setItem("openadminos:appearance:v1", ${JSON.stringify(theme)}); window.dispatchEvent(new StorageEvent("storage", {key:"openadminos:appearance:v1"}));`,
    );
    for (const { name, ...shot } of SHOTS) {
      const reuse = shot.prepare === "chat-transcript" && transcriptRoute;
      const hash = await navigate(
        reuse
          ? {
              ...shot,
              route: transcriptRoute!,
              prepare: undefined,
              waitFor: [
                ...shot.waitFor,
                "WIN-01 is stale based on cached Intune and Entra device evidence.",
              ],
            }
          : shot,
      );
      if (shot.prepare === "chat-transcript" && !reuse && hash.startsWith("#/chat/")) {
        transcriptRoute = hash.slice(1);
      }
      await applyZoom();
      // No focus rings or hover states from the capture itself: blur the
      // focused control and park the pointer on an empty strip of the top bar.
      await window.webContents.executeJavaScript(
        "document.activeElement instanceof HTMLElement && document.activeElement.blur()",
      );
      window.webContents.sendInputEvent({
        type: "mouseMove",
        x: Math.round(pixelWidth * 0.62),
        y: 6,
      });
      await window.webContents.executeJavaScript("document.fonts.ready");
      // Force and discard one frame so the capture matches the verified DOM.
      window.webContents.invalidate();
      await window.webContents.capturePage();
      await new Promise((resolve) => setTimeout(resolve, 250));
      window.webContents.invalidate();
      const image = await window.webContents.capturePage();
      const size = image.getSize();
      if (size.width !== pixelWidth || size.height !== pixelHeight) {
        throw new Error(
          `Landing capture ${name} is ${size.width}x${size.height}; expected ${pixelWidth}x${pixelHeight}.`,
        );
      }
      await writeFile(join(outDir, `${name}-${theme}.png`), image.toPNG());
      console.log(`[landing-capture] wrote ${name}-${theme}.png`);
    }
  }
}
