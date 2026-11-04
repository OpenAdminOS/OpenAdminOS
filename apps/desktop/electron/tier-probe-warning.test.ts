import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { InteractionRequiredAuthError } from "@azure/msal-node";
import type { AppState, TenantRecord } from "@openadminos/agent-sdk";
import type { runInteractiveFlow } from "@openadminos/runtime";

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
type InteractiveInput = Parameters<typeof runInteractiveFlow>[0];

async function makeFixture(options: {
  tenants: TenantRecord[];
  signIns: Account[];
  /** Answers `/subscribedSkus`. Defaults to an empty subscription list. */
  respond?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Replaces the interactive sign-in. */
  interactive?: (input: InteractiveInput) => Promise<unknown>;
  /** Replaces the silent `.default` request that Check again makes. */
  silentDefault?: (request: { scopes: string[] }) => Promise<unknown>;
  /** Replaces the token cache's account list. */
  accounts?: () => Promise<unknown[]>;
  deadlineMs?: number;
}) {
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
    ...(options.deadlineMs ? { tenantCheckDeadlineMs: options.deadlineMs } : {}),
    interactiveSignIn: async (input) => {
      if (options.interactive) return (await options.interactive(input)) as never;
      const { scopes } = input;
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
      getAllAccounts: options.accounts ?? (async () => [CONNECTED]),
      getAccountByHomeId: async (id: string) => (id === CONNECTED.homeAccountId ? CONNECTED : null),
    }),
    acquireTokenSilent: async (request: { scopes: string[] }) => {
      if (request.scopes.includes(DEFAULT_SCOPE)) {
        if (options.silentDefault) return options.silentDefault(request);
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
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    fetches.push(String(input));
    if (options.respond && String(input).endsWith("/subscribedSkus")) return options.respond(String(input), init);
    return new Response(JSON.stringify({ value: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return {
    store,
    fetches,
    /** Holds the store's write queue until the returned function is called. */
    holdWrites(): () => void {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      void (store as unknown as { serialize(work: () => Promise<void>): Promise<void> }).serialize(() => gate);
      return release;
    },
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
      tierProbeWarning: { message: MISMATCH, reason: "account-mismatch", accountMismatch: true, at: "2026-11-03T10:00:00.000Z" },
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

const SKUS = {
  value: [{
    skuPartNumber: "SPE_E5",
    capabilityStatus: "Enabled",
    prepaidUnits: { enabled: 25 },
    consumedUnits: 20,
    servicePlans: [{ servicePlanName: "AAD_PREMIUM_P2", provisioningStatus: "Success" }],
  }],
};
const skusResponse = async () => Response.json(SKUS);
const SHARED: TenantRecord = { ...LICENSED, appRegistration: { kind: "openadminos", clientId: "11111111-2222-4333-8444-555555555555" } };
const OWN: TenantRecord = { ...LICENSED, appRegistration: { kind: "custom", clientId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" } };
const OLD_WARNING = {
  message: MISMATCH,
  reason: "account-mismatch" as const,
  accountMismatch: true,
  at: "2026-11-03T10:00:00.000Z",
};

/** Like runInteractiveFlow: waits until its signal aborts. */
function waitForAbort(input: InteractiveInput): Promise<never> {
  return new Promise((_resolve, reject) => {
    input.signal?.addEventListener("abort", () => {
      const error = new Error("Tenant sign-in was cancelled.");
      error.name = "TenantConnectCancelledError";
      reject(error);
    }, { once: true });
  });
}

/** A fetch that only settles when its request signal aborts. */
function hangingFetch(seen: AbortSignal[]) {
  return (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      if (init?.signal) seen.push(init.signal);
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
}

async function until(condition: () => Promise<boolean>): Promise<void> {
  await waitFor(async () => ((await condition()) ? true : undefined));
}

describe("license check failures keep the stored tier and licenses", () => {
  const cancelledSignIn = async () => {
    const error = new Error("Tenant sign-in was cancelled.");
    error.name = "TenantConnectCancelledError";
    throw error;
  };
  const cases: Array<{
    label: string;
    respond?: () => Promise<Response>;
    interactive?: () => Promise<unknown>;
    expected: Record<string, unknown>;
  }> = [
    { label: "HTTP 403", respond: async () => new Response("Forbidden", { status: 403 }), expected: { reason: "http", status: 403, message: "Microsoft Graph answered /subscribedSkus with HTTP 403." } },
    { label: "HTTP 503", respond: async () => new Response("Unavailable", { status: 503 }), expected: { reason: "http", status: 503 } },
    { label: "a network error", respond: async () => { throw new TypeError("fetch failed"); }, expected: { reason: "network", message: "Microsoft Graph could not be reached for /subscribedSkus: fetch failed" } },
    { label: "a malformed response", respond: async () => Response.json({ value: "invalid" }), expected: { reason: "malformed" } },
    { label: "a cancelled sign-in", interactive: cancelledSignIn, expected: { reason: "cancelled", message: "The Microsoft sign-in for the license check was cancelled." } },
  ];
  for (const { label, respond, interactive, expected } of cases) {
    it(`saves ${label} as a warning with its reason`, async () => {
      const fixture = await makeFixture({
        tenants: [LICENSED],
        signIns: [CONNECTED],
        ...(respond ? { respond } : {}),
        ...(interactive ? { interactive } : {}),
      });
      try {
        await fixture.store.probeAllTenants();
        const tenant = await fixture.tenant();
        assertTierKept(tenant);
        assert.equal(tenant?.intuneLicensed, LICENSED.intuneLicensed);
        for (const [key, value] of Object.entries(expected)) {
          assert.equal((tenant?.tierProbeWarning as Record<string, unknown> | undefined)?.[key], value, key);
        }
        assert.equal(tenant?.tierProbeWarning?.accountMismatch, false);
      } finally {
        await fixture.close();
      }
    });
  }

  it("does not check or warn when Organization.Read.All is not granted", async () => {
    const notGranted: TenantRecord = { ...LICENSED, grantedScopes: ["graph:User.Read"] };
    const fixture = await makeFixture({ tenants: [notGranted], signIns: [] });
    try {
      await fixture.store.probeAllTenants();
      const tenant = await fixture.tenant();
      assertTierKept(tenant);
      assert.equal(tenant?.tierProbeWarning, undefined);
      assert.deepEqual(fixture.fetches.filter((url) => url.endsWith("/subscribedSkus")), []);
    } finally {
      await fixture.close();
    }
  });

  it("Check again saves the new grants and the HTTP failure, not an unknown tier", async () => {
    const fixture = await makeFixture({
      tenants: [OWN],
      signIns: [CONNECTED],
      respond: async () => new Response("Server error", { status: 500 }),
    });
    try {
      const state = await fixture.store.refreshTenantGrants(OWN.id);
      const tenant = state.tenants.find((entry) => entry.id === OWN.id);
      assert.ok(tenant?.grantedScopes?.includes("graph:SecurityEvents.Read.All"));
      assertTierKept(tenant);
      assert.equal(tenant?.tierProbeWarning?.reason, "http");
      assert.equal(tenant?.tierProbeWarning?.status, 500);
    } finally {
      await fixture.close();
    }
  });
});

describe("retrying a license check", () => {
  it("Check again retries the probe when grants are unchanged and a warning exists", async () => {
    const unchanged: TenantRecord = {
      ...OWN,
      grantedScopes: ["graph:User.Read", "graph:Organization.Read.All", "graph:SecurityEvents.Read.All"],
      tierProbeWarning: OLD_WARNING,
    };
    const fixture = await makeFixture({ tenants: [unchanged], signIns: [CONNECTED], respond: skusResponse });
    try {
      const state = await fixture.store.refreshTenantGrants(unchanged.id);
      const tenant = state.tenants.find((entry) => entry.id === unchanged.id);
      assert.equal(tenant?.tierProbeWarning, undefined);
      assert.equal(tenant?.entraTier, "p2");
      assert.deepEqual(tenant?.relevantLicenses?.map((license) => license.skuPartNumber), ["SPE_E5"]);
      assert.deepEqual(tenant?.grantedScopes, unchanged.grantedScopes);
      assert.equal(fixture.fetches.filter((url) => url.endsWith("/subscribedSkus")).length, 1);
    } finally {
      await fixture.close();
    }
  });

  it("Check again still reports unchanged grants when no warning exists", async () => {
    const unchanged: TenantRecord = {
      ...OWN,
      grantedScopes: ["graph:User.Read", "graph:Organization.Read.All", "graph:SecurityEvents.Read.All"],
    };
    const fixture = await makeFixture({ tenants: [unchanged], signIns: [CONNECTED], respond: skusResponse });
    try {
      await assert.rejects(fixture.store.refreshTenantGrants(unchanged.id), { name: "TenantGrantsUnchangedError" });
      assert.deepEqual(fixture.fetches.filter((url) => url.endsWith("/subscribedSkus")), []);
    } finally {
      await fixture.close();
    }
  });

  for (const [label, tenant] of [["a shared-app tenant", SHARED], ["an own-registration tenant", OWN]] as const) {
    it(`Retry license check runs only the probe for ${label}`, async () => {
      const warned: TenantRecord = { ...tenant, tierProbeWarning: OLD_WARNING };
      const fixture = await makeFixture({ tenants: [warned], signIns: [CONNECTED], respond: skusResponse });
      try {
        const state = await fixture.store.retryTenantLicenseCheck(warned.id);
        const stored = state.tenants.find((entry) => entry.id === warned.id);
        assert.equal(stored?.tierProbeWarning, undefined);
        assert.equal(stored?.entraTier, "p2");
        assert.deepEqual(stored?.grantedScopes, warned.grantedScopes);
        assert.deepEqual(fixture.fetches.filter((url) => url.endsWith("/subscribedSkus")).length, 1);
      } finally {
        await fixture.close();
      }
    });
  }

  it("Retry license check replaces the warning when it fails again", async () => {
    const warned: TenantRecord = { ...SHARED, tierProbeWarning: OLD_WARNING };
    const fixture = await makeFixture({
      tenants: [warned],
      signIns: [CONNECTED],
      respond: async () => new Response("Forbidden", { status: 403 }),
    });
    try {
      const state = await fixture.store.retryTenantLicenseCheck(warned.id);
      const stored = state.tenants.find((entry) => entry.id === warned.id);
      assertTierKept(stored);
      assert.equal(stored?.tierProbeWarning?.reason, "http");
      assert.equal(stored?.tierProbeWarning?.status, 403);
    } finally {
      await fixture.close();
    }
  });

  it("Add access clears the warning and runs the license check for a shared-app tenant", async () => {
    const warned: TenantRecord = { ...SHARED, tierProbeWarning: OLD_WARNING };
    const fixture = await makeFixture({ tenants: [warned], signIns: [CONNECTED], respond: skusResponse });
    try {
      const state = await fixture.store.addTenantAccess(warned.id, ["defender.incidents"]);
      const stored = state.tenants.find((entry) => entry.id === warned.id);
      assert.equal(stored?.tierProbeWarning, undefined);
      assert.equal(stored?.entraTier, "p2");
      assert.ok(stored?.grantedScopes?.includes("graph:SecurityAlert.Read.All"));
      assert.equal(fixture.fetches.filter((url) => url.endsWith("/subscribedSkus")).length, 1);
    } finally {
      await fixture.close();
    }
  });

  it("Add access saves a probe that cannot finish as a new warning", async () => {
    const fixture = await makeFixture({
      tenants: [SHARED],
      signIns: [CONNECTED],
      respond: async () => { throw new TypeError("fetch failed"); },
    });
    try {
      const state = await fixture.store.addTenantAccess(SHARED.id, ["defender.incidents"]);
      const stored = state.tenants.find((entry) => entry.id === SHARED.id);
      assertTierKept(stored);
      assert.equal(stored?.tierProbeWarning?.reason, "network");
      assert.ok(stored?.grantedScopes?.includes("graph:SecurityAlert.Read.All"));
    } finally {
      await fixture.close();
    }
  });
});

const CANCELLED_AFTER_ACCESS =
  "Access was added. The license check was cancelled; the Entra tier and licenses are as they were. Retry license check to update them.";

describe("cancelling and timing out a tenant check", () => {
  it("shows the open Microsoft sign-in, and a cancel before a token saves nothing", async () => {
    const fixture = await makeFixture({
      tenants: [OWN],
      signIns: [],
      silentDefault: async () => {
        throw new InteractionRequiredAuthError("interaction_required", "Interaction required.");
      },
      interactive: waitForAbort,
    });
    try {
      const pending = fixture.store.refreshTenantGrants(OWN.id);
      pending.catch(() => undefined);
      await until(async () =>
        (await fixture.store.getAppState()).tenantChecks?.[0]?.phase === "sign-in",
      );
      assert.deepEqual((await fixture.store.getAppState()).tenantChecks, [
        { tenantId: OWN.id, kind: "permissions", phase: "sign-in" },
      ]);
      fixture.store.cancelTenantCheck(OWN.id);
      await assert.rejects(pending, {
        name: "TenantCheckCancelledError",
        message: "Check again was cancelled. OpenAdminOS saved nothing.",
      });
      const state = await fixture.store.getAppState();
      assert.equal(state.tenantChecks, undefined);
      const tenant = state.tenants.find((entry) => entry.id === OWN.id);
      assert.deepEqual(tenant?.grantedScopes, OWN.grantedScopes);
      assert.equal(tenant?.tierProbeWarning, undefined);
      assertTierKept(tenant);
    } finally {
      await fixture.close();
    }
  });

  it("Add access cancelled during sign-in says OpenAdminOS saved nothing", async () => {
    const fixture = await makeFixture({ tenants: [SHARED], signIns: [], interactive: waitForAbort });
    try {
      const pending = fixture.store.addTenantAccess(SHARED.id, ["defender.incidents"]);
      pending.catch(() => undefined);
      await until(async () =>
        (await fixture.store.getAppState()).tenantChecks?.[0]?.phase === "sign-in",
      );
      fixture.store.cancelTenantCheck(SHARED.id);
      await assert.rejects(pending, { message: "Sign-in was cancelled. OpenAdminOS saved nothing." });
      assert.deepEqual((await fixture.tenant())?.grantedScopes, SHARED.grantedScopes);
    } finally {
      await fixture.close();
    }
  });

  it("Check again cancelled during the license fetch keeps the new grants and records the cancel", async () => {
    const seen: AbortSignal[] = [];
    const fixture = await makeFixture({ tenants: [OWN], signIns: [CONNECTED], respond: hangingFetch(seen) });
    try {
      const pending = fixture.store.refreshTenantGrants(OWN.id);
      pending.catch(() => undefined);
      await until(async () => seen.length > 0);
      assert.equal((await fixture.store.getAppState()).tenantChecks?.[0]?.phase, "licenses");
      fixture.store.cancelTenantCheck(OWN.id);
      await assert.rejects(pending, {
        name: "TenantCheckCancelledError",
        message:
          "Permissions were updated. The license check was cancelled; the Entra tier and licenses are as they were. Retry license check to update them.",
      });
      assert.equal(seen[0]?.aborted, true);
      const warning = await waitFor(async () => (await fixture.tenant())?.tierProbeWarning);
      assert.equal(warning.reason, "cancelled");
      const tenant = await fixture.tenant();
      assert.ok(tenant?.grantedScopes?.includes("graph:SecurityEvents.Read.All"));
      assertTierKept(tenant);
    } finally {
      await fixture.close();
    }
  });

  it("Add access cancelled during the license check keeps the new access and says so", async () => {
    const seen: AbortSignal[] = [];
    const fixture = await makeFixture({ tenants: [SHARED], signIns: [CONNECTED], respond: hangingFetch(seen) });
    try {
      const pending = fixture.store.addTenantAccess(SHARED.id, ["defender.incidents"]);
      pending.catch(() => undefined);
      await until(async () => seen.length > 0);
      fixture.store.cancelTenantCheck(SHARED.id);
      await assert.rejects(pending, { name: "TenantCheckCancelledError", message: CANCELLED_AFTER_ACCESS });
      const warning = await waitFor(async () => (await fixture.tenant())?.tierProbeWarning);
      assert.equal(warning.reason, "cancelled");
      assert.equal(warning.message, "The license check was cancelled.");
      const tenant = await fixture.tenant();
      assert.ok(tenant?.grantedScopes?.includes("graph:SecurityAlert.Read.All"));
      assertTierKept(tenant);
    } finally {
      await fixture.close();
    }
  });

  it("a cancel while the grants wait behind another write still saves them and says so", async () => {
    let signedIn = false;
    const fixture = await makeFixture({
      tenants: [SHARED],
      signIns: [],
      interactive: async ({ scopes }) => {
        signedIn = true;
        return { account: CONNECTED, tenantId: CONNECTED.tenantId, scopes, accessToken: "interactive-token" };
      },
      respond: skusResponse,
    });
    try {
      const release = fixture.holdWrites();
      const pending = fixture.store.addTenantAccess(SHARED.id, ["defender.incidents"]);
      pending.catch(() => undefined);
      await until(async () => signedIn);
      fixture.store.cancelTenantCheck(SHARED.id);
      await assert.rejects(pending, { name: "TenantCheckCancelledError", message: CANCELLED_AFTER_ACCESS });
      assert.equal((await fixture.store.getAppState()).tenantChecks, undefined);
      release();
      const tenant = await waitFor(async () => {
        const stored = await fixture.tenant();
        return stored?.tierProbeWarning ? stored : undefined;
      });
      assert.ok(tenant.grantedScopes?.includes("graph:SecurityAlert.Read.All"));
      assert.equal(tenant.tierProbeWarning?.reason, "cancelled");
      assertTierKept(tenant);
      assert.deepEqual(fixture.fetches.filter((url) => url.endsWith("/subscribedSkus")), []);
    } finally {
      await fixture.close();
    }
  });

  it("a cancelled Retry license check keeps the earlier warning", async () => {
    const warned: TenantRecord = { ...SHARED, tierProbeWarning: OLD_WARNING };
    const fixture = await makeFixture({ tenants: [warned], signIns: [], interactive: waitForAbort });
    try {
      const pending = fixture.store.retryTenantLicenseCheck(warned.id);
      pending.catch(() => undefined);
      await until(async () =>
        (await fixture.store.getAppState()).tenantChecks?.[0]?.phase === "sign-in",
      );
      fixture.store.cancelTenantCheck(warned.id);
      await assert.rejects(pending, {
        name: "TenantCheckCancelledError",
        message:
          "The license check was cancelled; the Entra tier and licenses are as they were. Retry license check to update them.",
      });
      const tenant = await fixture.tenant();
      assert.deepEqual(tenant?.tierProbeWarning, OLD_WARNING);
      assertTierKept(tenant);
    } finally {
      await fixture.close();
    }
  });

  it("a check that never gets a token stops at the deadline with grants unchanged", async () => {
    const fixture = await makeFixture({
      tenants: [OWN],
      signIns: [],
      silentDefault: () => new Promise(() => undefined),
      deadlineMs: 50,
    });
    try {
      await assert.rejects(fixture.store.refreshTenantGrants(OWN.id), {
        name: "TenantCheckTimeoutError",
        message: "Check again did not finish within 1 second. OpenAdminOS saved nothing. Choose Check again to try again.",
      });
      const tenant = await fixture.tenant();
      assert.deepEqual(tenant?.grantedScopes, OWN.grantedScopes);
      assert.equal((await fixture.store.getAppState()).tenantChecks, undefined);
    } finally {
      await fixture.close();
    }
  });

  it("a stalled token cache read reaches the deadline and releases the tenant", async () => {
    const fixture = await makeFixture({
      tenants: [OWN],
      signIns: [],
      accounts: () => new Promise(() => undefined),
      deadlineMs: 50,
    });
    try {
      await assert.rejects(fixture.store.refreshTenantGrants(OWN.id), { name: "TenantCheckTimeoutError" });
      assert.equal((await fixture.store.getAppState()).tenantChecks, undefined);
      // The next check starts instead of reporting a check in progress.
      await assert.rejects(fixture.store.retryTenantLicenseCheck(OWN.id), { name: "TenantCheckTimeoutError" });
      assertTierKept(await fixture.tenant());
    } finally {
      await fixture.close();
    }
  });

  it("a license fetch that does not answer before the deadline keeps the new grants and saves a timeout warning", async () => {
    const seen: AbortSignal[] = [];
    const fixture = await makeFixture({ tenants: [OWN], signIns: [CONNECTED], respond: hangingFetch(seen), deadlineMs: 80 });
    try {
      await assert.rejects(fixture.store.refreshTenantGrants(OWN.id), {
        name: "TenantCheckTimeoutError",
        message:
          "Permissions were updated. The license check did not finish within 1 second; the Entra tier and licenses are as they were. Retry license check to update them.",
      });
      const warning = await waitFor(async () => (await fixture.tenant())?.tierProbeWarning);
      assert.equal(warning.reason, "timeout");
      assert.equal(warning.message, "The license check did not finish within 1 second.");
      const tenant = await fixture.tenant();
      assert.ok(tenant?.grantedScopes?.includes("graph:SecurityEvents.Read.All"));
      assertTierKept(tenant);
      assert.equal(seen[0]?.aborted, true);
    } finally {
      await fixture.close();
    }
  });
});

describe("one operation per tenant connection", () => {
  it("a reconnect during a running check discards the old check's result", async () => {
    const lateToken = { resolve: (_value: unknown) => undefined as void };
    let calls = 0;
    const fixture = await makeFixture({
      tenants: [{ ...SHARED, connectionId: "connection-1" }],
      signIns: [],
      // Add access gets a sign-in that ignores its signal and answers late;
      // the reconnect signs in at once.
      interactive: ({ scopes }) => {
        calls += 1;
        if (calls === 1) return new Promise((resolve) => { lateToken.resolve = resolve; });
        return Promise.resolve({ account: CONNECTED, tenantId: CONNECTED.tenantId, scopes, accessToken: "token" });
      },
    });
    try {
      const pending = fixture.store.addTenantAccess(SHARED.id, ["defender.incidents"]);
      pending.catch(() => undefined);
      await until(async () =>
        (await fixture.store.getAppState()).tenantChecks?.[0]?.phase === "sign-in",
      );
      await fixture.store.connectTenant({});
      await assert.rejects(pending, { name: "TenantCheckSupersededError" });
      lateToken.resolve({
        account: CONNECTED,
        tenantId: CONNECTED.tenantId,
        scopes: ["SecurityAlert.Read.All", "SecurityIncident.Read.All"],
        accessToken: "late-token",
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const tenant = await fixture.tenant();
      assert.notEqual(tenant?.connectionId, "connection-1");
      assert.equal(tenant?.grantedScopes?.includes("graph:SecurityAlert.Read.All"), false);
    } finally {
      await fixture.close();
    }
  });

  it("a slow background license check cannot overwrite a newer successful retry", async () => {
    const lateAnswer = { resolve: (_value: Response) => undefined as void };
    let skuCalls = 0;
    const fixture = await makeFixture({
      tenants: [],
      signIns: [CONNECTED],
      // The first /subscribedSkus request ignores its signal and answers late.
      respond: () => {
        skuCalls += 1;
        if (skuCalls === 1) return new Promise((resolve) => { lateAnswer.resolve = resolve; });
        return skusResponse();
      },
    });
    try {
      await fixture.store.connectTenant({});
      await until(async () => skuCalls === 1);
      assert.deepEqual((await fixture.store.getAppState()).tenantChecks, [
        { tenantId: CONNECTED.tenantId, kind: "license", phase: "licenses" },
      ]);
      await assert.rejects(fixture.store.retryTenantLicenseCheck(CONNECTED.tenantId), { name: "TenantCheckBusyError" });
      fixture.store.cancelTenantCheck(CONNECTED.tenantId);
      await until(async () => (await fixture.store.getAppState()).tenantChecks === undefined);
      const retried = await fixture.store.retryTenantLicenseCheck(CONNECTED.tenantId);
      assert.equal(retried.tenants[0]?.entraTier, "p2");
      lateAnswer.resolve(Response.json({ value: [] }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const tenant = await fixture.tenant();
      assert.equal(tenant?.entraTier, "p2");
      assert.equal(tenant?.tierProbeWarning, undefined);
    } finally {
      await fixture.close();
    }
  });
});
