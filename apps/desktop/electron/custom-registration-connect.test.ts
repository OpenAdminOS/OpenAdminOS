import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  SAVED_APP_REGISTRATION_LIMIT,
  type TenantAppRegistration,
} from "@openadminos/agent-sdk";
import {
  DEFAULT_AUTHORITY,
  OPENADMINOS_CLIENT_ID,
  type TokenCacheStorage,
} from "@openadminos/runtime";

import { AppStateStore } from "./state.js";

const CUSTOM_CLIENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_CLIENT_ID = "11111111-2222-4333-8444-555555555555";

interface MsalConfigView {
  config: { auth: { clientId: string; authority: string } };
}

function authOf(client: unknown): { clientId: string; authority: string } {
  const { clientId, authority } = (client as MsalConfigView).config.auth;
  return { clientId, authority };
}

function assertSignIns(
  signIns: Array<{ clientId: string; authority: string }>,
  expected: { clientId: string; authority: string },
): void {
  assert.ok(signIns.length >= 1);
  for (const signIn of signIns) assert.deepEqual(signIn, expected);
}

const HOME_ACCOUNT_ID = "home-account.contoso-tenant-id";
const OTHER_HOME_ACCOUNT_ID = "other-account.fabrikam-tenant-id";
const ENVIRONMENT = "login.microsoftonline.com";

/** A serialized MSAL cache holding one account and its refresh token. */
function cacheWithAccount(clientId: string, homeAccountId = HOME_ACCOUNT_ID): string {
  const [localAccountId, realm] = homeAccountId.split(".") as [string, string];
  return JSON.stringify({
    Account: {
      [`${homeAccountId}-${ENVIRONMENT}-${realm}`]: {
        home_account_id: homeAccountId,
        environment: ENVIRONMENT,
        realm,
        local_account_id: localAccountId,
        username: "admin@contoso.example",
        authority_type: "MSSTS",
      },
    },
    IdToken: {},
    AccessToken: {},
    RefreshToken: {
      [`${homeAccountId}-${ENVIRONMENT}-refreshtoken-${clientId}----`.toLowerCase()]: {
        home_account_id: homeAccountId,
        environment: ENVIRONMENT,
        credential_type: "RefreshToken",
        client_id: clientId,
        secret: `refresh-token-for-${homeAccountId}`,
      },
    },
    AppMetadata: {},
  });
}

function mergeCaches(...caches: string[]): string {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const cache of caches) {
    for (const [section, entries] of Object.entries(JSON.parse(cache) as Record<string, Record<string, unknown>>)) {
      merged[section] = { ...merged[section], ...entries };
    }
  }
  return JSON.stringify(merged);
}

interface MemoryTokenStore extends TokenCacheStorage {
  contents(): string;
}

function memoryStore(initial = ""): MemoryTokenStore {
  let contents = initial;
  return {
    read: async () => contents,
    write: async (serialized) => {
      contents = serialized;
    },
    contents: () => contents,
  };
}

/** Home account IDs that still have an account or a refresh token in a store. */
function cachedAccounts(store: MemoryTokenStore): string[] {
  if (!store.contents()) return [];
  const cache = JSON.parse(store.contents()) as Record<string, Record<string, { home_account_id: string }>>;
  const ids = new Set<string>();
  for (const section of ["Account", "RefreshToken"]) {
    for (const entry of Object.values(cache[section] ?? {})) ids.add(entry.home_account_id);
  }
  return [...ids].sort();
}

async function makeFixture(
  initial: Record<string, unknown> = {},
  stores: {
    tokenStore?: TokenCacheStorage;
    perClientStores?: Map<string, TokenCacheStorage>;
    legacyTokenStores?: Map<string, TokenCacheStorage[]>;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-custom-registration-"));
  const statePath = join(dir, "state.json");
  await writeFile(
    statePath,
    JSON.stringify({ activeProviderId: "ollama", installedAgents: [], runs: [], tenants: [], ...initial }),
    "utf8",
  );
  const defaultStore: TokenCacheStorage = stores.tokenStore ?? {
    read: async () => "",
    write: async () => undefined,
  };
  const perClientStores = stores.perClientStores ?? new Map<string, TokenCacheStorage>();
  const legacyTokenStores = stores.legacyTokenStores;
  const signIns: Array<{ clientId: string; authority: string }> = [];
  const store = new AppStateStore({
    filePath: statePath,
    tokenStore: defaultStore,
    tokenStoreFor: (clientId) => {
      const existing = perClientStores.get(clientId);
      if (existing) return existing;
      const created: TokenCacheStorage = { read: async () => "", write: async () => undefined };
      perClientStores.set(clientId, created);
      return created;
    },
    ...(legacyTokenStores
      ? { legacyTokenStoresFor: (partition: string) => legacyTokenStores.get(partition) ?? [] }
      : {}),
    userDataPath: dir,
    statsApiUrl: "",
    appVersion: "0.7.2",
    interactiveSignIn: async ({ client }) => {
      signIns.push(authOf(client));
      return {
        account: {
          homeAccountId: "home-account.contoso-tenant-id",
          tenantId: "contoso-tenant-id",
          username: "admin@contoso.example",
        },
        scopes: ["https://graph.microsoft.com/Device.Read.All"],
      } as never;
    },
  });
  return {
    store,
    statePath,
    signIns,
    perClientStores,
    defaultStore,
    internal: store as unknown as {
      msalClientFor(registration: TenantAppRegistration | undefined): unknown;
    },
    async readPersisted(): Promise<Record<string, unknown>> {
      return JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    },
    async close() {
      for (const tenant of (await store.getAppState().catch(() => undefined))?.tenants ?? []) {
        await store.cancelGraphCachePreload(tenant.id).catch(() => undefined);
      }
      store.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

describe("connecting with a custom app registration", () => {
  it("signs in against the directory authority with a per-client token store and persists the registration", async () => {
    const fixture = await makeFixture();
    try {
      const state = await fixture.store.connectTenant({
        appRegistration: {
          clientId: ` ${CUSTOM_CLIENT_ID} `,
          directoryTenantId: "contoso.onmicrosoft.com",
          label: "Contoso admin app",
        },
      });

      // The background Entra tier probe may sign in again; every sign-in
      // must use the same registration.
      assertSignIns(fixture.signIns, {
        clientId: CUSTOM_CLIENT_ID,
        authority: "https://login.microsoftonline.com/contoso.onmicrosoft.com",
      });
      assert.deepEqual([...fixture.perClientStores.keys()], [CUSTOM_CLIENT_ID]);

      const expectedRegistration = {
        kind: "custom",
        clientId: CUSTOM_CLIENT_ID,
        authority: "https://login.microsoftonline.com/contoso.onmicrosoft.com",
        label: "Contoso admin app",
      };
      assert.deepEqual(state.tenants[0]?.appRegistration, expectedRegistration);
      const persisted = await fixture.readPersisted();
      const tenants = persisted.tenants as Array<{ appRegistration?: unknown }>;
      assert.deepEqual(tenants[0]?.appRegistration, expectedRegistration);

      assert.equal(state.savedAppRegistrations?.length, 1);
      assert.deepEqual(
        { ...state.savedAppRegistrations![0], lastUsedAt: "x" },
        {
          clientId: CUSTOM_CLIENT_ID,
          directoryTenantId: "contoso.onmicrosoft.com",
          label: "Contoso admin app",
          lastUsedAt: "x",
        },
      );
      assert.deepEqual(persisted.savedAppRegistrations, state.savedAppRegistrations);
      assert.doesNotMatch(JSON.stringify(persisted.savedAppRegistrations), /secret/i);
    } finally {
      await fixture.close();
    }
  });

  it("uses the common authority for a multi-tenant custom registration", async () => {
    const fixture = await makeFixture();
    try {
      await fixture.store.connectTenant({ appRegistration: { clientId: CUSTOM_CLIENT_ID } });
      assertSignIns(fixture.signIns, { clientId: CUSTOM_CLIENT_ID, authority: DEFAULT_AUTHORITY });
      const saved = (await fixture.store.getAppState()).savedAppRegistrations ?? [];
      assert.deepEqual(saved.map((entry) => entry.directoryTenantId), [undefined]);
    } finally {
      await fixture.close();
    }
  });

  it("connects with the OpenAdminOS app on the default token store and remembers nothing", async () => {
    const fixture = await makeFixture();
    try {
      const state = await fixture.store.connectTenant();
      assertSignIns(fixture.signIns, { clientId: OPENADMINOS_CLIENT_ID, authority: DEFAULT_AUTHORITY });
      assert.equal(fixture.perClientStores.size, 0);
      assert.deepEqual(state.tenants[0]?.appRegistration, {
        kind: "openadminos",
        clientId: OPENADMINOS_CLIENT_ID,
      });
      assert.deepEqual(state.savedAppRegistrations, []);
    } finally {
      await fixture.close();
    }
  });

  it("rejects a client ID that is not a GUID before any sign-in", async () => {
    const fixture = await makeFixture();
    try {
      await assert.rejects(
        fixture.store.connectTenant({ appRegistration: { clientId: "not-a-guid" } }),
        /Application \(client\) ID must be a GUID/,
      );
      assert.equal(fixture.signIns.length, 0);
    } finally {
      await fixture.close();
    }
  });

  it("moves a reused registration to the front and keeps its label", async () => {
    const fixture = await makeFixture({
      savedAppRegistrations: [
        { clientId: OTHER_CLIENT_ID, lastUsedAt: "2026-11-02T10:00:00.000Z" },
        { clientId: CUSTOM_CLIENT_ID, label: "Contoso admin app", lastUsedAt: "2026-11-01T10:00:00.000Z" },
      ],
    });
    try {
      const state = await fixture.store.connectTenant({ appRegistration: { clientId: CUSTOM_CLIENT_ID } });
      assert.deepEqual(
        state.savedAppRegistrations?.map((entry) => [entry.clientId, entry.label]),
        [
          [CUSTOM_CLIENT_ID, "Contoso admin app"],
          [OTHER_CLIENT_ID, undefined],
        ],
      );
    } finally {
      await fixture.close();
    }
  });

  it("removes a saved registration without touching the connected tenant", async () => {
    const fixture = await makeFixture();
    try {
      await fixture.store.connectTenant({
        appRegistration: { clientId: CUSTOM_CLIENT_ID, directoryTenantId: "contoso.onmicrosoft.com" },
      });
      const state = await fixture.store.removeSavedAppRegistration(
        CUSTOM_CLIENT_ID.toUpperCase(),
        "Contoso.onmicrosoft.com",
      );
      assert.deepEqual(state.savedAppRegistrations, []);
      assert.equal(state.tenants[0]?.appRegistration?.clientId, CUSTOM_CLIENT_ID);
      assert.equal(state.activeTenantId, "contoso-tenant-id");
    } finally {
      await fixture.close();
    }
  });

  it("drops invalid, duplicate, and excess saved registrations on read", async () => {
    const many = Array.from({ length: SAVED_APP_REGISTRATION_LIMIT + 5 }, (_, index) => ({
      clientId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      lastUsedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    }));
    const fixture = await makeFixture({
      savedAppRegistrations: [
        { clientId: "not-a-guid", lastUsedAt: "2026-11-03T10:00:00.000Z" },
        { clientId: CUSTOM_CLIENT_ID, directoryTenantId: "evil.com/../x", lastUsedAt: "2026-11-03T10:00:00.000Z" },
        { clientId: CUSTOM_CLIENT_ID, lastUsedAt: "not a date" },
        { clientId: CUSTOM_CLIENT_ID, secret: "never", lastUsedAt: "2026-11-03T09:00:00.000Z" },
        { clientId: CUSTOM_CLIENT_ID.toUpperCase(), lastUsedAt: "2026-11-03T08:00:00.000Z" },
        ...many,
      ],
    });
    try {
      const saved = (await fixture.store.getAppState()).savedAppRegistrations ?? [];
      assert.equal(saved.length, SAVED_APP_REGISTRATION_LIMIT);
      assert.deepEqual(saved[0], { clientId: CUSTOM_CLIENT_ID, lastUsedAt: "2026-11-03T09:00:00.000Z" });
      assert.equal(saved.filter((entry) => entry.clientId.toLowerCase() === CUSTOM_CLIENT_ID).length, 1);
    } finally {
      await fixture.close();
    }
  });
});

describe("MSAL client isolation per app registration", () => {
  it("caches one client per client ID and authority, each with its own token store", async () => {
    const fixture = await makeFixture();
    try {
      const custom: TenantAppRegistration = {
        kind: "custom",
        clientId: CUSTOM_CLIENT_ID,
        authority: "https://login.microsoftonline.com/contoso.onmicrosoft.com",
      };
      const customClient = fixture.internal.msalClientFor(custom);
      const sameCustom = fixture.internal.msalClientFor({ ...custom, label: "Renamed" });
      const otherAuthority = fixture.internal.msalClientFor({ ...custom, authority: DEFAULT_AUTHORITY });
      const otherClient = fixture.internal.msalClientFor({ kind: "custom", clientId: OTHER_CLIENT_ID });
      const defaultClient = fixture.internal.msalClientFor(undefined);

      assert.equal(customClient, sameCustom);
      assert.notEqual(customClient, otherAuthority);
      assert.notEqual(customClient, otherClient);
      assert.notEqual(customClient, defaultClient);
      assert.deepEqual(authOf(customClient), {
        clientId: CUSTOM_CLIENT_ID,
        authority: "https://login.microsoftonline.com/contoso.onmicrosoft.com",
      });
      assert.deepEqual(authOf(otherClient), { clientId: OTHER_CLIENT_ID, authority: DEFAULT_AUTHORITY });
      assert.deepEqual(authOf(defaultClient), { clientId: OPENADMINOS_CLIENT_ID, authority: DEFAULT_AUTHORITY });
      assert.deepEqual([...fixture.perClientStores.keys()].sort(), [OTHER_CLIENT_ID, CUSTOM_CLIENT_ID].sort());
    } finally {
      await fixture.close();
    }
  });

  it("reads each client's token cache only from that client's store", async () => {
    const fixture = await makeFixture();
    const reads: string[] = [];
    try {
      for (const clientId of [CUSTOM_CLIENT_ID, OTHER_CLIENT_ID]) {
        fixture.perClientStores.set(clientId, {
          read: async () => {
            reads.push(clientId);
            return "";
          },
          write: async () => undefined,
        });
      }
      const client = fixture.internal.msalClientFor({ kind: "custom", clientId: CUSTOM_CLIENT_ID }) as {
        getTokenCache(): { getAllAccounts(): Promise<unknown[]> };
      };
      await client.getTokenCache().getAllAccounts();
      assert.ok(reads.length > 0);
      assert.ok(reads.every((entry) => entry === CUSTOM_CLIENT_ID));
    } finally {
      await fixture.close();
    }
  });
});

describe("reconnecting a tenant with a different app registration", () => {
  function recordRemovals(client: unknown): string[] {
    const removed: string[] = [];
    const account = { homeAccountId: "home-account.contoso-tenant-id" };
    Object.defineProperty(client, "getTokenCache", {
      value: () => ({
        getAccountByHomeId: async (homeAccountId: string) =>
          homeAccountId === account.homeAccountId ? account : null,
        removeAccount: async (entry: { homeAccountId: string }) => {
          removed.push(entry.homeAccountId);
        },
      }),
    });
    return removed;
  }

  const customRegistration: TenantAppRegistration = {
    kind: "custom",
    clientId: CUSTOM_CLIENT_ID,
    authority: "https://login.microsoftonline.com/contoso.onmicrosoft.com",
  };

  it("removes the previous registration's cached account after switching to the OpenAdminOS app", async () => {
    const fixture = await makeFixture();
    try {
      await fixture.store.connectTenant({
        appRegistration: { clientId: CUSTOM_CLIENT_ID, directoryTenantId: "contoso.onmicrosoft.com" },
      });
      const removed = recordRemovals(fixture.internal.msalClientFor(customRegistration));

      const state = await fixture.store.connectTenant({});

      assert.equal(state.tenants.length, 1);
      assert.equal(state.tenants[0]?.appRegistration?.clientId, OPENADMINOS_CLIENT_ID);
      assert.deepEqual(removed, ["home-account.contoso-tenant-id"]);
    } finally {
      await fixture.close();
    }
  });

  it("keeps the cached account when only the authority changes, because the token cache is per client", async () => {
    const fixture = await makeFixture();
    try {
      await fixture.store.connectTenant({
        appRegistration: { clientId: CUSTOM_CLIENT_ID, directoryTenantId: "contoso.onmicrosoft.com" },
      });
      const removedViaDirectory = recordRemovals(fixture.internal.msalClientFor(customRegistration));
      const removedViaCommon = recordRemovals(
        fixture.internal.msalClientFor({ kind: "custom", clientId: CUSTOM_CLIENT_ID, authority: DEFAULT_AUTHORITY }),
      );

      const state = await fixture.store.connectTenant({ appRegistration: { clientId: CUSTOM_CLIENT_ID } });

      assert.equal(state.tenants[0]?.appRegistration?.authority, DEFAULT_AUTHORITY);
      assert.deepEqual(removedViaDirectory, []);
      assert.deepEqual(removedViaCommon, []);
    } finally {
      await fixture.close();
    }
  });

  it("keeps the cached account when only the client ID's letter case changes", async () => {
    const fixture = await makeFixture();
    try {
      await fixture.store.connectTenant({
        appRegistration: { clientId: CUSTOM_CLIENT_ID.toUpperCase(), directoryTenantId: "contoso.onmicrosoft.com" },
      });
      const removed = recordRemovals(
        fixture.internal.msalClientFor({ ...customRegistration, clientId: CUSTOM_CLIENT_ID.toUpperCase() }),
      );

      await fixture.store.connectTenant({
        appRegistration: { clientId: CUSTOM_CLIENT_ID, directoryTenantId: "contoso.onmicrosoft.com" },
      });

      assert.deepEqual(removed, []);
    } finally {
      await fixture.close();
    }
  });

  it("keeps the cached account while another tenant uses it with a differently cased client ID", async () => {
    const fixture = await makeFixture({
      tenants: [
        {
          id: "fabrikam-tenant-id",
          displayName: "Fabrikam",
          username: "admin@contoso.example",
          homeAccountId: "home-account.contoso-tenant-id",
          addedAt: "2026-11-01T10:00:00.000Z",
          appRegistration: { kind: "custom", clientId: CUSTOM_CLIENT_ID.toUpperCase(), authority: DEFAULT_AUTHORITY },
        },
      ],
    });
    try {
      await fixture.store.connectTenant({
        appRegistration: { clientId: CUSTOM_CLIENT_ID, directoryTenantId: "contoso.onmicrosoft.com" },
      });
      const removed = recordRemovals(fixture.internal.msalClientFor(customRegistration));

      await fixture.store.connectTenant({});

      assert.deepEqual(removed, []);
    } finally {
      await fixture.close();
    }
  });

  it("keeps the cached account while another tenant signs in with it from the same client", async () => {
    const fixture = await makeFixture({
      tenants: [
        {
          id: "fabrikam-tenant-id",
          displayName: "Fabrikam",
          username: "admin@contoso.example",
          homeAccountId: "home-account.contoso-tenant-id",
          addedAt: "2026-11-01T10:00:00.000Z",
          appRegistration: { kind: "custom", clientId: CUSTOM_CLIENT_ID, authority: DEFAULT_AUTHORITY },
        },
      ],
    });
    try {
      await fixture.store.connectTenant({
        appRegistration: { clientId: CUSTOM_CLIENT_ID, directoryTenantId: "contoso.onmicrosoft.com" },
      });
      const removed = recordRemovals(fixture.internal.msalClientFor(customRegistration));

      const state = await fixture.store.connectTenant({});

      assert.equal(state.tenants.length, 2);
      assert.deepEqual(removed, []);
    } finally {
      await fixture.close();
    }
  });

  it("keeps the cached account when the tenant reconnects with the same registration", async () => {
    const fixture = await makeFixture();
    try {
      await fixture.store.connectTenant({
        appRegistration: { clientId: CUSTOM_CLIENT_ID, directoryTenantId: "contoso.onmicrosoft.com" },
      });
      const removed = recordRemovals(fixture.internal.msalClientFor(customRegistration));

      await fixture.store.connectTenant({
        appRegistration: { clientId: CUSTOM_CLIENT_ID, directoryTenantId: "contoso.onmicrosoft.com" },
      });

      assert.deepEqual(removed, []);
    } finally {
      await fixture.close();
    }
  });
});

describe("client ID letter case and token cache selection", () => {
  const UPPER_DEFAULT_CLIENT_ID = OPENADMINOS_CLIENT_ID.toUpperCase();
  const UPPER_CUSTOM_CLIENT_ID = CUSTOM_CLIENT_ID.toUpperCase();

  function accountsVisibleTo(client: unknown): Promise<Array<{ homeAccountId: string }>> {
    return (client as { getTokenCache(): { getAllAccounts(): Promise<Array<{ homeAccountId: string }>> } })
      .getTokenCache()
      .getAllAccounts();
  }

  it("stores the OpenAdminOS client ID typed in upper case as a custom registration on the shared cache, so disconnect after switching to the OpenAdminOS app removes its refresh token", async () => {
    const tokenStore = memoryStore(cacheWithAccount(OPENADMINOS_CLIENT_ID));
    const fixture = await makeFixture({}, { tokenStore });
    try {
      const custom = await fixture.store.connectTenant({
        appRegistration: { clientId: UPPER_DEFAULT_CLIENT_ID },
      });
      assert.deepEqual(custom.tenants[0]?.appRegistration, {
        kind: "custom",
        clientId: OPENADMINOS_CLIENT_ID,
        authority: DEFAULT_AUTHORITY,
      });
      assert.deepEqual(
        custom.savedAppRegistrations?.map((entry) => entry.clientId),
        [OPENADMINOS_CLIENT_ID],
      );
      assertSignIns(fixture.signIns, { clientId: OPENADMINOS_CLIENT_ID, authority: DEFAULT_AUTHORITY });
      assert.equal(fixture.perClientStores.size, 0);

      await fixture.store.connectTenant({});
      assert.equal(fixture.perClientStores.size, 0);
      assert.deepEqual(cachedAccounts(tokenStore), [HOME_ACCOUNT_ID]);

      const state = await fixture.store.disconnectTenant("contoso-tenant-id");
      assert.equal(state.tenants.length, 0);
      assert.deepEqual(cachedAccounts(tokenStore), []);
      assert.equal(fixture.perClientStores.size, 0);
    } finally {
      await fixture.close();
    }
  });

  it("keeps a stored upper case OpenAdminOS custom record signed in from its legacy cache and removes it from both caches on disconnect", async () => {
    const tokenStore = memoryStore(cacheWithAccount(OPENADMINOS_CLIENT_ID, OTHER_HOME_ACCOUNT_ID));
    const legacyStore = memoryStore(cacheWithAccount(UPPER_DEFAULT_CLIENT_ID));
    const fixture = await makeFixture(
      {
        tenants: [
          {
            id: "contoso-tenant-id",
            displayName: "contoso.example",
            username: "admin@contoso.example",
            homeAccountId: HOME_ACCOUNT_ID,
            addedAt: "2026-11-01T10:00:00.000Z",
            appRegistration: { kind: "custom", clientId: UPPER_DEFAULT_CLIENT_ID, authority: DEFAULT_AUTHORITY },
          },
        ],
        activeTenantId: "contoso-tenant-id",
      },
      { tokenStore, legacyTokenStores: new Map([[OPENADMINOS_CLIENT_ID, [legacyStore]]]) },
    );
    try {
      const loaded = await fixture.store.getAppState();
      assert.equal(loaded.tenants[0]?.appRegistration?.clientId, OPENADMINOS_CLIENT_ID);
      const client = fixture.internal.msalClientFor(loaded.tenants[0]?.appRegistration);
      assert.equal(client, fixture.internal.msalClientFor(undefined));
      assert.deepEqual(
        (await accountsVisibleTo(client)).map((account) => account.homeAccountId).sort(),
        [HOME_ACCOUNT_ID, OTHER_HOME_ACCOUNT_ID].sort(),
      );

      await fixture.store.connectTenant({});
      await fixture.store.disconnectTenant("contoso-tenant-id");

      assert.deepEqual(cachedAccounts(legacyStore), []);
      assert.deepEqual(cachedAccounts(tokenStore), [OTHER_HOME_ACCOUNT_ID]);
      assert.equal(fixture.perClientStores.size, 0);
    } finally {
      await fixture.close();
    }
  });

  it("resolves a custom client ID in either case to one token store and removes the account from it when switching to the OpenAdminOS app", async () => {
    const customStore = memoryStore(cacheWithAccount(CUSTOM_CLIENT_ID));
    const tokenStore = memoryStore(cacheWithAccount(OPENADMINOS_CLIENT_ID, OTHER_HOME_ACCOUNT_ID));
    const fixture = await makeFixture(
      {},
      { tokenStore, perClientStores: new Map([[CUSTOM_CLIENT_ID, customStore]]) },
    );
    try {
      const upper = await fixture.store.connectTenant({
        appRegistration: { clientId: UPPER_CUSTOM_CLIENT_ID },
      });
      assert.equal(upper.tenants[0]?.appRegistration?.clientId, CUSTOM_CLIENT_ID);
      await fixture.store.connectTenant({ appRegistration: { clientId: CUSTOM_CLIENT_ID } });
      assert.equal(
        fixture.internal.msalClientFor({ kind: "custom", clientId: UPPER_CUSTOM_CLIENT_ID }),
        fixture.internal.msalClientFor({ kind: "custom", clientId: CUSTOM_CLIENT_ID }),
      );
      assert.deepEqual([...fixture.perClientStores.keys()], [CUSTOM_CLIENT_ID]);
      assert.deepEqual(cachedAccounts(customStore), [HOME_ACCOUNT_ID]);

      await fixture.store.connectTenant({});

      assert.deepEqual(cachedAccounts(customStore), []);
      assert.deepEqual(cachedAccounts(tokenStore), [OTHER_HOME_ACCOUNT_ID]);
      assert.deepEqual([...fixture.perClientStores.keys()], [CUSTOM_CLIENT_ID]);
    } finally {
      await fixture.close();
    }
  });

  it("removes a stored upper case custom record's account from its legacy and canonical caches and leaves other accounts in place", async () => {
    const customStore = memoryStore(cacheWithAccount(CUSTOM_CLIENT_ID));
    const legacyStore = memoryStore(
      mergeCaches(
        cacheWithAccount(UPPER_CUSTOM_CLIENT_ID),
        cacheWithAccount(UPPER_CUSTOM_CLIENT_ID, OTHER_HOME_ACCOUNT_ID),
      ),
    );
    const tokenStore = memoryStore();
    const fixture = await makeFixture(
      {
        tenants: [
          {
            id: "contoso-tenant-id",
            displayName: "contoso.example",
            username: "admin@contoso.example",
            homeAccountId: HOME_ACCOUNT_ID,
            addedAt: "2026-11-01T10:00:00.000Z",
            appRegistration: { kind: "custom", clientId: UPPER_CUSTOM_CLIENT_ID, authority: DEFAULT_AUTHORITY },
          },
        ],
        activeTenantId: "contoso-tenant-id",
      },
      {
        tokenStore,
        perClientStores: new Map([[CUSTOM_CLIENT_ID, customStore]]),
        legacyTokenStores: new Map([[CUSTOM_CLIENT_ID, [legacyStore]]]),
      },
    );
    try {
      const loaded = await fixture.store.getAppState();
      assert.equal(loaded.tenants[0]?.appRegistration?.clientId, CUSTOM_CLIENT_ID);

      await fixture.store.connectTenant({});

      // The partition's client reads both files and writes the canonical
      // one, so the other account is carried into it rather than lost.
      assert.deepEqual(cachedAccounts(legacyStore), [OTHER_HOME_ACCOUNT_ID]);
      assert.deepEqual(cachedAccounts(customStore), [OTHER_HOME_ACCOUNT_ID]);
      assert.deepEqual([...fixture.perClientStores.keys()], [CUSTOM_CLIENT_ID]);
    } finally {
      await fixture.close();
    }
  });
});
