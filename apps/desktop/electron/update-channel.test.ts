import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { UpdateState } from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";
import type { CancellationToken } from "electron-updater";
import { withAgentCompatibility } from "./agent-draft-helpers.js";
import { AppStateStore } from "./state.js";
import {
  UpdateController,
  switchAndSaveChannel,
  updateUnavailableReason,
  type UpdaterPort,
} from "./update-controller.js";
import { defaultUpdateChannel, isNightlyVersion } from "../src/shared/update-channel.js";

type Handler = (...args: unknown[]) => void;

/** Stands in for electron-updater's AppUpdater, including its channel setter side effect. */
class FakeUpdater {
  private current: string | null = null;
  allowPrerelease = false;
  allowDowngrade = false;
  autoDownload = true;
  autoInstallOnAppQuit = true;
  autoRunAppAfterInstall = true;
  readonly handlers = new Map<string, Handler>();
  checks = 0;
  readonly downloads: CancellationToken[] = [];
  readonly installs: unknown[][] = [];
  /** Next checkForUpdates implementations, used in order. */
  readonly checkQueue: Array<() => Promise<unknown>> = [];
  /** Next downloadUpdate implementations, used in order. */
  readonly downloadQueue: Array<() => Promise<unknown>> = [];

  get channel(): string | null {
    return this.current;
  }

  // Like electron-updater, setting a channel also allows downgrades.
  set channel(value: string | null) {
    this.current = value;
    this.allowDowngrade = true;
  }

  on(event: string, handler: Handler): this {
    this.handlers.set(event, handler);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    this.handlers.get(event)?.(...args);
  }

  checkForUpdates(): Promise<unknown> {
    this.checks++;
    return (this.checkQueue.shift() ?? (async () => null))();
  }

  downloadUpdate(token?: CancellationToken): Promise<unknown> {
    if (token) this.downloads.push(token);
    return (this.downloadQueue.shift() ?? (async () => []))();
  }

  quitAndInstall(...args: unknown[]): void {
    this.installs.push(args);
  }
}

function harness(t: TestContext, version = "0.7.0", platform: NodeJS.Platform = "darwin") {
  const updater = new FakeUpdater();
  const states: UpdateState[] = [];
  let beforeQuit: ((event: { preventDefault(): void }) => void) | undefined;
  let quits = 0;
  const confirm = { answer: false, asked: [] as string[] };
  const controller = new UpdateController({
    updater: updater as unknown as UpdaterPort,
    version,
    platform,
    quit: () => {
      quits++;
    },
    onBeforeQuit: (listener) => {
      beforeQuit = listener;
    },
    confirmRestart: async (next) => {
      confirm.asked.push(next);
      return confirm.answer;
    },
    notify: (state) => states.push(state),
  });
  t.after(() => controller.stop());
  return {
    updater,
    controller,
    states,
    confirm,
    quits: () => quits,
    beforeQuit: () => {
      let prevented = false;
      beforeQuit?.({ preventDefault: () => (prevented = true) });
      return prevented;
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("update channel preference", () => {
  const tokenStore: TokenCacheStorage = { read: async () => "", write: async () => undefined };

  async function store(t: TestContext, appVersion: string, dir?: string) {
    const root = dir ?? (await mkdtemp(join(tmpdir(), "openadminos-update-channel-")));
    if (!dir) t.after(() => rm(root, { recursive: true, force: true }));
    const instance = new AppStateStore({
      filePath: join(root, "state.json"),
      tokenStore,
      statsApiUrl: "",
      appVersion,
    });
    return { root, instance };
  }

  it("defaults to the channel of the installed build", async (t) => {
    assert.equal(isNightlyVersion("0.7.1-nightly.20261023141500"), true);
    assert.equal(isNightlyVersion("0.7.1"), false);
    assert.equal(defaultUpdateChannel("0.7.0"), "stable");
    assert.equal(defaultUpdateChannel("0.7.1-nightly.20261023141500"), "nightly");
    assert.equal(await (await store(t, "0.7.0")).instance.getUpdateChannel(), "stable");
    assert.equal(
      await (await store(t, "0.7.1-nightly.20261023141500")).instance.getUpdateChannel(),
      "nightly",
    );
  });

  it("remembers an explicit choice across builds and stores nothing until one is made", async (t) => {
    const { root, instance } = await store(t, "0.7.1-nightly.20261023141500");
    assert.equal(await instance.getUpdateChannel(), "nightly");
    await instance.setSandboxedCodeEnabled(true);
    const before = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    assert.equal("updateChannel" in before, false);

    await instance.setUpdateChannel("stable");
    // A later nightly build still follows the admin's choice.
    const later = await store(t, "0.7.2-nightly.20261101090000", root);
    assert.equal(await later.instance.getUpdateChannel(), "stable");
  });
});

describe("update availability", () => {
  it("keeps Linux, Microsoft Store and development runs off electron-updater", () => {
    assert.equal(updateUnavailableReason({ isPackaged: true, platform: "linux", windowsStore: false }), "linux");
    assert.equal(updateUnavailableReason({ isPackaged: true, platform: "win32", windowsStore: true }), "windows-store");
    assert.equal(updateUnavailableReason({ isPackaged: false, platform: "darwin", windowsStore: false }), "development");
    assert.equal(updateUnavailableReason({ isPackaged: true, platform: "win32", windowsStore: false }), undefined);
    assert.equal(updateUnavailableReason({ isPackaged: true, platform: "darwin", windowsStore: false }), undefined);
  });
});

describe("update channel", () => {
  it("never downloads or installs on its own", (t) => {
    const { updater } = harness(t);
    assert.equal(updater.autoDownload, false);
    assert.equal(updater.autoInstallOnAppQuit, false);
  });

  it("maps the channel to channel, allowPrerelease and allowDowngrade after the setter side effect", (t) => {
    const { updater, controller } = harness(t);
    controller.configure("nightly");
    assert.deepEqual(
      { channel: updater.channel, allowPrerelease: updater.allowPrerelease, allowDowngrade: updater.allowDowngrade },
      { channel: "nightly", allowPrerelease: true, allowDowngrade: false },
    );
    controller.configure("stable");
    assert.deepEqual(
      { channel: updater.channel, allowPrerelease: updater.allowPrerelease, allowDowngrade: updater.allowDowngrade },
      { channel: "latest", allowPrerelease: false, allowDowngrade: false },
    );
  });

  it("checks the new channel right away when the channel is switched", async (t) => {
    const { updater, controller } = harness(t);
    controller.configure("stable");
    assert.equal(updater.checks, 0, "the first check waits for the startup delay");
    controller.configure("nightly");
    await settle();
    assert.equal(updater.checks, 1);
  });

  it("does not download what a check for the previous channel found, then checks the new channel", async (t) => {
    const { updater, controller } = harness(t);
    controller.configure("stable");
    let finish = () => {};
    updater.checkQueue.push(() => new Promise<void>((resolve) => (finish = resolve)));
    const stale = controller.check();
    await settle();
    controller.configure("nightly");
    // The check for "latest" completes after the switch to nightly.
    updater.emit("update-available", { version: "0.7.0" });
    finish();
    await stale;
    await controller.check();
    assert.equal(updater.checks, 2);
    assert.equal(updater.downloads.length, 0);
    assert.notEqual(controller.current().status, "downloading");

    // The next check is for nightly, and what it finds is downloaded.
    updater.checkQueue.push(async () => {
      await Promise.resolve();
      updater.emit("update-available", { version: "0.7.1-nightly.20261023141500" });
    });
    await controller.check();
    assert.equal(updater.downloads.length, 1);
    assert.deepEqual(controller.current(), {
      status: "downloading",
      version: "0.7.1-nightly.20261023141500",
    });
  });

  it("publishes download progress when electron-updater provides it", async (t) => {
    const { updater, controller } = harness(t);
    controller.configure("stable");
    updater.checkQueue.push(async () => {
      updater.emit("update-available", { version: "0.7.1" });
    });
    await controller.check();
    updater.emit("download-progress", { percent: 42.4 });
    assert.deepEqual(controller.current(), {
      status: "downloading",
      version: "0.7.1",
      progress: 42.4,
    });
  });

  it("discards a downloaded update from the old channel and checks the selected channel", async (t) => {
    const { updater, controller, confirm } = harness(t);
    confirm.answer = true;
    controller.configure("stable");
    updater.emit("update-downloaded", { version: "0.7.1" });
    assert.equal(controller.current().status, "ready");
    controller.configure("nightly");
    await controller.check();
    assert.notEqual(controller.current().status, "ready");
    assert.equal(updater.checks, 1);
    // Neither the explicit path nor the restart dialog installs the discarded update.
    assert.equal(await controller.install(), false);
    await settle();
    assert.equal(updater.installs.length, 0);
  });

  it("allows returning from an installed nightly to the current stable, including after a restart", async (t) => {
    const nightly = "0.7.1-nightly.20261023141500";
    const first = harness(t, nightly);
    first.controller.configure("nightly");
    assert.equal(first.updater.allowDowngrade, false);
    first.controller.configure("stable");
    await first.controller.check();
    assert.deepEqual(
      {
        channel: first.updater.channel,
        allowPrerelease: first.updater.allowPrerelease,
        allowDowngrade: first.updater.allowDowngrade,
      },
      { channel: "latest", allowPrerelease: false, allowDowngrade: true },
    );
    assert.equal(first.updater.checks, 1);

    const restarted = harness(t, nightly);
    restarted.controller.configure("stable");
    assert.equal(restarted.updater.allowDowngrade, true);
  });

  it("cancels an old-channel download, ignores its late events, then downloads the selected stable", async (t) => {
    const { updater, controller } = harness(t, "0.7.1-nightly.20261023141500");
    controller.configure("nightly");
    let finish = () => {};
    updater.downloadQueue.push(() => new Promise<never[]>((resolve) => (finish = () => resolve([]))));
    updater.checkQueue.push(async () => {
      updater.emit("update-available", { version: "0.7.1-nightly.20261024080000" });
    });
    await controller.check();
    await settle();
    const token = updater.downloads[0];
    assert.ok(token);
    controller.configure("stable");
    assert.equal(token.cancelled, true);
    updater.emit("update-downloaded", { version: "0.7.1-nightly.20261024080000" });
    updater.emit("error", new Error("cancelled old download"));
    assert.equal(controller.current().status, "idle");
    assert.equal(await controller.install(), false);

    updater.checkQueue.push(async () => {
      updater.emit("update-available", { version: "0.7.0" });
    });
    finish();
    await controller.check();
    assert.equal(updater.checks, 2);
    assert.equal(updater.downloads.length, 2);
    assert.deepEqual(controller.current(), { status: "downloading", version: "0.7.0" });
    updater.emit("update-downloaded", { version: "0.7.0" });
    assert.deepEqual(controller.current(), { status: "ready", version: "0.7.0" });
  });

  it("reports a failed check with a recovery-ready message", async (t) => {
    const { updater, controller } = harness(t);
    controller.configure("stable");
    updater.checkQueue.push(async () => {
      throw new Error("net::ERR_INTERNET_DISCONNECTED");
    });
    assert.deepEqual(await controller.check(), {
      status: "error",
      message: "Update check failed. net::ERR_INTERNET_DISCONNECTED",
    });
  });

  it("shows only the first line of an updater error", async (t) => {
    const { updater, controller } = harness(t);
    controller.configure("stable");
    updater.checkQueue.push(async () => {
      throw new Error("Cannot find nightly-mac.yml in the latest release artifacts: HttpError: 404\n    at stack frame\nheaders: {}");
    });
    assert.deepEqual(await controller.check(), {
      status: "error",
      message: "Update check failed. Cannot find nightly-mac.yml in the latest release artifacts: HttpError: 404",
    });
  });

  it("reports up to date when the channel has nothing newer", async (t) => {
    const { updater, controller } = harness(t);
    controller.configure("stable");
    updater.checkQueue.push(async () => updater.emit("update-not-available", { version: "0.7.0" }));
    assert.deepEqual(await controller.check(), { status: "not-available" });
  });
});

describe("installing a ready update", () => {
  it("restarts from the dialog only for the current channel", async (t) => {
    const { updater, controller, confirm } = harness(t);
    confirm.answer = true;
    controller.configure("stable");
    updater.emit("update-downloaded", { version: "0.7.1" });
    await settle();
    assert.deepEqual(confirm.asked, ["0.7.1"]);
    assert.deepEqual(updater.installs, [[]]);
    assert.equal(updater.autoRunAppAfterInstall, true);
  });

  it("refuses a channel switch once an install has started", async (t) => {
    const { updater, controller, confirm, states } = harness(t, "0.7.1-nightly.20261023141500");
    confirm.answer = true;
    controller.configure("nightly");
    updater.emit("update-downloaded", { version: "0.7.1-nightly.20261024080000" });
    await settle();
    // macOS: quitAndInstall() was called and Squirrel is staging the nightly.
    assert.equal(updater.installs.length, 1);
    assert.equal(controller.canChangeChannel("stable"), false);
    assert.equal(controller.canChangeChannel("nightly"), true);
    assert.throws(() => controller.configure("stable"), /being installed/);
    assert.equal(updater.channel, "nightly");
    assert.equal(states.at(-1)?.status, "ready");

    // A failed install releases the lock, so the admin can switch again.
    updater.emit("error", new Error("Squirrel could not stage the update"));
    assert.equal(controller.canChangeChannel("stable"), true);
    controller.configure("stable");
    assert.equal(updater.channel, "latest");
  });

  it("saves nothing when a switch is refused during an install", async (t) => {
    const { updater, controller, confirm } = harness(t, "0.7.1-nightly.20261023141500");
    confirm.answer = true;
    controller.configure("nightly");
    updater.emit("update-downloaded", { version: "0.7.1-nightly.20261024080000" });
    await settle();
    const saved: string[] = [];
    await assert.rejects(
      switchAndSaveChannel(controller, "stable", async (channel) => saved.push(channel)),
      /being installed/,
    );
    assert.deepEqual(saved, []);
    assert.equal(controller.channel(), "nightly");
  });

  it("switches before saving, so an install starting during the save cannot split them", async (t) => {
    const { updater, controller, confirm } = harness(t, "0.7.1-nightly.20261023141500");
    confirm.answer = true;
    controller.configure("nightly");
    let finishSave!: () => void;
    const saving = switchAndSaveChannel(
      controller,
      "stable",
      () => new Promise<void>((resolve) => (finishSave = resolve)),
    );
    // The live updater is already on stable while the save is pending.
    assert.equal(controller.channel(), "stable");
    assert.equal(updater.channel, "latest");
    // A stable update downloads and installs before the save finishes.
    controller.check();
    await settle();
    updater.emit("update-downloaded", { version: "0.7.0" });
    await settle();
    assert.equal(controller.canChangeChannel("nightly"), false);
    finishSave();
    await saving;
    assert.equal(controller.channel(), "stable");
  });

  it("restores the previous channel when saving fails", async (t) => {
    const { updater, controller } = harness(t, "0.7.1-nightly.20261023141500");
    controller.configure("nightly");
    await assert.rejects(
      switchAndSaveChannel(controller, "stable", async () => {
        throw new Error("disk full");
      }),
      /disk full/,
    );
    assert.equal(controller.channel(), "nightly");
    assert.equal(updater.channel, "nightly");
  });

  it("installs on quit when the admin chose Later", async (t) => {
    const { updater, controller, beforeQuit } = harness(t, "0.7.0", "win32");
    controller.configure("stable");
    updater.emit("update-downloaded", { version: "0.7.1" });
    assert.equal(beforeQuit(), true);
    assert.deepEqual(updater.installs, [[true, false]]);
    // The quit that follows is not held again.
    assert.equal(beforeQuit(), false);
  });

  it("lets Squirrel stage the update on macOS and still quits when staging fails", async (t) => {
    const { updater, controller, beforeQuit, quits } = harness(t, "0.7.0", "darwin");
    controller.configure("stable");
    updater.emit("update-downloaded", { version: "0.7.1" });
    assert.equal(beforeQuit(), true);
    assert.deepEqual(updater.installs, [[]]);
    // Installs as the app quits instead of relaunching it.
    assert.equal(updater.autoRunAppAfterInstall, false);
    assert.equal(quits(), 0);
    updater.emit("error", new Error("Squirrel could not stage the update"));
    assert.equal(quits(), 1);
    assert.deepEqual(controller.current(), {
      status: "error",
      message: "Squirrel could not stage the update",
    });
  });

  it("does nothing on quit without a ready update", (t) => {
    const { controller, beforeQuit, updater } = harness(t);
    controller.configure("stable");
    assert.equal(beforeQuit(), false);
    assert.equal(updater.installs.length, 0);
  });
});

describe("nightly builds and agent compatibility", () => {
  it("treats a nightly as satisfying the minAppVersion it previews and lower", () => {
    const nightly = "0.7.1-nightly.20261023141500";
    assert.equal(withAgentCompatibility({ minAppVersion: "0.7.1" }, nightly).compatibility.supported, true);
    assert.equal(withAgentCompatibility({ minAppVersion: "0.7.0" }, nightly).compatibility.supported, true);
    assert.equal(withAgentCompatibility({ minAppVersion: "0.1.0" }, nightly).compatibility.supported, true);
    assert.equal(withAgentCompatibility({ minAppVersion: "0.7.2" }, nightly).compatibility.supported, false);
    assert.equal(withAgentCompatibility({ minAppVersion: "0.8.0" }, nightly).compatibility.supported, false);
  });
});
