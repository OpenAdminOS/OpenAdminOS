import type { UpdateChannel, UpdateState, UpdateUnavailableReason } from "@openadminos/agent-sdk";
import type { AppUpdater } from "electron-updater";
import { CancellationToken } from "electron-updater";
import { isNightlyVersion } from "../src/shared/update-channel.js";

/** The parts of electron-updater's AppUpdater the controller drives. */
export type UpdaterPort = Pick<
  AppUpdater,
  | "channel"
  | "allowPrerelease"
  | "allowDowngrade"
  | "autoDownload"
  | "autoInstallOnAppQuit"
  | "autoRunAppAfterInstall"
  | "on"
  | "checkForUpdates"
  | "downloadUpdate"
  | "quitAndInstall"
>;

export interface UpdateHost {
  updater: UpdaterPort;
  /** Version of the running build, `app.getVersion()`. */
  version: string;
  platform: NodeJS.Platform;
  /** Quits the app, `app.quit()`. */
  quit(): void;
  /** Registers an `app.on("before-quit")` listener. */
  onBeforeQuit(listener: (event: { preventDefault(): void }) => void): void;
  /** Asks whether to restart into a downloaded update now. */
  confirmRestart(version: string): Promise<boolean>;
  notify(state: UpdateState): void;
}

/** Shown when the admin changes the channel while an update is being installed. */
export const CHANNEL_LOCKED_WHILE_INSTALLING =
  "An update is being installed. Change the channel after OpenAdminOS restarts.";

/** Startup delay so first-run UX is not dominated by a network round-trip. */
export const STARTUP_DELAY_MS = 15_000;
/** Poll while the app is open. */
export const POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * electron-updater errors can carry a stack, HTTP headers or the whole
 * release feed after the first line. Only the first line is shown.
 */
function errorSummary(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text.split("\n", 1)[0]?.trim() ?? "";
  return line.length > 300 ? `${line.slice(0, 300)}…` : line || "The updater reported an error without details.";
}

/**
 * Why this install cannot use electron-updater, or undefined when it can.
 * Linux packages are not executable-signed and update through the signed
 * apt repository or a manual download; Microsoft Store builds update
 * through the Store; development runs have no update target.
 */
export function updateUnavailableReason(input: {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  windowsStore: boolean;
}): UpdateUnavailableReason | undefined {
  if (input.platform === "linux") return "linux";
  if (input.platform === "win32" && input.windowsStore) return "windows-store";
  if (!input.isPackaged) return "development";
  return undefined;
}

/**
 * Checks GitHub releases on the selected channel, downloads in the
 * background, and installs only after the admin restarts or quits.
 *
 * Downloads are never automatic: one starts only for an update-available
 * from a check of the current channel. A generation counter is bumped on
 * every channel switch so check results, download events and installs that
 * belong to the previous channel are dropped, and a ready update from the
 * previous channel is discarded. `autoInstallOnAppQuit` stays off so
 * electron-updater never installs a stale download on its own; installing
 * on quit goes through `install(true)` instead.
 */
export class UpdateController {
  private state: UpdateState = { status: "idle" };
  private nightly: boolean | null = null;
  private started = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  // Bumped when the channel changes, so work for the previous channel is recognised.
  private generation = 0;
  private checking: { generation: number; done: Promise<void> } | null = null;
  private downloading: {
    generation: number;
    token: CancellationToken;
    done: Promise<void>;
  } | null = null;
  private installing = false;
  private quitAfterInstallError = false;

  constructor(private readonly host: UpdateHost) {
    const { updater } = host;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;

    updater.on("update-not-available", () => {
      if (this.currentActivity()) this.set({ status: "not-available" });
    });
    updater.on("update-available", (info) => {
      // electron-updater emits this before the check returns, so `checking`
      // still identifies the check that found it.
      if (!this.started || this.checking?.generation !== this.generation) return;
      this.set({ status: "downloading", version: info.version });
      const download = {
        generation: this.generation,
        token: new CancellationToken(),
        done: Promise.resolve(),
      };
      this.downloading = download;
      // Failures also arrive as error events.
      download.done = Promise.resolve()
        .then(() => updater.downloadUpdate(download.token))
        .then(() => undefined, () => undefined)
        .finally(() => {
          if (this.downloading === download) this.downloading = null;
        });
    });
    updater.on("update-downloaded", (info) => {
      if (!this.currentActivity()) return;
      this.set({ status: "ready", version: info.version });
      const generation = this.generation;
      void host.confirmRestart(info.version).then((restart) => {
        if (restart && generation === this.generation) void this.install();
      });
    });
    updater.on("error", (error) => {
      const quitAfterError = this.quitAfterInstallError;
      if (!this.currentActivity() && !quitAfterError) return;
      // Also reports an installer that could not start, so installing may be tried again.
      this.installing = false;
      this.quitAfterInstallError = false;
      console.error("[updater] error", error);
      updater.autoRunAppAfterInstall = true;
      this.set({ status: "error", message: errorSummary(error) });
      if (quitAfterError) host.quit();
    });
    host.onBeforeQuit((event) => {
      if (!this.started || this.state.status !== "ready" || this.installing) return;
      event.preventDefault();
      void this.install(true);
    });
  }

  current(): UpdateState {
    return this.state;
  }

  channel(): UpdateChannel | null {
    if (this.nightly === null) return null;
    return this.nightly ? "nightly" : "stable";
  }

  /**
   * Whether the channel can change now. Not while an install is under way:
   * on macOS, Squirrel stages the downloaded update asynchronously after
   * quitAndInstall() and then installs it from a native callback the
   * generation counter cannot reach, so a switch at that point would still
   * install the previous channel's update.
   */
  canChangeChannel(channel: UpdateChannel): boolean {
    return !this.installing || this.channel() === channel;
  }

  /**
   * Starts background checks on the given channel, or switches channel.
   * A switch cancels work for the previous channel and checks right away.
   * Throws while an update is being installed, see canChangeChannel().
   */
  configure(channel: UpdateChannel): void {
    if (!this.canChangeChannel(channel)) throw new Error(CHANNEL_LOCKED_WHILE_INSTALLING);
    const nightly = channel === "nightly";
    const firstStart = !this.started;
    const channelChanged = this.nightly !== null && nightly !== this.nightly;
    this.useChannel(nightly);
    this.started = true;
    if (firstStart) {
      this.startupTimer = setTimeout(() => void this.check(), STARTUP_DELAY_MS);
      this.pollTimer = setInterval(() => void this.check(), POLL_INTERVAL_MS);
    } else if (channelChanged) {
      // A check still running for the previous channel is followed right away by one for this channel.
      void this.check();
    }
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.pollTimer = null;
    this.startupTimer = null;
    this.started = false;
  }

  async check(): Promise<UpdateState> {
    // electron-updater hands out a running check again, even one for the
    // previous channel, so that one has to settle before this channel is checked.
    while (
      (this.checking && this.checking.generation !== this.generation) ||
      (this.downloading && this.downloading.generation !== this.generation)
    ) {
      await Promise.all([this.checking?.done, this.downloading?.done]);
    }
    if (!this.started || this.state.status === "ready" || this.downloading) return this.state;
    if (!this.checking) {
      const generation = this.generation;
      const checking = {
        generation,
        done: Promise.resolve().then(() => this.run(generation)),
      };
      this.checking = checking;
      void checking.done.finally(() => {
        if (this.checking === checking) this.checking = null;
      });
    }
    await this.checking.done;
    return this.state;
  }

  private async run(generation: number): Promise<void> {
    if (!this.started || generation !== this.generation) return;
    this.set({ status: "checking" });
    try {
      await this.host.updater.checkForUpdates();
    } catch (error) {
      if (generation !== this.generation) return;
      console.error("[updater] checkForUpdates failed", error);
      this.set({ status: "error", message: `Update check failed. ${errorSummary(error)}` });
    }
  }

  /**
   * Restarts into the downloaded update of the current channel. With
   * `onQuit` it installs silently while the app quits. False when nothing
   * was installed.
   */
  async install(onQuit = false): Promise<boolean> {
    if (!this.started || this.state.status !== "ready" || this.installing) return false;
    this.installing = true;
    const { updater, platform } = this.host;
    if (!onQuit) {
      updater.quitAndInstall();
      // An installer that fails to start reports an error right away, which clears installing.
      return this.installing;
    }
    // macOS must let Squirrel fetch the selected update before quitting.
    // Without autoRunAppAfterInstall MacUpdater then quits instead of
    // relaunching, and Squirrel installs the update as the app exits.
    if (platform === "darwin") {
      this.quitAfterInstallError = true;
      updater.autoRunAppAfterInstall = false;
      updater.quitAndInstall();
      return this.installing;
    }
    // Quits like quitAndInstall does after starting the installer, and also when it could not.
    updater.quitAndInstall(true, false);
    setImmediate(() => this.host.quit());
    return true;
  }

  /**
   * Nightly follows the nightly feed (nightly*.yml on prereleases), stable
   * only stable releases (latest*.yml). A nightly install returning to
   * stable may install the current stable even when it is older. Stable
   * installs and ordinary nightly updates never downgrade.
   */
  private useChannel(nightly: boolean): void {
    if (nightly === this.nightly) return;
    const switching = this.nightly !== null;
    this.nightly = nightly;
    this.generation++;
    this.downloading?.token.cancel();
    const { updater } = this.host;
    updater.channel = nightly ? "nightly" : "latest";
    updater.allowPrerelease = nightly;
    // The channel setter also sets allowDowngrade = true, so this has to come after it.
    updater.allowDowngrade = !nightly && isNightlyVersion(this.host.version);
    // A ready or partially downloaded update from the other channel must never install.
    if (switching) this.set({ status: "idle" });
  }

  private currentActivity(): boolean {
    return (
      this.started &&
      (!this.checking || this.checking.generation === this.generation) &&
      (!this.downloading || this.downloading.generation === this.generation)
    );
  }

  private set(next: UpdateState): void {
    this.state = next;
    try {
      this.host.notify(next);
    } catch (error) {
      console.error("[updater] listener failed", error);
    }
  }
}
