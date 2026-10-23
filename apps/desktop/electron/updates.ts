import { app, dialog, BrowserWindow } from "electron";
import electronUpdater from "electron-updater";
import type {
  UpdateChannel,
  UpdateChannelSettings,
  UpdateState,
} from "@openadminos/agent-sdk";
import { UpdateController, updateUnavailableReason } from "./update-controller.js";
import { RELEASE_FEED, ReleaseProvider } from "./update-provider.js";

export type { UpdateState };

let controller: UpdateController | undefined;
let idleState: UpdateState = { status: "idle" };
const listeners = new Set<(state: UpdateState) => void>();

export function getUpdateState(): UpdateState {
  return controller?.current() ?? idleState;
}

export function subscribeToUpdateState(
  listener: (state: UpdateState) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(next: UpdateState): void {
  for (const listener of listeners) {
    try {
      listener(next);
    } catch (error) {
      console.error("[updater] listener failed", error);
    }
  }
}

function unavailableReason() {
  return updateUnavailableReason({
    isPackaged: app.isPackaged,
    platform: process.platform,
    windowsStore: isWindowsStoreBuild(),
  });
}

export function getUpdateChannelSettings(channel: UpdateChannel): UpdateChannelSettings {
  const reason = unavailableReason();
  return reason ? { channel, unavailableReason: reason } : { channel };
}

/**
 * Applies a channel the admin picked. The caller persists it first; this
 * only switches the running updater, which discards a ready update from
 * the other channel and checks the new one right away.
 */
export function setUpdateChannel(channel: UpdateChannel): UpdateChannelSettings {
  controller?.configure(channel);
  return getUpdateChannelSettings(channel);
}

export async function applyUpdateNow(): Promise<void> {
  await controller?.install();
}

export async function checkForUpdatesNow(): Promise<UpdateState> {
  if (!app.isPackaged) return getUpdateState();
  if (unavailableReason() === "linux") {
    idleState = {
      status: "error",
      message:
        "Automatic updates are unavailable for unsigned Linux packages. Update through the signed apt repository or install the next package manually.",
    };
    notify(idleState);
    return idleState;
  }
  if (!controller) return getUpdateState();
  return controller.check();
}

/**
 * Wire `electron-updater` against the GitHub Releases feed on the given
 * channel: a 15-second startup delay, then a 4-hour poll.
 *
 * Skipped when:
 *   - The app is unpackaged (`npm run dev`): no autoUpdater target.
 *   - Running on Windows as a Microsoft Store-installed AppX: the
 *     Store handles updates itself; calling out to GitHub would let the
 *     two update channels race and break Store reputation. Detected
 *     via Electron's `process.windowsStore` flag.
 *   - Linux: packages are not executable-signed. Updates flow through the
 *     signed apt repository or an explicit package download instead of
 *     electron-updater replacing an executable without package trust.
 *
 * Call this after the main window is created so notification dialogs
 * have a parent. Safe to call once per session.
 */
export function startAutoUpdater(
  getMainWindow: () => BrowserWindow | undefined,
  channel: UpdateChannel,
): void {
  if (controller || unavailableReason()) return;
  const { autoUpdater } = electronUpdater;

  // The GitHub feed from app-update.yml, but nightly checks also offer a
  // newer stable release. Windows signature verification still reads
  // publisherName from app-update.yml, independent of this feed.
  autoUpdater.setFeedURL({
    ...RELEASE_FEED,
    provider: "custom",
    updateProvider: ReleaseProvider,
  });

  controller = new UpdateController({
    updater: autoUpdater,
    version: app.getVersion(),
    platform: process.platform,
    quit: () => app.quit(),
    onBeforeQuit: (listener) => app.on("before-quit", listener),
    confirmRestart: async (version) => {
      const parent = getMainWindow();
      const options: Electron.MessageBoxOptions = {
        type: "info",
        title: "Update ready",
        message: `OpenAdminOS ${version} downloaded`,
        detail: "Restart to install. The update is already on disk and will apply on quit.",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
        cancelId: 1,
      };
      const result = parent
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options);
      return result.response === 0;
    },
    notify,
  });
  controller.configure(channel);
}

export function stopAutoUpdater(): void {
  controller?.stop();
}

function isWindowsStoreBuild(): boolean {
  // Electron sets process.windowsStore = true when the app is running
  // from inside an MSIX / AppX container. The flag is not typed by
  // @types/node, so we read it via an index cast.
  return Boolean((process as unknown as { windowsStore?: boolean }).windowsStore);
}
