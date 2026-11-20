import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, renameSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { spawnSync } from "node:child_process";

import type { TenantRecord } from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

import {
  LOCAL_RESET_MARKER,
  LocalResetRequestError,
  localResetLeftoverPaths,
  macosLoginKeychain,
  parseKeychainList,
  folderGoesThroughLink,
  localResetPolicyProblem,
  markerFolderMatches,
  identityFromStat,
  localResetFolderIdentity,
  parseWhoamiUser,
  windowsTaskBelongsToThisAccount,
  windowsTaskListHas,
  windowsTaskUserId,
  localResetRemovalPlan,
  MACOS_SAFE_STORAGE_ACCOUNT,
  MACOS_SAFE_STORAGE_SERVICE,
  readLocalResetMarker,
  sharedReadOnlyFile,
  isKeptThroughReset,
  UPDATER_CACHE_DIR,
  requestLocalReset,
  runPendingLocalReset,
  writeLocalResetMarker,
  type CommandResult,
  type LocalResetFileSystem,
  type LocalResetMarker,
  type LocalResetRequestSteps,
} from "./local-reset.js";
import { AppStateStore } from "./state.js";
import { dataFolderSealed, unsealDataFolder } from "./data-folder-seal.js";

// A committed reset seals the data folder for the whole process; each test
// starts unsealed, as a new process does.
afterEach(() => unsealDataFolder());
import { OrganizationBoundaryError } from "./runs.js";
import { blockConnectorConfirmations, requestConnectorConfirmation } from "./connector-confirm-bridge.js";
import { LOCAL_RESET_PHRASE } from "../src/shared/local-reset.js";

/** A reset requested in an installed build. */
const MARKER: LocalResetMarker = { version: 1, requestedAt: "2026-11-19T10:00:00.000Z", build: "installed" };
/** A reset requested in a development build. */
const DEV_MARKER: LocalResetMarker = { ...MARKER, build: "development" };

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "openadminos-local-reset-"));
}

/** A data folder with what a used install leaves, plus the marker. */
function seedDataFolder(dir: string, marker: LocalResetMarker = MARKER): void {
  for (const name of ["state.json", "openadminos.db", "openadminos.db-wal", "openadminos.db-audit-anchor.json", "openadminos.db-audit-pending.json", "office.db", "tokens.bin", "tokens-0f3c.bin", "Local State", "policy.json", "SingletonLock"]) {
    writeFileSync(join(dir, name), name === "policy.json" ? "{\"provider\":\"ollama\"}\n" : "x");
  }
  for (const folder of ["providers/secrets", "connectors/secrets", "connectors/whatsapp-web/auth", "agents/sample", "agent-updates", "registry-cache", "retrieval-index", "logs"]) {
    mkdirSync(join(dir, folder), { recursive: true });
    writeFileSync(join(dir, folder, "file"), "x");
  }
  writeFileSync(join(dir, LOCAL_RESET_MARKER), JSON.stringify(markerFor(dir, marker)));
}

/** A marker as writeLocalResetMarker writes it: bound to this folder's device and inode. */
function markerFor(dir: string, marker: LocalResetMarker): LocalResetMarker {
  return { ...marker, folder: localResetFolderIdentity(dir)! };
}

function recordingRun(results: Record<string, CommandResult[]> = {}): { run: (file: string, args: string[]) => CommandResult; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: (file, args) => {
      calls.push([file, ...args]);
      const next = results[file]?.shift();
      if (next) return next;
      // An unscripted Keychain lookup finds nothing, as on a Mac without the item.
      return file === "/usr/bin/security" && args[0] === "find-generic-password" ? { status: 44 } : { status: 0 };
    },
  };
}

const keychainNotFound: CommandResult = { status: 44 };

/** An empty Linux mount table, for wipes tested with the Linux platform on another system. */
const noMounts = () => "";

describe("local reset: removal plan", () => {
  it("keeps the policy file, the marker and Chromium's lock files, with the audit side files last", () => {
    const plan = localResetRemovalPlan([
      "state.json",
      "openadminos.db-audit-anchor.json",
      "policy.json",
      LOCAL_RESET_MARKER,
      "openadminos.db",
      "SingletonLock",
      "SingletonSocket",
      "SingletonCookie",
      "lockfile",
      "openadminos.db-audit-pending.json",
      "tokens.bin",
    ]);
    assert.deepEqual(plan.first, ["openadminos.db", "state.json", "tokens.bin"]);
    assert.deepEqual(plan.last, ["openadminos.db-audit-anchor.json", "openadminos.db-audit-pending.json"]);
  });

  it("lists only OpenAdminOS paths outside the data folder", () => {
    assert.deepEqual(localResetLeftoverPaths("darwin", "/Users/admin", {}), [
      "/Users/admin/Library/Caches/@openadminosdesktop-updater",
      "/Users/admin/Library/Caches/com.openadminos.desktop",
      "/Users/admin/Library/Caches/com.openadminos.desktop.ShipIt",
      "/Users/admin/Library/HTTPStorages/com.openadminos.desktop",
      "/Users/admin/Library/HTTPStorages/com.openadminos.desktop.binarycookies",
      "/Users/admin/Library/Saved Application State/com.openadminos.desktop.savedState",
    ]);
    assert.deepEqual(localResetLeftoverPaths("win32", "C:\\Users\\admin", { LOCALAPPDATA: "C:\\Users\\admin\\AppData\\Local" }), [
      "C:\\Users\\admin\\AppData\\Local\\@openadminosdesktop-updater",
    ]);
    assert.deepEqual(localResetLeftoverPaths("linux", "/home/admin", {}), ["/home/admin/.cache/@openadminosdesktop-updater"]);
  });
});

describe("local reset: wipe at launch", () => {
  it("does nothing without a marker", async () => {
    const dir = await tempDir();
    try {
      writeFileSync(join(dir, "state.json"), "{}");
      const { run, calls } = recordingRun();
      assert.equal(runPendingLocalReset({ userDataDir: dir, packaged: true, platform: "darwin", home: dir, env: {}, run }), undefined);
      assert.ok(existsSync(join(dir, "state.json")));
      assert.deepEqual(calls, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("empties the data folder except policy.json and the lock file, then removes the marker", async () => {
    const dir = await tempDir();
    try {
      seedDataFolder(dir, DEV_MARKER);
      const { run, calls } = recordingRun();
      const report = runPendingLocalReset({ userDataDir: dir, packaged: false, platform: "darwin", home: join(dir, "home"), env: {}, run });
      assert.equal(report?.status, "completed");
      assert.equal(report?.requestedAt, MARKER.requestedAt);
      assert.deepEqual(report?.failed, []);
      assert.deepEqual(readdirSync(dir).sort(), ["SingletonLock", "policy.json"]);
      assert.equal(readFileSync(join(dir, "policy.json"), "utf8"), "{\"provider\":\"ollama\"}\n");
      // A development build never touches the Keychain, the scheduler or caches.
      assert.deepEqual(calls, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the database's own files and the audit anchor while the database could not be removed, and keeps the marker", async () => {
    const dir = await tempDir();
    try {
      seedDataFolder(dir);
      writeFileSync(join(dir, "openadminos.db-shm"), "x");
      const fs = failingFileSystem((path) => path.endsWith("openadminos.db"));
      const report = runPendingLocalReset({ userDataDir: dir, packaged: true, platform: "darwin", home: dir, env: {}, fs, run: recordingRun().run });
      assert.equal(report?.status, "incomplete");
      assert.deepEqual(report?.failed, [
        { item: "openadminos.db", reason: "the file is in use by another program or cannot be changed" },
        { item: "openadminos.db-shm", reason: "kept with openadminos.db, which could not be removed" },
        { item: "openadminos.db-wal", reason: "kept with openadminos.db, which could not be removed" },
      ]);
      // The database stays whole for the next try: its write-ahead log and
      // shared memory file are not removed without it.
      assert.ok(existsSync(join(dir, "openadminos.db")));
      assert.ok(existsSync(join(dir, "openadminos.db-wal")));
      assert.ok(existsSync(join(dir, "openadminos.db-shm")));
      // Everything else still goes, a database sorted after it included.
      assert.ok(!existsSync(join(dir, "office.db")));
      assert.ok(existsSync(join(dir, "openadminos.db-audit-anchor.json")));
      assert.ok(existsSync(join(dir, "openadminos.db-audit-pending.json")));
      assert.ok(existsSync(join(dir, LOCAL_RESET_MARKER)));
      assert.ok(!existsSync(join(dir, "state.json")));
      assert.ok(!existsSync(join(dir, "tokens.bin")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("states reasons in plain words without repeating the path", async () => {
    const dir = await tempDir();
    try {
      seedDataFolder(dir, DEV_MARKER);
      const fs: LocalResetFileSystem = {
        ...failingFileSystem(() => false),
        remove: (path) => {
          if (path.endsWith("logs")) throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`), { code: "ENOTEMPTY" });
          rmSync(path, { recursive: true, force: true });
        },
      };
      const report = runPendingLocalReset({ userDataDir: dir, packaged: false, platform: "linux", mountInfo: noMounts, home: dir, env: {}, fs });
      assert.deepEqual(report?.failed, [{ item: "logs", reason: "something inside it could not be removed" }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resumes after an interrupted wipe and finishes on the next launch", async () => {
    const dir = await tempDir();
    try {
      seedDataFolder(dir, DEV_MARKER);
      // The first launch stops partway: removing the connectors folder throws.
      const first = runPendingLocalReset({
        userDataDir: dir,
        packaged: false,
        platform: "linux", mountInfo: noMounts,
        home: dir,
        env: {},
        fs: failingFileSystem((path) => path.endsWith("connectors")),
      });
      assert.equal(first?.status, "incomplete");
      assert.ok(existsSync(join(dir, LOCAL_RESET_MARKER)));
      assert.ok(existsSync(join(dir, "connectors", "secrets", "file")));
      assert.ok(existsSync(join(dir, "openadminos.db-audit-anchor.json")));

      const second = runPendingLocalReset({ userDataDir: dir, packaged: false, platform: "linux", mountInfo: noMounts, home: dir, env: {} });
      assert.equal(second?.status, "completed");
      assert.deepEqual(readdirSync(dir).sort(), ["SingletonLock", "policy.json"]);
      assert.equal(runPendingLocalReset({ userDataDir: dir, packaged: false, platform: "linux", mountInfo: noMounts, home: dir, env: {} }), undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("in an installed macOS build removes the Keychain item by its exact service name, preferences, caches and the scheduler", async () => {
    const dir = await tempDir();
    try {
      const data = join(dir, "data");
      const home = join(dir, "home");
      mkdirSync(data);
      seedDataFolder(data);
      const leftovers = localResetLeftoverPaths("darwin", home, {});
      for (const path of leftovers) {
        if (path.endsWith(".binarycookies")) {
          // A cookie store is a plain file, not a folder.
          mkdirSync(join(path, ".."), { recursive: true });
          writeFileSync(path, "cookies");
          continue;
        }
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, "file"), "x");
      }
      const unrelated = join(home, "Library", "Caches", "com.example.other");
      mkdirSync(unrelated, { recursive: true });
      let schedulerRemoved = 0;
      const { run, calls } = recordingRun({ "/usr/bin/security": [{ status: 0 }, keychainNotFound] });
      const report = runPendingLocalReset({
        userDataDir: data,
        packaged: true,
        platform: "darwin",
        home,
        env: {},
        run,
        removeScheduler: () => { schedulerRemoved += 1; },
      });
      assert.equal(report?.status, "completed");
      assert.deepEqual(report?.warnings, []);
      assert.equal(schedulerRemoved, 1);
      // Only the login keychain is searched: an item of the same name in a
      // keychain imported from another Mac is not this install's key.
      const loginKeychain = join(home, "Library", "Keychains", "login.keychain-db");
      assert.equal(macosLoginKeychain(home), loginKeychain);
      assert.deepEqual(calls, [
        ["/usr/bin/security", "delete-generic-password", "-s", MACOS_SAFE_STORAGE_SERVICE, "-a", MACOS_SAFE_STORAGE_ACCOUNT, loginKeychain],
        ["/usr/bin/security", "delete-generic-password", "-s", MACOS_SAFE_STORAGE_SERVICE, "-a", MACOS_SAFE_STORAGE_ACCOUNT, loginKeychain],
        ["/usr/bin/security", "list-keychains", "-d", "user"],
        ["/usr/bin/defaults", "delete", "com.openadminos.desktop"],
      ]);
      for (const path of leftovers) assert.ok(!existsSync(path), path);
      assert.ok(existsSync(unrelated));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a Keychain failure as a warning and still finishes, without retrying it later", async () => {
    const dir = await tempDir();
    try {
      seedDataFolder(dir);
      const { run } = recordingRun({ "/usr/bin/security": [{ status: 51 }] });
      const report = runPendingLocalReset({ userDataDir: dir, packaged: true, platform: "darwin", home: join(dir, "home"), env: {}, run });
      assert.equal(report?.status, "completed");
      assert.deepEqual(report?.warnings, [{ item: `Keychain item "${MACOS_SAFE_STORAGE_SERVICE}"`, reason: "security exited with code 51" }]);
      assert.ok(!existsSync(join(dir, LOCAL_RESET_MARKER)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not touch the Keychain or caches while the data folder is not empty", async () => {
    const dir = await tempDir();
    try {
      seedDataFolder(dir);
      const { run, calls } = recordingRun();
      let schedulerRemoved = false;
      const report = runPendingLocalReset({
        userDataDir: dir,
        packaged: true,
        platform: "darwin",
        home: join(dir, "home"),
        env: {},
        run,
        fs: failingFileSystem((path) => path.endsWith("tokens.bin")),
        removeScheduler: () => { schedulerRemoved = true; },
      });
      assert.equal(report?.status, "incomplete");
      assert.deepEqual(calls, []);
      assert.equal(schedulerRemoved, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves a reset requested in the installed app to the installed app", async () => {
    const dir = await tempDir();
    try {
      seedDataFolder(dir, MARKER);
      const { run, calls } = recordingRun();
      const report = runPendingLocalReset({ userDataDir: dir, packaged: false, platform: "darwin", home: join(dir, "home"), env: {}, run });
      assert.equal(report?.status, "incomplete");
      assert.match(report?.failed[0]?.reason ?? "", /open the installed OpenAdminOS to finish it/);
      assert.ok(existsSync(join(dir, "tokens.bin")));
      assert.ok(existsSync(join(dir, LOCAL_RESET_MARKER)));
      assert.deepEqual(calls, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never widens a development reset in an installed build: the data folder only, with a warning", async () => {
    const dir = await tempDir();
    try {
      seedDataFolder(dir, DEV_MARKER);
      const { run, calls } = recordingRun();
      let schedulerRemoved = false;
      const report = runPendingLocalReset({
        userDataDir: dir, packaged: true, platform: "darwin", home: join(dir, "home"), env: {}, run,
        removeScheduler: () => { schedulerRemoved = true; },
      });
      assert.equal(report?.status, "completed");
      assert.deepEqual(readdirSync(dir).sort(), ["SingletonLock", "policy.json"]);
      assert.deepEqual(calls, []);
      assert.equal(schedulerRemoved, false);
      assert.match(report?.warnings[0]?.reason ?? "", /requested in a development build/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not remove the Keychain item again when only the marker could not be removed", async () => {
    const dir = await tempDir();
    try {
      seedDataFolder(dir, MARKER);
      const { run, calls } = recordingRun({ "/usr/bin/security": [keychainNotFound, keychainNotFound] });
      const first = runPendingLocalReset({
        userDataDir: dir, packaged: true, platform: "darwin", home: join(dir, "home"), env: {}, run,
        fs: failingFileSystem((path) => path.endsWith(LOCAL_RESET_MARKER)),
      });
      assert.equal(first?.status, "incomplete");
      assert.equal(readLocalResetMarker(dir)?.leftoversDone, true);
      const keychainCalls = () => calls.filter((call) => call[0] === "/usr/bin/security" && call[1] === "delete-generic-password").length;
      assert.equal(keychainCalls(), 1);
      const second = runPendingLocalReset({ userDataDir: dir, packaged: true, platform: "darwin", home: join(dir, "home"), env: {}, run });
      assert.equal(second?.status, "completed");
      assert.equal(keychainCalls(), 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stays incomplete when something is written into the folder during the wipe", async () => {
    const dir = await tempDir();
    try {
      seedDataFolder(dir, DEV_MARKER);
      let recreated = false;
      const fs: LocalResetFileSystem = {
        ...failingFileSystem(() => false),
        remove: (path) => {
          rmSync(path, { recursive: true, force: true });
          // A process left from the last session writes a file after the listing.
          if (!recreated && path.endsWith("logs")) {
            recreated = true;
            writeFileSync(join(dir, "Session Storage"), "x");
          }
        },
      };
      const report = runPendingLocalReset({ userDataDir: dir, packaged: false, platform: "linux", mountInfo: noMounts, home: dir, env: {}, fs });
      assert.equal(report?.status, "incomplete");
      assert.deepEqual(report?.failed, [{ item: "Session Storage", reason: "it was created again during the reset" }]);
      assert.ok(existsSync(join(dir, LOCAL_RESET_MARKER)));
      const second = runPendingLocalReset({ userDataDir: dir, packaged: false, platform: "linux", mountInfo: noMounts, home: dir, env: {} });
      assert.equal(second?.status, "completed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a progress record it could not write, and each failed step once", async () => {
    const dir = await tempDir();
    try {
      seedDataFolder(dir, { ...MARKER, requestWarnings: [{ item: "Background scheduler", reason: "launchctl failed" }] });
      writeFileSync(join(dir, `${LOCAL_RESET_MARKER}.tmp`), "{}");
      const fs: LocalResetFileSystem = {
        ...failingFileSystem(() => false),
        writeMarker: () => { throw Object.assign(new Error("EROFS"), { code: "EROFS" }); },
      };
      const { run } = recordingRun({ "/usr/bin/security": [keychainNotFound] });
      const report = runPendingLocalReset({
        userDataDir: dir, packaged: true, platform: "darwin", home: join(dir, "home"), env: {}, run, fs,
        removeScheduler: () => { throw new Error("launchd refused it again"); },
      });
      assert.equal(report?.status, "completed");
      assert.deepEqual(report?.warnings, [
        { item: "Background scheduler", reason: "launchd refused it again" },
        { item: "Reset progress", reason: "could not be recorded (the disk is read-only). If the reset has to resume, it removes the Keychain item and caches again" },
      ]);
      assert.deepEqual(readdirSync(dir).sort(), ["SingletonLock", "policy.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the policy file in any letter case", async () => {
    const dir = await tempDir();
    try {
      seedDataFolder(dir, DEV_MARKER);
      rmSync(join(dir, "policy.json"));
      writeFileSync(join(dir, "Policy.json"), "{}\n");
      const report = runPendingLocalReset({ userDataDir: dir, packaged: false, platform: "darwin", home: join(dir, "home"), env: {} });
      assert.equal(report?.status, "completed");
      assert.deepEqual(readdirSync(dir).sort(), ["Policy.json", "SingletonLock"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the cleanup warnings for a resumed wipe", async () => {
    const dir = await tempDir();
    try {
      seedDataFolder(dir, MARKER);
      const { run } = recordingRun({ "/usr/bin/security": [{ status: 51 }] });
      const keychainWarning = { item: `Keychain item "${MACOS_SAFE_STORAGE_SERVICE}"`, reason: "security exited with code 51" };
      const first = runPendingLocalReset({
        userDataDir: dir, packaged: true, platform: "darwin", home: join(dir, "home"), env: {}, run,
        fs: failingFileSystem((path) => path.endsWith(LOCAL_RESET_MARKER)),
      });
      assert.equal(first?.status, "incomplete");
      const second = runPendingLocalReset({ userDataDir: dir, packaged: true, platform: "darwin", home: join(dir, "home"), env: {}, run });
      assert.equal(second?.status, "completed");
      assert.deepEqual(second?.warnings, [keychainWarning]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not empty a data folder that is a link, and removes token caches that are links as links", async () => {
    const dir = await tempDir();
    try {
      const shared = join(dir, "shared");
      mkdirSync(shared);
      seedDataFolder(shared, DEV_MARKER);
      const linked = join(dir, "profile-link");
      symlinkSync(shared, linked);
      assert.equal(folderGoesThroughLink(linked), true);
      const report = runPendingLocalReset({ userDataDir: linked, packaged: false, platform: "linux", mountInfo: noMounts, home: dir, env: {} });
      assert.equal(report?.status, "incomplete");
      assert.match(report?.failed[0]?.reason ?? "", /is a link, holds another mount, or could not be read in full/);
      assert.ok(existsSync(join(shared, "state.json")));

      const profile = join(dir, "profile");
      mkdirSync(profile);
      writeFileSync(join(dir, "other-cache.bin"), "other profile");
      symlinkSync(join(dir, "other-cache.bin"), join(profile, "tokens-abc.bin"));
      writeFileSync(join(profile, "tokens.bin"), "x");
      writeFileSync(join(profile, LOCAL_RESET_MARKER), JSON.stringify(markerFor(profile, DEV_MARKER)));
      assert.equal(runPendingLocalReset({ userDataDir: profile, packaged: false, platform: "linux", mountInfo: noMounts, home: dir, env: {} })?.status, "completed");
      assert.equal(readFileSync(join(dir, "other-cache.bin"), "utf8"), "other profile");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("on Windows leaves a read-only file that a backup also links, so the backup's copy keeps its attributes", { skip: process.platform === "win32" ? "runs with POSIX file modes; on Windows chmod maps only to the read-only attribute" : false }, async () => {
    const dir = await tempDir();
    try {
      const profile = join(dir, "profile");
      mkdirSync(join(profile, "Local Storage"), { recursive: true });
      writeFileSync(join(dir, "backup.ldb"), "backup bytes");
      linkSync(join(dir, "backup.ldb"), join(profile, "Local Storage", "000003.ldb"));
      chmodSync(join(dir, "backup.ldb"), 0o444);
      writeFileSync(join(profile, "state.json"), "{}");
      writeFileSync(join(profile, LOCAL_RESET_MARKER), JSON.stringify(markerFor(profile, DEV_MARKER)));
      assert.deepEqual(sharedReadOnlyFile(join(profile, "Local Storage"), "Local Storage"), { item: "Local Storage\\000003.ldb" });
      const report = runPendingLocalReset({ userDataDir: profile, packaged: false, platform: "win32", home: dir, env: {} });
      assert.equal(report?.status, "incomplete");
      assert.deepEqual(report?.failed, [{
        item: "Local Storage",
        reason: "Local Storage\\000003.ldb is read-only and also linked from another place, such as a backup; removing it would make that copy writable too. Remove the other link first, or remove it by hand",
      }]);
      // Nothing about the backup's copy changed; the rest of the folder went.
      assert.equal(lstatSync(join(dir, "backup.ldb")).mode & 0o777, 0o444);
      assert.equal(lstatSync(join(dir, "backup.ldb")).nlink, 2);
      assert.ok(!existsSync(join(profile, "state.json")));
      assert.equal(sharedReadOnlyFile(join(dir, "missing"), "missing"), undefined);
      // A folder that cannot be listed is not removed unchecked.
      mkdirSync(join(dir, "locked"));
      chmodSync(join(dir, "locked"), 0o000);
      try {
        assert.deepEqual(sharedReadOnlyFile(join(dir, "locked"), "locked"), { item: "locked", unlisted: true });
      } finally {
        chmodSync(join(dir, "locked"), 0o755);
      }
    } finally {
      chmodSync(join(dir, "backup.ldb"), 0o644);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats a hard-linked token cache as shared, and removes only the profile's entry", async () => {
    const dir = await tempDir();
    try {
      const profile = join(dir, "profile");
      mkdirSync(profile);
      writeFileSync(join(dir, "backup-tokens.bin"), "backup bytes");
      linkSync(join(dir, "backup-tokens.bin"), join(profile, "tokens.bin"));
      writeFileSync(join(profile, LOCAL_RESET_MARKER), JSON.stringify(markerFor(profile, DEV_MARKER)));
      assert.equal(runPendingLocalReset({ userDataDir: profile, packaged: false, platform: "linux", mountInfo: noMounts, home: dir, env: {} })?.status, "completed");
      assert.equal(readFileSync(join(dir, "backup-tokens.bin"), "utf8"), "backup bytes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never starts a wipe from a folder where the marker belongs", async () => {
    const dir = await tempDir();
    try {
      writeFileSync(join(dir, "state.json"), "{}");
      mkdirSync(join(dir, LOCAL_RESET_MARKER));
      const report = runPendingLocalReset({ userDataDir: dir, packaged: false, platform: "linux", mountInfo: noMounts, home: dir, env: {} });
      assert.equal(report?.status, "incomplete");
      assert.ok(existsSync(join(dir, "state.json")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("clears the request's scheduler warning when removal works at launch", async () => {
    const dir = await tempDir();
    try {
      seedDataFolder(dir, { ...MARKER, requestWarnings: [{ item: "Background scheduler", reason: "launchctl failed" }] });
      const { run } = recordingRun({ "/usr/bin/security": [keychainNotFound] });
      const report = runPendingLocalReset({
        userDataDir: dir, packaged: true, platform: "darwin", home: join(dir, "home"), env: {}, run,
        removeScheduler: () => undefined,
      });
      assert.equal(report?.status, "completed");
      assert.deepEqual(report?.warnings, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never starts a wipe from a hard-linked marker", async () => {
    const dir = await tempDir();
    try {
      const profile = join(dir, "profile");
      mkdirSync(profile);
      writeFileSync(join(profile, "state.json"), "{}");
      writeFileSync(join(dir, "elsewhere.json"), JSON.stringify(DEV_MARKER));
      linkSync(join(dir, "elsewhere.json"), join(profile, LOCAL_RESET_MARKER));
      const report = runPendingLocalReset({ userDataDir: profile, packaged: false, platform: "linux", mountInfo: noMounts, home: dir, env: {} });
      assert.equal(report?.status, "incomplete");
      assert.ok(existsSync(join(profile, "state.json")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never starts a wipe from a marker that is a link", async () => {
    const dir = await tempDir();
    try {
      const profile = join(dir, "profile");
      mkdirSync(profile);
      writeFileSync(join(profile, "state.json"), "{}");
      writeFileSync(join(dir, "unrelated.txt"), "not a marker");
      symlinkSync(join(dir, "unrelated.txt"), join(profile, LOCAL_RESET_MARKER));
      const report = runPendingLocalReset({ userDataDir: profile, packaged: true, platform: "darwin", home: join(dir, "home"), env: {}, run: recordingRun().run });
      assert.equal(report?.status, "incomplete");
      assert.match(report?.failed[0]?.reason ?? "", /not a plain file OpenAdminOS wrote \(it is a link, a shared file or a folder\), so nothing was removed/);
      assert.ok(existsSync(join(profile, "state.json")));
      assert.equal(readFileSync(join(dir, "unrelated.txt"), "utf8"), "not a marker");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stops when the policy file is not a plain file", async () => {
    const dir = await tempDir();
    try {
      const fifo = spawnSync("mkfifo", [join(dir, "policy.json")]);
      if (fifo.status !== 0) return;
      assert.match(localResetPolicyProblem(dir) ?? "", /is not a plain file/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stops when a folder sits where the policy file belongs", async () => {
    const dir = await tempDir();
    try {
      seedDataFolder(dir, DEV_MARKER);
      rmSync(join(dir, "policy.json"));
      mkdirSync(join(dir, "Policy.json"));
      writeFileSync(join(dir, "Policy.json", "stash.bin"), "x");
      const report = runPendingLocalReset({ userDataDir: dir, packaged: false, platform: "linux", mountInfo: noMounts, home: dir, env: {} });
      assert.equal(report?.status, "incomplete");
      assert.match(report?.failed[0]?.reason ?? "", /is a folder, not the IT policy file/);
      assert.ok(existsSync(join(dir, "state.json")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves an item of the same name in another keychain alone and names each keychain that has one", async () => {
    const dir = await tempDir();
    try {
      seedDataFolder(dir, MARKER);
      const home = join(dir, "home");
      const login = macosLoginKeychain(home);
      const work = "/Users/admin/Library/Keychains/work.keychain-db";
      const old = "/Users/admin/Library/Keychains/old-mac.keychain-db";
      const { run, calls } = recordingRun({
        "/usr/bin/security": [
          { status: 51 },
          { status: 0, stdout: `    "${work}"\n    "${login}"\n    "${old}"\n` },
          { status: 0, stdout: `keychain: "${work}"\n` },
          keychainNotFound,
        ],
      });
      const report = runPendingLocalReset({ userDataDir: dir, packaged: true, platform: "darwin", home, env: {}, run });
      assert.equal(report?.status, "completed");
      // Each other keychain is looked up on its own, attributes only; nothing
      // outside the login keychain is deleted.
      assert.deepEqual(calls.filter((call) => call[0] === "/usr/bin/security"), [
        ["/usr/bin/security", "delete-generic-password", "-s", MACOS_SAFE_STORAGE_SERVICE, "-a", MACOS_SAFE_STORAGE_ACCOUNT, login],
        ["/usr/bin/security", "list-keychains", "-d", "user"],
        ["/usr/bin/security", "find-generic-password", "-s", MACOS_SAFE_STORAGE_SERVICE, "-a", MACOS_SAFE_STORAGE_ACCOUNT, work],
        ["/usr/bin/security", "find-generic-password", "-s", MACOS_SAFE_STORAGE_SERVICE, "-a", MACOS_SAFE_STORAGE_ACCOUNT, old],
      ]);
      // The failed login deletion and the item elsewhere are both reported.
      assert.deepEqual(report?.warnings, [
        { item: `Keychain item "${MACOS_SAFE_STORAGE_SERVICE}"`, reason: "security exited with code 51" },
        {
          item: `Keychain item "${MACOS_SAFE_STORAGE_SERVICE}" in ${work}`,
          reason: "not removed: the reset removes it from the login keychain only. If OpenAdminOS used this keychain, remove the item there with Keychain Access",
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("says so when the keychain search list cannot be read", async () => {
    const dir = await tempDir();
    try {
      seedDataFolder(dir, MARKER);
      const { run } = recordingRun({ "/usr/bin/security": [keychainNotFound, { status: 1 }] });
      const report = runPendingLocalReset({ userDataDir: dir, packaged: true, platform: "darwin", home: join(dir, "home"), env: {}, run });
      assert.deepEqual(report?.warnings, [{
        item: `Keychain item "${MACOS_SAFE_STORAGE_SERVICE}" in other keychains`,
        reason: "not checked, because the keychain search list could not be read",
      }]);
      assert.deepEqual(parseKeychainList('    "/a/login.keychain-db"\n    "/Library/Keychains/System.keychain"\n'), ["/a/login.keychain-db", "/Library/Keychains/System.keychain"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not warn when exactly five Keychain items were removed", async () => {
    const dir = await tempDir();
    try {
      seedDataFolder(dir, MARKER);
      const { run, calls } = recordingRun({ "/usr/bin/security": [{ status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }, keychainNotFound] });
      const report = runPendingLocalReset({ userDataDir: dir, packaged: true, platform: "darwin", home: join(dir, "home"), env: {}, run });
      assert.deepEqual(report?.warnings, []);
      const security = calls.filter((call) => call[0] === "/usr/bin/security");
      // Five deletions, the login keychain lookup, then the search list.
      assert.equal(security.length, 7);
      assert.deepEqual(security.at(-2), ["/usr/bin/security", "find-generic-password", "-s", MACOS_SAFE_STORAGE_SERVICE, "-a", MACOS_SAFE_STORAGE_ACCOUNT, macosLoginKeychain(join(dir, "home"))]);
      assert.deepEqual(security.at(-1), ["/usr/bin/security", "list-keychains", "-d", "user"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not bring back a cleared warning when the wipe resumes", async () => {
    const dir = await tempDir();
    try {
      seedDataFolder(dir, { ...MARKER, requestWarnings: [{ item: "Background scheduler", reason: "launchctl failed" }] });
      const { run } = recordingRun({ "/usr/bin/security": [keychainNotFound] });
      const first = runPendingLocalReset({
        userDataDir: dir, packaged: true, platform: "darwin", home: join(dir, "home"), env: {}, run,
        removeScheduler: () => undefined,
        fs: failingFileSystem((path) => path.endsWith(LOCAL_RESET_MARKER)),
      });
      assert.equal(first?.status, "incomplete");
      const second = runPendingLocalReset({ userDataDir: dir, packaged: true, platform: "darwin", home: join(dir, "home"), env: {}, run });
      assert.equal(second?.status, "completed");
      assert.deepEqual(second?.warnings, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never writes through a link planted where a marker temp file used to go", async () => {
    const dir = await tempDir();
    try {
      const data = join(dir, "data");
      mkdirSync(data);
      const outside = join(dir, "outside.txt");
      writeFileSync(outside, "keep me");
      symlinkSync(outside, join(data, `${LOCAL_RESET_MARKER}.tmp`));
      await writeLocalResetMarker(data, DEV_MARKER);
      assert.equal(readFileSync(outside, "utf8"), "keep me");
      assert.equal(readLocalResetMarker(data)?.build, "development");
      assert.deepEqual(readdirSync(data).filter((name) => name.endsWith(".tmp")), [`${LOCAL_RESET_MARKER}.tmp`]);
      const report = runPendingLocalReset({ userDataDir: data, packaged: false, platform: "linux", mountInfo: noMounts, home: dir, env: {} });
      assert.equal(report?.status, "completed");
      assert.deepEqual(readdirSync(data), []);
      assert.equal(readFileSync(outside, "utf8"), "keep me");
      assert.ok(lstatSync(outside).isFile());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats the marker as written once it is renamed into place, even if the folder flush fails", async () => {
    const dir = await tempDir();
    try {
      await writeLocalResetMarker(dir, MARKER, { syncDirectory: async () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); } });
      assert.equal(readLocalResetMarker(dir)?.build, "installed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("carries the warnings of the request into the report", async () => {
    const dir = await tempDir();
    try {
      await writeLocalResetMarker(dir, { ...DEV_MARKER, requestWarnings: [{ item: "Background scheduler", reason: "launchctl failed" }] });
      assert.deepEqual(readLocalResetMarker(dir)?.requestWarnings, [{ item: "Background scheduler", reason: "launchctl failed" }]);
      const report = runPendingLocalReset({ userDataDir: dir, packaged: false, platform: "linux", mountInfo: noMounts, home: dir, env: {} });
      assert.deepEqual(report?.warnings, [{ item: "Background scheduler", reason: "launchctl failed" }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never wipes on a marker that is not a complete reset request", async () => {
    for (const content of [
      "{not json",
      "",
      "null",
      JSON.stringify({ version: 1, requestedAt: "2026-11-19T10:00:00.000Z", folder: { dev: 1, ino: 1 } }),
      JSON.stringify({ version: 2, requestedAt: "2026-11-19T10:00:00.000Z", build: "installed", folder: { dev: 1, ino: 1 } }),
      JSON.stringify({ version: 1, requestedAt: "not a date", build: "development", folder: { dev: 1, ino: 1 } }),
      JSON.stringify({ version: 1, build: "development", folder: { dev: 1, ino: 1 } }),
      // Everything but the folder it was written for.
      JSON.stringify({ version: 1, requestedAt: "2026-11-19T10:00:00.000Z", build: "development" }),
    ]) {
      const dir = await tempDir();
      try {
        writeFileSync(join(dir, LOCAL_RESET_MARKER), content);
        writeFileSync(join(dir, "tokens.bin"), "x");
        const report = runPendingLocalReset({ userDataDir: dir, packaged: false, platform: "linux", mountInfo: noMounts, home: dir, env: {} });
        assert.equal(report?.status, "incomplete", content);
        assert.match(report?.failed[0]?.reason ?? "", /not a complete reset request, so nothing was removed/);
        assert.ok(existsSync(join(dir, "tokens.bin")), content);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("treats any detour through a link to the data folder as a link", async () => {
    const dir = await tempDir();
    try {
      const shared = join(dir, "shared");
      mkdirSync(join(shared, "inner"), { recursive: true });
      seedDataFolder(shared, DEV_MARKER);
      const linked = join(dir, "profile-link");
      symlinkSync(shared, linked);
      // "profile-link/../shared" lists the real parent of the target, while the
      // path reads as a folder next to the link.
      for (const path of [linked, `${linked}/`, `${linked}/.`, `${linked}/inner/..`, `${linked}/../shared`]) {
        assert.equal(folderGoesThroughLink(path), true, path);
        const report = runPendingLocalReset({ userDataDir: path, packaged: false, platform: "linux", mountInfo: noMounts, home: dir, env: {} });
        assert.equal(report?.status, "incomplete", path);
        assert.ok(existsSync(join(shared, "state.json")), path);
      }
      assert.equal(folderGoesThroughLink(shared), false);
      assert.equal(folderGoesThroughLink(`${shared}/`), false);
      assert.equal(folderGoesThroughLink(join(dir, "missing")), false);
      // Linux: a folder that is itself a mount point, such as a bind mount.
      const realShared = realpathSync(shared);
      const mountInfo = () => `36 35 98:0 /mnt1 ${realShared.replaceAll(" ", "\\040")} rw,noatime master:1 - ext3 /dev/root rw\n`;
      assert.equal(folderGoesThroughLink(shared, { platform: "linux", mountInfo }), true);
      assert.equal(folderGoesThroughLink(shared, { platform: "darwin", mountInfo }), false);
      assert.equal(folderGoesThroughLink(shared, { platform: "linux", mountInfo: () => "36 35 98:0 / / rw - ext4 /dev/root rw\n" }), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stops before removing anything when the policy file is a link, wherever it points", async () => {
    const dir = await tempDir();
    const outside = await tempDir();
    try {
      writeFileSync(join(outside, "central.json"), "{}");
      mkdirSync(join(outside, "central-folder"));
      writeFileSync(join(outside, "central-folder", "current.json"), "{}");
      const cases: Array<() => void> = [
        // Into the data folder.
        () => {
          mkdirSync(join(dir, "managed"));
          writeFileSync(join(dir, "managed", "current.json"), "{}");
          symlinkSync(join(dir, "managed", "current.json"), join(dir, "policy.json"));
        },
        // Through a folder link inside the data folder.
        () => {
          symlinkSync(join(outside, "central-folder"), join(dir, "managed-link"));
          symlinkSync(join(dir, "managed-link", "current.json"), join(dir, "policy.json"));
        },
        // Straight outside: still refused, the reset cannot vouch for a chain.
        () => symlinkSync(join(outside, "central.json"), join(dir, "Policy.json")),
      ];
      for (const plant of cases) {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir);
        seedDataFolder(dir, DEV_MARKER);
        rmSync(join(dir, "policy.json"));
        plant();
        assert.match(localResetPolicyProblem(dir) ?? "", /is a link, and the reset cannot be sure/);
        const report = runPendingLocalReset({ userDataDir: dir, packaged: false, platform: "linux", mountInfo: noMounts, home: dir, env: {} });
        assert.equal(report?.status, "incomplete");
        assert.ok(existsSync(join(dir, "state.json")));
      }
      assert.equal(readFileSync(join(outside, "central.json"), "utf8"), "{}");
      assert.equal(readFileSync(join(outside, "central-folder", "current.json"), "utf8"), "{}");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("removes the cache at its real location when a folder above it is a link, and reports preferences left behind", async () => {
    const dir = await tempDir();
    try {
      const home = join(dir, "home");
      const archive = join(dir, "archive-caches");
      mkdirSync(join(archive, "@openadminosdesktop-updater"), { recursive: true });
      writeFileSync(join(archive, "@openadminosdesktop-updater", "pending.zip"), "app cache");
      writeFileSync(join(archive, "other-app.cache"), "keep");
      mkdirSync(join(home, "Library"), { recursive: true });
      symlinkSync(archive, join(home, "Library", "Caches"));

      const data = join(dir, "data");
      mkdirSync(data);
      seedDataFolder(data, MARKER);
      const { run } = recordingRun({ "/usr/bin/security": [keychainNotFound], "/usr/bin/defaults": [{ status: 1 }, { status: 0 }] });
      const report = runPendingLocalReset({ userDataDir: data, packaged: true, platform: "darwin", home, env: {}, run });
      assert.equal(report?.status, "completed");
      // The app's own cache folder goes, wherever ~/Library/Caches resolves; nothing beside it.
      assert.ok(!existsSync(join(archive, "@openadminosdesktop-updater")));
      assert.equal(readFileSync(join(archive, "other-app.cache"), "utf8"), "keep");
      assert.ok(report?.warnings.some((warning) => /Preferences/.test(warning.item) && /still there/.test(warning.reason)));

      // A read that fails says the removal could not be confirmed.
      const data2 = join(dir, "data2");
      mkdirSync(data2);
      seedDataFolder(data2, MARKER);
      const failing = recordingRun({ "/usr/bin/security": [keychainNotFound], "/usr/bin/defaults": [{ status: 1 }, { status: null, error: new Error("timed out") }] });
      const report2 = runPendingLocalReset({ userDataDir: data2, packaged: true, platform: "darwin", home, env: {}, run: failing.run });
      assert.ok(report2?.warnings.some((warning) => /Preferences/.test(warning.item) && /could not be confirmed/.test(warning.reason)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("matches its folder across a restart even when the device number changed, except on Linux", () => {
    const stored = { dev: 16777220, ino: 4242, birth: 1763550000000 };
    assert.equal(markerFolderMatches(stored, { ...stored, dev: 16777231 }, "darwin"), true);
    assert.equal(markerFolderMatches(stored, { ...stored, dev: 16777231 }, "win32"), true);
    // A Btrfs snapshot restored as the home keeps inode and birth time; only
    // the device number differs, so on Linux it never matches.
    assert.equal(markerFolderMatches(stored, { ...stored, dev: 16777231 }, "linux"), false);
    assert.equal(markerFolderMatches(stored, stored, "linux"), true);
    assert.equal(markerFolderMatches({ ...stored, ino: 0 }, { ...stored, ino: 0, dev: 1 }, "linux"), false);
    assert.equal(markerFolderMatches(stored, { ...stored, ino: 4243 }), false);
    assert.equal(markerFolderMatches(stored, { ...stored, birth: 1763559999000 }), false);
    // No birth time on this file system: the inode and the device decide.
    assert.equal(markerFolderMatches({ ...stored, birth: 0 }, { ...stored, birth: 0 }), true);
    assert.equal(markerFolderMatches({ ...stored, birth: 0 }, { ...stored, birth: 0, dev: 99 }), false);
    // Where statx is blocked the birth time is the change time: unknown.
    assert.deepEqual(identityFromStat({ dev: 1, ino: 7, birthtimeMs: 500, ctimeMs: 500 }), { dev: 1, ino: 7, birth: 0 });
    assert.deepEqual(identityFromStat({ dev: 1, ino: 7, birthtimeMs: 400, ctimeMs: 500 }), { dev: 1, ino: 7, birth: 400 });
    assert.equal(identityFromStat({ dev: 1, ino: 0, birthtimeMs: 500, ctimeMs: 500 }), undefined);
    // No inode: only a known, equal birth time matches.
    assert.equal(markerFolderMatches({ ...stored, ino: 0 }, { ...stored, ino: 0 }), true);
    assert.equal(markerFolderMatches({ ...stored, ino: 0, birth: 0 }, { ...stored, ino: 0, birth: 0 }), false);
  });

  it("marks the reset committed at the rename, before the folder flush returns", async () => {
    const dir = await tempDir();
    try {
      let committed = false;
      let committedWhenFlushStarted: boolean | undefined;
      let release!: () => void;
      const written = writeLocalResetMarker(dir, MARKER, {
        onCommitted: () => { committed = true; },
        syncDirectory: () => new Promise<void>((resolve) => {
          committedWhenFlushStarted = committed;
          release = resolve;
        }),
      });
      await new Promise((resolve) => setImmediate(resolve));
      while (committedWhenFlushStarted === undefined) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(committedWhenFlushStarted, true);
      assert.ok(existsSync(join(dir, LOCAL_RESET_MARKER)));
      release();
      await written;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("on Windows stops when the folder or the entry is replaced during the hard-link check", async () => {
    for (const swap of ["folder", "entry"] as const) {
      const dir = await tempDir();
      try {
        const profile = join(dir, "profile");
        mkdirSync(profile);
        seedDataFolder(profile, DEV_MARKER);
        const report = runPendingLocalReset({
          userDataDir: profile,
          packaged: false,
          platform: "win32",
          home: dir,
          env: {},
          // A restore lands while "agents" is being checked.
          scanSharedFiles: (path, label) => {
            if (label === "agents") {
              if (swap === "folder") {
                renameSync(profile, join(dir, "profile-old"));
                mkdirSync(join(profile, "agents"), { recursive: true });
              } else {
                renameSync(path, join(dir, "agents-old"));
                mkdirSync(path);
              }
              writeFileSync(join(path, "restored"), "restored agent");
            }
            return undefined;
          },
        });
        assert.equal(report?.status, "incomplete", swap);
        assert.match(report?.failed.at(-1)?.reason ?? "", /was replaced by another folder or a link/, swap);
        assert.equal(readFileSync(join(profile, "agents", "restored"), "utf8"), "restored agent", swap);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("stops before the Keychain item when the profile is restored during the cleanup outside it", async () => {
    for (const when of ["scheduler", "keychain"] as const) {
      const dir = await tempDir();
      try {
        const profile = join(dir, "profile");
        mkdirSync(profile);
        seedDataFolder(profile, MARKER);
        const restore = () => {
          renameSync(profile, join(dir, "profile-old"));
          mkdirSync(profile);
          writeFileSync(join(profile, "tokens.bin"), "restored tokens");
        };
        const calls: string[][] = [];
        const run = (file: string, args: string[]): CommandResult => {
          calls.push([file, ...args]);
          // One item deleted, more may be left: the next attempt comes after the restore.
          if (when === "keychain" && args[0] === "delete-generic-password" && calls.length === 1) {
            restore();
            return { status: 0 };
          }
          return { status: 44 };
        };
        const report = runPendingLocalReset({
          userDataDir: profile, packaged: true, platform: "darwin", home: join(dir, "home"), env: {}, run,
          // The scheduler step checks the folder right before its own removal.
          removeScheduler: (guard) => { if (when === "scheduler") { restore(); guard(); } },
        });
        assert.equal(report?.status, "incomplete", when);
        assert.match(report?.failed.at(-1)?.reason ?? "", /was replaced by another folder or a link/, when);
        // No Keychain deletion after the restore, and no later step either.
        assert.equal(calls.filter((call) => call[1] === "delete-generic-password").length, when === "keychain" ? 1 : 0, when);
        assert.ok(!calls.some((call) => call[0] === "/usr/bin/defaults"), when);
        assert.equal(readFileSync(join(profile, "tokens.bin"), "utf8"), "restored tokens", when);
        assert.ok(!report?.warnings.some((warning) => warning.item === "Background scheduler"), when);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("keeps the Keychain key when files are restored into the same data folder during the cleanup", async () => {
    for (const when of ["scheduler", "keychain"] as const) {
      const dir = await tempDir();
      try {
        const profile = join(dir, "profile");
        mkdirSync(profile);
        seedDataFolder(profile, MARKER);
        // A backup tool puts the token file back without replacing the folder.
        const restore = () => writeFileSync(join(profile, "tokens.bin"), "restored tokens");
        const calls: string[][] = [];
        const run = (file: string, args: string[]): CommandResult => {
          calls.push([file, ...args]);
          if (when === "keychain" && args[0] === "delete-generic-password" && calls.length === 1) {
            restore();
            return { status: 0 };
          }
          return { status: 44 };
        };
        const report = runPendingLocalReset({
          userDataDir: profile, packaged: true, platform: "darwin", home: join(dir, "home"), env: {}, run,
          removeScheduler: (guard) => { if (when === "scheduler") { restore(); guard(); } },
        });
        assert.equal(report?.status, "incomplete", when);
        assert.deepEqual(report?.failed, [{ item: "tokens.bin", reason: "it was created again during the reset" }], when);
        assert.equal(calls.filter((call) => call[1] === "delete-generic-password").length, when === "keychain" ? 1 : 0, when);
        assert.equal(readFileSync(join(profile, "tokens.bin"), "utf8"), "restored tokens", when);
        // The marker stays, without the cleanup recorded as done.
        assert.equal(readLocalResetMarker(profile)?.leftoversDone, undefined, when);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("on Linux stops before the next removal when a mount appears inside the data folder", async () => {
    const dir = await tempDir();
    try {
      const profile = join(dir, "profile");
      mkdirSync(profile);
      seedDataFolder(profile, DEV_MARKER);
      const real = realpathSync(profile);
      let reads = 0;
      const report = runPendingLocalReset({
        userDataDir: profile,
        packaged: false,
        platform: "linux",
        home: dir,
        env: {},
        // A mount service bind-mounts shared storage under registry-cache
        // after the first removal.
        mountInfo: () => (reads++ === 0 ? "" : `36 35 0:42 / ${real}/registry-cache rw - ext4 /dev/sdb1 rw\n`),
      });
      assert.equal(report?.status, "incomplete");
      assert.match(report?.failed.at(-1)?.reason ?? "", /a mount appeared at or inside the data folder/);
      // One entry went; the wipe stopped before the next one.
      assert.equal(reads, 2);
      assert.ok(existsSync(join(profile, "registry-cache", "file")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the Keychain key when the profile is replaced while the guard lists it", async () => {
    const dir = await tempDir();
    try {
      const profile = join(dir, "profile");
      mkdirSync(profile);
      seedDataFolder(profile, MARKER);
      const calls: string[][] = [];
      let leftoversStarted = false;
      let swapped = false;
      const base = failingFileSystem(() => false);
      const report = runPendingLocalReset({
        userDataDir: profile,
        packaged: true,
        platform: "darwin",
        home: join(dir, "home"),
        env: {},
        run: (file, args) => { calls.push([file, ...args]); return { status: 44 }; },
        removeScheduler: () => { leftoversStarted = true; },
        fs: {
          ...base,
          // The listing reads the old folder; a backup tool swaps in the
          // restored profile before the listing returns.
          readdir: (path) => {
            const names = base.readdir(path);
            if (path === profile && leftoversStarted && !swapped) {
              swapped = true;
              renameSync(profile, join(dir, "profile-old"));
              mkdirSync(profile);
              writeFileSync(join(profile, "tokens.bin"), "restored tokens");
            }
            return names;
          },
        },
      });
      assert.ok(swapped);
      assert.equal(report?.status, "incomplete");
      assert.match(report?.failed.at(-1)?.reason ?? "", /was replaced by another folder or a link/);
      assert.ok(!calls.some((call) => call[1] === "delete-generic-password"));
      assert.equal(readFileSync(join(profile, "tokens.bin"), "utf8"), "restored tokens");
      // No progress record went into the restored profile.
      assert.deepEqual(readdirSync(profile), ["tokens.bin"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves a cache folder replaced while the data folder is listed before its removal", async () => {
    const dir = await tempDir();
    try {
      const profile = join(dir, "profile");
      mkdirSync(profile);
      seedDataFolder(profile, MARKER);
      const cache = join(dir, "cache", UPDATER_CACHE_DIR);
      mkdirSync(cache, { recursive: true });
      writeFileSync(join(cache, "update.AppImage"), "old update");
      let cacheWalked = false;
      let swapped = false;
      const base = failingFileSystem(() => false);
      const report = runPendingLocalReset({
        userDataDir: profile,
        packaged: true,
        platform: "linux",
        home: join(dir, "home"),
        env: { XDG_CACHE_HOME: join(dir, "cache") },
        mountInfo: () => {
          if (readdirSync(profile).every((name) => isKeptThroughReset(name))) cacheWalked = true;
          return "";
        },
        fs: {
          ...base,
          // The guard lists the data folder after the cache's walk: a backup
          // job replaces the cache right then.
          readdir: (path) => {
            if (path === profile && cacheWalked && !swapped) {
              swapped = true;
              renameSync(cache, `${cache}-old`);
              mkdirSync(cache);
              writeFileSync(join(cache, "restored"), "restored cache");
            }
            return base.readdir(path);
          },
        },
      });
      assert.ok(swapped);
      assert.equal(report?.status, "completed");
      assert.deepEqual(report?.warnings, [{ item: cache, reason: "it was replaced while it was being checked, so it was left in place" }]);
      assert.equal(readFileSync(join(cache, "restored"), "utf8"), "restored cache");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not record the outside cleanup as done when files come back during its last step", async () => {
    const dir = await tempDir();
    try {
      const profile = join(dir, "profile");
      mkdirSync(profile);
      seedDataFolder(profile, MARKER);
      const cache = join(dir, "cache", UPDATER_CACHE_DIR);
      mkdirSync(cache, { recursive: true });
      const base = failingFileSystem(() => false);
      const report = runPendingLocalReset({
        userDataDir: profile,
        packaged: true,
        platform: "linux",
        mountInfo: noMounts,
        home: join(dir, "home"),
        env: { XDG_CACHE_HOME: join(dir, "cache") },
        fs: {
          ...base,
          remove: (path) => {
            base.remove(path);
            // A restore puts the token file back while the last cache goes.
            if (path === cache) writeFileSync(join(profile, "tokens.bin"), "restored tokens");
          },
        },
      });
      assert.equal(report?.status, "incomplete");
      assert.deepEqual(report?.failed, [{ item: "tokens.bin", reason: "it was created again during the reset" }]);
      assert.equal(readLocalResetMarker(profile)?.leftoversDone, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("on Linux leaves a cache folder that gains a mount after its walk", async () => {
    const dir = await tempDir();
    try {
      const profile = join(dir, "profile");
      mkdirSync(profile);
      seedDataFolder(profile, MARKER);
      const cache = join(dir, "cache", UPDATER_CACHE_DIR);
      mkdirSync(join(cache, "pending"), { recursive: true });
      writeFileSync(join(cache, "pending", "update.AppImage"), "update");
      let cacheReads = 0;
      const report = runPendingLocalReset({
        userDataDir: profile,
        packaged: true,
        platform: "linux",
        home: join(dir, "home"),
        env: { XDG_CACHE_HOME: join(dir, "cache") },
        // The walk sees no mount; right after it, one is added inside.
        mountInfo: () => {
          if (!readdirSync(profile).every((name) => isKeptThroughReset(name))) return "";
          return cacheReads++ === 0 ? "" : `36 35 0:42 / ${realpathSync(cache)}/pending rw - ext4 /dev/sdb1 rw\n`;
        },
      });
      assert.equal(report?.status, "completed");
      assert.deepEqual(report?.warnings, [{ item: cache, reason: "it is a link or holds another mount, so it was left in place" }]);
      assert.ok(existsSync(join(cache, "pending", "update.AppImage")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves a cache folder that was replaced during its link and mount check", async () => {
    const dir = await tempDir();
    try {
      const profile = join(dir, "profile");
      mkdirSync(profile);
      seedDataFolder(profile, MARKER);
      const cache = join(dir, "cache", UPDATER_CACHE_DIR);
      mkdirSync(cache, { recursive: true });
      writeFileSync(join(cache, "update.AppImage"), "old update");
      let swapped = false;
      const report = runPendingLocalReset({
        userDataDir: profile,
        packaged: true,
        platform: "linux",
        home: join(dir, "home"),
        env: { XDG_CACHE_HOME: join(dir, "cache") },
        // The mount table is read during the walk: a restore lands right then.
        mountInfo: () => {
          const dataWiped = readdirSync(profile).every((name) => isKeptThroughReset(name));
          if (dataWiped && !swapped) {
            swapped = true;
            renameSync(cache, `${cache}-old`);
            mkdirSync(cache);
            writeFileSync(join(cache, "restored"), "restored cache");
          }
          return "";
        },
      });
      assert.equal(report?.status, "completed");
      assert.deepEqual(report?.warnings, [{ item: cache, reason: "it was replaced while it was being checked, so it was left in place" }]);
      assert.equal(readFileSync(join(cache, "restored"), "utf8"), "restored cache");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes the warnings only to the folder the reset was accepted for", async () => {
    const dir = await tempDir();
    try {
      const data = join(dir, "data");
      mkdirSync(data);
      const committed = await writeLocalResetMarker(data, DEV_MARKER);
      // A restore replaces the folder with a plain folder of the same name.
      renameSync(data, `${data}-old`);
      mkdirSync(data);
      writeFileSync(join(data, "state.json"), "restored");
      await assert.rejects(
        writeLocalResetMarker(data, { ...DEV_MARKER, requestWarnings: [{ item: "Background scheduler", reason: "x" }] }, { expectFolder: committed }),
        /no longer the one the reset was accepted for/,
      );
      assert.deepEqual(readdirSync(data), ["state.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never wipes a copy of the folder restored or roamed elsewhere", async () => {
    const dir = await tempDir();
    try {
      const original = join(dir, "original");
      const restored = join(dir, "restored");
      mkdirSync(original);
      mkdirSync(restored);
      seedDataFolder(original, MARKER);
      // The restored copy carries the marker written for the original folder.
      writeFileSync(join(restored, "state.json"), "{}");
      writeFileSync(join(restored, LOCAL_RESET_MARKER), readFileSync(join(original, LOCAL_RESET_MARKER)));
      const { run, calls } = recordingRun();
      const report = runPendingLocalReset({ userDataDir: restored, packaged: true, platform: "darwin", home: join(dir, "home"), env: {}, run });
      assert.equal(report?.status, "incomplete");
      assert.match(report?.failed[0]?.reason ?? "", /written for this data folder on another device/);
      assert.ok(existsSync(join(restored, "state.json")));
      assert.deepEqual(calls, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stops before the next removal when the folder is swapped in the middle of the wipe", async () => {
    const dir = await tempDir();
    try {
      const data = join(dir, "data");
      const other = join(dir, "other-workspace");
      mkdirSync(data);
      mkdirSync(join(other, "logs"), { recursive: true });
      writeFileSync(join(other, "logs", "keep.txt"), "keep");
      seedDataFolder(data, DEV_MARKER);
      let swapped = false;
      const fs: LocalResetFileSystem = {
        ...failingFileSystem(() => false),
        remove: (path) => {
          rmSync(path, { recursive: true, force: true });
          // After the first removal another process swaps the folder for a link.
          if (!swapped) {
            swapped = true;
            renameSync(data, `${data}-old`);
            symlinkSync(other, data);
          }
        },
      };
      const report = runPendingLocalReset({ userDataDir: data, packaged: false, platform: "linux", mountInfo: noMounts, home: dir, env: {}, fs });
      assert.equal(report?.status, "incomplete");
      assert.equal(readFileSync(join(other, "logs", "keep.txt"), "utf8"), "keep");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stops when the data folder is swapped for another while the wipe runs", async () => {
    const dir = await tempDir();
    try {
      const data = join(dir, "data");
      const other = join(dir, "other-profile");
      mkdirSync(data);
      mkdirSync(other);
      writeFileSync(join(other, "state.json"), "other");
      seedDataFolder(data, MARKER);
      const { run } = recordingRun({ "/usr/bin/security": [keychainNotFound] });
      const report = runPendingLocalReset({
        userDataDir: data, packaged: true, platform: "darwin", home: join(dir, "home"), env: {}, run,
        // Another process swaps the emptied folder for a link during the cleanup outside it.
        removeScheduler: () => {
          renameSync(data, `${data}-old`);
          symlinkSync(other, data);
        },
      });
      assert.equal(report?.status, "incomplete");
      assert.match(report?.failed[0]?.reason ?? "", /replaced by another folder or a link/);
      assert.deepEqual(readdirSync(other), ["state.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads task presence from the full task list", () => {
    const csv = '"\\Microsoft Edge Update","20/11/2026 10:00:00","Ready"\r\n"\\OpenAdminOS Scheduler","N/A","Ready"\r\n';
    assert.equal(windowsTaskListHas(csv, "OpenAdminOS Scheduler"), true);
    assert.equal(windowsTaskListHas('"\\OpenAdminOS Scheduler Old","N/A","Ready"\r\n', "OpenAdminOS Scheduler"), false);
    assert.equal(windowsTaskListHas("", "OpenAdminOS Scheduler"), false);
  });

  it("removes the Windows scheduled task only when it also runs as this account", () => {
    const home = "C:\\Users\\ada";
    const program = "C:\\Users\\ada\\AppData\\Local\\Programs\\OpenAdminOS\\OpenAdminOS.exe";
    const account = parseWhoamiUser('"contoso\\ada","S-1-5-21-1-2-3-1001"\r\n');
    assert.deepEqual(account, { name: "contoso\\ada", sid: "S-1-5-21-1-2-3-1001" });
    const xml = (userId: string) => `<Task><Principals><Principal id="Author"><UserId>${userId}</UserId><LogonType>InteractiveToken</LogonType></Principal></Principals></Task>`;
    assert.equal(windowsTaskUserId(xml("CONTOSO\\ada")), "CONTOSO\\ada");
    for (const userId of ["CONTOSO\\ada", "ada", "S-1-5-21-1-2-3-1001"]) {
      assert.equal(windowsTaskBelongsToThisAccount(program, home, { taskUserId: windowsTaskUserId(xml(userId)), account }), true, userId);
    }
    // A service account's task pointing at Ada's program is not Ada's.
    assert.equal(windowsTaskBelongsToThisAccount(program, home, { taskUserId: "CONTOSO\\svc-openadminos", account }), false);
    assert.equal(windowsTaskBelongsToThisAccount(program, home, { taskUserId: "S-1-5-18", account }), false);
    // Unknown on either side: left in place.
    assert.equal(windowsTaskBelongsToThisAccount(program, home, { taskUserId: undefined, account }), false);
    assert.equal(windowsTaskBelongsToThisAccount(program, home, { taskUserId: "ada", account: undefined }), false);
    assert.equal(parseWhoamiUser("Access is denied."), undefined);
  });

  it("removes the Windows scheduled task only when its program is under this account's profile", () => {
    const home = "C:\\Users\\ada";
    assert.equal(windowsTaskBelongsToThisAccount("C:\\Users\\ada\\AppData\\Local\\Programs\\OpenAdminOS\\OpenAdminOS.exe", home), true);
    assert.equal(windowsTaskBelongsToThisAccount("c:\\users\\ADA\\AppData\\Local\\Programs\\OpenAdminOS\\openadminos.exe", home), true);
    // A copy for all users may be shared, even when it is the program running now.
    assert.equal(windowsTaskBelongsToThisAccount("C:\\Program Files\\OpenAdminOS\\OpenAdminOS.exe", home), false);
    assert.equal(windowsTaskBelongsToThisAccount("C:\\Users\\bob\\AppData\\Local\\Programs\\OpenAdminOS\\OpenAdminOS.exe", home), false);
    assert.equal(windowsTaskBelongsToThisAccount("C:\\Users\\adam\\OpenAdminOS.exe", home), false);
    assert.equal(windowsTaskBelongsToThisAccount(undefined, home), false);
  });

  it("treats a sub-folder it cannot read as something it cannot rule out, and ignores letter case", async () => {
    const dir = await tempDir();
    try {
      const data = join(dir, "Profile");
      mkdirSync(join(data, "locked", "inner"), { recursive: true });
      assert.equal(folderGoesThroughLink(data), false);
      // On a case-insensitive volume the other spelling is the same folder.
      if (existsSync(join(dir, "profile"))) assert.equal(folderGoesThroughLink(join(dir, "profile")), false);
      // chmod cannot take away read access on Windows, and root reads anything.
      if (process.platform !== "win32" && process.getuid?.() !== 0) {
        chmodSync(join(data, "locked"), 0o000);
        try {
          assert.equal(folderGoesThroughLink(data), true);
          assert.match(localResetPolicyProblem(join(data, "locked")) ?? "", /could not be read/);
        } finally {
          chmodSync(join(data, "locked"), 0o755);
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves the data folder and caches alone when another mount sits inside them (Linux)", async () => {
    const dir = await tempDir();
    try {
      const data = join(dir, "data");
      mkdirSync(join(data, "registry-cache", "shared"), { recursive: true });
      writeFileSync(join(data, "registry-cache", "shared", "other.txt"), "keep");
      const realData = realpathSync(data);
      const mountInfo = () => `40 35 98:0 /shared ${realData}/registry-cache/shared rw - ext4 /dev/sdb1 rw\n`;
      assert.equal(folderGoesThroughLink(data, { platform: "linux", mountInfo }), true);
      assert.equal(folderGoesThroughLink(`${data}-other`, { platform: "linux", mountInfo }), false);

      const home = join(dir, "home");
      const cache = join(home, ".cache", "@openadminosdesktop-updater");
      mkdirSync(join(cache, "mounted"), { recursive: true });
      writeFileSync(join(cache, "mounted", "other.txt"), "keep");
      const plainData = join(dir, "plain");
      mkdirSync(plainData);
      seedDataFolder(plainData, MARKER);
      const realCache = realpathSync(cache);
      const report = runPendingLocalReset({
        userDataDir: plainData, packaged: true, platform: "linux", home, env: {},
        mountInfo: () => `41 35 98:0 /x ${realCache}/mounted rw - ext4 /dev/sdc1 rw\n`,
      });
      assert.equal(report?.status, "completed");
      assert.ok(existsSync(join(cache, "mounted", "other.txt")));
      assert.match(report?.warnings.find((warning) => warning.item === cache)?.reason ?? "", /holds another mount/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("local reset: request", () => {
  function steps(log: string[], overrides: Partial<LocalResetRequestSteps> = {}): LocalResetRequestSteps {
    return {
      checkReady: async () => { log.push("check"); },
      writeMarker: async (marker) => { log.push(`marker:${marker.requestWarnings?.length ?? 0}`); },
      stopTenantWork: async () => { log.push("stop-work"); },
      disableScheduler: async () => { log.push("scheduler"); },
      disableLoginItem: async () => { log.push("login-item"); },
      build: "installed",
      now: () => new Date(MARKER.requestedAt),
      ...overrides,
    };
  }

  it("refuses a wrong phrase before doing anything", async () => {
    for (const phrase of ["", "reset openadminos", "RESET OPENADMINOS ", " RESET OPENADMINOS", "RESET OPEN ADMINOS", undefined, 42]) {
      const log: string[] = [];
      await assert.rejects(requestLocalReset(phrase, steps(log)), LocalResetRequestError);
      assert.deepEqual(log, []);
    }
  });

  it("writes the marker first, then stops tenant work and turns off background work", async () => {
    const log: string[] = [];
    const { marker } = await requestLocalReset(LOCAL_RESET_PHRASE, steps(log));
    assert.deepEqual(log, ["check", "marker:0", "stop-work", "scheduler", "login-item"]);
    assert.deepEqual(marker, MARKER);
  });

  it("removes nothing when the reset must wait or the marker cannot be written", async () => {
    const log: string[] = [];
    await assert.rejects(
      requestLocalReset(LOCAL_RESET_PHRASE, steps(log, { checkReady: async () => { throw new LocalResetRequestError("An apply is running. Nothing was removed."); } })),
      /An apply is running/,
    );
    assert.deepEqual(log, []);
    await assert.rejects(
      requestLocalReset(LOCAL_RESET_PHRASE, steps(log, { writeMarker: async () => { throw new Error("EACCES"); } })),
      /could not start.*Nothing was removed/,
    );
    assert.deepEqual(log, ["check"]);
  });

  it("goes on past failed steps after the marker and records the scheduler failure in it", async () => {
    const log: string[] = [];
    const { marker } = await requestLocalReset(
      LOCAL_RESET_PHRASE,
      steps(log, {
        stopTenantWork: async () => { throw new Error("store closed"); },
        disableScheduler: async () => { throw new Error("launchctl failed"); },
      }),
    );
    assert.deepEqual(log, ["check", "marker:0", "login-item", "marker:1"]);
    assert.deepEqual(marker.requestWarnings, [{ item: "Background scheduler", reason: "launchctl failed" }]);
  });

  it("never signs out or rewrites anything in the data folder after the marker", async () => {
    const dir = await tempDir();
    try {
      writeFileSync(join(dir, "tokens.bin"), "encrypted cache");
      const before = statSync(join(dir, "tokens.bin"));
      await requestLocalReset(LOCAL_RESET_PHRASE, {
        checkReady: async () => undefined,
        writeMarker: async (marker) => { await writeLocalResetMarker(dir, marker); },
        stopTenantWork: async () => undefined,
        disableScheduler: async () => undefined,
        disableLoginItem: async () => undefined,
        build: "development",
      });
      // The token cache is removed by the launch wipe, never rewritten in
      // place by a sign-out that could reach a folder swapped in since.
      assert.equal(readFileSync(join(dir, "tokens.bin"), "utf8"), "encrypted cache");
      assert.equal(statSync(join(dir, "tokens.bin")).mtimeMs, before.mtimeMs);
      assert.deepEqual(readdirSync(dir).sort(), [LOCAL_RESET_MARKER, "tokens.bin"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("local reset: end to end with the store", () => {
  it("relaunches into first run with no tenants, tokens or secrets, a fresh database and an intact audit log", async () => {
    const dir = await tempDir();
    const tokenCache = new Map<string, string>();
    try {
      const statePath = join(dir, "state.json");
      await writeFile(statePath, `${JSON.stringify({ activeProviderId: "ollama", installedAgents: [], runs: [], tenants: [tenant], activeTenantId: tenant.id }, null, 2)}\n`, "utf8");
      writeFileSync(join(dir, "policy.json"), "{}\n");
      writeFileSync(join(dir, "tokens.bin"), "encrypted");
      mkdirSync(join(dir, "providers", "secrets"), { recursive: true });
      writeFileSync(join(dir, "providers", "secrets", "anthropic.bin"), "encrypted");
      const store = new AppStateStore({ filePath: statePath, tokenStore: memoryTokenStore(tokenCache), userDataPath: dir, statsApiUrl: "" });
      await store.recordAuditLogAtStartup();
      await store.exportAuditLog({ format: "json" });
      assert.ok(existsSync(join(dir, "openadminos.db")));
      assert.ok(existsSync(join(dir, "openadminos.db-audit-anchor.json")));

      // Phase 1, as the main process runs it.
      await requestLocalReset(LOCAL_RESET_PHRASE, {
        checkReady: async () => assert.equal(await store.beginLocalReset(), undefined),
        writeMarker: async (marker) => { await writeLocalResetMarker(dir, marker); },
        stopTenantWork: async () => store.closeAllTenantWork(),
        disableScheduler: async () => undefined,
        disableLoginItem: async () => undefined,
        build: "development",
      });
      // No confirmed change starts between the request and the restart.
      await assert.rejects(store.confirmRun("any-run", "ANY PHRASE"), /OpenAdminOS is resetting.*Nothing was applied/);
      await store.shutdown(500);

      // Phase 2, at the next launch.
      const report = runPendingLocalReset({ userDataDir: dir, packaged: false, platform: process.platform, home: join(dir, "home"), env: {} });
      assert.equal(report?.status, "completed");
      assert.deepEqual(readdirSync(dir), ["policy.json"]);

      const fresh = new AppStateStore({ filePath: statePath, tokenStore: memoryTokenStore(new Map()), userDataPath: dir, statsApiUrl: "" });
      try {
        const state = await fresh.getAppState();
        assert.deepEqual(state.tenants, []);
        assert.equal(state.activeTenantId, undefined);
        assert.equal(state.firstRunScanPending, true);
        await fresh.recordAuditLogAtStartup();
        const exported = await fresh.exportAuditLog({ format: "json" });
        assert.equal(typeof exported.hashChain.finalHash, "string");
        assert.ok(!existsSync(join(dir, "tokens.bin")));
        assert.ok(!existsSync(join(dir, "providers")));
      } finally {
        fresh.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closes and drains organizations without reading or creating the state file", async () => {
    const dir = await tempDir();
    try {
      const statePath = join(dir, "state.json");
      await writeFile(statePath, JSON.stringify({ activeProviderId: "ollama", installedAgents: [], runs: [], tenants: [tenant] }), "utf8");
      const store = new AppStateStore({ filePath: statePath, tokenStore: memoryTokenStore(new Map()), userDataPath: dir, statsApiUrl: "" });
      assert.equal(await store.beginLocalReset(), undefined);
      // A folder swapped in after the marker has no state file yet: the
      // reset must not create one there.
      rmSync(statePath);
      await store.closeAllTenantWork();
      const lifecycle = (store as unknown as { tenantLifecycle: { isWritable(id: string): boolean } }).tenantLifecycle;
      assert.equal(lifecycle.isWritable(tenant.id), false);
      await store.shutdown(200);
      assert.ok(!existsSync(statePath));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses every state write once the reset is committed, a queued one included", async () => {
    const dir = await tempDir();
    try {
      const statePath = join(dir, "state.json");
      await writeFile(statePath, JSON.stringify({ activeProviderId: "ollama", installedAgents: [], runs: [], tenants: [tenant] }), "utf8");
      const store = new AppStateStore({ filePath: statePath, tokenStore: memoryTokenStore(new Map()), userDataPath: dir, statsApiUrl: "" });
      try {
        assert.equal(await store.beginLocalReset(), undefined);
        // Before the marker, the app still saves: a refused reset loses nothing.
        await store.setUpdateChannel("nightly");
        assert.match(readFileSync(statePath, "utf8"), /nightly/);
        // A write queued before the commit runs after it and is refused too.
        const queued = store.setUpdateChannel("stable");
        await store.closeAllTenantWork();
        await assert.rejects(queued, /OpenAdminOS is resetting.*Nothing was saved/);
        rmSync(statePath);
        await assert.rejects(store.setUpdateChannel("nightly"), /Nothing was saved/);
        assert.ok(!existsSync(statePath));
        // A request refused after the commit (not reachable today) saves again.
        store.cancelLocalReset();
        await store.setUpdateChannel("nightly");
        assert.ok(existsSync(statePath));
      } finally {
        store.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("neither writes, clears nor reads a token cache from disk once the reset is committed", async () => {
    const dir = await tempDir();
    try {
      const calls: string[] = [];
      const recording = (name: string): TokenCacheStorage => ({
        read: async () => { calls.push(`${name}:read`); return "cached"; },
        write: async () => { calls.push(`${name}:write`); },
        clear: async () => { calls.push(`${name}:clear`); },
      });
      const statePath = join(dir, "state.json");
      await writeFile(statePath, JSON.stringify({ activeProviderId: "ollama", installedAgents: [], runs: [], tenants: [] }), "utf8");
      const store = new AppStateStore({
        filePath: statePath,
        tokenStore: recording("default"),
        tokenStoreFor: (partition) => recording(partition),
        legacyTokenStoresFor: (partition) => [recording(`legacy-${partition}`)],
        userDataPath: dir,
        statsApiUrl: "",
      });
      try {
        const internals = store as unknown as {
          tokenStore: TokenCacheStorage;
          tokenStoreFor: (partition: string) => TokenCacheStorage;
          legacyTokenStoresFor: (partition: string) => TokenCacheStorage[];
        };
        // Before the commit every call goes through.
        assert.equal(await internals.tokenStore.read(), "cached");
        await internals.tokenStore.write("x");
        await internals.tokenStore.clear?.();
        assert.deepEqual(calls.splice(0), ["default:read", "default:write", "default:clear"]);
        // A sign-in refresh that comes back after the commit touches no file.
        store.markLocalResetCommitted();
        const stores = [internals.tokenStore, internals.tokenStoreFor("custom"), ...internals.legacyTokenStoresFor("custom")];
        for (const tokenStore of stores) {
          assert.equal(await tokenStore.read(), "");
          await assert.rejects(tokenStore.write("refreshed"), /Nothing was saved/);
          await tokenStore.clear?.();
        }
        assert.deepEqual(calls, []);
        assert.equal(dataFolderSealed(), true);
        // A refused reset (not reachable after the commit today) opens all of it again.
        store.cancelLocalReset();
        assert.equal(dataFolderSealed(), false);
        assert.equal(await internals.tokenStore.read(), "cached");
        await internals.tokenStore.write("y");
        assert.deepEqual(calls.splice(0), ["default:read", "default:write"]);
      } finally {
        store.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses WhatsApp Web and Splashtop work once a reset has started, and stops WhatsApp Web at the commit", async () => {
    const dir = await tempDir();
    try {
      const statePath = join(dir, "state.json");
      await writeFile(statePath, JSON.stringify({ activeProviderId: "ollama", installedAgents: [], runs: [], tenants: [] }), "utf8");
      const store = new AppStateStore({ filePath: statePath, tokenStore: memoryTokenStore(new Map()), userDataPath: dir, statsApiUrl: "" });
      try {
        let disposed = 0;
        (store as unknown as { whatsappWebClientInstance: { dispose(): void } }).whatsappWebClientInstance = { dispose: () => { disposed += 1; } };
        assert.equal(await store.beginLocalReset(), undefined);
        for (const call of [
          () => store.getWhatsAppWebStatus(),
          () => store.startWhatsAppWebLogin(),
          () => store.disconnectWhatsAppWeb(),
          () => store.listWhatsAppWebGroups(),
          () => store.testSplashtop("org-1"),
          () => store.disconnectSplashtop("org-1"),
        ]) {
          await assert.rejects(call(), /OpenAdminOS is resetting/);
        }
        store.markLocalResetCommitted();
        assert.equal(disposed, 1);
        assert.equal(dataFolderSealed(), true);
        // The shutdown leaves the databases open: closing would checkpoint
        // and delete the write-ahead log by path.
        await store.shutdown(100);
        const audit = (store as unknown as { auditLog: { closed: boolean } }).auditLog;
        assert.equal(audit.closed, false);
      } finally {
        store.cancelLocalReset();
        store.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never creates a missing state file while the reset is being checked", async () => {
    const dir = await tempDir();
    try {
      const statePath = join(dir, "state.json");
      // A running app that has read its state, whose file is then moved
      // away (a restore swapping folders) before the reset's checks.
      await writeFile(statePath, JSON.stringify({ activeProviderId: "ollama", installedAgents: [], runs: [], tenants: [tenant] }), "utf8");
      const store = new AppStateStore({ filePath: statePath, tokenStore: memoryTokenStore(new Map()), userDataPath: dir, statsApiUrl: "" });
      try {
        assert.equal((await store.getAppState()).tenants.length, 1);
        rmSync(statePath);
        assert.equal(await store.beginLocalReset(), undefined);
        assert.ok(!existsSync(statePath));
        // A refused or cancelled reset brings back the normal first launch rule.
        store.cancelLocalReset();
      } finally {
        store.close();
      }
      // A store that never read its state creates none during the checks either.
      const fresh = new AppStateStore({ filePath: statePath, tokenStore: memoryTokenStore(new Map()), userDataPath: dir, statsApiUrl: "" });
      try {
        assert.equal(await fresh.beginLocalReset(), undefined);
        assert.ok(!existsSync(statePath));
      } finally {
        fresh.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("waits while a confirmed change is being applied", async () => {
    const dir = await tempDir();
    try {
      const statePath = join(dir, "state.json");
      await writeFile(statePath, JSON.stringify({
        activeProviderId: "ollama",
        installedAgents: [],
        tenants: [tenant],
        runs: [{ id: "run-1", agentSlug: "stale-device-cleanup", tenantId: tenant.id, status: "running", queuedAt: "2026-11-19T09:00:00.000Z", confirmedAt: "2026-11-19T09:01:00.000Z" }],
      }), "utf8");
      const store = new AppStateStore({ filePath: statePath, tokenStore: memoryTokenStore(new Map()), userDataPath: dir, statsApiUrl: "" });
      try {
        assert.match((await store.localResetBlocker()) ?? "", /is applying a confirmed change.*Nothing was removed/);
        // A refused reset does not hold back confirmations.
        assert.match((await store.beginLocalReset()) ?? "", /is applying a confirmed change/);
        await assert.rejects(store.confirmRun("missing-run", "X"), (error: Error) => !/is resetting/.test(error.message));
        // A cancelled apply still settling a request it sent counts too.
        const persisted = JSON.parse(readFileSync(statePath, "utf8")) as { runs: Array<Record<string, unknown>> };
        persisted.runs[0] = { ...persisted.runs[0], status: "cancelled" };
        writeFileSync(statePath, JSON.stringify(persisted));
        const runService = (store as unknown as { runService: { hasActiveApply(): boolean } }).runService;
        const original = runService.hasActiveApply.bind(runService);
        runService.hasActiveApply = () => true;
        assert.match((await store.localResetBlocker()) ?? "", /A confirmed change is still finishing.*Nothing was removed/);
        // Also when the run's record is gone, as after a disconnect.
        persisted.runs = [];
        writeFileSync(statePath, JSON.stringify(persisted));
        assert.match((await store.localResetBlocker()) ?? "", /still finishing/);
        runService.hasActiveApply = original;
        assert.equal(await store.localResetBlocker(), undefined);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("local reset: runs and connector sends", () => {
  it("waits while any run is still going, read-only ones included", async () => {
    const dir = await tempDir();
    try {
      const statePath = join(dir, "state.json");
      await writeFile(statePath, JSON.stringify({
        activeProviderId: "ollama",
        installedAgents: [],
        tenants: [tenant],
        runs: [{ id: "run-read", agentSlug: "device-report", tenantId: tenant.id, status: "running", queuedAt: "2026-11-19T09:00:00.000Z" }],
      }), "utf8");
      const store = new AppStateStore({ filePath: statePath, tokenStore: memoryTokenStore(new Map()), userDataPath: dir, statsApiUrl: "" });
      try {
        assert.match((await store.beginLocalReset()) ?? "", /is still running. Wait for it to finish, or cancel it in Runs/);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops new work for every organization once accepted, and gives it back when the request is refused", async () => {
    const dir = await tempDir();
    try {
      const statePath = join(dir, "state.json");
      await writeFile(statePath, JSON.stringify({ activeProviderId: "ollama", installedAgents: [], tenants: [tenant], runs: [] }), "utf8");
      const store = new AppStateStore({ filePath: statePath, tokenStore: memoryTokenStore(new Map()), userDataPath: dir, statsApiUrl: "" });
      const lifecycle = (store as unknown as { tenantLifecycle: { isWritable(id: string): boolean } }).tenantLifecycle;
      try {
        assert.equal(await store.beginLocalReset(), undefined);
        await store.closeAllTenantWork();
        assert.equal(lifecycle.isWritable(tenant.id), false);
        store.cancelLocalReset();
        assert.equal(lifecycle.isWritable(tenant.id), true);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts no run and sends nothing more once accepted, and waits for a run still finishing", async () => {
    const dir = await tempDir();
    try {
      const statePath = join(dir, "state.json");
      await writeFile(statePath, JSON.stringify({ activeProviderId: "ollama", installedAgents: [], tenants: [tenant], runs: [] }), "utf8");
      const store = new AppStateStore({ filePath: statePath, tokenStore: memoryTokenStore(new Map()), userDataPath: dir, statsApiUrl: "" });
      const runService = (store as unknown as { runService: { hasActiveDrive(): boolean } }).runService;
      try {
        const original = runService.hasActiveDrive.bind(runService);
        runService.hasActiveDrive = () => true;
        assert.match((await store.beginLocalReset()) ?? "", /A run is still finishing/);
        runService.hasActiveDrive = original;

        assert.equal(await store.beginLocalReset(), undefined);
        // A schedule treats it as waiting, not as a failed run.
        await assert.rejects(store.startRun("device-report"), (error: Error) =>
          error instanceof OrganizationBoundaryError && /OpenAdminOS is resetting.*The run did not start/.test(error.message));
        await assert.rejects(store.sendWhatsAppWebTestMessage("+15550100"), /OpenAdminOS is resetting. Nothing was sent/);
        await assert.rejects(store.prepareSplashtopChange({ organizationId: "org", kind: "reboot", targets: [] } as never), /OpenAdminOS is resetting/);
        await assert.rejects(store.startBaselineRollback({ tenantId: tenant.id, baselineId: "b" } as never), /OpenAdminOS is resetting/);
        await assert.rejects(
          store.sendNovaConnector({ connectorId: "teams", tenantId: tenant.id } as never),
          /OpenAdminOS is resetting. Nothing more was sent/,
        );
        await store.processPendingRunDeliveries();
        store.cancelLocalReset();
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("declines connector sends once a reset has started", async () => {
    blockConnectorConfirmations("OpenAdminOS is resetting. Nothing was sent.");
    try {
      const decision = await requestConnectorConfirmation({ connectorId: "teams", capabilityId: "post-message", args: {}, sideEffect: "notify" } as never);
      assert.deepEqual(decision, { approved: false, reason: "OpenAdminOS is resetting. Nothing was sent." });
    } finally {
      blockConnectorConfirmations(undefined);
    }
  });
});

describe("local reset: confirmations", () => {
  it("waits while a confirmation is in flight and blocks new ones once the reset starts", async () => {
    const dir = await tempDir();
    let releaseProviders: () => void = () => undefined;
    let providersRequested: () => void = () => undefined;
    const requested = new Promise<void>((resolve) => { providersRequested = resolve; });
    const gate = new Promise<void>((resolve) => { releaseProviders = resolve; });
    const statePath = join(dir, "state.json");
    await writeFile(statePath, JSON.stringify({
      activeProviderId: "ollama",
      installedAgents: [{
        id: "write-agent", slug: "write-agent", name: "Write agent", description: "Fixture.", mode: "write",
        category: "devices", tier: "agent", requiresEntraTier: "free", scopes: [], author: { name: "OpenAdminOS" },
        version: "1.0.0", installedAt: "2026-11-01T00:00:00.000Z",
      }],
      tenants: [tenant],
      activeTenantId: tenant.id,
      runs: [{
        id: "run-1", agentSlug: "write-agent", tenantId: tenant.id, status: "awaiting-confirmation",
        queuedAt: "2026-11-19T09:00:00.000Z", providerId: "ollama", model: "test-model", steps: [], logs: [],
        plan: {
          summary: "Retire one device.", confirmationPhrase: "RETIRE 1 DEVICE",
          actions: [{ id: "retire:0", kind: "retire-managed-device", label: "Retire laptop", severity: "destructive", metadata: { deviceId: "device-1" } }],
        },
      }],
    }), "utf8");
    const store = new AppStateStore({
      filePath: statePath, tokenStore: memoryTokenStore(new Map()), userDataPath: dir, statsApiUrl: "",
      providerListFactory: async () => { providersRequested(); await gate; return []; },
    });
    try {
      const confirming = store.confirmRun("run-1", "RETIRE 1 DEVICE", { activeOrganizationOnly: true });
      await requested;
      // The confirmation has passed its checks but is not recorded yet.
      assert.match((await store.beginLocalReset()) ?? "", /A change is being confirmed.*Nothing was removed/);
      releaseProviders();
      const run = await confirming;
      assert.ok(run.confirmedAt);
      // The real apply is tracked from the moment it is confirmed until its
      // work settles, without stubs.
      const runService = (store as unknown as { runService: { hasActiveApply(): boolean } }).runService;
      assert.equal(runService.hasActiveApply(), true);
      for (let attempt = 0; attempt < 3000 && runService.hasActiveApply(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(runService.hasActiveApply(), false);
      // Now recorded as applying, until the apply finishes. The finished
      // run's report delivery pass may still be under way: wait it out.
      let blocker = await store.beginLocalReset();
      for (let attempt = 0; attempt < 3000 && blocker !== undefined && /being sent|still finishing|still running/.test(blocker); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        blocker = await store.beginLocalReset();
      }
      if (blocker === undefined) {
        // The apply already failed (no sign-in): the reset may start, and new confirmations are refused.
        await assert.rejects(store.confirmRun("run-1", "RETIRE 1 DEVICE"), /OpenAdminOS is resetting/);
      } else {
        assert.match(blocker, /is applying a confirmed change/);
      }
    } finally {
      releaseProviders();
      await store.shutdown(500);
      const pending = () => (store as unknown as { writeChain: Promise<unknown> }).writeChain;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const chain = pending();
        await chain;
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (pending() === chain) break;
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

const tenant: TenantRecord = {
  id: "tenant-1",
  displayName: "Contoso",
  username: "admin@contoso.example",
  homeAccountId: "home-1",
  addedAt: "2026-11-01T00:00:00.000Z",
};

function memoryTokenStore(cache: Map<string, string>): TokenCacheStorage {
  return {
    read: async () => cache.get("default") ?? "",
    write: async (serialized: string) => { cache.set("default", serialized); },
  };
}

/** Real file operations, except that removing a matching path fails as a locked file does. */
function failingFileSystem(fails: (path: string) => boolean): LocalResetFileSystem {
  return {
    exists: existsSync,
    readdir: (path) => readdirSync(path),
    readFile: (path) => readFileSync(path, "utf8"),
    remove: (path) => {
      if (fails(path)) throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${path}'`), { code: "EBUSY" });
      rmSync(path, { recursive: true, force: true });
    },
    writeMarker: (path, content) => writeFileSync(path, content),
    isLink: (path) => folderGoesThroughLink(path),
    isShared: (path) => {
      try {
        const stat = lstatSync(path);
        return !(stat.isFile() && stat.nlink === 1);
      } catch (cause) {
        return (cause as NodeJS.ErrnoException).code !== "ENOENT";
      }
    },
  };
}
