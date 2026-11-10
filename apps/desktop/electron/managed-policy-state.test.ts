import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  providerCatalog,
  type ManagedPolicyStatus,
  type ProviderId,
  type ProviderSummary,
} from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

import type { ConfigurationAuditEvent } from "./configuration-audit.js";
import { MCP_CATALOG, type McpCatalogEntry } from "./mcp/catalog.js";
import { McpHost, McpHostError } from "./mcp/host.js";
import { ManagedPolicyError, loadManagedPolicy } from "./managed-policy.js";
import { AppStateStore } from "./state.js";

const tokenStore: TokenCacheStorage = { read: async () => "", write: async () => undefined };
const MACHINE = "/etc/openadminos/policy.json";
const USER = "/home/admin/.config/openadminos/policy.json";
const CLIENT_ID = "aaaaaaaa-1111-2222-3333-444444444444";

async function policyOf(machine: unknown, user?: unknown): Promise<ManagedPolicyStatus | undefined> {
  const files: Record<string, string> = {};
  if (machine !== undefined) files[MACHINE] = typeof machine === "string" ? machine : JSON.stringify(machine, null, 2);
  if (user !== undefined) files[USER] = typeof user === "string" ? user : JSON.stringify(user, null, 2);
  return loadManagedPolicy({
    providerIds: providerCatalog.map((provider) => provider.id),
    publicReferenceIds: MCP_CATALOG.map((entry) => entry.id),
    paths: [
      { scope: "machine", path: MACHINE },
      { scope: "user", path: USER },
    ],
    read: async (path) => {
      const content = files[path];
      if (content === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return new TextEncoder().encode(content);
    },
  });
}

/** Every provider ready, each with one model; the CLIs report no model list. */
function readyProviders(): ProviderSummary[] {
  return providerCatalog.map((provider) => ({
    ...provider,
    status: "connected" as const,
    models: provider.isLocal ? [`${provider.id}-model`, `${provider.id}-other`] : [],
    ...(provider.isLocal ? { defaultModel: `${provider.id}-model` } : {}),
  }));
}

const catalog: McpCatalogEntry[] = [
  { ...MCP_CATALOG[0]!, id: "microsoft-learn", name: "Microsoft Learn", url: "http://127.0.0.1:9/mcp" },
  { ...MCP_CATALOG[0]!, id: "kql-search", name: "KQL Search", url: "http://127.0.0.1:9/kql" },
  // Built in, with the Splashtop logo; its host is never called by these tests.
  MCP_CATALOG.find((entry) => entry.id === "splashtop-packr-kb")!,
];

/**
 * Without `fresh`, the app is past its first run (no provider chosen yet);
 * with it, there is no state file, so the first-run scan is pending.
 */
async function makeFixture(
  options: { policy?: ManagedPolicyStatus; initial?: Record<string, unknown>; fresh?: boolean; providers?: () => ProviderSummary[] } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-managed-policy-"));
  const statePath = join(dir, "state.json");
  if (!options.fresh) {
    await writeFile(
      statePath,
      JSON.stringify({
        activeProviderId: "ollama",
        providerChosenByUser: false,
        installedAgents: [],
        runs: [],
        tenants: [],
        organizations: [],
        ...options.initial,
      }),
      "utf8",
    );
  }
  const llmCalls: Array<[ProviderId, string | undefined]> = [];
  const signIns: unknown[] = [];
  const open = (policy: ManagedPolicyStatus | undefined) =>
    new AppStateStore({
      filePath: statePath,
      tokenStore,
      tokenStoreFor: () => tokenStore,
      statsApiUrl: "",
      appVersion: "0.8.0",
      mcpCatalog: catalog,
      providerListFactory: options.providers ?? (() => readyProviders()),
      llmFactory: async (providerId, model) => {
        llmCalls.push([providerId, model]);
        return { available: true } as never;
      },
      interactiveSignIn: async (request) => {
        signIns.push(request);
        throw new Error("sign-in is not part of this test");
      },
      ...(policy ? { managedPolicy: policy } : {}),
    });
  let store = open(options.policy);
  await store.applyManagedPolicy();
  return {
    get store() {
      return store;
    },
    llmCalls,
    signIns,
    async relaunch(policy: ManagedPolicyStatus | undefined) {
      store.close();
      store = open(policy);
      await store.applyManagedPolicy();
      return store;
    },
    async persisted(): Promise<Record<string, unknown>> {
      return JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    },
    async audit(): Promise<ConfigurationAuditEvent[]> {
      return ((await this.persisted()).configurationAudit as ConfigurationAuditEvent[] | undefined) ?? [];
    },
    async close() {
      store.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

function buildLlm(store: AppStateStore, providerId: ProviderId, model?: string): Promise<unknown> {
  return (store as unknown as { buildLlm(id: ProviderId, model: string | undefined): Promise<unknown> }).buildLlm(providerId, model);
}

const LOCAL_ONLY = { allowedProviders: ["ollama", "lm-studio", "apple-foundation"] };

describe("managed policy: providers", () => {
  it("offers no hosted provider and refuses one in the main process", async () => {
    const fixture = await makeFixture({ policy: await policyOf(LOCAL_ONLY), initial: { activeProviderId: "anthropic", providerChosenByUser: true } });
    try {
      const state = await fixture.store.getAppState();
      assert.deepEqual(state.providers.map((provider) => provider.id), ["ollama", "apple-foundation", "lm-studio"]);
      assert.ok(state.providers.every((provider) => provider.isLocal));
      // The disallowed provider chosen before the policy is replaced at launch.
      assert.equal(state.activeProviderId, "ollama");
      assert.equal((await fixture.persisted()).activeProviderId, "ollama");

      await assert.rejects(fixture.store.setActiveProvider("anthropic"), (error: unknown) =>
        error instanceof ManagedPolicyError && /does not allow Claude Code on this device/.test(error.message));
      await assert.rejects(fixture.store.setActiveModel("openai", "gpt-5"), ManagedPolicyError);
      await assert.rejects(fixture.store.testProvider("gemini"), ManagedPolicyError);
      // Chat, agents and drafts build their model here: refused before any provider is created.
      for (const id of ["anthropic", "openai", "azure-openai", "copilot", "gemini"] as const) {
        await assert.rejects(buildLlm(fixture.store, id), ManagedPolicyError);
      }
      assert.deepEqual(fixture.llmCalls, []);
      await buildLlm(fixture.store, "ollama");
      assert.deepEqual(fixture.llmCalls, [["ollama", undefined]]);
    } finally {
      await fixture.close();
    }
  });

  it("sets and locks the provider and model on a fresh install", async () => {
    const fixture = await makeFixture({ policy: await policyOf({ defaultProvider: "lm-studio", defaultModel: "lm-studio-other", skipFirstRunScan: true }) });
    try {
      const state = await fixture.store.getAppState();
      assert.equal(state.activeProviderId, "lm-studio");
      assert.deepEqual(state.activeModelByProviderId, { "lm-studio": "lm-studio-other" });
      // A locked provider is the only one, and a locked model the only model.
      assert.deepEqual(state.providers.map((provider) => [provider.id, provider.models, provider.defaultModel]), [
        ["lm-studio", ["lm-studio-other"], "lm-studio-other"],
      ]);
      assert.deepEqual(state.managedPolicy?.locked, ["defaultProvider", "defaultModel", "skipFirstRunScan"]);

      await assert.rejects(fixture.store.setActiveProvider("ollama"), (error: unknown) =>
        error instanceof ManagedPolicyError && /set LM Studio as the provider/.test(error.message));
      await assert.rejects(fixture.store.setActiveModel("lm-studio", "lm-studio-model"), (error: unknown) =>
        error instanceof ManagedPolicyError && /set lm-studio-other as the LM Studio model/.test(error.message));
      await assert.rejects(fixture.store.setActiveModel("lm-studio", null), ManagedPolicyError);
      await assert.rejects(buildLlm(fixture.store, "lm-studio", "lm-studio-model"), ManagedPolicyError);
      await buildLlm(fixture.store, "lm-studio", "lm-studio-other");
      // Picking the locked values again is allowed.
      await fixture.store.setActiveProvider("lm-studio");
      await fixture.store.setActiveModel("lm-studio", "lm-studio-other");
    } finally {
      await fixture.close();
    }
  });

  it("passes a locked model to a CLI provider and reports one the provider does not list", async () => {
    const cli = await makeFixture({ policy: await policyOf({ defaultProvider: "anthropic", defaultModel: "sonnet" }) });
    try {
      const [provider] = (await cli.store.getAppState()).providers;
      assert.deepEqual([provider!.id, provider!.models, provider!.status], ["anthropic", ["sonnet"], "connected"]);
    } finally {
      await cli.close();
    }
    const missing = await makeFixture({ policy: await policyOf({ defaultProvider: "ollama", defaultModel: "llama3.1:70b" }) });
    try {
      const [provider] = (await missing.store.getAppState()).providers;
      assert.equal(provider!.status, "error");
      assert.deepEqual(provider!.models, []);
      assert.match(provider!.detail ?? "", /set the model llama3\.1:70b, which Ollama does not list/);
    } finally {
      await missing.close();
    }
  });

  it("applies an unlocked default until the admin picks another provider", async () => {
    const policy = await policyOf({ defaultProvider: "lm-studio", defaultModel: "lm-studio-other", lock: [] });
    const fixture = await makeFixture({ policy });
    try {
      let state = await fixture.store.getAppState();
      assert.equal(state.activeProviderId, "lm-studio");
      assert.equal(state.providers.length, providerCatalog.length);
      assert.equal(state.activeModelByProviderId?.["lm-studio"], "lm-studio-other");

      await fixture.store.setActiveProvider("ollama");
      await fixture.store.setActiveModel("lm-studio", "lm-studio-model");
      await fixture.relaunch(policy);
      state = await fixture.store.getAppState();
      assert.equal(state.activeProviderId, "ollama");
      assert.equal(state.activeModelByProviderId?.["lm-studio"], "lm-studio-model");
    } finally {
      await fixture.close();
    }
  });
});

describe("managed policy: first-run scan", () => {
  it("skips the scan on a fresh install when the policy provider is ready, and goes to Connect Microsoft 365", async () => {
    const fixture = await makeFixture({
      fresh: true,
      policy: await policyOf({ defaultProvider: "ollama", defaultModel: "ollama-other", skipFirstRunScan: true }),
    });
    try {
      const persisted = await fixture.persisted();
      assert.equal(persisted.firstRunScan, undefined);
      assert.equal(persisted.firstRunMicrosoftStep, "pending");
      const state = await fixture.store.getAppState();
      assert.equal(state.firstRunScanPending, undefined);
      assert.equal(state.firstRunMicrosoftStepPending, true);
      assert.equal(state.activeProviderId, "ollama");
      assert.deepEqual(state.providers.map((provider) => [provider.id, provider.models]), [["ollama", ["ollama-other"]]]);
    } finally {
      await fixture.close();
    }
  });

  it("runs the scan when the policy provider is not ready or the policy does not ask to skip", async () => {
    const notReady = await makeFixture({
      fresh: true,
      providers: () => readyProviders().map((provider) => (provider.id === "ollama" ? { ...provider, status: "error" as const, models: [] } : provider)),
      policy: await policyOf({ defaultProvider: "ollama", skipFirstRunScan: true }),
    });
    try {
      assert.equal((await notReady.persisted()).firstRunScan, "pending");
      assert.equal((await notReady.store.getAppState()).firstRunScanPending, true);
    } finally {
      await notReady.close();
    }
    const noSkip = await makeFixture({ fresh: true, policy: await policyOf({ defaultProvider: "ollama" }) });
    try {
      assert.equal((await noSkip.persisted()).firstRunScan, "pending");
    } finally {
      await noSkip.close();
    }
  });

  it("checks and offers only allowed providers, and keeps the policy provider selected", async () => {
    const fixture = await makeFixture({
      fresh: true,
      policy: await policyOf({ allowedProviders: ["lm-studio", "anthropic"], defaultProvider: "lm-studio", lock: ["allowedProviders"] }),
    });
    try {
      const result = await fixture.store.scanModels();
      assert.deepEqual(result.probes.map((probe) => probe.providerId).sort(), ["anthropic", "lm-studio"]);
      const state = await fixture.store.getAppState();
      assert.deepEqual(state.providers.map((provider) => provider.id).sort(), ["anthropic", "lm-studio"]);
      assert.equal(state.activeProviderId, "lm-studio");
    } finally {
      await fixture.close();
    }
  });
});

describe("managed policy: public references", () => {
  it("hides references the policy does not allow and refuses them", async () => {
    const fixture = await makeFixture({
      policy: await policyOf({ allowedPublicReferences: ["kql-search"] }),
      initial: {
        providerChosenByUser: true,
        mcpServers: { "microsoft-learn": { enabled: true, installedAt: "2026-11-01T00:00:00.000Z", tools: [] } },
      },
    });
    try {
      assert.deepEqual((await fixture.store.listMcpServers()).map((server) => server.id), ["kql-search"]);
      assert.deepEqual((await fixture.store.getAppState()).mcpServers?.map((server) => server.id), ["kql-search"]);
      await assert.rejects(fixture.store.installMcpServer("microsoft-learn"), (error: unknown) =>
        error instanceof ManagedPolicyError && /does not allow Microsoft Learn on this device\. Nothing was sent\./.test(error.message));
      await assert.rejects(fixture.store.checkMcpServer("microsoft-learn"), ManagedPolicyError);
      await assert.rejects(fixture.store.setMcpServerEnabled("microsoft-learn", true), ManagedPolicyError);
      // Removing one that was installed before the policy is still possible.
      await fixture.store.uninstallMcpServer("microsoft-learn");
    } finally {
      await fixture.close();
    }
  });

  it("passes the owner's logo to the summaries of listings that have one", async () => {
    const fixture = await makeFixture({ policy: await policyOf({ allowedPublicReferences: ["kql-search", "splashtop-packr-kb"] }) });
    try {
      const logos = (await fixture.store.listMcpServers()).map((server) => [server.id, server.logo]);
      assert.deepEqual(logos, [["kql-search", undefined], ["splashtop-packr-kb", "splashtop"]]);
    } finally {
      await fixture.close();
    }
  });

  it("allows none with an empty list", async () => {
    const fixture = await makeFixture({ policy: await policyOf({ allowedPublicReferences: [] }) });
    try {
      assert.deepEqual(await fixture.store.listMcpServers(), []);
    } finally {
      await fixture.close();
    }
  });

  it("never connects to or calls a server the host is told is not allowed", async () => {
    let fetched = 0;
    const host = new McpHost({
      clientVersion: "0.8.0",
      allowed: (serverId) => serverId !== "microsoft-learn",
      fetch: async () => {
        fetched += 1;
        throw new Error("no network in this test");
      },
    });
    const entry = catalog[0]!;
    await assert.rejects(host.connect(entry), (error: unknown) =>
      error instanceof McpHostError && error.code === "not-allowed" && error.sent === false);
    const tool = entry.tools?.[0] ?? "search";
    await assert.rejects(host.callTool({ ...entry, tools: [tool] }, tool, {}), (error: unknown) =>
      error instanceof McpHostError && error.code === "not-allowed");
    assert.equal(fetched, 0);
    await host.closeAll();
  });
});

describe("managed policy: app registration", () => {
  it("pre-seeds a locked registration that sign-in must use and that cannot be removed", async () => {
    const fixture = await makeFixture({
      policy: await policyOf({ appRegistration: { clientId: CLIENT_ID, tenantId: "contoso.onmicrosoft.com", label: "Contoso IT" } }),
    });
    try {
      const state = await fixture.store.getAppState();
      assert.deepEqual(state.savedAppRegistrations?.[0], {
        clientId: CLIENT_ID,
        directoryTenantId: "contoso.onmicrosoft.com",
        label: "Contoso IT",
        lastUsedAt: (state.savedAppRegistrations?.[0] as { lastUsedAt: string }).lastUsedAt,
        managed: true,
      });
      await assert.rejects(fixture.store.connectTenant({ partIds: ["intune-devices"] }), ManagedPolicyError);
      await assert.rejects(
        fixture.store.connectTenant({ appRegistration: { clientId: "bbbbbbbb-1111-2222-3333-444444444444" } }),
        /set the app registration Contoso IT for sign-in/,
      );
      assert.equal(fixture.signIns.length, 0);
      // The policy's own registration goes on to sign in.
      await assert.rejects(
        fixture.store.connectTenant({ appRegistration: { clientId: CLIENT_ID.toUpperCase(), directoryTenantId: "contoso.onmicrosoft.com" } }),
        /sign-in is not part of this test/,
      );
      assert.equal(fixture.signIns.length, 1);
      await assert.rejects(fixture.store.removeSavedAppRegistration(CLIENT_ID, "contoso.onmicrosoft.com"), ManagedPolicyError);
    } finally {
      await fixture.close();
    }
  });

  it("seeds an unlocked registration once, so a removed one stays removed", async () => {
    const policy = await policyOf({ appRegistration: { clientId: CLIENT_ID }, lock: [] });
    const fixture = await makeFixture({ policy });
    try {
      assert.equal((await fixture.store.getAppState()).savedAppRegistrations?.length, 1);
      await fixture.store.removeSavedAppRegistration(CLIENT_ID);
      await fixture.relaunch(policy);
      assert.deepEqual((await fixture.store.getAppState()).savedAppRegistrations, []);
    } finally {
      await fixture.close();
    }
  });
});

describe("managed policy: audit and notice", () => {
  it("records load, change, problems and removal once each", async () => {
    const first = await policyOf(LOCAL_ONLY);
    const fixture = await makeFixture({ policy: first, initial: { activeProviderId: "openai", providerChosenByUser: true } });
    try {
      let events = await fixture.audit();
      assert.deepEqual(events.map((event) => event.type), ["provider.changed", "policy.loaded"]);
      assert.deepEqual(events[0]!.details, { providerId: "ollama", previousProviderId: "openai", chosenByAdmin: false, setByPolicy: true });
      assert.deepEqual(events[1]!.details, {
        keys: ["allowedProviders"],
        lockedKeys: ["allowedProviders"],
        machineKeys: ["allowedProviders"],
        userKeys: [],
        allowedProviders: ["ollama", "lm-studio", "apple-foundation"],
      });

      // The same policy at the next launch records nothing.
      await fixture.relaunch(await policyOf(LOCAL_ONLY));
      assert.equal((await fixture.audit()).length, 2);

      await fixture.relaunch(await policyOf({ ...LOCAL_ONLY, allowedPublicReferences: [] }));
      events = await fixture.audit();
      assert.equal(events.at(-1)!.type, "policy.changed");
      assert.deepEqual(events.at(-1)!.details.changedKeys, ["allowedPublicReferences"]);
      assert.deepEqual(events.at(-1)!.details.allowedPublicReferences, []);

      const invalid = '{\n  "allowedProviders": ["ollama", "lm-studio", "apple-foundation"],\n  "allowedPublicReferences": [],\n  "defaultProvider": "olama"\n}';
      await fixture.relaunch(await policyOf(invalid));
      events = await fixture.audit();
      assert.equal(events.at(-1)!.type, "policy.invalid");
      assert.equal(events.at(-1)!.details.problemCount, 1);
      assert.match((events.at(-1)!.details.problems as string[])[0]!, /^\/etc\/openadminos\/policy\.json, line 4: "defaultProvider" is "olama"/);
      // The same problems at the next launch are not recorded again.
      await fixture.relaunch(await policyOf(invalid));
      assert.equal((await fixture.audit()).length, events.length);

      await fixture.relaunch(undefined);
      events = await fixture.audit();
      assert.equal(events.at(-1)!.type, "policy.removed");
      assert.deepEqual(events.at(-1)!.details, { previousKeys: ["allowedProviders", "allowedPublicReferences"] });
      assert.equal((await fixture.persisted()).managedPolicy, undefined);
      // Stored events keep their policy details through every launch's read and write.
      assert.deepEqual(events[1]!.details.allowedProviders, ["ollama", "lm-studio", "apple-foundation"]);
      assert.equal(events[0]!.details.setByPolicy, true);
      assert.ok(events.some((event) => event.type === "policy.changed" && Array.isArray(event.details.changedKeys)));
    } finally {
      await fixture.close();
    }
  });

  it("shows the problem notice until it is dismissed, and again when the problems change", async () => {
    const fixture = await makeFixture({ policy: await policyOf('{\n  "allowedProviders": "ollama"\n}') });
    try {
      let policy = (await fixture.store.getAppState()).managedPolicy;
      assert.equal(policy?.issues.length, 1);
      assert.equal(policy?.issues[0]!.line, 2);
      assert.equal(policy?.noticeDismissed, undefined);
      // An invalid key is not applied: every provider stays available.
      assert.equal((await fixture.store.getAppState()).providers.length, providerCatalog.length);

      policy = (await fixture.store.dismissManagedPolicyNotice()).managedPolicy;
      assert.equal(policy?.noticeDismissed, true);
      await fixture.relaunch(await policyOf('{\n  "allowedProviders": "ollama"\n}'));
      assert.equal((await fixture.store.getAppState()).managedPolicy?.noticeDismissed, true);

      await fixture.relaunch(await policyOf('{\n\n  "allowedProviders": "ollama"\n}'));
      assert.equal((await fixture.store.getAppState()).managedPolicy?.noticeDismissed, undefined);
    } finally {
      await fixture.close();
    }
  });
});
