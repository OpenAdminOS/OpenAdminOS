import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { InteractionRequiredAuthError } from "@azure/msal-node";
import type { AppState, TenantRecord } from "@openadminos/agent-sdk";

import { AppStateStore } from "./state.js";

type Account = { homeAccountId: string; tenantId: string; username: string };

const CONNECTED: Account = {
  homeAccountId: "home.contoso-tenant-id",
  tenantId: "contoso-tenant-id",
  username: "admin@contoso.example",
};
const OTHER: Account = {
  homeAccountId: "other.fabrikam-tenant-id",
  tenantId: "fabrikam-tenant-id",
  username: "it@fabrikam.example",
};
const MISMATCH =
  "Signed in as it@fabrikam.example, but this tenant is connected as admin@contoso.example. Sign in as admin@contoso.example and try again.";
const DEFAULT_SCOPE = "https://graph.microsoft.com/.default";

const LICENSED: TenantRecord = {
  id: CONNECTED.tenantId,
  displayName: "Contoso",
  username: CONNECTED.username,
  homeAccountId: CONNECTED.homeAccountId,
  addedAt: "2026-11-04T10:00:00.000Z",
  grantedScopes: ["graph:User.Read", "graph:Organization.Read.All"],
  entraTier: "p1",
  entraTierDetectedAt: "2026-11-01T10:00:00.000Z",
  relevantLicenses: [{ skuPartNumber: "AAD_PREMIUM", displayName: "Microsoft Entra ID P1", enabledUnits: 5, consumedUnits: 3 }],
};

function token(scp: string): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ scp })}.signature`;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Silent requests for `.default` (Check again) succeed for the connected
 * account. Every other silent request needs interaction, and each
 * interactive sign-in returns the next account in `signIns`.
 */
async function makeFixture(options: { tenants: TenantRecord[]; signIns: Account[] }) {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-tier-warning-"));
  const filePath = join(dir, "state.json");
  await writeFile(filePath, JSON.stringify({
    activeProviderId: "ollama", installedAgents: [], runs: [], tenants: options.tenants,
    ...(options.tenants[0] ? { activeTenantId: options.tenants[0].id } : {}),
  }));
  const signIns = [...options.signIns];
  const store = new AppStateStore({
    filePath, userDataPath: dir, statsApiUrl: "", appVersion: "0.7.2",
    tokenStore: { read: async () => "", write: async () => undefined },
    tokenStoreFor: () => ({ read: async () => "", write: async () => undefined }),
    interactiveSignIn: async ({ scopes }) => {
      const account = signIns.shift() ?? CONNECTED;
      return {
        account,
        tenantId: account.tenantId,
        scopes: [...(scopes ?? []), "User.Read", "Organization.Read.All"],
        accessToken: "interactive-token",
      } as never;
    },
  });
  Object.defineProperty(store, "msalClientForTenant", { value: () => ({
    getTokenCache: () => ({
      getAllAccounts: async () => [CONNECTED],
      getAccountByHomeId: async (id: string) => (id === CONNECTED.homeAccountId ? CONNECTED : null),
    }),
    acquireTokenSilent: async (request: { scopes: string[] }) => {
      if (request.scopes.includes(DEFAULT_SCOPE)) {
        return {
          account: CONNECTED,
          tenantId: CONNECTED.tenantId,
          scopes: [DEFAULT_SCOPE],
          accessToken: token("User.Read Organization.Read.All SecurityEvents.Read.All"),
        };
      }
      throw new InteractionRequiredAuthError("interaction_required", "Interaction required.");
    },
  }) });
  const fetches: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetches.push(String(input));
    return new Response(JSON.stringify({ value: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return {
    store,
    fetches,
    async tenant(): Promise<TenantRecord | undefined> {
      return (await store.getAppState()).tenants.find((entry) => entry.id === CONNECTED.tenantId);
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

function assertTierKept(tenant: TenantRecord | undefined): void {
  assert.equal(tenant?.entraTier, "p1");
  assert.equal(tenant?.entraTierDetectedAt, LICENSED.entraTierDetectedAt);
  assert.deepEqual(tenant?.relevantLicenses, LICENSED.relevantLicenses);
}

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}

describe("Entra tier probe account mismatch warning", () => {
  it("probeAllTenants keeps the stored tier and saves the mismatch as a tenant warning", async () => {
    const fixture = await makeFixture({ tenants: [LICENSED], signIns: [OTHER] });
    try {
      await fixture.store.probeAllTenants();
      const tenant = await fixture.tenant();
      assertTierKept(tenant);
      assert.equal(tenant?.tierProbeWarning?.message, MISMATCH);
      assert.equal(tenant?.tierProbeWarning?.accountMismatch, true);
      assert.deepEqual(fixture.fetches.filter((url) => url.endsWith("/subscribedSkus")), []);
    } finally {
      await fixture.close();
    }
  });

  it("a probe that finishes clears the warning", async () => {
    const warned: TenantRecord = {
      ...LICENSED,
      tierProbeWarning: { message: MISMATCH, accountMismatch: true, at: "2026-11-03T10:00:00.000Z" },
    };
    const fixture = await makeFixture({ tenants: [warned], signIns: [CONNECTED] });
    try {
      await fixture.store.probeAllTenants();
      const tenant = await fixture.tenant();
      assert.equal(tenant?.tierProbeWarning, undefined);
      assert.notEqual(tenant?.entraTierDetectedAt, LICENSED.entraTierDetectedAt);
    } finally {
      await fixture.close();
    }
  });

  it("Check again saves the new grants and returns the probe warning instead of plain success", async () => {
    const own: TenantRecord = {
      ...LICENSED,
      grantedScopes: ["graph:User.Read", "graph:Organization.Read.All"],
      appRegistration: { kind: "custom", clientId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    };
    const fixture = await makeFixture({ tenants: [own], signIns: [OTHER] });
    try {
      const state: AppState = await fixture.store.refreshTenantGrants(own.id);
      const tenant = state.tenants.find((entry) => entry.id === own.id);
      assert.deepEqual(tenant?.grantedScopes, [
        "graph:User.Read",
        "graph:Organization.Read.All",
        "graph:SecurityEvents.Read.All",
      ]);
      assertTierKept(tenant);
      assert.equal(tenant?.tierProbeWarning?.message, MISMATCH);
      assert.equal(tenant?.tierProbeWarning?.accountMismatch, true);
    } finally {
      await fixture.close();
    }
  });

  it("connect saves the warning when the background probe signs in as another account", async () => {
    const fixture = await makeFixture({ tenants: [], signIns: [CONNECTED, OTHER] });
    try {
      await fixture.store.connectTenant({});
      const warning = await waitFor(async () => (await fixture.tenant())?.tierProbeWarning);
      assert.equal(warning.message, MISMATCH);
      assert.equal(warning.accountMismatch, true);
      const tenant = await fixture.tenant();
      assert.equal(tenant?.homeAccountId, CONNECTED.homeAccountId);
      assert.equal(tenant?.entraTier, undefined);
    } finally {
      await fixture.close();
    }
  });
});
