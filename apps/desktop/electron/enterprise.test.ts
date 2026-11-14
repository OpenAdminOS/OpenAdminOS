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
  EnterpriseLicenceFileError,
  MAX_TIMER_DELAY_MS,
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

  const cases: Array<[string, string | undefined, string]> = [
    ["no licence", undefined, "no-licence"],
    ["an empty licence file", "\n", "no-licence"],
    ["a malformed licence", "not-a-licence", "malformed"],
    ["a tampered licence", `${licence().split(".")[0]}x.${licence().split(".")[1]}`, "signature"],
    ["a licence for another key", signLicence({ v: 1 }, generateKeyPairSync("ed25519").privateKey), "signature"],
    ["a licence that is not valid yet", licence({ notBefore: NOW_SECONDS + DAY }), "not-yet-valid"],
    ["a licence past its grace period", licence({ expiresAt: NOW_SECONDS - 20 * DAY, graceSeconds: 14 * DAY }), "expired"],
  ];

  for (const [name, token, expected] of cases) {
    it(`runs no module code and makes no network call with ${name}`, async () => {
      const before = process.getActiveResourcesInfo().sort();
      const { module, seen } = trackingModule();
      const { options, ipc, storage, calls } = harness({ token, module });
      const runtime = await loadEnterprise(options);
      const after = process.getActiveResourcesInfo().sort();

      const outcome = runtime.outcome;
      assert.equal(outcome.kind === "licence-refused" ? outcome.reason : outcome.kind, expected);
      assert.deepEqual(runtime.status(), { active: false });
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
    assert.equal(runtime.outcome.kind, "licence-refused");
    assert.equal(calls.resolve, 0);
    assert.match(logs[0]?.message ?? "", /could not be read/);
  });
});

describe("loadEnterprise with a valid licence", () => {
  it("uses the no-op stub when the private module is not installed", async () => {
    const { options, ipc, calls } = harness({ token: licence() });
    const runtime = await loadEnterprise(options);
    assert.deepEqual(runtime.outcome, { kind: "module-off", source: "stub" });
    assert.deepEqual(runtime.status(), { active: false });
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
      settingsSections: [{ id: "team", title: "Team", description: "Approvals and audit." }],
    });
    assert.equal(changes.length, 2);
    assert.equal(seen.host?.entitlement().state, "active");

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

  it("turns the module off when the grace period ends during the session", async () => {
    const graceEndsAt = (NOW_SECONDS + 3 * DAY) * 1000 + 30 * 24 * 60 * 60 * 1000;
    let now = NOW;
    const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
    const { module, seen } = trackingModule();
    const changes: number[] = [];
    const { options, ipc } = harness({
      // Expires in three days, with a 30 day grace period: past 2^31-1 ms.
      token: licence({ expiresAt: NOW_SECONDS + 3 * DAY, graceSeconds: 30 * DAY }),
      module,
      now: () => now,
      onChange: () => changes.push(1),
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
    assert.equal(timers.length, 1);
    assert.equal(timers[0]?.delay, MAX_TIMER_DELAY_MS);

    // The first step ends before the grace period does: wait again.
    now += MAX_TIMER_DELAY_MS;
    timers[0]?.callback();
    assert.equal(timers.length, 2);
    assert.equal(timers[1]?.delay, graceEndsAt - now);
    assert.equal(seen.deactivated, 0);
    assert.equal(runtime.status().active, true);

    // Cross graceEndsAt.
    now = graceEndsAt;
    timers[1]?.callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(seen.deactivated, 1);
    assert.equal(ipc.handlers.size, 0);
    assert.equal(runtime.status().active, false);
    assert.ok(changes.length >= 1);
    assert.equal(timers.length, 2);
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
    assert.deepEqual(cancelled, [true]);
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
      assert.equal(created[0]?.delay, MAX_TIMER_DELAY_MS);
      assert.equal(created[0]?.unref, true);
      await runtime.deactivate();
      assert.equal(created[0]?.cleared, true);
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
    assert.deepEqual(runtime.status(), { active: false });
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
    assert.equal(ipc.handlers.size, 0);
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
