import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import dgram from "node:dgram";
import dns from "node:dns";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  LICENCE_SIGNING_CONTEXT,
  EnterpriseInterfaceVersionError,
  type EnterpriseHost,
  type EnterpriseIpcRegistrar,
  type EnterpriseLogLevel,
  type EnterpriseStorageBackend,
} from "@openadminos/enterprise";

import {
  DEFAULT_TEAM_STATUS_LABEL,
  ENTERPRISE_LICENCE_FILE_MAX_BYTES,
  ENTERPRISE_MODULE_SPECIFIER,
  ENTERPRISE_STORAGE_FILE_MAX_BYTES,
  EnterpriseLicenceFileError,
  EnterpriseStorageFileError,
  ENTERPRISE_STOP_TIMEOUT_MS,
  createEnterpriseService,
  ENTERPRISE_CHECK_INTERVAL_MS,
  EnterpriseModuleLoadError,
  enterpriseFiles,
  ipcMainRegistrar,
  loadEnterprise,
  resolveInstalledModule,
  type LoadEnterpriseOptions,
} from "./enterprise.js";

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const NOW_SECONDS = Math.floor(NOW / 1000);
const DAY = 24 * 60 * 60;
const MODULE_URL = "file:///app/node_modules/@openadminos/enterprise-module/dist/index.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

function signLicence(payload: Record<string, unknown>, key: KeyObject = privateKey): string {
  const segment = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${segment}.${sign(null, Buffer.from(LICENCE_SIGNING_CONTEXT + segment, "utf8"), key).toString("base64url")}`;
}

function licence(overrides: Record<string, unknown> = {}): string {
  return signLicence({
    v: 1,
    licenseeId: "org-contoso",
    features: ["approvals"],
    notBefore: NOW_SECONDS - 30 * DAY,
    expiresAt: NOW_SECONDS + 30 * DAY,
    graceSeconds: 14 * DAY,
    ...overrides,
  });
}

class FakeIpc implements EnterpriseIpcRegistrar {
  readonly handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  handleCalls = 0;
  handle(channel: string, listener: (input: unknown) => Promise<unknown>): void {
    this.handleCalls += 1;
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
}

function memoryStorage(): EnterpriseStorageBackend & { reads: number; writes: number } {
  let text: string | undefined;
  const backend = {
    reads: 0,
    writes: 0,
    read: async () => {
      backend.reads += 1;
      return text;
    },
    write: async (next: string) => {
      backend.writes += 1;
      text = next;
    },
  };
  return backend;
}

function harness(overrides: Partial<LoadEnterpriseOptions> & { token?: string | undefined; module?: unknown } = {}) {
  const ipc = new FakeIpc();
  const storage = memoryStorage();
  const logs: Array<{ level: EnterpriseLogLevel; message: string }> = [];
  const calls = { resolve: 0, import: 0 };
  const { token, module, ...rest } = overrides;
  const options: LoadEnterpriseOptions = {
    readLicenceToken: async () => token,
    publicKey: PUBLIC_KEY_PEM,
    now: () => NOW,
    resolveModule: (specifier) => {
      calls.resolve += 1;
      assert.equal(specifier, ENTERPRISE_MODULE_SPECIFIER);
      return "module" in overrides ? MODULE_URL : undefined;
    },
    importModule: async (url) => {
      calls.import += 1;
      assert.equal(url, MODULE_URL);
      return module;
    },
    ipc,
    storage,
    log: (level, message) => logs.push({ level, message }),
    ...rest,
  };
  return { options, ipc, storage, logs, calls };
}

/** A module that would register everything and open a socket if it ever ran. */
function trackingModule(interfaceVersion = 1) {
  const seen = { activated: 0, deactivated: 0, host: undefined as EnterpriseHost | undefined };
  const module = {
    interfaceVersion,
    activate(host: EnterpriseHost) {
      seen.activated += 1;
      seen.host = host;
      host.registerIpc("team.status", () => ({ ok: true }));
      return {
        deactivate: () => {
          seen.deactivated += 1;
        },
      };
    },
  };
  return { module: { default: module }, seen };
}

describe("loadEnterprise without a valid licence", () => {
  const network: string[] = [];
  const restore: Array<() => void> = [];

  function trap<T extends object, K extends keyof T>(target: T, key: K, label: string): void {
    const original = target[key];
    (target as Record<K, unknown>)[key] = function (this: unknown, ...args: unknown[]) {
      network.push(label);
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
    restore.push(() => {
      (target as Record<K, unknown>)[key] = original;
    });
  }

  beforeEach(() => {
    network.length = 0;
    trap(globalThis, "fetch", "fetch");
    trap(net.Socket.prototype, "connect", "net.Socket.connect");
    trap(net, "createConnection", "net.createConnection");
    trap(tls, "connect", "tls.connect");
    trap(http, "request", "http.request");
    trap(https, "request", "https.request");
    trap(dgram, "createSocket", "dgram.createSocket");
    trap(dns, "lookup", "dns.lookup");
    trap(globalThis, "setInterval", "setInterval");
    trap(globalThis, "setTimeout", "setTimeout");
  });

  afterEach(() => {
    for (const undo of restore.splice(0).reverse()) undo();
  });

  // [name, token, outcome or licence reason, problem shown to the admin]
  const cases: Array<[string, string | undefined, string, string | undefined]> = [
    ["no licence", undefined, "no-licence", undefined],
    ["an empty licence file", "\n", "no-licence", undefined],
    ["a malformed licence", "not-a-licence", "malformed", "licence-malformed"],
    ["a tampered licence", `${licence().split(".")[0]}x.${licence().split(".")[1]}`, "signature", "licence-signature"],
    ["a licence for another key", signLicence({ v: 1 }, generateKeyPairSync("ed25519").privateKey), "signature", "licence-signature"],
    ["a licence that is not valid yet", licence({ notBefore: NOW_SECONDS + DAY }), "not-yet-valid", "licence-not-yet-valid"],
    ["a licence past its grace period", licence({ expiresAt: NOW_SECONDS - 20 * DAY, graceSeconds: 14 * DAY }), "expired", "licence-expired"],
  ];

  for (const [name, token, expected, problemReason] of cases) {
    it(`runs no module code and makes no network call with ${name}`, async () => {
      const before = process.getActiveResourcesInfo().sort();
      const { module, seen } = trackingModule();
      const { options, ipc, storage, calls } = harness({ token, module });
      const runtime = await loadEnterprise(options);
      const after = process.getActiveResourcesInfo().sort();

      const outcome = runtime.outcome;
      assert.equal(outcome.kind === "licence-refused" ? outcome.reason : outcome.kind, expected);
      const status = runtime.status();
      assert.equal(status.active, false);
      if (problemReason === undefined) {
        // No licence is the free app: nothing to say.
        assert.deepEqual(status, { active: false });
      } else {
        assert.ok(!status.active && status.problem);
        assert.equal(status.problem.reason, problemReason);
        assert.match(status.problem.message, /\. (Install|Check) .*, then restart OpenAdminOS\.$/);
      }
      assert.equal(calls.resolve, 0, "the module was resolved");
      assert.equal(calls.import, 0, "the module was imported");
      assert.equal(seen.activated, 0);
      assert.equal(ipc.handleCalls, 0);
      assert.equal(storage.reads + storage.writes, 0);
      assert.deepEqual(network, []);
      assert.deepEqual(after, before, "a timer, socket or handle was left open");
      await runtime.deactivate();
    });
  }

  it("logs a refused licence but stays quiet when there is none", async () => {
    const none = harness({ token: undefined });
    await loadEnterprise(none.options);
    assert.deepEqual(none.logs, []);
    const refused = harness({ token: "not-a-licence" });
    await loadEnterprise(refused.options);
    assert.equal(refused.logs.length, 1);
    assert.equal(refused.logs[0]?.level, "warn");
    assert.match(refused.logs[0]?.message ?? "", /licence was refused/);
  });

  it("logs a licence file it cannot read and keeps the app working", async () => {
    const { options, logs, calls } = harness({
      readLicenceToken: async () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    });
    const runtime = await loadEnterprise(options);
    assert.deepEqual(runtime.outcome, {
      kind: "licence-refused",
      reason: "unreadable",
      message: "The licence file could not be read (EACCES: permission denied).",
    });
    assert.deepEqual(runtime.status(), {
      active: false,
      problem: {
        reason: "licence-unreadable",
        message: "The licence file could not be read (EACCES: permission denied). Check that the file is readable by your account, then restart OpenAdminOS.",
      },
    });
    assert.equal(calls.resolve, 0);
    assert.match(logs[0]?.message ?? "", /could not be read/);
  });

  it("reports a licence file over the size limit as malformed, not missing", async () => {
    const { options } = harness({
      readLicenceToken: async () => {
        throw new EnterpriseLicenceFileError("too-large", "The licence file is 99999 bytes; a licence is at most 8192 bytes.");
      },
    });
    const runtime = await loadEnterprise(options);
    assert.ok(runtime.outcome.kind === "licence-refused" && runtime.outcome.reason === "malformed");
    const status = runtime.status();
    assert.ok(!status.active && status.problem?.reason === "licence-malformed");
  });
});

describe("loadEnterprise with a valid licence", () => {
  it("uses the no-op stub when the private module is not installed", async () => {
    const { options, ipc, calls } = harness({ token: licence() });
    const runtime = await loadEnterprise(options);
    assert.deepEqual(runtime.outcome, { kind: "module-off", source: "stub" });
    assert.deepEqual(runtime.status(), {
      active: false,
      problem: {
        reason: "module-missing",
        message:
          "A team features licence is installed, but this build of OpenAdminOS does not include team features. Install the official build from openadminos.com, then restart OpenAdminOS.",
      },
    });
    assert.equal(calls.resolve, 1);
    assert.equal(calls.import, 0);
    assert.equal(ipc.handleCalls, 0);
  });

  it("activates a module built for this interface version", async () => {
    const { module, seen } = trackingModule();
    const changes: number[] = [];
    const { options, ipc } = harness({ token: licence(), module, onChange: () => changes.push(1) });
    const runtime = await loadEnterprise(options);
    assert.deepEqual(runtime.outcome, { kind: "active" });
    assert.equal(seen.activated, 1);
    assert.deepEqual([...ipc.handlers.keys()], ["openadminos-enterprise:team.status"]);
    assert.deepEqual(runtime.status(), { active: true, label: DEFAULT_TEAM_STATUS_LABEL, settingsSections: [] });

    seen.host?.setStatusContribution({ label: "Team service · Frankfurt · end-to-end encrypted", detail: "Payloads are ciphertext." });
    seen.host?.registerSettingsSection({ id: "team", title: "Team", description: "Approvals and audit." });
    assert.deepEqual(runtime.status(), {
      active: true,
      label: "Team service · Frankfurt · end-to-end encrypted",
      detail: "Payloads are ciphertext.",
      settingsSections: [{ id: "team", title: "Team", description: "Approvals and audit.", revision: 1 }],
    });
    assert.equal(changes.length, 2);
    assert.equal(seen.host?.entitlement().state, "active");
    // Declarative UI reaches the window in the status, checked.
    seen.host?.updateSettingsSection("team", { elements: [{ type: "status", label: "Team", value: "Joined", tone: "success" }] });
    seen.host?.registerUiAction("team.schedule", async () => ({ notice: { type: "notice", tone: "success", title: "Moved", message: "Moved." } }));
    seen.host?.setScheduleTargets({ action: "team.schedule", targets: [{ id: "mini-pc", label: "Office mini PC" }] });
    const status = runtime.status();
    assert.ok(status.active);
    assert.deepEqual(status.active ? status.settingsSections[0]?.body : undefined, { elements: [{ type: "status", label: "Team", value: "Joined", tone: "success" }] });
    assert.deepEqual(status.active ? status.scheduleTargets : undefined, { action: "team.schedule", targets: [{ id: "mini-pc", label: "Office mini PC" }] });

    await runtime.deactivate();
    await runtime.deactivate();
    assert.equal(seen.deactivated, 1);
    assert.equal(ipc.handlers.size, 0);
    assert.deepEqual(runtime.status(), { active: false });
  });

  it("activates within the grace period and reports it", async () => {
    const { module, seen } = trackingModule();
    const { options } = harness({ token: licence({ expiresAt: NOW_SECONDS - DAY, graceSeconds: 7 * DAY }), module });
    const runtime = await loadEnterprise(options);
    assert.equal(runtime.outcome.kind, "active");
    assert.equal(seen.host?.entitlement().state, "grace");
  });

  /** An active runtime on a fake clock with a recorded timer list. */
  async function clockHarness(token: string) {
    const clock = { now: NOW };
    const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
    const { module, seen } = trackingModule();
    const changes: string[] = [];
    const { options, ipc } = harness({
      token,
      module,
      now: () => clock.now,
      onChange: () => changes.push("changed"),
      setTimer: (callback, delay) => {
        const timer = { callback, delay, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    });
    const runtime = await loadEnterprise(options);
    assert.equal(runtime.outcome.kind, "active");
    const checks = () => timers.filter((timer) => timer.delay !== ENTERPRISE_STOP_TIMEOUT_MS);
    const fireLatestCheck = () => {
      const latest = checks().at(-1);
      assert.ok(latest && !latest.cancelled, "no pending check timer");
      latest.callback();
    };
    return { clock, timers, checks, fireLatestCheck, seen, changes, ipc, runtime };
  }

  it("checks the licence window every 15 minutes and turns the module off at the grace end", async () => {
    const graceEndsAt = (NOW_SECONDS + DAY + DAY) * 1000;
    const t = await clockHarness(licence({ expiresAt: NOW_SECONDS + DAY, graceSeconds: DAY }));
    assert.deepEqual(t.checks().map((timer) => timer.delay), [ENTERPRISE_CHECK_INTERVAL_MS]);

    // A step inside the window schedules the next one, no longer than 15 minutes.
    t.clock.now += ENTERPRISE_CHECK_INTERVAL_MS;
    t.fireLatestCheck();
    assert.equal(t.checks().length, 2);
    assert.equal(t.checks()[1]?.delay, ENTERPRISE_CHECK_INTERVAL_MS);
    assert.equal(t.ipc.handlers.size, 1);

    // Close to the end the step shortens to land on graceEndsAt.
    t.clock.now = graceEndsAt - 60_000;
    t.fireLatestCheck();
    assert.equal(t.checks().at(-1)?.delay, 60_000);

    t.clock.now = graceEndsAt;
    t.fireLatestCheck();
    // Synchronously, without a status() call: handlers gone, renderer told.
    assert.equal(t.ipc.handlers.size, 0);
    assert.deepEqual(t.changes, ["changed"]);
    const status = t.runtime.status();
    assert.ok(!status.active && status.problem?.reason === "licence-expired");
    assert.match(status.problem.message, /grace period ended .*Install a renewed licence, then restart OpenAdminOS\.$/);
    // No further check is scheduled; the remaining timer only bounds deactivate.
    assert.equal(t.checks().length, 3);
    assert.ok(t.timers.some((timer) => timer.delay === ENTERPRISE_STOP_TIMEOUT_MS));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(t.seen.deactivated, 1);
  });

  it("follows the system clock moved past the grace end at the next timer step", async () => {
    // A licence valid for a year: the pending step is 15 minutes, not months.
    const t = await clockHarness(licence({ expiresAt: NOW_SECONDS + 365 * DAY, graceSeconds: 14 * DAY }));
    assert.equal(t.checks()[0]?.delay, ENTERPRISE_CHECK_INTERVAL_MS);
    t.clock.now = (NOW_SECONDS + 400 * DAY) * 1000;
    t.fireLatestCheck();
    assert.equal(t.ipc.handlers.size, 0);
    assert.deepEqual(t.changes, ["changed"]);
    const status = t.runtime.status();
    assert.ok(!status.active && status.problem?.reason === "licence-expired");
  });

  it("follows the system clock moved back before notBefore at the next timer step", async () => {
    const t = await clockHarness(licence({ notBefore: NOW_SECONDS - DAY }));
    t.clock.now = NOW - 3 * DAY * 1000;
    t.fireLatestCheck();
    assert.equal(t.ipc.handlers.size, 0);
    assert.deepEqual(t.changes, ["changed"]);
    const status = t.runtime.status();
    assert.ok(!status.active && status.problem?.reason === "licence-not-yet-valid");
  });

  it("checks again at once on recheck, as on resume from sleep", async () => {
    const t = await clockHarness(licence({ expiresAt: NOW_SECONDS + DAY, graceSeconds: 0 }));
    t.runtime.recheck();
    assert.equal(t.ipc.handlers.size, 1);
    assert.deepEqual(t.changes, []);
    t.clock.now = (NOW_SECONDS + 2 * DAY) * 1000;
    t.runtime.recheck();
    assert.equal(t.ipc.handlers.size, 0);
    assert.deepEqual(t.changes, ["changed"]);
    const status = t.runtime.status();
    assert.ok(!status.active && status.problem?.reason === "licence-expired");
    // The pending check timer was cancelled.
    assert.equal(t.checks()[0]?.cancelled, true);
    t.runtime.recheck();
    assert.deepEqual(t.changes, ["changed"]);
  });

  it("does not activate when the licence lapses while the module is imported", async () => {
    const graceEndsAt = (NOW_SECONDS + 2 * DAY) * 1000;
    let now = NOW;
    const { module, seen } = trackingModule();
    const timers: number[] = [];
    const { options, ipc, calls } = harness({
      token: licence({ expiresAt: NOW_SECONDS + DAY, graceSeconds: DAY }),
      module,
      now: () => now,
      setTimer: (_callback, delay) => {
        timers.push(delay);
        return () => undefined;
      },
    });
    const importModule = options.importModule;
    const runtime = await loadEnterprise({
      ...options,
      importModule: async (url) => {
        const imported = await importModule(url);
        now = graceEndsAt;
        return imported;
      },
    });
    assert.equal(calls.import, 1);
    assert.equal(seen.activated, 0);
    assert.equal(ipc.handleCalls, 0);
    assert.deepEqual(timers, []);
    assert.ok(runtime.outcome.kind === "licence-refused" && runtime.outcome.reason === "expired");
    const status = runtime.status();
    assert.ok(!status.active && status.problem?.reason === "licence-expired");
  });

  it("says not yet valid, not expired, when the clock moves back before notBefore", async () => {
    let now = NOW;
    const { module, seen } = trackingModule();
    const { options, ipc } = harness({
      token: licence({ notBefore: NOW_SECONDS - DAY }),
      module,
      now: () => now,
      setTimer: () => () => undefined,
    });
    const runtime = await loadEnterprise(options);
    assert.equal(runtime.status().active, true);
    now = NOW - 2 * DAY * 1000;
    const status = runtime.status();
    assert.ok(!status.active && status.problem?.reason === "licence-not-yet-valid");
    assert.match(status.problem.message, /not valid before .*Check the date and time on this device, then restart OpenAdminOS\.$/);
    assert.equal(ipc.handlers.size, 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(seen.deactivated, 1);
  });

  it("revokes the module at the grace end even when its deactivate never resolves", async () => {
    let now = NOW;
    const timers: Array<{ callback: () => void; delay: number }> = [];
    let host: EnterpriseHost | undefined;
    let deactivateCalls = 0;
    const module = {
      default: {
        interfaceVersion: 1,
        activate(given: EnterpriseHost) {
          host = given;
          given.registerIpc("team.status", () => null);
          return {
            deactivate: () => {
              deactivateCalls += 1;
              return new Promise<void>(() => undefined);
            },
          };
        },
      },
    };
    const changes: string[] = [];
    const { options, ipc, logs } = harness({
      token: licence({ expiresAt: NOW_SECONDS + DAY, graceSeconds: DAY }),
      module,
      now: () => now,
      onChange: () => changes.push("changed"),
      setTimer: (callback, delay) => {
        timers.push({ callback, delay });
        return () => undefined;
      },
    });
    const runtime = await loadEnterprise(options);
    assert.equal(runtime.status().active, true);

    now = (NOW_SECONDS + 2 * DAY) * 1000;
    timers[0]?.callback();
    // Synchronously, before deactivate settles: revoked and announced.
    assert.equal(ipc.handlers.size, 0);
    assert.deepEqual(changes, ["changed"]);
    const status = runtime.status();
    assert.ok(!status.active && status.problem?.reason === "licence-expired");
    assert.throws(() => host?.registerIpc("again", () => null), /turned off/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(deactivateCalls, 1);

    // The bound lets go of the hung deactivate and says so.
    const bound = timers.find((timer) => timer.delay === ENTERPRISE_STOP_TIMEOUT_MS);
    assert.ok(bound);
    bound.callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(logs.some((entry) => /did not stop in time/.test(entry.message)));
    await runtime.deactivate();
    assert.equal(deactivateCalls, 1);
  });

  it("turns the module off from status() when the clock passed the grace end before the timer fired", async () => {
    let now = NOW;
    const cancelled: boolean[] = [];
    const { module, seen } = trackingModule();
    const { options, ipc } = harness({
      token: licence({ expiresAt: NOW_SECONDS + DAY, graceSeconds: DAY }),
      module,
      now: () => now,
      setTimer: () => () => cancelled.push(true),
    });
    const runtime = await loadEnterprise(options);
    assert.equal(runtime.status().active, true);
    now = NOW + 2 * DAY * 1000;
    assert.equal(runtime.status().active, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(seen.deactivated, 1);
    assert.equal(ipc.handlers.size, 0);
    // The expiry timer, then the bound on deactivate once it settled.
    assert.deepEqual(cancelled, [true, true]);
  });

  it("uses an unref'd timer that is cleared on deactivate", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const created: Array<{ delay: number | undefined; unref: boolean; cleared: boolean; timer: ReturnType<typeof setTimeout> }> = [];
    globalThis.setTimeout = ((callback: () => void, delay?: number) => {
      const timer = realSetTimeout(callback, delay);
      const entry = { delay, unref: false, cleared: false, timer };
      const unref = timer.unref.bind(timer);
      timer.unref = () => {
        entry.unref = true;
        return unref();
      };
      created.push(entry);
      return timer;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
      const entry = created.find((candidate) => candidate.timer === timer);
      if (entry) entry.cleared = true;
      realClearTimeout(timer);
    }) as typeof clearTimeout;
    try {
      const { module } = trackingModule();
      const { options } = harness({ token: licence(), module });
      const runtime = await loadEnterprise(options);
      assert.equal(created.length, 1);
      assert.equal(created[0]?.delay, ENTERPRISE_CHECK_INTERVAL_MS);
      assert.equal(created[0]?.unref, true);
      await runtime.deactivate();
      assert.equal(created[0]?.cleared, true);
      // deactivate is bounded by a second timer, cleared once it settles.
      assert.equal(created[1]?.delay, ENTERPRISE_STOP_TIMEOUT_MS);
      assert.equal(created[1]?.unref, true);
      assert.equal(created[1]?.cleared, true);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  it("refuses a module built for another interface version and keeps the app working", async () => {
    const { module, seen } = trackingModule(2);
    const { options, ipc, logs } = harness({ token: licence(), module });
    const runtime = await loadEnterprise(options);
    assert.equal(runtime.outcome.kind, "failed");
    assert.ok(runtime.outcome.kind === "failed" && runtime.outcome.error instanceof EnterpriseInterfaceVersionError);
    assert.equal(seen.activated, 0);
    assert.equal(ipc.handleCalls, 0);
    assert.deepEqual(runtime.status(), {
      active: false,
      problem: {
        reason: "module-version",
        message:
          "The team features in this build do not match this version of OpenAdminOS. Install the official build from openadminos.com, then restart OpenAdminOS.",
      },
    });
    assert.equal(logs.at(-1)?.level, "error");
    assert.match(logs.at(-1)?.message ?? "", /EnterpriseInterfaceVersionError: .*interface version 2/);
  });

  it("names an import failure", async () => {
    const { options, logs } = harness({
      token: licence(),
      module: undefined,
      importModule: async () => {
        throw new Error("Cannot find package 'left-pad'");
      },
    });
    const runtime = await loadEnterprise(options);
    assert.ok(runtime.outcome.kind === "failed" && runtime.outcome.error instanceof EnterpriseModuleLoadError);
    assert.match(logs.at(-1)?.message ?? "", /EnterpriseModuleLoadError: .*left-pad/);
    const status = runtime.status();
    assert.ok(!status.active && status.problem?.reason === "module-load");
    assert.equal(
      status.problem.message,
      "The team features module could not be loaded: Cannot find package 'left-pad'. Install the official build from openadminos.com again, then restart OpenAdminOS.",
    );
  });

  it("refuses an export that is not a module", async () => {
    for (const module of [undefined, null, 5, { default: { interfaceVersion: 1 } }, { activate: () => undefined }]) {
      const { options } = harness({ token: licence(), module });
      const runtime = await loadEnterprise(options);
      assert.ok(runtime.outcome.kind === "failed" && runtime.outcome.error instanceof EnterpriseModuleLoadError);
    }
  });

  it("removes what a module registered when it throws while activating", async () => {
    const module = {
      default: {
        interfaceVersion: 1,
        activate(host: EnterpriseHost) {
          host.registerIpc("half", () => null);
          throw new Error("boom");
        },
      },
    };
    const { options, ipc } = harness({ token: licence(), module });
    const runtime = await loadEnterprise(options);
    assert.ok(runtime.outcome.kind === "failed" && runtime.outcome.error instanceof EnterpriseModuleLoadError);
    assert.equal(ipc.handlers.size, 0);
    const status = runtime.status();
    assert.ok(!status.active && status.problem?.reason === "module-activate");
    assert.equal(
      status.problem.message,
      "The team features module failed to start: boom. Restart OpenAdminOS. If it fails again, report it with Report an issue.",
    );
  });

  it("refuses an async activate and logs its later failure", async () => {
    const module = {
      default: {
        interfaceVersion: 1,
        activate(host: EnterpriseHost) {
          host.registerIpc("early", () => null);
          return Promise.reject(new Error("late failure")) as never;
        },
      },
    };
    const { options, ipc, logs } = harness({ token: licence(), module });
    const runtime = await loadEnterprise(options);
    assert.ok(runtime.outcome.kind === "failed" && runtime.outcome.error instanceof EnterpriseModuleLoadError);
    assert.equal(ipc.handlers.size, 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(logs.some((entry) => /after an async activate/.test(entry.message)));
  });

  it("removes what a module registered when it stays off", async () => {
    const module = {
      default: {
        interfaceVersion: 1,
        activate(host: EnterpriseHost) {
          host.registerIpc("unused", () => null);
          return undefined;
        },
      },
    };
    const { options, ipc } = harness({ token: licence(), module });
    const runtime = await loadEnterprise(options);
    assert.deepEqual(runtime.outcome, { kind: "module-off", source: "module" });
    assert.deepEqual(runtime.status(), { active: false });
    assert.equal(ipc.handlers.size, 0);
  });
});

describe("createEnterpriseService", () => {
  it("stores a delayed startup failure and notifies after the first status read", async () => {
    let fail: (error: Error) => void = () => undefined;
    const notified: string[] = [];
    const logs: string[] = [];
    const service = createEnterpriseService({
      load: () =>
        new Promise<never>((_resolve, reject) => {
          fail = reject;
        }),
      notify: () => notified.push(JSON.stringify(service.status())),
      log: (_level, message) => logs.push(message),
    });
    const started = service.start();
    // The renderer reads first, while loading is still under way.
    assert.deepEqual(service.status(), { active: false });
    assert.deepEqual(notified, []);
    fail(new Error("ENOMEM: out of memory"));
    const runtime = await started;
    assert.equal(runtime.outcome.kind, "failed");
    const status = service.status();
    assert.ok(!status.active && status.problem?.reason === "module-load");
    assert.equal(
      status.problem.message,
      "Team features could not be checked: ENOMEM: out of memory. Restart OpenAdminOS. If it fails again, report it with Report an issue.",
    );
    // The notification came after the runtime was stored, so a read then sees the failure.
    assert.equal(notified.length, 1);
    assert.match(notified[0] ?? "", /module-load/);
    assert.equal(logs.length, 1);
    assert.equal(await service.start(), runtime);
    assert.equal(notified.length, 1);
  });

  it("passes recheck to the runtime once loaded and ignores it before", async () => {
    const rechecks: string[] = [];
    let resolve: (runtime: Parameters<typeof Promise.resolve>[0]) => void = () => undefined;
    const service = createEnterpriseService({
      load: () => new Promise((done) => {
        resolve = done as typeof resolve;
      }),
      notify: () => undefined,
      log: () => undefined,
    });
    const started = service.start();
    service.recheck();
    resolve({
      outcome: { kind: "active" },
      status: () => ({ active: false }),
      recheck: () => rechecks.push("recheck"),
      deactivate: async () => undefined,
    });
    await started;
    service.recheck();
    assert.deepEqual(rechecks, ["recheck"]);
  });

  it("notifies for every outcome", async () => {
    const outcomes = [
      harness({ token: undefined }),
      harness({ token: "not-a-licence" }),
      harness({ token: licence(), module: trackingModule().module }),
    ];
    const expected: Array<Record<string, unknown>> = [];
    for (const { options } of outcomes) {
      let notified = 0;
      let seen: unknown;
      const service = createEnterpriseService({
        load: () => loadEnterprise(options),
        notify: () => {
          notified += 1;
          seen = service.status();
        },
        log: () => undefined,
      });
      await service.start();
      assert.equal(notified, 1);
      expected.push(seen as Record<string, unknown>);
    }
    assert.deepEqual(expected[0], { active: false });
    assert.equal((expected[1]?.problem as { reason?: string } | undefined)?.reason, "licence-malformed");
    assert.equal(expected[2]?.active, true);
  });
});

describe("enterprise wiring", () => {
  it("does not find the private module in a build from this repository", () => {
    assert.equal(resolveInstalledModule(ENTERPRISE_MODULE_SPECIFIER, (specifier) => import.meta.resolve(specifier)), undefined);
    assert.throws(() =>
      resolveInstalledModule("x", () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }),
    );
  });

  it("passes only the input to module handlers and checks the sender", async () => {
    const registered = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const senders: unknown[] = [];
    const registrar = ipcMainRegistrar(
      {
        handle: (channel, listener) => registered.set(channel, listener),
        removeHandler: (channel) => registered.delete(channel),
      },
      (event: never) => {
        senders.push(event);
        if ((event as { trusted?: boolean }).trusted !== true) throw new Error("untrusted sender");
      },
    );
    const received: unknown[][] = [];
    registrar.handle("openadminos-enterprise:x", async (...args: unknown[]) => {
      received.push(args);
      return "ok";
    });
    const event = { trusted: true, sender: { session: "cookies" } };
    assert.equal(await registered.get("openadminos-enterprise:x")?.(event, { a: 1 }, "extra"), "ok");
    assert.deepEqual(received, [[{ a: 1 }]]);
    assert.throws(() => registered.get("openadminos-enterprise:x")?.({ trusted: false }, {}), /untrusted sender/);
    assert.equal(senders.length, 2);
    registrar.removeHandler("openadminos-enterprise:x");
    assert.equal(registered.size, 0);
  });

  it("reads the licence and keeps module storage under the user data folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-enterprise-"));
    try {
      const files = enterpriseFiles(dir);
      assert.equal(await files.readLicenceToken(), undefined);
      assert.equal(await files.storage.read(), undefined);
      await files.storage.write('{"team.id":"team-1"}');
      assert.equal(await readFile(join(dir, "enterprise", "storage.json"), "utf8"), '{"team.id":"team-1"}');
      assert.equal(await files.storage.read(), '{"team.id":"team-1"}');
      await mkdir(join(dir, "enterprise"), { recursive: true });
      await writeFile(join(dir, "enterprise", "licence.token"), "token-text\n");
      assert.equal(await files.readLicenceToken(), "token-text\n");
      await writeFile(join(dir, "enterprise", "licence.token"), "x".repeat(ENTERPRISE_LICENCE_FILE_MAX_BYTES));
      assert.equal((await files.readLicenceToken())?.length, ENTERPRISE_LICENCE_FILE_MAX_BYTES);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a storage file over the size limit, or a path that is not a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-enterprise-"));
    try {
      const files = enterpriseFiles(dir);
      const path = join(dir, "enterprise", "storage.json");
      await mkdir(join(dir, "enterprise"), { recursive: true });
      await writeFile(path, "x".repeat(ENTERPRISE_STORAGE_FILE_MAX_BYTES));
      assert.equal((await files.storage.read())?.length, ENTERPRISE_STORAGE_FILE_MAX_BYTES);
      await writeFile(path, "x".repeat(ENTERPRISE_STORAGE_FILE_MAX_BYTES + 1));
      await assert.rejects(files.storage.read(), (error: unknown) => error instanceof EnterpriseStorageFileError && error.code === "too-large");
      await rm(path);
      await mkdir(path);
      await assert.rejects(files.storage.read(), (error: unknown) => error instanceof EnterpriseStorageFileError && error.code === "not-a-file");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a licence file over the size limit, or a path that is not a file, without reading it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-enterprise-"));
    try {
      const files = enterpriseFiles(dir);
      await mkdir(join(dir, "enterprise"), { recursive: true });
      await writeFile(join(dir, "enterprise", "licence.token"), "x".repeat(ENTERPRISE_LICENCE_FILE_MAX_BYTES + 1));
      await assert.rejects(files.readLicenceToken(), (error: unknown) => error instanceof EnterpriseLicenceFileError && error.code === "too-large");
      await rm(join(dir, "enterprise", "licence.token"));
      await mkdir(join(dir, "enterprise", "licence.token"));
      await assert.rejects(files.readLicenceToken(), (error: unknown) => error instanceof EnterpriseLicenceFileError && error.code === "not-a-file");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
