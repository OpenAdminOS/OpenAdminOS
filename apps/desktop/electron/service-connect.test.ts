import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { partIdsFor } from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

import { AppStateStore } from "./state.js";

const G = "https://graph.microsoft.com/";

async function makeFixture(options: {
  initial?: Record<string, unknown>;
  returnedScopes: (requested: string[]) => string[];
  account?: { homeAccountId: string; tenantId: string; username: string };
}) {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-service-connect-"));
  const statePath = join(dir, "state.json");
  await writeFile(
    statePath,
    JSON.stringify({ activeProviderId: "ollama", installedAgents: [], runs: [], tenants: [], ...options.initial }),
    "utf8",
  );
  const storage: TokenCacheStorage = { read: async () => "", write: async () => undefined };
  const requests: string[][] = [];
  const loginHints: Array<string | undefined> = [];
  const store = new AppStateStore({
    filePath: statePath,
    tokenStore: storage,
    tokenStoreFor: () => storage,
    userDataPath: dir,
    statsApiUrl: "",
    appVersion: "0.7.2",
    interactiveSignIn: async ({ scopes, loginHint }) => {
      requests.push([...(scopes ?? [])]);
      loginHints.push(loginHint);
      return {
        account: options.account ?? {
          homeAccountId: "home.contoso-tenant-id",
          tenantId: "contoso-tenant-id",
          username: "admin@contoso.example",
        },
        scopes: options.returnedScopes(scopes ?? []),
      } as never;
    },
  });
  return {
    store,
    requests,
    loginHints,
    async persistedGrants(): Promise<unknown> {
      const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
        tenants: Array<{ grantedScopes?: unknown }>;
      };
      return persisted.tenants[0]?.grantedScopes;
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

describe("connecting by service part", () => {
  it("requests exactly the baseline plus the Intune part scopes for Intune only", async () => {
    const fixture = await makeFixture({ returnedScopes: (requested) => requested });
    try {
      await fixture.store.connectTenant({ partIds: partIdsFor(["intune"]) });
      assert.deepEqual(fixture.requests[0], [
        "openid",
        "profile",
        "offline_access",
        `${G}User.Read`,
        `${G}User.Read.All`,
        `${G}GroupMember.Read.All`,
        `${G}Organization.Read.All`,
        `${G}DeviceManagementManagedDevices.Read.All`,
        `${G}DeviceManagementConfiguration.Read.All`,
        `${G}DeviceManagementServiceConfig.Read.All`,
        `${G}DeviceManagementScripts.Read.All`,
        `${G}DeviceManagementRBAC.Read.All`,
        `${G}Device.Read.All`,
        `${G}DeviceManagementApps.Read.All`,
      ]);
      assert.equal(fixture.requests[0]!.some((scope) => scope.endsWith("Directory.Read.All")), false);
    } finally {
      await fixture.close();
    }
  });

  it("stores only the qualified scopes the token returned", async () => {
    const fixture = await makeFixture({
      returnedScopes: () => ["openid", "profile", "User.Read", "DeviceManagementApps.Read.All"],
    });
    try {
      const state = await fixture.store.connectTenant({ partIds: ["intune.apps", "intune.devices"] });
      assert.deepEqual(state.tenants[0]?.grantedScopes, [
        "graph:User.Read",
        "graph:DeviceManagementApps.Read.All",
      ]);
      assert.deepEqual(await fixture.persistedGrants(), state.tenants[0]?.grantedScopes);
    } finally {
      await fixture.close();
    }
  });

  it("consents only the added parts and merges them into the existing grants", async () => {
    const fixture = await makeFixture({
      initial: {
        activeTenantId: "contoso-tenant-id",
        tenants: [{
          id: "contoso-tenant-id",
          displayName: "Contoso",
          username: "admin@contoso.example",
          homeAccountId: "home.contoso-tenant-id",
          addedAt: "2026-11-04T10:00:00.000Z",
          appRegistration: { kind: "openadminos", clientId: "d1de0a94-f67a-421d-8804-a235955ffd69" },
          grantedScopes: ["graph:User.Read", "graph:DeviceManagementApps.Read.All"],
        }],
      },
      returnedScopes: () => ["SecurityAlert.Read.All", "SecurityIncident.Read.All"],
    });
    try {
      const state = await fixture.store.addTenantAccess("contoso-tenant-id", ["defender.incidents"]);
      assert.deepEqual(fixture.requests[0], [`${G}SecurityAlert.Read.All`, `${G}SecurityIncident.Read.All`]);
      assert.deepEqual(fixture.loginHints, ["admin@contoso.example"]);
      assert.deepEqual(state.tenants[0]?.grantedScopes, [
        "graph:DeviceManagementApps.Read.All",
        "graph:SecurityAlert.Read.All",
        "graph:SecurityIncident.Read.All",
        "graph:User.Read",
      ]);
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
    it(`Add access saves nothing when ${label} signs in`, async () => {
      const fixture = await makeFixture({
        initial: {
          activeTenantId: "contoso-tenant-id",
          tenants: [{
            id: "contoso-tenant-id",
            displayName: "Contoso",
            username: "admin@contoso.example",
            homeAccountId: "home.contoso-tenant-id",
            addedAt: "2026-11-04T10:00:00.000Z",
            appRegistration: { kind: "openadminos", clientId: "d1de0a94-f67a-421d-8804-a235955ffd69" },
            grantedScopes: ["graph:User.Read"],
          }],
        },
        returnedScopes: () => ["SecurityAlert.Read.All", "SecurityIncident.Read.All"],
        account,
      });
      try {
        await assert.rejects(fixture.store.addTenantAccess("contoso-tenant-id", ["defender.incidents"]), {
          name: "TenantAccountMismatchError",
          message,
        });
        assert.deepEqual(await fixture.persistedGrants(), ["graph:User.Read"]);
      } finally {
        await fixture.close();
      }
    });
  }

  it("asks an own registration to add permissions on the app instead of consenting", async () => {
    const fixture = await makeFixture({
      initial: {
        tenants: [{
          id: "contoso-tenant-id",
          displayName: "Contoso",
          username: "admin@contoso.example",
          homeAccountId: "home.contoso-tenant-id",
          addedAt: "2026-11-04T10:00:00.000Z",
          appRegistration: { kind: "custom", clientId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
          grantedScopes: ["graph:User.Read"],
        }],
      },
      returnedScopes: (requested) => requested,
    });
    try {
      await assert.rejects(
        fixture.store.addTenantAccess("contoso-tenant-id", ["defender.score"]),
        /Add these permissions to your app registration, then choose Check again\./,
      );
      await assert.rejects(
        fixture.store.addTenantAccess("contoso-tenant-id", ["defender.hunting"]),
        /Add these permissions to your app registration/,
      );
      assert.equal(fixture.requests.length, 0);
    } finally {
      await fixture.close();
    }
  });

  it("refuses planned and unknown parts", async () => {
    const fixture = await makeFixture({
      initial: {
        tenants: [{
          id: "contoso-tenant-id",
          displayName: "Contoso",
          username: "admin@contoso.example",
          homeAccountId: "home.contoso-tenant-id",
          addedAt: "2026-11-04T10:00:00.000Z",
          grantedScopes: [],
        }],
      },
      returnedScopes: (requested) => requested,
    });
    try {
      await assert.rejects(
        fixture.store.addTenantAccess("contoso-tenant-id", ["defender.hunting"]),
        /Choose a service part that can be added\./,
      );
      await assert.rejects(
        fixture.store.addTenantAccess("contoso-tenant-id", ["intune.unknown"]),
        /Choose a service part that can be added\./,
      );
      assert.equal(fixture.requests.length, 0);
    } finally {
      await fixture.close();
    }
  });

  it("skips the Entra tier probe when Organization.Read.All was not granted", async () => {
    const fixture = await makeFixture({ returnedScopes: () => ["SecurityAlert.Read.All", "SecurityIncident.Read.All"] });
    try {
      await fixture.store.connectTenant({ partIds: ["defender.incidents"] });
      await new Promise((resolve) => setTimeout(resolve, 20));
      // One sign-in for the connect itself, no consent prompt from the probe.
      assert.equal(fixture.requests.length, 1);
    } finally {
      await fixture.close();
    }
  });
});
