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
    getTokenCache: () => ({ getAllAccounts: async () => [] }),
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
    msalClientForTenant: () => ({ getTokenCache: () => ({ getAllAccounts: async () => [] }) }),
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
  const authorities: Array<string | undefined> = [];
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
    msalClientForTenant: (tenant: { id: string; homeAccountId: string; appRegistration?: { clientId: string } }) => {
      resolvedFor.push({ tenantId: tenant.id, ...(tenant.appRegistration ? { clientId: tenant.appRegistration.clientId } : {}) });
      const clientId = tenant.appRegistration?.clientId ?? "default";
      return {
        getTokenCache: () => ({ getAllAccounts: async () => {
          accountLookups.push(`${clientId}:${tenant.homeAccountId}`);
          return [{ homeAccountId: tenant.homeAccountId, tenantId: tenant.id, username: "admin@contoso.example" }];
        } }),
        acquireTokenSilent: async (request: { scopes: string[]; authority?: string }) => {
          authorities.push(request.authority);
          return {
            accessToken: `token-${clientId}`,
            scopes: request.scopes,
            expiresOn: new Date(Date.now() + 3_600_000),
            account: { homeAccountId: "byo-home", tenantId: "tenant-byo", username: "admin@contoso.example" },
            tenantId: "tenant-byo",
          };
        },
      };
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
  const graphCalls: Array<{ url: string; authorization: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    graphCalls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    if (url.endsWith("/sendMail")) return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ id: "message-1", webUrl: "https://teams.example/message-1" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  let teamsResult: { error?: string };
  let outlookResult: { error?: string };
  try {
    teamsResult = await internal.deliverRunToTeams(run);
    outlookResult = await internal.deliverRunToOutlook(run);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(teamsResult.error, undefined);
  assert.equal(outlookResult.error, undefined);
  assert.ok(graphCalls.some((call) => call.url.endsWith("/teams/team/channels/channel/messages")));
  assert.ok(graphCalls.some((call) => call.url.endsWith("/me/sendMail")));
  assert.ok(graphCalls.every((call) => call.authorization === `Bearer token-${byoRegistration.clientId}`));
  assert.deepEqual(resolvedFor, [
    { tenantId: "tenant-byo", clientId: byoRegistration.clientId },
    { tenantId: "tenant-byo", clientId: byoRegistration.clientId },
  ]);
  assert.ok(accountLookups.length > 0);
  assert.ok(accountLookups.every((entry) => entry === `${byoRegistration.clientId}:byo-home`));
  // The registration's host, with the stored directory.
  assert.ok(authorities.length > 0);
  assert.ok(authorities.every((authority) => authority === "https://login.microsoftonline.com/tenant-byo"));
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
    getTokenCache: () => ({ getAllAccounts: async () => [] }),
  }) });
  try {
    const internal = store as unknown as { buildGraph(tenant: string, scopes: string[]): Promise<{ createGraph(log: () => void): RunGraphApi }> };
    const selection = await internal.buildGraph("tenant-1", ["Policy.Read.All"]);
    await assert.rejects(
      selection.createGraph(() => undefined).request({ method: "GET", path: "/identity/conditionalAccess/policies" }),
      /This needs Entra Conditional Access and policies, which is not granted for Test\. Add it in Settings, Tenants\./,
    );
    assert.equal(browserCalls, 0);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
