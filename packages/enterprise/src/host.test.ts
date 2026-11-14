import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  ENTERPRISE_LIMITS,
  EnterpriseHostError,
  checkJson,
  createEnterpriseHost,
  type EnterpriseIpcRegistrar,
  type EnterpriseLogLevel,
  type EnterpriseStorageBackend,
} from "./host.js";
import type { EnterpriseEntitlement, EnterpriseJson } from "./interface.js";

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
      "entitlement",
      "interfaceVersion",
      "log",
      "registerIpc",
      "registerSettingsSection",
      "setStatusContribution",
      "storage",
    ]);
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
    assert.deepEqual(controller.snapshot().settingsSections, [{ id: "team", title: "Team", description: "Approvals and audit." }]);
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

  it("removes every handler on dispose and refuses later calls", async () => {
    const { host, ipc, controller } = setup();
    host.registerIpc("a", () => null);
    host.registerIpc("b", () => null);
    host.setStatusContribution({ label: "Team features on" });
    const stale = ipc.handlers.get("openadminos-enterprise:a");
    controller.dispose();
    controller.dispose();
    assert.equal(ipc.handlers.size, 0);
    assert.deepEqual(controller.snapshot(), { status: undefined, settingsSections: [], ipcChannels: [] });
    assertError(() => host.registerIpc("c", () => null), "disposed");
    assertError(() => host.setStatusContribution(undefined), "disposed");
    await assertRejects(host.storage.keys(), "disposed");
    await assertRejects(stale?.(null) ?? Promise.resolve(), "disposed");
  });
});
