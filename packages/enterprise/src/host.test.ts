import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { checkUiReply, currentTargetFor, ENTERPRISE_UI_LIMITS } from "./ui.js";
import {
  ENTERPRISE_LIMITS,
  EnterpriseHostError,
  EnterprisePlacementsFullError,
  checkJson,
  createEnterpriseHost,
  type CreateEnterpriseHostOptions,
  type EnterpriseIpcRegistrar,
  type EnterpriseLogLevel,
  type EnterpriseStorageBackend,
} from "./host.js";
import type { EnterpriseEntitlement, EnterpriseJson, EnterpriseSandboxes } from "./interface.js";

const ENTITLEMENT: EnterpriseEntitlement = Object.freeze({
  state: "active",
  licenseeId: "org-contoso",
  features: Object.freeze(["approvals"]),
  notBefore: 0,
  expiresAt: 2_000_000_000_000,
  graceEndsAt: 2_001_000_000_000,
});

class FakeIpc implements EnterpriseIpcRegistrar {
  readonly handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  handle(channel: string, listener: (input: unknown) => Promise<unknown>): void {
    if (this.handlers.has(channel)) throw new Error(`duplicate ${channel}`);
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
  invoke(channel: string, input: unknown): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler(input);
  }
}

class MemoryStorage implements EnterpriseStorageBackend {
  text: string | undefined;
  writes = 0;
  constructor(text?: string) {
    this.text = text;
  }
  async read(): Promise<string | undefined> {
    return this.text;
  }
  async write(text: string): Promise<void> {
    this.writes += 1;
    this.text = text;
  }
}

function setup(storage = new MemoryStorage()) {
  const ipc = new FakeIpc();
  const logs: Array<{ level: EnterpriseLogLevel; message: string; fields: unknown }> = [];
  let changes = 0;
  const controller = createEnterpriseHost({
    entitlement: () => ENTITLEMENT,
    ipc,
    storage,
    log: (level, message, fields) => logs.push({ level, message, fields }),
    onChange: () => {
      changes += 1;
    },
  });
  return { controller, host: controller.host, ipc, storage, logs, changes: () => changes };
}

function setupWithCapabilities(capabilities: CreateEnterpriseHostOptions["capabilities"], entitlement: () => EnterpriseEntitlement = () => ENTITLEMENT) {
  const logs: Array<{ level: EnterpriseLogLevel; message: string; fields: unknown }> = [];
  const controller = createEnterpriseHost({
    entitlement,
    ipc: new FakeIpc(),
    storage: new MemoryStorage(),
    log: (level, message, fields) => logs.push({ level, message, fields }),
    ...(capabilities ? { capabilities } : {}),
  });
  return { controller, host: controller.host, logs };
}

function assertError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof EnterpriseHostError && error.code === code);
}

async function assertRejects(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof EnterpriseHostError && error.code === code);
}

/** Every value reachable from `root` through own properties and no argument calls. */
async function reachable(root: unknown): Promise<unknown[]> {
  const seen = new Set<unknown>();
  const queue: unknown[] = [root];
  while (queue.length > 0) {
    const value = queue.shift();
    if ((typeof value !== "object" && typeof value !== "function") || value === null || seen.has(value)) continue;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor) queue.push(descriptor.value);
    }
    if (typeof value === "function" && value.length === 0 && value !== root) {
      try {
        queue.push(await (value as () => unknown).call(undefined));
      } catch {
        // A function that needs arguments has nothing to give.
      }
    }
  }
  return [...seen];
}

describe("checkJson", () => {
  it("counts exactly the bytes of the JSON text", () => {
    const values: unknown[] = [
      null,
      true,
      false,
      0,
      -12.5,
      1e21,
      "",
      "plain",
      "quote \" and \\ and \n and \u0001",
      "Zürich 東京 \u{1F600}",
      [],
      [1, [2, [3]], { a: null }],
      {},
      { "key with \"quote\"": ["x", { nested: false }], ü: 1 },
    ];
    for (const value of values) {
      const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
      assert.deepEqual(checkJson(value, bytes, "the value"), value);
      assert.throws(
        () => checkJson(value, bytes - 1, "the value"),
        (error: unknown) => error instanceof EnterpriseHostError && error.code === "limit",
        JSON.stringify(value),
      );
    }
  });

  it("stops walking once the limit is passed", () => {
    let reads = 0;
    const items = Array.from({ length: 1000 }, () => "x".repeat(100));
    const watched = new Proxy(items, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    assert.throws(() => checkJson(watched, 1024, "the value"), (error: unknown) => error instanceof EnterpriseHostError && error.code === "limit");
    assert.ok(reads < 20, `read ${reads} items`);
  });
});

describe("createEnterpriseHost", () => {
  it("exposes only the documented host APIs", () => {
    const { host } = setup();
    assert.deepEqual(Object.keys(host).sort(), [
      "agents",
      "entitlement",
      "interfaceVersion",
      "log",
      "organizations",
      "registerIpc",
      "registerSettingsSection",
      "registerUiAction",
      "sandboxes",
      "setScheduleTargets",
      "setStatusContribution",
      "storage",
      "updateSettingsSection",
    ]);
    assert.deepEqual(Object.keys(host.organizations), ["list"]);
    assert.deepEqual(Object.keys(host.agents), ["readOnlyCatalog"]);
    assert.deepEqual(Object.keys(host.sandboxes).sort(), ["assign", "list", "pair", "status", "sync", "unpair"]);
    assert.deepEqual(Object.keys(host.storage).sort(), ["delete", "get", "keys", "set"]);
    assert.deepEqual(Object.keys(host.log).sort(), ["error", "info", "warn"]);
    assert.equal(host.interfaceVersion, 1);
    assert.equal(host.entitlement(), ENTITLEMENT);
  });

  it("freezes the host and everything reachable from it", async () => {
    const { host } = setup();
    for (const value of await reachable(host)) {
      assert.ok(Object.isFrozen(value), `not frozen: ${String((value as { name?: unknown }).name ?? typeof value)}`);
    }
    assert.throws(() => {
      (host as { registerIpc: unknown }).registerIpc = () => undefined;
    }, TypeError);
    assert.throws(() => {
      (host as unknown as Record<string, unknown>).tokens = {};
    }, TypeError);
    assert.throws(() => {
      (host.storage as { get: unknown }).get = () => undefined;
    }, TypeError);
  });

  it("exposes no tenant tokens, provider credentials or keychain on the host surface", async () => {
    // Secrets the app holds next to the host. None of them are passed in.
    const appSecrets = {
      tenantAccessToken: "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.tenant-token",
      refreshToken: "refresh-token-secret-1",
      providerApiKey: "sk-provider-secret-2",
      keychainPassword: "keychain-password-3",
    };
    const storage = new MemoryStorage(JSON.stringify({ "team.id": "team-1" }));
    const { host, controller } = setup(storage);
    host.setStatusContribution({ label: "Team service · Frankfurt · end-to-end encrypted" });
    host.registerSettingsSection({ id: "team", title: "Team", description: "Approvals and audit for your team." });

    const values = await reachable(host);
    values.push(controller.snapshot());
    const names = new Set<string>();
    for (const value of values) {
      if ((typeof value === "object" || typeof value === "function") && value !== null) {
        for (const key of Reflect.ownKeys(value)) names.add(String(key));
      }
    }
    for (const name of names) {
      assert.doesNotMatch(name, /token|credential|keychain|keytar|secret|password|safeStorage|msal|apiKey|provider|tenant|electron|ipcMain|webContents/i);
    }
    const dump = JSON.stringify(values.filter((value) => typeof value !== "function"));
    for (const secret of Object.values(appSecrets)) {
      assert.ok(!dump.includes(secret));
    }
    // The prototype chain of the host ends at Object.prototype; nothing app specific sits between.
    assert.equal(Object.getPrototypeOf(host), Object.prototype);
    assert.equal(Object.getPrototypeOf(host.storage), Object.prototype);
    assert.equal(Object.getPrototypeOf(host.log), Object.prototype);
  });

  describe("registerIpc", () => {
    it("registers under the fixed prefix and passes validated input only", async () => {
      const { host, ipc, controller } = setup();
      const received: unknown[] = [];
      host.registerIpc("team.status", (input) => {
        received.push(input);
        return { ok: true };
      });
      assert.deepEqual([...ipc.handlers.keys()], ["openadminos-enterprise:team.status"]);
      assert.deepEqual(controller.snapshot().ipcChannels, ["openadminos-enterprise:team.status"]);
      assert.deepEqual(await ipc.invoke("openadminos-enterprise:team.status", { a: [1, "b", null] }), { ok: true });
      assert.deepEqual(received, [{ a: [1, "b", null] }]);
      assert.ok(Object.isFrozen(received[0]));
    });

    it("turns a missing input or reply into null", async () => {
      const { host, ipc } = setup();
      const received: unknown[] = [];
      host.registerIpc("ping", (input) => {
        received.push(input);
      });
      assert.equal(await ipc.invoke("openadminos-enterprise:ping", undefined), null);
      assert.deepEqual(received, [null]);
    });

    it("refuses names outside the allowed pattern", () => {
      const { host } = setup();
      for (const name of ["", "Team", "team:status", "team/status", "../x", "-team", "team..status", "a.b.c.d.e", "x".repeat(49), "openadminos:get-app-state"]) {
        assertError(() => host.registerIpc(name, () => null), "invalid-name");
      }
      assertError(() => host.registerIpc("ok", "not a function" as never), "invalid-value");
    });

    it("refuses duplicates and more than the handler limit", () => {
      const { host } = setup();
      host.registerIpc("one", () => null);
      assertError(() => host.registerIpc("one", () => null), "duplicate");
      for (let i = 1; i < ENTERPRISE_LIMITS.maxIpcHandlers; i += 1) host.registerIpc(`h${i}`, () => null);
      assertError(() => host.registerIpc("too-many", () => null), "limit");
    });

    it("refuses input that is not bounded plain JSON", async () => {
      const { host, ipc } = setup();
      let calls = 0;
      host.registerIpc("echo", (input) => {
        calls += 1;
        return input;
      });
      const channel = "openadminos-enterprise:echo";
      let deep: unknown = 1;
      for (let i = 0; i < ENTERPRISE_LIMITS.maxJsonDepth + 2; i += 1) deep = [deep];
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      await assertRejects(ipc.invoke(channel, "x".repeat(ENTERPRISE_LIMITS.maxIpcInputBytes)), "limit");
      await assertRejects(ipc.invoke(channel, deep), "limit");
      await assertRejects(ipc.invoke(channel, cyclic), "limit");
      await assertRejects(ipc.invoke(channel, { when: new Date() }), "invalid-value");
      await assertRejects(ipc.invoke(channel, new Map()), "invalid-value");
      await assertRejects(ipc.invoke(channel, Number.NaN), "invalid-value");
      await assertRejects(ipc.invoke(channel, () => 1), "invalid-value");
      await assertRejects(ipc.invoke(channel, 10n), "invalid-value");
      assert.equal(calls, 0);
    });

    it("keeps a __proto__ key as plain data", async () => {
      const { host, ipc } = setup();
      const received: unknown[] = [];
      host.registerIpc("echo", (input) => {
        received.push(input);
        return input;
      });
      const input = JSON.parse('{"__proto__":{"admin":true},"name":"x"}') as unknown;
      const reply = await ipc.invoke("openadminos-enterprise:echo", input);
      const seen = received[0] as Record<string, unknown>;
      assert.equal(Object.getPrototypeOf(seen), Object.prototype);
      assert.equal((seen as { admin?: unknown }).admin, undefined);
      assert.ok(Object.hasOwn(seen, "__proto__"));
      assert.equal(JSON.stringify(reply), '{"__proto__":{"admin":true},"name":"x"}');
    });

    it("refuses a reply that is not bounded plain JSON", async () => {
      const { host, ipc } = setup();
      host.registerIpc("big", () => "x".repeat(ENTERPRISE_LIMITS.maxIpcOutputBytes));
      host.registerIpc("date", () => ({ when: new Date() }) as unknown as EnterpriseJson);
      await assertRejects(ipc.invoke("openadminos-enterprise:big", null), "limit");
      await assertRejects(ipc.invoke("openadminos-enterprise:date", null), "invalid-value");
    });

    it("names the handler when it fails and logs the failure", async () => {
      const { host, ipc, logs } = setup();
      host.registerIpc("fails", async () => {
        throw new Error("service said no");
      });
      await assert.rejects(ipc.invoke("openadminos-enterprise:fails", null), /The team feature request fails failed: service said no/);
      assert.equal(logs.at(-1)?.level, "error");
    });
  });

  it("validates settings sections and the status contribution", () => {
    const { host, controller, changes } = setup();
    host.registerSettingsSection({ id: "team", title: "Team", description: "Approvals and audit." });
    assertError(() => host.registerSettingsSection({ id: "team", title: "Again", description: "x" }), "duplicate");
    assertError(() => host.registerSettingsSection({ id: "Bad Id", title: "x", description: "x" }), "invalid-name");
    assertError(() => host.registerSettingsSection({ id: "long", title: "x".repeat(61), description: "x" }), "invalid-value");
    assertError(() => host.registerSettingsSection({ id: "empty", title: "  ", description: "x" }), "invalid-value");
    assertError(() => host.registerSettingsSection(null as never), "invalid-value");
    assertError(() => host.setStatusContribution({ label: "two\nlines" }), "invalid-value");
    assertError(() => host.setStatusContribution({ label: "x".repeat(81) }), "invalid-value");
    assertError(() => host.setStatusContribution({ label: "ok", detail: 5 as never }), "invalid-value");
    host.setStatusContribution({ label: " Team service · Frankfurt · end-to-end encrypted ", detail: "Approvals are end-to-end encrypted." });
    assert.deepEqual(controller.snapshot().status, {
      label: "Team service · Frankfurt · end-to-end encrypted",
      detail: "Approvals are end-to-end encrypted.",
    });
    assert.deepEqual(controller.snapshot().settingsSections, [{ id: "team", title: "Team", description: "Approvals and audit.", revision: 1 }]);
    host.setStatusContribution(undefined);
    assert.equal(controller.snapshot().status, undefined);
    assert.equal(changes(), 3);
    for (let i = 1; i < ENTERPRISE_LIMITS.maxSettingsSections; i += 1) {
      host.registerSettingsSection({ id: `s${i}`, title: "x", description: "x" });
    }
    assertError(() => host.registerSettingsSection({ id: "more", title: "x", description: "x" }), "limit");
  });

  it("keeps module storage in its own namespace with bounds", async () => {
    const storage = new MemoryStorage();
    const { host } = setup(storage);
    assert.equal(await host.storage.get("team.id"), undefined);
    await host.storage.set("team.id", "team-1");
    await host.storage.set("team.members", ["a", "b"]);
    assert.deepEqual(await host.storage.get("team.members"), ["a", "b"]);
    assert.deepEqual(await host.storage.keys(), ["team.id", "team.members"]);
    await host.storage.delete("team.id");
    await host.storage.delete("missing");
    assert.deepEqual(JSON.parse(storage.text ?? "{}"), { "team.members": ["a", "b"] });
    assert.equal(storage.writes, 3);
    await assertRejects(host.storage.get("Bad Key"), "invalid-name");
    await assertRejects(host.storage.set("big", "x".repeat(ENTERPRISE_LIMITS.maxStorageValueBytes)), "limit");
    await assertRejects(host.storage.set("date", new Date() as never), "invalid-value");
    assert.deepEqual(await host.storage.keys(), ["team.members"]);
  });

  it("limits the number of stored keys", async () => {
    const { host } = setup();
    for (let i = 0; i < ENTERPRISE_LIMITS.maxStorageKeys; i += 1) await host.storage.set(`k${i}`, i);
    await assertRejects(host.storage.set("one-more", 1), "limit");
    await host.storage.set("k0", "replaced");
    assert.equal(await host.storage.get("k0"), "replaced");
  });

  it("reports a storage file that is not JSON", async () => {
    const { host } = setup(new MemoryStorage("{not json"));
    await assertRejects(host.storage.keys(), "invalid-value");
  });

  it("refuses a storage file over the size or key limit", async () => {
    const big = setup(new MemoryStorage(JSON.stringify({ blob: "x".repeat(ENTERPRISE_LIMITS.maxStorageBytes) })));
    await assertRejects(big.host.storage.keys(), "limit");
    const many = Object.fromEntries(Array.from({ length: ENTERPRISE_LIMITS.maxStorageKeys + 1 }, (_, i) => [`k${i}`, i]));
    const crowded = setup(new MemoryStorage(JSON.stringify(many)));
    await assertRejects(crowded.host.storage.keys(), "limit");
    const full = Object.fromEntries(Array.from({ length: ENTERPRISE_LIMITS.maxStorageKeys }, (_, i) => [`k${i}`, i]));
    assert.equal((await setup(new MemoryStorage(JSON.stringify(full))).host.storage.keys()).length, ENTERPRISE_LIMITS.maxStorageKeys);
  });

  it("reads storage again after a failed read", async () => {
    const storage = new MemoryStorage(JSON.stringify({ "team.id": "team-1" }));
    let failures = 1;
    const read = storage.read.bind(storage);
    storage.read = async () => {
      if (failures-- > 0) throw new Error("EBUSY: resource busy");
      return read();
    };
    const { host } = setup(storage);
    await assert.rejects(host.storage.keys(), /EBUSY/);
    assert.deepEqual(await host.storage.keys(), ["team.id"]);
  });

  it("prefixes and bounds module log lines", () => {
    const { host, logs } = setup();
    host.log.warn("x".repeat(1000), { count: 2, ok: true, nested: { a: 1 } as never });
    assert.equal(logs[0]?.level, "warn");
    assert.ok(logs[0]?.message.startsWith("enterprise module: "));
    assert.equal(logs[0]?.message.length, "enterprise module: ".length + ENTERPRISE_LIMITS.maxLogMessageLength);
    assert.deepEqual(logs[0]?.fields, { count: 2, ok: true });
  });

  it("refuses IPC requests once the licence has expired", async () => {
    let state: EnterpriseEntitlement["state"] = "grace";
    const ipc = new FakeIpc();
    let calls = 0;
    const { host } = createEnterpriseHost({
      entitlement: () => ({ ...ENTITLEMENT, state }),
      ipc,
      storage: new MemoryStorage(),
      log: () => undefined,
    });
    host.registerIpc("team.status", () => {
      calls += 1;
      return null;
    });
    assert.equal(await ipc.invoke("openadminos-enterprise:team.status", null), null);
    state = "expired";
    await assertRejects(ipc.invoke("openadminos-enterprise:team.status", null), "expired");
    assert.equal(calls, 1);
  });

  it("removes every handler on dispose and refuses later calls", async () => {
    const { host, ipc, controller } = setup();
    host.registerIpc("a", () => null);
    host.registerIpc("b", () => null);
    host.setStatusContribution({ label: "Team features on" });
    const stale = ipc.handlers.get("openadminos-enterprise:a");
    controller.dispose();
    controller.dispose();
    assert.equal(ipc.handlers.size, 0);
    assert.deepEqual(controller.snapshot(), { status: undefined, settingsSections: [], scheduleTargets: undefined, ipcChannels: [] });
    assertError(() => host.registerIpc("c", () => null), "disposed");
    assertError(() => host.setStatusContribution(undefined), "disposed");
    await assertRejects(host.storage.keys(), "disposed");
    await assertRejects(stale?.(null) ?? Promise.resolve(), "disposed");
  });

  it("answers empty or sandboxes-unavailable without the app's capabilities", async () => {
    const { host } = setupWithCapabilities(undefined);
    assert.deepEqual(await host.organizations.list(), []);
    assert.deepEqual(await host.agents.readOnlyCatalog(), []);
    assert.deepEqual(await host.sandboxes.list(), []);
    const paired = await host.sandboxes.pair({ address: "127.0.0.1:7443", code: "x", organizationId: "org-1" });
    assert.equal(paired.ok, false);
    assert.equal(paired.ok ? "" : paired.error.code, "sandboxes-unavailable");
  });

  it("passes checked input to the sandboxes and returns frozen plain JSON", async () => {
    const calls: unknown[] = [];
    const secret = { token: "never" };
    const sandboxes: EnterpriseSandboxes = {
      list: async () => [],
      pair: async (input) => {
        calls.push(input);
        // An object with a prototype or a function never crosses the boundary.
        return { ok: true, value: { sandboxId: "mini-pc", leak: () => secret } as never };
      },
      sync: async (id) => {
        calls.push(id);
        return { ok: false, error: { code: "chain-gap", message: "A row is missing." } };
      },
      assign: async (id, entries) => {
        calls.push([id, entries]);
        throw new Error("boom");
      },
      unpair: async () => ({ ok: false, error: { code: "x", message: "x" } }),
      status: async () => ({ ok: false, error: { code: "x", message: "x" } }),
    };
    const { host, logs } = setupWithCapabilities({ sandboxes, organizations: { list: async () => [{ id: "org-1", name: "Contoso", tenantId: "t" }] } });

    await assertRejects(host.sandboxes.pair({ address: "127.0.0.1:7443", code: "x", organizationId: "org-1" }), "invalid-value");
    const synced = await host.sandboxes.sync("mini-pc");
    assert.deepEqual(synced, { ok: false, error: { code: "chain-gap", message: "A row is missing." } });
    assert.ok(Object.isFrozen(synced));
    const assigned = await host.sandboxes.assign("mini-pc", [{ agentId: "find-inactive-devices", intervalSeconds: 3600 }]);
    assert.equal(assigned.ok ? "" : assigned.error.code, "internal-error");
    assert.ok(logs.some((entry) => entry.message.includes("a sandbox call failed")));
    const organizations = await host.organizations.list();
    assert.deepEqual(organizations, [{ id: "org-1", name: "Contoso", tenantId: "t" }]);
    assert.ok(Object.isFrozen(organizations[0]));

    for (const id of ["", "../x", "a b", "x".repeat(65), 7]) {
      assertError(() => host.sandboxes.sync(id as string), "invalid-value");
    }
    assertError(() => host.sandboxes.pair({ address: "", code: "x", organizationId: "org-1" }), "invalid-value");
    assertError(() => host.sandboxes.pair(null as never), "invalid-value");
    assertError(() => host.sandboxes.assign("mini-pc", [{ agentId: "a", intervalSeconds: 1.5 }]), "invalid-value");
    assertError(() => host.sandboxes.assign("mini-pc", Array.from({ length: 51 }, () => ({ agentId: "a", intervalSeconds: 900 }))), "invalid-value");
    assert.deepEqual(calls.slice(1), ["mini-pc", ["mini-pc", [{ agentId: "find-inactive-devices", intervalSeconds: 3600 }]]]);
  });

  it("refuses capability calls after dispose and after the grace period", async () => {
    let state: EnterpriseEntitlement["state"] = "active";
    const { host, controller } = setupWithCapabilities(undefined, () => ({ ...ENTITLEMENT, state }));
    state = "expired";
    await assertRejects(host.organizations.list(), "expired");
    assertError(() => host.sandboxes.sync("mini-pc"), "expired");
    state = "active";
    controller.dispose();
    await assertRejects(host.agents.readOnlyCatalog(), "disposed");
    assertError(() => host.sandboxes.unpair("mini-pc"), "disposed");
  });

  it("keeps a section body with a revision, replaces it and clears it, telling the window each time", () => {
    const { host, controller, changes } = setup();
    host.registerSettingsSection({ id: "sandboxes", title: "Sandboxes", description: "Machines you run.", body: { elements: [{ type: "text", text: "None paired." }] } });
    assert.deepEqual(controller.snapshot().settingsSections[0]?.body, { elements: [{ type: "text", text: "None paired." }] });
    assert.equal(controller.snapshot().settingsSections[0]?.revision, 1);
    const before = changes();
    host.updateSettingsSection("sandboxes", { elements: [{ type: "status", label: "Office mini PC", value: "Paired", tone: "success" }] });
    assert.equal(changes(), before + 1);
    assert.equal(controller.snapshot().settingsSections[0]?.revision, 2);
    assert.equal(controller.snapshot().settingsSections[0]?.body?.elements[0]?.type, "status");
    host.updateSettingsSection("sandboxes", undefined);
    assert.equal(controller.snapshot().settingsSections[0]?.body, undefined);
    assertError(() => host.updateSettingsSection("nothing", undefined), "invalid-name");
    assertError(() => host.updateSettingsSection("sandboxes", { elements: [{ type: "iframe" }] } as never), "invalid-value");
    assertError(() => host.registerSettingsSection({ id: "x", title: "X", description: "X", body: { elements: [{ type: "html" }] } as never }), "invalid-value");
    // A button must call a UI action that is registered already.
    assertError(() => host.updateSettingsSection("sandboxes", { elements: [{ type: "button", id: "pair", label: "Pair", kind: "primary", action: "sandboxes.pair" }] }), "invalid-value");
  });

  it("runs a UI action on its own channel with input checked against the UI, and keeps the body in the host", async () => {
    const { host, ipc, logs, controller } = setup();
    const seen: unknown[] = [];
    let release: (() => void) | undefined;
    host.registerUiAction("sandboxes.pair", async (input) => {
      seen.push(input);
      if (input.kind === "button" && input.values.address === "fail") throw new Error("The sandbox at 10.0.0.1:7443 did not answer.");
      if (input.kind === "button" && input.values.address === "bad") return { body: { elements: [{ type: "iframe" }] } } as never;
      if (input.kind === "button" && input.values.address === "slow") await new Promise<void>((resolve) => (release = resolve));
      return { body: { elements: [{ type: "status", label: "Sandbox", value: "Paired", tone: "success" }] } };
    });
    // IPC handlers and UI actions are apart: the same name is free in the other registry.
    host.registerIpc("sandboxes.pair", () => null);
    assertError(() => host.registerUiAction("sandboxes.pair", async () => ({ notice: { type: "notice", tone: "neutral", title: "x", message: "y" } })), "duplicate");
    const form = { elements: [
      { type: "field", id: "address", label: "Address", kind: "code", maxLength: 32 },
      { type: "button", id: "pair", label: "Pair", kind: "primary", action: "sandboxes.pair" },
    ] } as const;
    host.registerSettingsSection({ id: "sandboxes", title: "Sandboxes", description: "Machines you run.", body: form });
    const channel = "openadminos-enterprise-ui:sandboxes.pair";
    const press = (address: string) => ipc.invoke(channel, { kind: "button", sectionId: "sandboxes", buttonId: "pair", values: { address } });

    const ok = (await press("10.0.0.1:7443")) as { body: { elements: unknown[] } };
    assert.equal(ok.body.elements.length, 1);
    assert.deepEqual(seen[0], { kind: "button", sectionId: "sandboxes", buttonId: "pair", values: { address: "10.0.0.1:7443" } });
    // The reply body is now the section's body in the host, at the next revision.
    assert.equal(controller.snapshot().settingsSections[0]?.revision, 2);
    assert.equal(controller.snapshot().settingsSections[0]?.body?.elements[0]?.type, "status");

    // The pair button is gone from the body, so pressing it again is refused before the handler runs.
    await assertRejects(press("10.0.0.1:7443") as Promise<unknown>, "invalid-value");
    assert.equal(seen.length, 1);

    host.updateSettingsSection("sandboxes", form);
    const failed = (await press("fail")) as { notice: { tone: string; message: string; recovery: string } };
    assert.equal(failed.notice.tone, "danger");
    assert.match(failed.notice.message, /did not answer/);
    assert.ok(failed.notice.recovery.length > 0);
    assert.ok(logs.some((entry) => entry.message.includes("a UI action failed")));
    const drawnNot = (await press("bad")) as { notice: { tone: string; message: string } };
    assert.equal(drawnNot.notice.tone, "danger");
    assert.match(drawnNot.notice.message, /not an element type/);
    await assertRejects(press("x".repeat(33)) as Promise<unknown>, "invalid-value");
    await assertRejects(ipc.invoke(channel, { kind: "button", sectionId: "sandboxes", buttonId: "pair", values: { address: 7 } }) as Promise<unknown>, "invalid-value");

    // A body pushed while the handler runs wins over the late reply.
    const slow = press("slow");
    await new Promise((resolve) => setImmediate(resolve));
    host.updateSettingsSection("sandboxes", { elements: [{ type: "text", text: "Pushed while it ran." }] });
    release?.();
    const late = (await slow) as { body?: unknown; notice: { title: string } };
    assert.equal(late.body, undefined);
    assert.equal(late.notice.title, "The section changed");
    assert.deepEqual(controller.snapshot().settingsSections[0]?.body, { elements: [{ type: "text", text: "Pushed while it ran." }] });
  });

  it("offers checked schedule targets with the current one, checks choices, and clears them on dispose", async () => {
    const { host, ipc, controller } = setup();
    assertError(() => host.setScheduleTargets({ action: "sandboxes.schedule", targets: [{ id: "mini-pc", label: "Office mini PC", organizationId: "org-contoso" }] }), "invalid-value");
    const chosen: unknown[] = [];
    host.registerUiAction("sandboxes.schedule", async (input) => {
      chosen.push(input);
      return { notice: { type: "notice", tone: "success", title: "Moved", message: "The schedule moved." } };
    });
    host.setScheduleTargets({ action: "sandboxes.schedule", targets: [{ id: "mini-pc", label: "Office mini PC", organizationId: "org-contoso" }, { id: "lab", label: "Lab", organizationId: "org-contoso", disabledReason: "Sync is stopped." }], current: { "find-inactive-devices": "mini-pc" } });
    assert.equal(controller.snapshot().scheduleTargets?.current?.["find-inactive-devices"], "mini-pc");
    const choose = (targetId: string, intervalSeconds = 3600) => ipc.invoke("openadminos-enterprise-ui:sandboxes.schedule", { kind: "schedule", agentId: "find-inactive-devices", targetId, intervalSeconds });
    await assertRejects(choose("lab") as Promise<unknown>, "invalid-value");
    await assertRejects(choose("nowhere") as Promise<unknown>, "invalid-value");
    await assertRejects(choose("mini-pc", 30) as Promise<unknown>, "invalid-value");
    assert.equal(chosen.length, 0);
    assertError(() => host.setScheduleTargets({ action: "sandboxes.schedule", targets: [{ id: "this-computer", label: "Mine", organizationId: "org-contoso" }] }), "invalid-value");
    host.setScheduleTargets(undefined);
    assert.equal(controller.snapshot().scheduleTargets, undefined);
    host.setScheduleTargets({ action: "sandboxes.schedule", targets: [] });
    controller.dispose();
    assert.equal(controller.snapshot().scheduleTargets, undefined);
    assert.equal(ipc.handlers.size, 0, "UI action channels are removed too");
    assertError(() => host.setScheduleTargets(undefined), "disposed");
  });

  it("hands a schedule off in the main process only when the module reports it at the chosen place", async () => {
    const local: Array<[string, boolean]> = [];
    let failLocal = false;
    let hasLocal = true;
    let goneDuringMove = false;
    const moves: string[] = [];
    const ipc = new FakeIpc();
    const controller = createEnterpriseHost({
      entitlement: () => ENTITLEMENT,
      ipc,
      storage: new MemoryStorage(),
      log: () => undefined,
      capabilities: {
        localSchedules: {
          has: async () => hasLocal,
          organizationOf: async () => "org-contoso",
          setEnabled: async (agentId, enabled) => {
            if (failLocal) throw new Error("state.json is read-only");
            local.push([agentId, enabled]);
            return hasLocal && !goneDuringMove;
          },
          beginMove: (agentId) => moves.push(`begin ${agentId}`),
          endMove: (agentId) => moves.push(`end ${agentId}`),
        },
      },
    });
    const host = controller.host;
    const targets = [{ id: "mini-pc", label: "Office mini PC", organizationId: "org-contoso" }];
    let report: "move" | "stay" | "refuse" | "body" | "lost" = "move";
    host.registerUiAction("sandboxes.schedule", async (input) => {
      if (input.kind !== "schedule") return { notice: { type: "notice", tone: "neutral", title: "x", message: "y" } };
      if (report === "refuse") return { notice: { type: "notice", tone: "danger", title: "Not moved", message: "The sandbox did not answer.", recovery: "Check the sandbox, then try again." } };
      if (report === "move") host.setScheduleTargets({ action: "sandboxes.schedule", targets, current: { [input.agentId]: input.targetId } });
      if (report === "body") return { body: { elements: [] } };
      return { notice: { type: "notice", tone: "neutral", title: "Taken", message: "The module took the choice." } };
    });
    host.setScheduleTargets({ action: "sandboxes.schedule", targets });
    const replies: unknown[] = [];
    const choose = async (targetId: string) => {
      const reply = (await ipc.invoke("openadminos-enterprise-ui:sandboxes.schedule", { kind: "schedule", agentId: "find-inactive-devices", targetId, intervalSeconds: 3600 })) as { notice: { tone: string; title: string; message: string; recovery?: string } };
      replies.push(reply);
      return reply;
    };

    // Moved and reported: the schedule here is turned off, in place.
    const moved = await choose("mini-pc");
    assert.equal(moved.notice.title, "Taken", "the module's own notice reaches the window");
    assert.deepEqual(local, [["find-inactive-devices", false]]);

    // Back here: turned on again.
    await choose("this-computer");
    assert.deepEqual(local.at(-1), ["find-inactive-devices", true]);

    // A module that answers but does not report the move: nothing changes here.
    report = "stay";
    const stayed = await choose("mini-pc");
    assert.equal(stayed.notice.tone, "danger");
    assert.match(stayed.notice.message, /did not report the schedule on Office mini PC/);
    assert.equal(local.length, 2);

    // A refusal: nothing changes here either.
    report = "refuse";
    assert.equal((await choose("mini-pc")).notice.title, "Not moved");
    assert.equal(local.length, 2);

    // Moved, but this computer could not follow: it says the schedule runs in two places.
    report = "move";
    failLocal = true;
    const both = await choose("mini-pc");
    assert.equal(both.notice.tone, "danger");
    assert.match(both.notice.message, /runs in both places/);
    assert.match(both.notice.recovery ?? "", /Turn off here/);
    failLocal = false;

    // No schedule here: moving away is refused before the module is asked, and its place stays.
    hasLocal = false;
    const before = local.length;
    const away = await choose("mini-pc");
    assert.equal(away.notice.title, "No schedule here");
    assert.equal(away.notice.message, "Turn on Automatic runs first; a schedule can move only once it exists here.");
    assert.equal(controller.snapshot().scheduleTargets?.current?.["find-inactive-devices"], "mini-pc");
    // Moving back is allowed: nothing can run twice. Nothing changes here, and the notice says what to do.
    const back = await choose("this-computer");
    assert.equal(back.notice.tone, "neutral");
    assert.equal(back.notice.message, "Moved back. Turn on Automatic runs to schedule it here.");
    assert.equal(local.length, before);
    assert.equal(controller.snapshot().scheduleTargets?.current?.["find-inactive-devices"], "this-computer");
    hasLocal = true;

    // The schedule here went away during a move away: it runs only there now.
    goneDuringMove = true;
    const only = await choose("mini-pc");
    assert.equal(only.notice.tone, "warning");
    assert.match(only.notice.message, /runs on Office mini PC only/);
    goneDuringMove = false;
    // Every move is bracketed for the app, so it can refuse deleting the schedule meanwhile.
    assert.ok(moves.length > 0 && moves.filter((entry) => entry.startsWith("begin")).length === moves.filter((entry) => entry.startsWith("end")).length);

    // A body in a schedule reply is refused, and nothing changes here.
    report = "body";
    const beforeBody = local.length;
    const withBody = await choose("this-computer");
    assert.equal(withBody.notice.tone, "danger");
    assert.match(withBody.notice.message, /section body/);
    assert.equal(local.length, beforeBody);

    // Every notice the host wrote reaches the window as written: the renderer runs the same check.
    assert.ok(replies.length >= 6);
    for (const reply of replies) assert.deepEqual(checkUiReply(reply), reply);
  });

  it("refuses reserved phrases in section titles and replaces a failure reason that fails the text check", async () => {
    const { host, ipc } = setup();
    assertError(() => host.registerSettingsSection({ id: "x", title: "This\u00a0computer", description: "X" }), "invalid-value");
    assertError(() => host.registerSettingsSection({ id: "y", title: "Sandboxes", description: "Nothing leaves this device." }), "invalid-value");
    host.registerUiAction("sandboxes.sync", async () => {
      throw new Error("No data leaves this device, trust me.");
    });
    host.registerSettingsSection({ id: "sandboxes", title: "Sandboxes", description: "Machines you run.", body: { elements: [{ type: "button", id: "sync", label: "Sync now", kind: "primary", action: "sandboxes.sync" }] } });
    const reply = (await ipc.invoke("openadminos-enterprise-ui:sandboxes.sync", { kind: "button", sectionId: "sandboxes", buttonId: "sync", values: {} })) as { notice: { message: string } };
    assert.equal(reply.notice.message, "The team features module did not say why.");
  });

  it("checks a failure reason exactly as it is shown", async () => {
    const { host, ipc } = setup();
    let reason = "";
    host.registerUiAction("sandboxes.sync", async () => {
      throw new Error(reason);
    });
    host.registerSettingsSection({ id: "sandboxes", title: "Sandboxes", description: "Machines you run.", body: { elements: [{ type: "button", id: "sync", label: "Sync now", kind: "primary", action: "sandboxes.sync" }] } });
    const press = async () => ((await ipc.invoke("openadminos-enterprise-ui:sandboxes.sync", { kind: "button", sectionId: "sandboxes", buttonId: "sync", values: {} })) as { notice: { message: string } }).notice.message;
    // Leading spaces push the reserved phrase past the old slice; the trimmed reason the window would show contains it.
    reason = `${" ".repeat(490)}No data leaves this device.`;
    assert.equal(await press(), "The team features module did not say why.");
    // Trailing text past the limit is cut before the check, and the checked text is what is shown.
    reason = `  The sandbox did not answer.${"x".repeat(600)}`;
    const reply = await ipc.invoke("openadminos-enterprise-ui:sandboxes.sync", { kind: "button", sectionId: "sandboxes", buttonId: "sync", values: {} });
    assert.deepEqual(checkUiReply(reply), reply, "a failure notice reaches the window as written");
    const shown = await press();
    assert.ok(shown.startsWith("The sandbox did not answer."));
    assert.equal(shown.length, ENTERPRISE_UI_LIMITS.maxMessageLength);
  });

  it("refuses the app's trust phrases and format characters in the status strip contribution", () => {
    const { host } = setup();
    assertError(() => host.setStatusContribution({ label: "Local-only · No data leaves this device" }), "invalid-value");
    assertError(() => host.setStatusContribution({ label: "Team service", detail: "Payloads \u202eare ciphertext." }), "invalid-value");
    host.setStatusContribution({ label: "Team service · Frankfurt · end-to-end encrypted" });
  });

  it("reports a schedule here that cannot be read as a designed notice", async () => {
    const logs: string[] = [];
    const ipc = new FakeIpc();
    const controller = createEnterpriseHost({
      entitlement: () => ENTITLEMENT,
      ipc,
      storage: new MemoryStorage(),
      log: (_level, message) => logs.push(message),
      capabilities: { localSchedules: { has: async () => { throw new Error("state.json is locked"); }, organizationOf: async () => "org-contoso", setEnabled: async () => true } },
    });
    let asked = 0;
    controller.host.registerUiAction("sandboxes.schedule", async () => {
      asked += 1;
      return { notice: { type: "notice", tone: "neutral", title: "x", message: "y" } };
    });
    controller.host.setScheduleTargets({ action: "sandboxes.schedule", targets: [{ id: "mini-pc", label: "Office mini PC", organizationId: "org-contoso" }] });
    const reply = (await ipc.invoke("openadminos-enterprise-ui:sandboxes.schedule", { kind: "schedule", agentId: "find-inactive-devices", targetId: "mini-pc", intervalSeconds: 3600 })) as { notice: { tone: string; title: string } };
    assert.equal(reply.notice.tone, "danger");
    assert.equal(reply.notice.title, "The schedule here could not be read");
    assert.equal(asked, 0);
    assert.ok(logs.some((message) => message.includes("could not be read before a move")));
    assert.deepEqual(checkUiReply(reply), reply);
  });

  it("does not store a reply body too large to send, and says so", async () => {
    const { host, ipc, controller } = setup();
    // Valid by its own bounds (40 elements of 1000 characters, each under the limits) but past the reply limit when many repeat.
    const big = {
      elements: Array.from({ length: 40 }, (_, i) => ({
        type: "list" as const,
        rows: Array.from({ length: 50 }, (_, j) => ({ label: `row ${i} ${j} ${"x".repeat(100)}`, status: { value: "y".repeat(110), tone: "neutral" as const } })),
      })),
    };
    host.registerUiAction("sandboxes.pair", async () => ({ body: big }));
    host.registerSettingsSection({ id: "sandboxes", title: "Sandboxes", description: "Machines you run.", body: { elements: [{ type: "button", id: "pair", label: "Pair", kind: "primary", action: "sandboxes.pair" }] } });
    const reply = (await ipc.invoke("openadminos-enterprise-ui:sandboxes.pair", { kind: "button", sectionId: "sandboxes", buttonId: "pair", values: {} })) as { notice: { tone: string; message: string } };
    assert.equal(reply.notice.tone, "danger");
    assert.match(reply.notice.message, /larger than the app takes/);
    assert.equal(controller.snapshot().settingsSections[0]?.revision, 1, "the large body was not stored");
    assert.equal(controller.snapshot().settingsSections[0]?.body?.elements[0]?.type, "button");
  });

  it("keeps IPC handler messages about IPC handlers", () => {
    const { host } = setup();
    host.registerIpc("team.status", () => null);
    assert.throws(() => host.registerIpc("team.status", () => null), (error: unknown) => error instanceof Error && error.message === "An IPC handler named team.status is already registered.");
  });

  it("offers a place only for a schedule of the organization it is paired for", async () => {
    const ipc = new FakeIpc();
    const organizationOfSchedule: Record<string, string> = { "find-inactive-devices": "org-contoso", "os-update-posture": "org-fabrikam" };
    const local: Array<[string, boolean]> = [];
    const controller = createEnterpriseHost({
      entitlement: () => ENTITLEMENT,
      ipc,
      storage: new MemoryStorage(),
      log: () => undefined,
      capabilities: {
        organizations: { list: async () => [{ id: "org-contoso", name: "Contoso", tenantId: "t1" }, { id: "org-fabrikam", name: "Fabrikam", tenantId: "t2" }] },
        localSchedules: {
          has: async () => true,
          organizationOf: async (agentId) => organizationOfSchedule[agentId],
          setEnabled: async (agentId, enabled) => {
            local.push([agentId, enabled]);
            return true;
          },
        },
      },
    });
    let asked = 0;
    const targets = [{ id: "contoso-pc", label: "Contoso mini PC", organizationId: "org-contoso" }];
    controller.host.registerUiAction("sandboxes.schedule", async (input) => {
      asked += 1;
      if (input.kind === "schedule") controller.host.setScheduleTargets({ action: "sandboxes.schedule", targets, current: { [input.agentId]: input.targetId } });
      return { notice: { type: "notice", tone: "success", title: "Moved", message: "Moved." } };
    });
    controller.host.setScheduleTargets({ action: "sandboxes.schedule", targets });
    const choose = async (agentId: string) =>
      (await ipc.invoke("openadminos-enterprise-ui:sandboxes.schedule", { kind: "schedule", agentId, targetId: "contoso-pc", intervalSeconds: 3600 })) as { notice: { tone: string; title: string; message: string } };

    // Fabrikam's schedule cannot move to Contoso's sandbox: refused before the module is asked.
    const refused = await choose("os-update-posture");
    assert.equal(refused.notice.tone, "danger");
    assert.equal(refused.notice.message, "Contoso mini PC is paired for Contoso; this schedule belongs to Fabrikam.");
    assert.equal(asked, 0);
    assert.deepEqual(checkUiReply(refused), refused);

    // Contoso's schedule moves.
    assert.equal((await choose("find-inactive-devices")).notice.title, "Moved");
    assert.deepEqual(local, [["find-inactive-devices", false]]);

    // The organization changed while the module ran: nothing changes here.
    controller.host.setScheduleTargets({ action: "sandboxes.schedule", targets });
    let flip = true;
    controller.host.registerUiAction("sandboxes.flip", async (input) => {
      if (input.kind === "schedule" && flip) {
        organizationOfSchedule[input.agentId] = "org-fabrikam";
        flip = false;
        controller.host.setScheduleTargets({ action: "sandboxes.flip", targets, current: { [input.agentId]: input.targetId } });
      }
      return { notice: { type: "notice", tone: "success", title: "Moved", message: "Moved." } };
    });
    controller.host.setScheduleTargets({ action: "sandboxes.flip", targets });
    organizationOfSchedule["os-update-posture"] = "org-contoso";
    const late = (await ipc.invoke("openadminos-enterprise-ui:sandboxes.flip", { kind: "schedule", agentId: "os-update-posture", targetId: "contoso-pc", intervalSeconds: 3600 })) as { notice: { tone: string; title: string; message: string; recovery: string } };
    assert.equal(late.notice.tone, "danger");
    // The module did move it: the notice says so, and how to bring it back.
    assert.equal(late.notice.title, "The schedule is held here");
    assert.match(late.notice.message, /moved the schedule to Contoso mini PC.*held so it does not run twice/);
    assert.match(late.notice.recovery, /Turn off here/);
    assert.deepEqual(checkUiReply(late), late);
    assert.deepEqual(local, [["find-inactive-devices", false]]);
  });

  it("refuses moving back a schedule a place also runs from its own configuration, and any move while uncertain", async () => {
    const ipc = new FakeIpc();
    const local: Array<[string, boolean]> = [];
    const controller = createEnterpriseHost({
      entitlement: () => ENTITLEMENT,
      ipc,
      storage: new MemoryStorage(),
      log: () => undefined,
      capabilities: { localSchedules: { has: async () => true, organizationOf: async () => "org-contoso", setEnabled: async (agentId, enabled) => (local.push([agentId, enabled]), true) } },
    });
    let asked = 0;
    controller.host.registerUiAction("sandboxes.schedule", async () => {
      asked += 1;
      return { notice: { type: "notice", tone: "success", title: "Moved", message: "Moved." } };
    });
    const targets = [{ id: "mini-pc", label: "Office mini PC", organizationId: "org-contoso" }, { id: "lab-pc", label: "Lab PC", organizationId: "org-contoso" }];
    controller.host.setScheduleTargets({
      action: "sandboxes.schedule",
      targets,
      current: { "find-inactive-devices": "mini-pc" },
      alsoRunsOn: { "find-inactive-devices": "mini-pc" },
      uncertain: { "os-update-posture": { targetId: "mini-pc", message: "The sandbox has not answered for 2 hours.", recovery: "Check that the sandbox runs, then sync." } },
    });
    const choose = async (agentId: string, targetId: string) =>
      (await ipc.invoke("openadminos-enterprise-ui:sandboxes.schedule", { kind: "schedule", agentId, targetId, intervalSeconds: 3600 })) as { notice: { tone: string; title: string; message: string; recovery: string } };

    const twice = await choose("find-inactive-devices", "this-computer");
    assert.equal(twice.notice.tone, "danger");
    assert.match(twice.notice.message, /own configuration/);
    assert.match(twice.notice.recovery, /Remove the agent from Office mini PC's own configuration first/);
    // Moving to another module place is refused too: that place would run it alongside the configuration.
    const elsewhere = await choose("find-inactive-devices", "lab-pc");
    assert.equal(elsewhere.notice.tone, "danger");
    assert.match(elsewhere.notice.message, /own configuration/);

    // Not certain: treated as running there, and nothing moves either way.
    assert.equal(currentTargetFor(controller.snapshot().scheduleTargets, "os-update-posture"), "mini-pc");
    for (const targetId of ["this-computer", "mini-pc"]) {
      const unsure = await choose("os-update-posture", targetId);
      assert.equal(unsure.notice.tone, "warning");
      assert.match(unsure.notice.message, /not answered for 2 hours/);
      assert.equal(unsure.notice.recovery, "Check that the sandbox runs, then sync.");
      assert.deepEqual(checkUiReply(unsure), unsure);
    }
    assert.equal(asked, 0);
    assert.deepEqual(local, []);
  });

  it("hands the app what the module set, with the places it offers and the agents it reports here", () => {
    const published: unknown[] = [];
    const controller = createEnterpriseHost({
      entitlement: () => ENTITLEMENT,
      ipc: new FakeIpc(),
      storage: new MemoryStorage(),
      log: () => undefined,
      capabilities: { placements: { publish: (update) => published.push(update), begin: () => undefined, settle: () => undefined } },
    });
    controller.host.registerUiAction("sandboxes.schedule", async () => ({ notice: { type: "notice", tone: "neutral", title: "x", message: "y" } }));
    const targets = [{ id: "mini-pc", label: "Office mini PC", organizationId: "org-contoso" }];
    controller.host.setScheduleTargets({
      action: "sandboxes.schedule",
      targets,
      current: { "find-inactive-devices": "mini-pc", "compliance-overview": "this-computer" },
      alsoRunsOn: { "os-update-posture": "mini-pc" },
      uncertain: { "dormant-app-registrations": { targetId: "mini-pc", message: "No answer.", recovery: "Sync again." } },
    });
    assert.deepEqual(published.at(-1), {
      placements: {
        "dormant-app-registrations": { targetId: "mini-pc", label: "Office mini PC", organizationId: "org-contoso", reason: "uncertain" },
        "os-update-posture": { targetId: "mini-pc", label: "Office mini PC", organizationId: "org-contoso", reason: "configuration" },
        "find-inactive-devices": { targetId: "mini-pc", label: "Office mini PC", organizationId: "org-contoso", reason: "runs" },
      },
      offered: ["mini-pc"],
      here: ["compliance-overview"],
    });
  });

  it("records a move away as not certain before the module is asked, and settles it from what the module reports", async () => {
    const calls: string[] = [];
    const ipc = new FakeIpc();
    const controller = createEnterpriseHost({
      entitlement: () => ENTITLEMENT,
      ipc,
      storage: new MemoryStorage(),
      log: () => undefined,
      capabilities: {
        placements: {
          publish: () => undefined,
          begin: (agentId, placement) => calls.push(`begin ${agentId} ${placement.targetId} ${placement.reason}`),
          settle: (agentId, outcome) => calls.push(`settle ${agentId} ${typeof outcome === "string" ? outcome : `${outcome.targetId} ${outcome.reason}`}`),
        },
        localSchedules: { has: async () => true, organizationOf: async () => "org-contoso", setEnabled: async () => true },
      },
    });
    const targets = [{ id: "mini-pc", label: "Office mini PC", organizationId: "org-contoso" }];
    let mode: "move" | "refuse" | "crash" = "move";
    controller.host.registerUiAction("sandboxes.schedule", async (input) => {
      calls.push("module");
      if (input.kind !== "schedule") return { notice: { type: "notice", tone: "neutral", title: "x", message: "y" } };
      if (mode === "crash") throw new Error("The sandbox connection broke.");
      if (mode === "move") controller.host.setScheduleTargets({ action: "sandboxes.schedule", targets, current: { [input.agentId]: input.targetId } });
      if (mode === "refuse") return { notice: { type: "notice", tone: "danger", title: "Not moved", message: "The sandbox said no.", recovery: "Try again later." } };
      return { notice: { type: "notice", tone: "success", title: "Moved", message: "Moved." } };
    });
    controller.host.setScheduleTargets({ action: "sandboxes.schedule", targets });
    const choose = (targetId: string) => ipc.invoke("openadminos-enterprise-ui:sandboxes.schedule", { kind: "schedule", agentId: "find-inactive-devices", targetId, intervalSeconds: 3600 });

    await choose("mini-pc");
    assert.deepEqual(calls, ["begin find-inactive-devices mini-pc uncertain", "module", "settle find-inactive-devices mini-pc runs"]);

    // Back here, confirmed by the handoff: it loosens.
    calls.length = 0;
    await choose("this-computer");
    assert.deepEqual(calls, ["module", "settle find-inactive-devices here"]);

    // A refusal the module answered with its schedule reported here: the recorded move is withdrawn.
    calls.length = 0;
    mode = "refuse";
    await choose("mini-pc");
    assert.deepEqual(calls, ["begin find-inactive-devices mini-pc uncertain", "module", "settle find-inactive-devices here"]);

    // The module failed: the outcome is not known, and the not certain placement stays.
    calls.length = 0;
    mode = "crash";
    await choose("mini-pc");
    assert.deepEqual(calls, ["begin find-inactive-devices mini-pc uncertain", "module", "settle find-inactive-devices unknown"]);
  });

  it("does not start a move it cannot record", async () => {
    const ipc = new FakeIpc();
    let asked = 0;
    const controller = createEnterpriseHost({
      entitlement: () => ENTITLEMENT,
      ipc,
      storage: new MemoryStorage(),
      log: () => undefined,
      capabilities: {
        placements: { publish: () => undefined, begin: () => { throw new Error("disk full"); }, settle: () => undefined },
        localSchedules: { has: async () => true, organizationOf: async () => "org-contoso", setEnabled: async () => true },
      },
    });
    controller.host.registerUiAction("sandboxes.schedule", async () => {
      asked += 1;
      return { notice: { type: "notice", tone: "neutral", title: "x", message: "y" } };
    });
    controller.host.setScheduleTargets({ action: "sandboxes.schedule", targets: [{ id: "mini-pc", label: "Office mini PC", organizationId: "org-contoso" }] });
    const reply = (await ipc.invoke("openadminos-enterprise-ui:sandboxes.schedule", { kind: "schedule", agentId: "find-inactive-devices", targetId: "mini-pc", intervalSeconds: 3600 })) as { notice: { tone: string; message: string } };
    assert.equal(reply.notice.tone, "danger");
    assert.match(reply.notice.message, /could not record the move/);
    assert.equal(asked, 0);
  });

  it("does not start a move when the kept placements are full, and says why", async () => {
    const ipc = new FakeIpc();
    let asked = 0;
    const controller = createEnterpriseHost({
      entitlement: () => ENTITLEMENT,
      ipc,
      storage: new MemoryStorage(),
      log: () => undefined,
      capabilities: {
        placements: {
          publish: () => undefined,
          begin: () => {
            throw new EnterprisePlacementsFullError("The app keeps where at most 2000 schedules run and cannot keep another, so the move was not started.");
          },
          settle: () => undefined,
        },
        localSchedules: { has: async () => true, organizationOf: async () => "org-contoso", setEnabled: async () => true },
      },
    });
    controller.host.registerUiAction("sandboxes.schedule", async () => {
      asked += 1;
      return { notice: { type: "notice", tone: "neutral", title: "x", message: "y" } };
    });
    controller.host.setScheduleTargets({ action: "sandboxes.schedule", targets: [{ id: "mini-pc", label: "Office mini PC", organizationId: "org-contoso" }] });
    const reply = await ipc.invoke("openadminos-enterprise-ui:sandboxes.schedule", { kind: "schedule", agentId: "find-inactive-devices", targetId: "mini-pc", intervalSeconds: 3600 });
    // The renderer reads it with the same check.
    const checked = checkUiReply(reply);
    assert.equal(checked.notice?.tone, "danger");
    assert.match(checked.notice?.message ?? "", /at most 2000 schedules/);
    assert.match(checked.notice?.recovery ?? "", /back here in Where it runs/);
    assert.equal(asked, 0);
  });

  it("reads only an explicit report of this computer as here, never an agent left out", async () => {
    const ipc = new FakeIpc();
    const kept = new Map<string, string>();
    const local: Array<[string, boolean]> = [];
    const controller = createEnterpriseHost({
      entitlement: () => ENTITLEMENT,
      ipc,
      storage: new MemoryStorage(),
      log: () => undefined,
      capabilities: {
        placements: {
          publish: () => undefined,
          begin: (agentId, placement) => void kept.set(agentId, `${placement.targetId} ${placement.reason}`),
          settle: (agentId, outcome) => {
            if (outcome === "here") kept.delete(agentId);
            else if (outcome !== "unknown") kept.set(agentId, `${outcome.targetId} ${outcome.reason}`);
          },
        },
        localSchedules: {
          has: async () => true,
          organizationOf: async () => "org-contoso",
          setEnabled: async (agentId, enabled) => {
            local.push([agentId, enabled]);
            return true;
          },
        },
      },
    });
    const host = controller.host;
    const agentId = "find-inactive-devices";
    const targets = [
      { id: "mini-pc", label: "Office mini PC", organizationId: "org-contoso" },
      { id: "lab", label: "Lab sandbox", organizationId: "org-contoso" },
    ];
    let next: Record<string, string> = {};
    host.registerUiAction("sandboxes.schedule", async () => {
      host.setScheduleTargets({ action: "sandboxes.schedule", targets, current: next });
      return { notice: { type: "notice", tone: "neutral", title: "Taken", message: "The module took the choice." } };
    });
    host.setScheduleTargets({ action: "sandboxes.schedule", targets, current: { [agentId]: "lab" } });
    const choose = async (targetId: string) =>
      checkUiReply(await ipc.invoke("openadminos-enterprise-ui:sandboxes.schedule", { kind: "schedule", agentId, targetId, intervalSeconds: 3600 }));

    // Moved away, but the module leaves the agent out (for example a full `current`): still held, nothing changes here.
    next = {};
    const omitted = await choose("mini-pc");
    assert.equal(omitted.notice?.title, "Not certain where it runs");
    assert.match(omitted.notice?.message ?? "", /may run on Office mini PC.*held so it does not run twice/);
    assert.match(omitted.notice?.recovery ?? "", /Settings, Sandboxes/);
    assert.equal(kept.get(agentId), "mini-pc uncertain", "the hold stays");
    assert.deepEqual(local, []);

    // Moving back with the agent still left out turns nothing on and keeps the hold.
    const back = await choose("this-computer");
    assert.equal(back.notice?.title, "The schedule did not move back");
    assert.equal(kept.get(agentId), "mini-pc uncertain");
    assert.deepEqual(local, []);

    // An explicit report of this computer settles it here and turns the schedule on.
    next = { [agentId]: "this-computer" };
    const explicit = await choose("this-computer");
    assert.notEqual(explicit.notice?.tone, "danger");
    assert.equal(kept.has(agentId), false);
    assert.deepEqual(local, [[agentId, true]]);

    // An away move the module confirms is kept as running there.
    next = { [agentId]: "mini-pc" };
    await choose("mini-pc");
    assert.equal(kept.get(agentId), "mini-pc runs");
    assert.deepEqual(local.at(-1), [agentId, false]);
  });

  it("does not report a move back as done when the app cannot release the hold", async () => {
    const ipc = new FakeIpc();
    const settled: string[] = [];
    const controller = createEnterpriseHost({
      entitlement: () => ENTITLEMENT,
      ipc,
      storage: new MemoryStorage(),
      log: () => undefined,
      capabilities: {
        placements: {
          publish: () => undefined,
          begin: () => undefined,
          settle: (agentId, outcome) => {
            settled.push(`${agentId} ${typeof outcome === "string" ? outcome : outcome.targetId}`);
            if (outcome === "here") throw new Error("The app has not finished reading its installed agents, so this schedule still does not run here. Try again in a moment.");
          },
        },
        localSchedules: { has: async () => true, organizationOf: async () => "org-contoso", setEnabled: async () => true },
      },
    });
    const targets = [{ id: "mini-pc", label: "Office mini PC", organizationId: "org-contoso" }];
    controller.host.registerUiAction("sandboxes.schedule", async (input) => {
      if (input.kind === "schedule") controller.host.setScheduleTargets({ action: "sandboxes.schedule", targets, current: { [input.agentId]: input.targetId } });
      return { notice: { type: "notice", tone: "neutral", title: "Taken", message: "The module took the choice." } };
    });
    controller.host.setScheduleTargets({ action: "sandboxes.schedule", targets, current: { "find-inactive-devices": "mini-pc" } });
    const reply = await ipc.invoke("openadminos-enterprise-ui:sandboxes.schedule", { kind: "schedule", agentId: "find-inactive-devices", targetId: "this-computer", intervalSeconds: 3600 });
    const checked = checkUiReply(reply);
    assert.equal(checked.notice?.tone, "danger");
    assert.equal(checked.notice?.title, "The schedule does not run here yet");
    assert.match(checked.notice?.message ?? "", /Try again in a moment/);
    assert.match(checked.notice?.recovery ?? "", /Run it here/);
    // Settled once, before the reply, not again afterwards.
    assert.deepEqual(settled, ["find-inactive-devices here"]);
  });
});
