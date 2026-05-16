import { app, dialog, BrowserWindow } from "electron";
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

/**
 * Update polling cadence. Mirrors t3code: a 15-second startup delay
 * (so first-run UX isn't dominated by a network round-trip) plus a
 * 4-hour poll while the app is open.
 */
const STARTUP_DELAY_MS = 15_000;
const POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;

let pollTimer: NodeJS.Timeout | undefined;

/**
 * Wire `electron-updater` against the GitHub Releases publish channel.
 *
 * Skipped when:
 *   - The app is unpackaged (`npm run dev`) — no autoUpdater target.
 *   - Running on Windows as a Microsoft Store-installed AppX — the
 *     Store handles updates itself; calling out to GitHub would let the
 *     two update channels race and break Store reputation. Detected
 *     via Electron's `process.windowsStore` flag.
 *
 * Call this after the main window is created so notification dialogs
 * have a parent. Safe to call once per session.
 */
export function startAutoUpdater(getMainWindow: () => BrowserWindow | undefined): void {
  if (!app.isPackaged) return;
  if (process.platform === "win32" && isWindowsStoreBuild()) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("error", (error) => {
    console.error("[updater] error", error);
  });

  autoUpdater.on("update-downloaded", (info) => {
    const parent = getMainWindow();
    const options: Electron.MessageBoxOptions = {
      type: "info",
      title: "Update ready",
      message: `Open Agents ${info.version} downloaded`,
      detail: "Restart to install. The update is already on disk and will apply on quit.",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
    };

    const dialogPromise = parent
      ? dialog.showMessageBox(parent, options)
      : dialog.showMessageBox(options);

    void dialogPromise.then((result) => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch((error: unknown) => {
      console.error("[updater] checkForUpdates failed", error);
    });
  };

  setTimeout(check, STARTUP_DELAY_MS);
  pollTimer = setInterval(check, POLL_INTERVAL_MS);
}

export function stopAutoUpdater(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

function isWindowsStoreBuild(): boolean {
  // Electron sets process.windowsStore = true when the app is running
  // from inside an MSIX / AppX container. The flag is not typed by
  // @types/node, so we read it via an index cast.
  return Boolean((process as unknown as { windowsStore?: boolean }).windowsStore);
}
