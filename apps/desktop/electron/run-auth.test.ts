import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { RunGraphApi } from "@openadminos/agent-sdk";
import { AppStateStore } from "./state.js";

it("scheduled Graph access fails with recovery instructions without opening Microsoft sign-in", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-scheduled-auth-"));
  const filePath = join(dir, "state.json");
  await writeFile(filePath, JSON.stringify({ activeProviderId: "ollama", installedAgents: [], runs: [],
    activeTenantId: "tenant-1", tenants: [{ id: "tenant-1", displayName: "Test", username: "test@example.com", homeAccountId: "test", addedAt: new Date().toISOString() }] }));
  let browserCalls = 0;
  const store = new AppStateStore({ filePath, userDataPath: dir, statsApiUrl: "",
    tokenStore: { read: async () => "", write: async () => undefined },
    openBrowser: async () => { browserCalls += 1; },
  });
  // Force a missing cached account without contacting Microsoft.
  Object.defineProperty(store, "msalClientForTenant", { value: () => ({
    getTokenCache: () => ({ getAccountByHomeId: async () => null }),
  }) });
  try {
    const internal = store as unknown as { buildGraph(tenant: string, scopes: string[], execution: {
      signal: AbortSignal; allowInteractive: boolean; onAuthRequired(): Promise<void>;
    }): Promise<{ createGraph(log: () => void): RunGraphApi }> };
    const selection = await internal.buildGraph("tenant-1", ["Policy.Read.All"], {
      signal: new AbortController().signal, allowInteractive: false,
      onAuthRequired: async () => { throw new Error("Interactive flow must not start"); },
    });
    await assert.rejects(selection.createGraph(() => undefined).request({ method: "GET", path: "/identity/conditionalAccess/policies" }), /Scheduled run needs Microsoft sign-in/);
    assert.equal(browserCalls, 0);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

it("scheduled Teams and Outlook deliveries never open an unattended sign-in", async () => {
  const { RunDeliveryService } = await import("./run-delivery.js");
  let browserCalls = 0;
  const run = { id: "scheduled", agentSlug: "test", status: "completed", trigger: "schedule",
    queuedAt: new Date().toISOString(), summary: "Test completed", logs: [], steps: [], tenantId: "tenant-1" } as const;
  const settings = { enabled: true, includeScheduledRuns: true, notifyOnSuccess: true };
  const host = {
    read: async () => ({ installedAgents: [{ id: "test", slug: "test", name: "Test", delivery: {
      teams: { ...settings, useDefaultTarget: true }, outlook: { ...settings, useDefaultRecipients: true },
    } }], tenants: [{ id: "tenant-1", displayName: "Test", homeAccountId: "test", username: "test@example.com" }],
    connectors: { teams: { config: { defaultTeamId: "team", defaultChannelId: "channel" } },
      outlook: { config: { defaultRecipients: "test@example.com" } } }, runs: [],
    }),
    msalClientForTenant: () => ({ getTokenCache: () => ({ getAccountByHomeId: async () => null }) }),
    openBrowser: async () => { browserCalls += 1; },
    connectorSecretsFor: () => ({ get: async () => undefined }),
    appendRunStep: async () => "step", finishRunStep: async () => undefined, appendRunLog: async () => undefined,
  };
  const service = new RunDeliveryService(host as unknown as import("./run-delivery.js").RunDeliveryHost);
  const internal = service as unknown as {
    deliverRunToTeams(run: unknown): Promise<{ error?: string }>;
    deliverRunToOutlook(run: unknown): Promise<{ error?: string }>;
  };
  assert.match((await internal.deliverRunToTeams(run)).error ?? "", /Scheduled notification needs Microsoft sign-in/);
  assert.match((await internal.deliverRunToOutlook(run)).error ?? "", /Scheduled notification needs Microsoft sign-in/);
  assert.equal(browserCalls, 0);
});

it("Teams and Outlook deliveries sign in with the tenant's own app registration", async () => {
  const { RunDeliveryService } = await import("./run-delivery.js");
  const run = { id: "scheduled", agentSlug: "test", status: "completed", trigger: "schedule",
    queuedAt: new Date().toISOString(), summary: "Test completed", logs: [], steps: [], tenantId: "tenant-byo" } as const;
  const settings = { enabled: true, includeScheduledRuns: true, notifyOnSuccess: true };
  const byoRegistration = { kind: "custom", clientId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    authority: "https://login.microsoftonline.com/contoso.onmicrosoft.com" } as const;
  const resolvedFor: Array<{ tenantId: string; clientId?: string }> = [];
  const accountLookups: string[] = [];
  const host = {
    read: async () => ({ installedAgents: [{ id: "test", slug: "test", name: "Test", delivery: {
      teams: { ...settings, useDefaultTarget: true }, outlook: { ...settings, useDefaultRecipients: true },
    } }], tenants: [
      { id: "tenant-default", displayName: "Default", homeAccountId: "default-home", username: "admin@default.example" },
      { id: "tenant-byo", displayName: "Contoso", homeAccountId: "byo-home", username: "admin@contoso.example",
        appRegistration: byoRegistration },
    ],
    activeTenantId: "tenant-default",
    connectors: { teams: { config: { defaultTeamId: "team", defaultChannelId: "channel" } },
      outlook: { config: { defaultRecipients: "test@example.com" } } }, runs: [],
    }),
    msalClientForTenant: (tenant: { id: string; appRegistration?: { clientId: string } }) => {
      resolvedFor.push({ tenantId: tenant.id, ...(tenant.appRegistration ? { clientId: tenant.appRegistration.clientId } : {}) });
      const clientId = tenant.appRegistration?.clientId ?? "default";
      return { getTokenCache: () => ({ getAccountByHomeId: async (homeAccountId: string) => {
        accountLookups.push(`${clientId}:${homeAccountId}`);
        return null;
      } }) };
    },
    openBrowser: async () => undefined,
    connectorSecretsFor: () => ({ get: async () => undefined }),
    appendRunStep: async () => "step", finishRunStep: async () => undefined, appendRunLog: async () => undefined,
  };
  const service = new RunDeliveryService(host as unknown as import("./run-delivery.js").RunDeliveryHost);
  const internal = service as unknown as {
    deliverRunToTeams(run: unknown): Promise<{ error?: string }>;
    deliverRunToOutlook(run: unknown): Promise<{ error?: string }>;
  };
  await internal.deliverRunToTeams(run);
  await internal.deliverRunToOutlook(run);
  assert.deepEqual(resolvedFor, [
    { tenantId: "tenant-byo", clientId: byoRegistration.clientId },
    { tenantId: "tenant-byo", clientId: byoRegistration.clientId },
  ]);
  assert.ok(accountLookups.length > 0);
  assert.ok(accountLookups.every((entry) => entry === `${byoRegistration.clientId}:byo-home`));
});

it("the delivery host resolves the MSAL client that connected the tenant", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-delivery-client-"));
  const filePath = join(dir, "state.json");
  const byoRegistration = { kind: "custom", clientId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    authority: "https://login.microsoftonline.com/contoso.onmicrosoft.com" } as const;
  await writeFile(filePath, JSON.stringify({ activeProviderId: "ollama", installedAgents: [], runs: [],
    activeTenantId: "tenant-byo", tenants: [{ id: "tenant-byo", displayName: "Contoso", username: "admin@contoso.example",
      homeAccountId: "byo-home", addedAt: new Date().toISOString(), appRegistration: byoRegistration }] }));
  const storesFor: string[] = [];
  const store = new AppStateStore({ filePath, userDataPath: dir, statsApiUrl: "",
    tokenStore: { read: async () => "", write: async () => undefined },
    tokenStoreFor: (clientId) => {
      storesFor.push(clientId);
      return { read: async () => "", write: async () => undefined };
    },
  });
  try {
    const internal = store as unknown as {
      runDeliveryService: { host: { msalClientForTenant(tenant: unknown): unknown } };
      msalClientFor(registration: unknown): unknown;
    };
    const tenant = (await store.getAppState()).tenants[0]!;
    const deliveryClient = internal.runDeliveryService.host.msalClientForTenant(tenant);
    assert.equal(deliveryClient, internal.msalClientFor(byoRegistration));
    assert.notEqual(deliveryClient, internal.msalClientFor(undefined));
    assert.deepEqual(storesFor, [byoRegistration.clientId]);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

it("Chat and cache Graph access never widens consent beyond the tenant's granted scopes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-granted-auth-"));
  const filePath = join(dir, "state.json");
  await writeFile(filePath, JSON.stringify({ activeProviderId: "ollama", installedAgents: [], runs: [],
    activeTenantId: "tenant-1", tenants: [{ id: "tenant-1", displayName: "Test", username: "test@example.com", homeAccountId: "test", addedAt: new Date().toISOString(),
      grantedScopes: ["User.Read.All", "GroupMember.Read.All", "Directory.Read.All", "Organization.Read.All"] }] }));
  let browserCalls = 0;
  const store = new AppStateStore({ filePath, userDataPath: dir, statsApiUrl: "",
    tokenStore: { read: async () => "", write: async () => undefined },
    openBrowser: async () => { browserCalls += 1; },
  });
  Object.defineProperty(store, "msalClientForTenant", { value: () => ({
    getTokenCache: () => ({ getAccountByHomeId: async () => null }),
  }) });
  try {
    const internal = store as unknown as { buildGraph(tenant: string, scopes: string[]): Promise<{ createGraph(log: () => void): RunGraphApi }> };
    const selection = await internal.buildGraph("tenant-1", ["Policy.Read.All"]);
    await assert.rejects(
      selection.createGraph(() => undefined).request({ method: "GET", path: "/identity/conditionalAccess/policies" }),
      /Policy\.Read\.All, which was not granted for Test\. Add the access in Settings, Tenants\./,
    );
    assert.equal(browserCalls, 0);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
