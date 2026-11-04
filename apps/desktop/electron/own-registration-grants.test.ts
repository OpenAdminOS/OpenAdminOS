import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { InteractionRequiredAuthError } from "@azure/msal-node";
import type { TenantRecord } from "@openadminos/agent-sdk";

import { AppStateStore } from "./state.js";

const CUSTOM_CLIENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const DEFAULT_SCOPE = "https://graph.microsoft.com/.default";

function token(scp: string): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ scp })}.signature`;
}

function customTenant(grantedScopes?: string[]): TenantRecord {
  return {
    id: "contoso-tenant-id",
    displayName: "Contoso",
    username: "admin@contoso.example",
    homeAccountId: "home.contoso-tenant-id",
    addedAt: "2026-11-04T10:00:00.000Z",
    appRegistration: { kind: "custom", clientId: CUSTOM_CLIENT_ID },
    ...(grantedScopes ? { grantedScopes } : {}),
  };
}

type Account = { homeAccountId: string; tenantId: string; username: string };
type SilentRequest = { scopes: string[]; forceRefresh?: boolean; account: Account; authority?: string };
const CONNECTED: Account = { homeAccountId: "home.contoso-tenant-id", tenantId: "contoso-tenant-id", username: "admin@contoso.example" };

async function makeFixture(options: {
  tenants?: TenantRecord[];
  interactive?: {
    scopes: string[];
    accessToken?: string;
    account?: { homeAccountId: string; tenantId: string; username: string };
  };
  silent?: (request: SilentRequest) => Promise<{ scopes: string[]; accessToken: string; account?: Account }>;
  /** Cached profiles. Defaults to the connected account in its own directory. */
  accounts?: Account[];
}) {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-own-grants-"));
  const filePath = join(dir, "state.json");
  await writeFile(filePath, JSON.stringify({
    activeProviderId: "ollama", installedAgents: [], runs: [], tenants: options.tenants ?? [],
  }));
  const interactiveRequests: string[][] = [];
  const loginHints: Array<string | undefined> = [];
  const interactiveAuthorities: Array<string | undefined> = [];
  const silentRequests: Array<{ scopes: string[]; forceRefresh?: boolean }> = [];
  const silentTargets: Array<{ tenantId: string; authority?: string }> = [];
  const store = new AppStateStore({
    filePath, userDataPath: dir, statsApiUrl: "", appVersion: "0.7.2",
    tokenStore: { read: async () => "", write: async () => undefined },
    tokenStoreFor: () => ({ read: async () => "", write: async () => undefined }),
    interactiveSignIn: async ({ scopes, loginHint, authority }) => {
      interactiveRequests.push([...(scopes ?? [])]);
      loginHints.push(loginHint);
      interactiveAuthorities.push(authority);
      return {
        account: options.interactive?.account ?? { homeAccountId: "home.contoso-tenant-id", tenantId: "contoso-tenant-id", username: "admin@contoso.example" },
        scopes: options.interactive?.scopes ?? [],
        accessToken: options.interactive?.accessToken ?? "",
      } as never;
    },
  });
  if (options.silent) {
    const silent = options.silent;
    const accounts = options.accounts ?? [CONNECTED];
    Object.defineProperty(store, "msalClientForTenant", { value: () => ({
      getTokenCache: () => ({
        getAllAccounts: async () => accounts,
        // MSAL returns the first profile with this homeAccountId.
        getAccountByHomeId: async (id: string) => accounts.find((entry) => entry.homeAccountId === id) ?? null,
      }),
      acquireTokenSilent: async (request: SilentRequest) => {
        silentRequests.push({ scopes: request.scopes, ...(request.forceRefresh ? { forceRefresh: true } : {}) });
        silentTargets.push({ tenantId: request.account.tenantId, ...(request.authority ? { authority: request.authority } : {}) });
        const result = await silent(request);
        const account = result.account ?? request.account;
        return { ...result, account, tenantId: account.tenantId };
      },
    }) });
  }
  return {
    store,
    interactiveRequests,
    loginHints,
    interactiveAuthorities,
    silentRequests,
    silentTargets,
    async close() {
      for (const tenant of (await store.getAppState().catch(() => undefined))?.tenants ?? []) {
        await store.cancelGraphCachePreload(tenant.id).catch(() => undefined);
      }
      store.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

describe("own app registration grants", () => {
  it("signs in with .default and stores the decoded scp grants, never .default", async () => {
    const fixture = await makeFixture({
      interactive: {
        scopes: [DEFAULT_SCOPE, "openid", "profile", "offline_access"],
        accessToken: token("User.Read DeviceManagementApps.Read.All Policy.Read.All"),
      },
    });
    try {
      // Parts are ignored for an own registration: the app decides.
      const state = await fixture.store.connectTenant({
        appRegistration: { clientId: CUSTOM_CLIENT_ID },
        partIds: ["defender.score"],
      });
      assert.deepEqual(fixture.interactiveRequests[0], [DEFAULT_SCOPE, "offline_access"]);
      assert.deepEqual(state.tenants[0]?.grantedScopes, [
        "graph:User.Read",
        "graph:DeviceManagementApps.Read.All",
        "graph:Policy.Read.All",
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("stores MSAL's returned scopes when they list real permissions", async () => {
    const fixture = await makeFixture({
      interactive: { scopes: ["User.Read", "AuditLog.Read.All", "openid"], accessToken: token("Ignored.Read.All") },
    });
    try {
      const state = await fixture.store.connectTenant({ appRegistration: { clientId: CUSTOM_CLIENT_ID } });
      assert.deepEqual(state.tenants[0]?.grantedScopes, ["graph:User.Read", "graph:AuditLog.Read.All"]);
    } finally {
      await fixture.close();
    }
  });

  it("Check again replaces the grants from a force-refreshed .default token", async () => {
    const fixture = await makeFixture({
      tenants: [customTenant(["graph:User.Read"])],
      silent: async () => ({ scopes: [DEFAULT_SCOPE], accessToken: token("User.Read SecurityEvents.Read.All") }),
    });
    try {
      const state = await fixture.store.refreshTenantGrants("contoso-tenant-id");
      assert.deepEqual(fixture.silentRequests[0], { scopes: [DEFAULT_SCOPE, "offline_access"], forceRefresh: true });
      assert.deepEqual(state.tenants[0]?.grantedScopes, ["graph:User.Read", "graph:SecurityEvents.Read.All"]);
      assert.equal(fixture.interactiveRequests.length, 0);
    } finally {
      await fixture.close();
    }
  });

  it("Check again says when Microsoft returned no new permissions", async () => {
    const fixture = await makeFixture({
      tenants: [customTenant(["graph:User.Read"])],
      silent: async () => ({ scopes: ["User.Read"], accessToken: token("User.Read") }),
    });
    try {
      await assert.rejects(
        fixture.store.refreshTenantGrants("contoso-tenant-id"),
        { name: "TenantGrantsUnchangedError", message: "Microsoft returned no new permissions. Admin consent can take a minute to appear." },
      );
    } finally {
      await fixture.close();
    }
  });

  it("Check again falls back to interactive sign-in when interaction is required", async () => {
    const fixture = await makeFixture({
      tenants: [customTenant(["graph:User.Read"])],
      silent: async () => { throw new InteractionRequiredAuthError("interaction_required", "Interaction required."); },
      interactive: { scopes: [DEFAULT_SCOPE], accessToken: token("User.Read Application.Read.All") },
    });
    try {
      const state = await fixture.store.refreshTenantGrants("contoso-tenant-id");
      assert.deepEqual(fixture.interactiveRequests[0], [DEFAULT_SCOPE, "offline_access"]);
      assert.deepEqual(fixture.loginHints, ["admin@contoso.example"]);
      assert.deepEqual(state.tenants[0]?.grantedScopes, ["graph:User.Read", "graph:Application.Read.All"]);
    } finally {
      await fixture.close();
    }
  });

  for (const [label, account, message] of [
    [
      "a different account",
      { homeAccountId: "other.fabrikam-tenant-id", tenantId: "fabrikam-tenant-id", username: "it@fabrikam.example" },
      "Signed in as it@fabrikam.example, but this tenant is connected as admin@contoso.example. Sign in as admin@contoso.example and try again.",
    ],
    [
      "the same account in another directory",
      { homeAccountId: "home.contoso-tenant-id", tenantId: "fabrikam-tenant-id", username: "admin@contoso.example" },
      "Signed in as admin@contoso.example to directory fabrikam-tenant-id, but this tenant is directory contoso-tenant-id, connected as admin@contoso.example. Sign in as admin@contoso.example to that directory and try again.",
    ],
  ] as const) {
    it(`Check again saves nothing when ${label} signs in`, async () => {
      const fixture = await makeFixture({
        tenants: [customTenant(["graph:User.Read"])],
        silent: async () => { throw new InteractionRequiredAuthError("interaction_required", "Interaction required."); },
        interactive: { scopes: [DEFAULT_SCOPE], accessToken: token("User.Read Application.Read.All"), account },
      });
      try {
        await assert.rejects(fixture.store.refreshTenantGrants("contoso-tenant-id"), {
          name: "TenantAccountMismatchError",
          message,
        });
        const state = await fixture.store.getAppState();
        assert.deepEqual(state.tenants[0]?.grantedScopes, ["graph:User.Read"]);
        assert.equal(state.tenants[0]?.homeAccountId, "home.contoso-tenant-id");
      } finally {
        await fixture.close();
      }
    });
  }

  describe("Check again for a guest with profiles in two directories", () => {
    // One homeAccountId, a profile in the guest's home directory listed
    // first, and a profile in the connected directory.
    const homeProfile: Account = { homeAccountId: "home.contoso-tenant-id", tenantId: "home-tenant-id", username: "admin@contoso.example" };
    const accounts = [homeProfile, CONNECTED];

    it("refreshes the stored directory's profile through its own authority", async () => {
      const fixture = await makeFixture({
        tenants: [customTenant(["graph:User.Read"])],
        accounts,
        silent: async () => ({ scopes: [DEFAULT_SCOPE], accessToken: token("User.Read SecurityEvents.Read.All") }),
      });
      try {
        const state = await fixture.store.refreshTenantGrants("contoso-tenant-id");
        assert.deepEqual(fixture.silentTargets, [
          { tenantId: "contoso-tenant-id", authority: "https://login.microsoftonline.com/contoso-tenant-id" },
        ]);
        assert.deepEqual(state.tenants[0]?.grantedScopes, ["graph:User.Read", "graph:SecurityEvents.Read.All"]);
      } finally {
        await fixture.close();
      }
    });

    it("saves nothing when the silent token is for another directory", async () => {
      const fixture = await makeFixture({
        tenants: [customTenant(["graph:User.Read"])],
        accounts,
        silent: async () => ({
          scopes: [DEFAULT_SCOPE],
          accessToken: token("User.Read Application.Read.All"),
          account: homeProfile,
        }),
      });
      try {
        await assert.rejects(fixture.store.refreshTenantGrants("contoso-tenant-id"), {
          name: "TenantAccountMismatchError",
          message:
            "Signed in as admin@contoso.example to directory home-tenant-id, but this tenant is directory contoso-tenant-id, connected as admin@contoso.example. Sign in as admin@contoso.example to that directory and try again.",
        });
        assert.equal(fixture.interactiveRequests.length, 0);
        const state = await fixture.store.getAppState();
        assert.deepEqual(state.tenants[0]?.grantedScopes, ["graph:User.Read"]);
      } finally {
        await fixture.close();
      }
    });

    it("signs in to the stored directory when only another directory's profile is cached", async () => {
      const fixture = await makeFixture({
        tenants: [customTenant(["graph:User.Read"])],
        accounts: [homeProfile],
        silent: async () => ({ scopes: [DEFAULT_SCOPE], accessToken: token("User.Read Application.Read.All") }),
        interactive: { scopes: [DEFAULT_SCOPE], accessToken: token("User.Read AuditLog.Read.All") },
      });
      try {
        const state = await fixture.store.refreshTenantGrants("contoso-tenant-id");
        assert.equal(fixture.silentRequests.length, 0);
        assert.deepEqual(fixture.interactiveAuthorities, ["https://login.microsoftonline.com/contoso-tenant-id"]);
        assert.deepEqual(state.tenants[0]?.grantedScopes, ["graph:User.Read", "graph:AuditLog.Read.All"]);
      } finally {
        await fixture.close();
      }
    });
  });

  it("Check again points the OpenAdminOS app to Add access", async () => {
    const fixture = await makeFixture({
      tenants: [{ ...customTenant(["graph:User.Read"]), appRegistration: { kind: "openadminos", clientId: "d1de0a94-f67a-421d-8804-a235955ffd69" } }],
      silent: async () => ({ scopes: [], accessToken: "" }),
    });
    try {
      await assert.rejects(fixture.store.refreshTenantGrants("contoso-tenant-id"), /Use Add access in Settings, Tenants/);
      assert.equal(fixture.silentRequests.length, 0);
    } finally {
      await fixture.close();
    }
  });
});
