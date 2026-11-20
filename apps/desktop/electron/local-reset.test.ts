import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { TenantRecord } from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

import {
  LOCAL_RESET_MARKER,
  LocalResetRequestError,
  localResetLeftoverPaths,
  localResetRemovalPlan,
  MACOS_SAFE_STORAGE_ACCOUNT,
  MACOS_SAFE_STORAGE_SERVICE,
  readLocalResetMarker,
  requestLocalReset,
  runPendingLocalReset,
  writeLocalResetMarker,
  type CommandResult,
  type LocalResetFileSystem,
  type LocalResetMarker,
  type LocalResetRequestSteps,
} from "./local-reset.js";
import { AppStateStore } from "./state.js";
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
  writeFileSync(join(dir, LOCAL_RESET_MARKER), JSON.stringify(marker));
}

function recordingRun(results: Record<string, CommandResult[]> = {}): { run: (file: string, args: string[]) => CommandResult; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: (file, args) => {
      calls.push([file, ...args]);
      return results[file]?.shift() ?? { status: 0 };
    },
  };
}

const keychainNotFound: CommandResult = { status: 44 };

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

  it("keeps the audit anchor while the database could not be removed, and keeps the marker", async () => {
    const dir = await tempDir();
    try {
      seedDataFolder(dir);
      const fs = failingFileSystem((path) => path.endsWith("openadminos.db"));
      const report = runPendingLocalReset({ userDataDir: dir, packaged: true, platform: "darwin", home: dir, env: {}, fs, run: recordingRun().run });
      assert.equal(report?.status, "incomplete");
      assert.deepEqual(report?.failed, [{ item: "openadminos.db", reason: "the file is in use by another program or cannot be changed" }]);
      assert.ok(existsSync(join(dir, "openadminos.db")));
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
      const report = runPendingLocalReset({ userDataDir: dir, packaged: false, platform: "linux", home: dir, env: {}, fs });
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
        platform: "linux",
        home: dir,
        env: {},
        fs: failingFileSystem((path) => path.endsWith("connectors")),
      });
      assert.equal(first?.status, "incomplete");
      assert.ok(existsSync(join(dir, LOCAL_RESET_MARKER)));
      assert.ok(existsSync(join(dir, "connectors", "secrets", "file")));
      assert.ok(existsSync(join(dir, "openadminos.db-audit-anchor.json")));

      const second = runPendingLocalReset({ userDataDir: dir, packaged: false, platform: "linux", home: dir, env: {} });
      assert.equal(second?.status, "completed");
      assert.deepEqual(readdirSync(dir).sort(), ["SingletonLock", "policy.json"]);
      assert.equal(runPendingLocalReset({ userDataDir: dir, packaged: false, platform: "linux", home: dir, env: {} }), undefined);
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
      assert.deepEqual(calls, [
        ["/usr/bin/security", "delete-generic-password", "-s", MACOS_SAFE_STORAGE_SERVICE, "-a", MACOS_SAFE_STORAGE_ACCOUNT],
        ["/usr/bin/security", "delete-generic-password", "-s", MACOS_SAFE_STORAGE_SERVICE, "-a", MACOS_SAFE_STORAGE_ACCOUNT],
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
      const keychainCalls = () => calls.filter((call) => call[0] === "/usr/bin/security").length;
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
      const report = runPendingLocalReset({ userDataDir: dir, packaged: false, platform: "linux", home: dir, env: {}, fs });
      assert.equal(report?.status, "incomplete");
      assert.deepEqual(report?.failed, [{ item: "Session Storage", reason: "it was created again during the reset" }]);
      assert.ok(existsSync(join(dir, LOCAL_RESET_MARKER)));
      const second = runPendingLocalReset({ userDataDir: dir, packaged: false, platform: "linux", home: dir, env: {} });
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
      const report = runPendingLocalReset({ userDataDir: dir, packaged: false, platform: "linux", home: dir, env: {} });
      assert.deepEqual(report?.warnings, [{ item: "Background scheduler", reason: "launchctl failed" }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats a marker it cannot parse as a pending reset", async () => {
    const dir = await tempDir();
    try {
      writeFileSync(join(dir, LOCAL_RESET_MARKER), "{not json");
      writeFileSync(join(dir, "tokens.bin"), "x");
      const report = runPendingLocalReset({ userDataDir: dir, packaged: false, platform: "linux", home: dir, env: {} });
      assert.equal(report?.status, "completed");
      assert.deepEqual(readdirSync(dir), []);
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
      forgetSignIns: async () => { log.push("sign-ins"); return []; },
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

  it("writes the marker first, then signs out and turns off background work", async () => {
    const log: string[] = [];
    const { marker } = await requestLocalReset(LOCAL_RESET_PHRASE, steps(log));
    assert.deepEqual(log, ["check", "marker:0", "sign-ins", "scheduler", "login-item"]);
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

  it("goes on past failed sign-out and scheduler steps and records them in the marker", async () => {
    const log: string[] = [];
    const { marker } = await requestLocalReset(
      LOCAL_RESET_PHRASE,
      steps(log, {
        forgetSignIns: async () => [{ item: "Microsoft sign-in for Contoso", reason: "cache locked" }],
        disableScheduler: async () => { throw new Error("launchctl failed"); },
      }),
    );
    assert.deepEqual(log, ["check", "marker:0", "login-item", "marker:2"]);
    assert.deepEqual(marker.requestWarnings, [
      { item: "Microsoft sign-in for Contoso", reason: "cache locked" },
      { item: "Background scheduler", reason: "launchctl failed" },
    ]);
  });
});

describe("local reset: end to end with the store", () => {
  it("relaunches into first run with no tenants, tokens or secrets, a fresh database and an intact audit log", async () => {
    const dir = await tempDir();
    const removedAccounts: string[] = [];
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
        writeMarker: (marker) => writeLocalResetMarker(dir, marker),
        forgetSignIns: async () => {
          const problems = await store.forgetAllSignIns();
          removedAccounts.push(...problems.map((problem) => problem.item));
          return problems;
        },
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
      assert.deepEqual(removedAccounts, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
      // Now recorded as applying, until the apply finishes.
      const blocker = await store.beginLocalReset();
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
  };
}
