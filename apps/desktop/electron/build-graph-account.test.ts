import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { InteractionRequiredAuthError } from "@azure/msal-node";
import type { RunGraphApi, TenantRecord } from "@openadminos/agent-sdk";

import { AppStateStore } from "./state.js";

const TENANT: TenantRecord = {
  id: "contoso-tenant-id",
  displayName: "Contoso",
  username: "admin@contoso.example",
  homeAccountId: "home.contoso-tenant-id",
  addedAt: "2026-11-04T10:00:00.000Z",
  grantedScopes: ["graph:User.Read", "graph:DeviceManagementManagedDevices.Read.All"],
};

type Account = { homeAccountId: string; tenantId: string; username: string };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function makeFixture(account: Account, tenant: TenantRecord = TENANT) {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-build-graph-"));
  const filePath = join(dir, "state.json");
  await writeFile(filePath, JSON.stringify({
    activeProviderId: "ollama", installedAgents: [], runs: [], tenants: [tenant], activeTenantId: tenant.id,
  }));
  const loginHints: Array<string | undefined> = [];
  const authorities: Array<string | undefined> = [];
  const store = new AppStateStore({
    filePath, userDataPath: dir, statsApiUrl: "", appVersion: "0.7.2",
    tokenStore: { read: async () => "", write: async () => undefined },
    tokenStoreFor: () => ({ read: async () => "", write: async () => undefined }),
    interactiveSignIn: async ({ scopes, loginHint, authority }) => {
      loginHints.push(loginHint);
      authorities.push(authority);
      return {
        account,
        scopes: [...(scopes ?? []), "Policy.Read.All"],
        accessToken: "interactive-token",
      } as never;
    },
  });
  // Silent acquisition always needs interaction, so every token comes
  // from the interactive fallback inside buildGraph.
  Object.defineProperty(store, "msalClientForTenant", { value: () => ({
    getTokenCache: () => ({
      getAllAccounts: async () => [{ homeAccountId: TENANT.homeAccountId, tenantId: TENANT.id, username: TENANT.username }],
    }),
    acquireTokenSilent: async () => {
      throw new InteractionRequiredAuthError("interaction_required", "Interaction required.");
    },
  }) });
  const fetches: Array<{ url: string; authorization?: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    fetches.push({ url: String(input), authorization: headers.get("authorization") ?? undefined });
    return new Response(JSON.stringify({ value: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const buildGraph = (store as unknown as {
    buildGraph(tenantId: string, scopes: string[]): Promise<{ createGraph(log: () => void): RunGraphApi }>;
  }).buildGraph.bind(store);
  return {
    store,
    loginHints,
    authorities,
    fetches,
    async graph(): Promise<RunGraphApi> {
      const built = await buildGraph(TENANT.id, ["DeviceManagementManagedDevices.Read.All"]);
      return built.createGraph(() => undefined);
    },
    async close() {
      store.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

async function settle(): Promise<void> {
  // recordTokenGrants runs without being awaited by the token provider.
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("buildGraph interactive fallback", () => {
  for (const [label, account] of [
    ["a different account", { homeAccountId: "other.fabrikam-tenant-id", tenantId: "fabrikam-tenant-id", username: "it@fabrikam.example" }],
    ["the same account in another directory", { homeAccountId: TENANT.homeAccountId, tenantId: "fabrikam-tenant-id", username: TENANT.username }],
  ] as const) {
    it(`rejects ${label} before any Graph request or grant update`, async () => {
      const fixture = await makeFixture(account);
      try {
        const graph = await fixture.graph();
        await assert.rejects(graph.listManagedDevices(), { name: "TenantAccountMismatchError" });
        await settle();
        assert.deepEqual(fixture.loginHints, [TENANT.username]);
        assert.equal(fixture.fetches.length, 0);
        const state = await fixture.store.getAppState();
        assert.deepEqual(state.tenants.find((t) => t.id === TENANT.id)?.grantedScopes, TENANT.grantedScopes);
      } finally {
        await fixture.close();
      }
    });
  }

  it("uses the token when the connected account signs in", async () => {
    const fixture = await makeFixture({ homeAccountId: TENANT.homeAccountId, tenantId: TENANT.id, username: TENANT.username });
    try {
      const graph = await fixture.graph();
      assert.deepEqual(await graph.listManagedDevices(), []);
      await settle();
      assert.deepEqual(fixture.loginHints, [TENANT.username]);
      assert.equal(fixture.fetches.length, 1);
      assert.equal(fixture.fetches[0]?.authorization, "Bearer interactive-token");
      const state = await fixture.store.getAppState();
      assert.deepEqual([...(state.tenants.find((t) => t.id === TENANT.id)?.grantedScopes ?? [])].sort(), [
        ...(TENANT.grantedScopes ?? []),
        "graph:Policy.Read.All",
      ].sort());
    } finally {
      await fixture.close();
    }
  });
});

const MISMATCHED: ReadonlyArray<readonly [string, Account]> = [
  ["a different account", { homeAccountId: "other.fabrikam-tenant-id", tenantId: "fabrikam-tenant-id", username: "it@fabrikam.example" }],
  ["the same account in another directory", { homeAccountId: TENANT.homeAccountId, tenantId: "fabrikam-tenant-id", username: TENANT.username }],
];

describe("connector tenant session interactive fallback", () => {
  for (const [label, account] of MISMATCHED) {
    it(`rejects ${label} before any Graph request`, async () => {
      const fixture = await makeFixture(account);
      try {
        const session = (fixture.store as unknown as {
          createTenantSessionForRecord(tenant: TenantRecord): import("@openadminos/agent-sdk").TenantSession;
        }).createTenantSessionForRecord(TENANT);
        await assert.rejects(session.acquireTokenForScopes(["ChannelMessage.Send"]), { name: "TenantAccountMismatchError" });
        await assert.rejects(session.acquireTokenWithScopes!(["Mail.Send"]), { name: "TenantAccountMismatchError" });
        await settle();
        assert.deepEqual(fixture.loginHints, [TENANT.username, TENANT.username]);
        assert.deepEqual(fixture.authorities, [
          "https://login.microsoftonline.com/contoso-tenant-id",
          "https://login.microsoftonline.com/contoso-tenant-id",
        ]);
        assert.equal(fixture.fetches.length, 0);
        const state = await fixture.store.getAppState();
        assert.deepEqual(state.tenants.find((t) => t.id === TENANT.id)?.grantedScopes, TENANT.grantedScopes);
      } finally {
        await fixture.close();
      }
    });
  }
});

describe("Entra tier probe interactive fallback", () => {
  const licensed: TenantRecord = {
    ...TENANT,
    grantedScopes: [...(TENANT.grantedScopes ?? []), "graph:Organization.Read.All"],
    entraTier: "p1",
    entraTierDetectedAt: "2026-11-01T10:00:00.000Z",
    relevantLicenses: [{ skuPartNumber: "AAD_PREMIUM", displayName: "Microsoft Entra ID P1", enabledUnits: 5, consumedUnits: 3 }],
  };

  for (const [label, account] of MISMATCHED) {
    it(`keeps the stored tier and licences when ${label} signs in`, async () => {
      const fixture = await makeFixture(account, licensed);
      try {
        const state = await fixture.store.retryTenantLicenseCheck(licensed.id);
        assert.equal(state.tenants.find((t) => t.id === TENANT.id)?.tierProbeWarning?.reason, "account-mismatch");
        await settle();
        assert.deepEqual(fixture.loginHints, [TENANT.username]);
        // Building the app state reads other endpoints; Graph is never asked.
        assert.deepEqual(fixture.fetches.filter((f) => f.url.includes("graph.microsoft.com")), []);
        const stored = (await fixture.store.getAppState()).tenants.find((t) => t.id === TENANT.id);
        assert.equal(stored?.entraTier, "p1");
        assert.equal(stored?.entraTierDetectedAt, licensed.entraTierDetectedAt);
        assert.deepEqual(stored?.relevantLicenses, licensed.relevantLicenses);
        assert.deepEqual(stored?.grantedScopes, licensed.grantedScopes);
      } finally {
        await fixture.close();
      }
    });
  }

  it("records the tier when the connected account signs in", async () => {
    const fixture = await makeFixture({ homeAccountId: TENANT.homeAccountId, tenantId: TENANT.id, username: TENANT.username }, licensed);
    try {
      await fixture.store.retryTenantLicenseCheck(licensed.id);
      const graph = fixture.fetches.filter((f) => f.url.includes("graph.microsoft.com"));
      assert.equal(graph.length, 1);
      assert.match(graph[0]?.url ?? "", /\/subscribedSkus$/);
      const stored = (await fixture.store.getAppState()).tenants.find((t) => t.id === TENANT.id);
      assert.notEqual(stored?.entraTierDetectedAt, licensed.entraTierDetectedAt);
    } finally {
      await fixture.close();
    }
  });
});
