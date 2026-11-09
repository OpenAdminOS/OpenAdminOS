import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { TokenCacheStorage } from "@openadminos/runtime";

import {
  CONFIGURATION_AUDIT_MAX_EVENTS,
  appendConfigurationAudit,
  diffConfigurationAudit,
  sanitizeConfigurationAudit,
  type ConfigurationAuditEvent,
} from "./configuration-audit.js";
import { MCP_CATALOG, type McpCatalogEntry } from "./mcp/catalog.js";
import type { McpHost } from "./mcp/host.js";
import { AppStateStore } from "./state.js";

const tokenStore: TokenCacheStorage = { read: async () => "", write: async () => undefined };
const ZERO_HASH = "0".repeat(64);
const ACCESS_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.secret-access-token-value";
const ID_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.secret-id-token-value";
const NOW = "2026-11-09T12:00:00.000Z";

const contoso = {
  id: "11111111-1111-1111-1111-111111111111",
  displayName: "Contoso",
  username: "admin@contoso.example",
  homeAccountId: "home-contoso",
  addedAt: "2026-09-01T08:00:00.000Z",
  connectionId: "connection-contoso",
  appRegistration: { kind: "openadminos", clientId: "d1de0a94-f67a-421d-8804-a235955ffd69" },
  grantedScopes: ["graph:User.Read"],
};

const fabrikam = {
  id: "22222222-2222-2222-2222-222222222222",
  displayName: "Fabrikam",
  username: "it@fabrikam.example",
  homeAccountId: "home-fabrikam",
  addedAt: "2026-10-01T08:00:00.000Z",
  connectionId: "connection-fabrikam",
  appRegistration: { kind: "openadminos", clientId: "d1de0a94-f67a-421d-8804-a235955ffd69" },
  grantedScopes: ["graph:User.Read"],
};

function agent(slug: string, schedule?: Record<string, unknown>) {
  return {
    id: slug,
    slug,
    name: `Agent ${slug}`,
    description: "Fixture",
    mode: "read",
    category: "devices",
    tier: "agent",
    requiresEntraTier: "free",
    scopes: [],
    author: { name: "OpenAdminOS", verified: true },
    version: "1.0.0",
    installedAt: "2026-09-02T00:00:00.000Z",
    ...(schedule ? { schedule } : {}),
  };
}

function run(id: string, queuedAt: string) {
  return {
    id,
    agentSlug: "inventory",
    status: "completed",
    queuedAt,
    startedAt: queuedAt,
    finishedAt: queuedAt,
    tenantId: contoso.id,
    steps: [],
    logs: [],
  };
}

async function makeFixture(initial: Record<string, unknown> = {}, options: { mcpCatalog?: McpCatalogEntry[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-configuration-audit-"));
  const statePath = join(dir, "state.json");
  await writeFile(
    statePath,
    JSON.stringify({ activeProviderId: "ollama", providerChosenByUser: true, installedAgents: [], runs: [], tenants: [], ...initial }),
    "utf8",
  );
  const requests: string[][] = [];
  const store = new AppStateStore({
    filePath: statePath,
    tokenStore,
    tokenStoreFor: () => tokenStore,
    userDataPath: dir,
    statsApiUrl: "",
    appVersion: "0.8.0",
    clock: () => new Date(NOW),
    ...(options.mcpCatalog ? { mcpCatalog: options.mcpCatalog } : {}),
    interactiveSignIn: async ({ scopes }) => {
      requests.push([...(scopes ?? [])]);
      return {
        account: { homeAccountId: "home-contoso", tenantId: contoso.id, username: contoso.username },
        scopes: requests.length === 1 ? ["User.Read"] : ["SecurityAlert.Read.All", "SecurityIncident.Read.All"],
        accessToken: ACCESS_TOKEN,
        idToken: ID_TOKEN,
      } as never;
    },
  });
  return {
    store,
    statePath,
    async recorded(): Promise<ConfigurationAuditEvent[]> {
      return (JSON.parse(await readFile(statePath, "utf8")) as { configurationAudit?: ConfigurationAuditEvent[] }).configurationAudit ?? [];
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

/** Two configuration changes, then a prune that removes the older of two runs. */
async function prunedFixture() {
  const fixture = await makeFixture({
    tenants: [contoso, fabrikam],
    activeTenantId: contoso.id,
    runs: [run("run-old", "2026-01-01T00:00:00.000Z"), run("run-new", "2026-11-08T00:00:00.000Z")],
    runHistoryRetention: { neverPrune: false, keepLastRuns: 1, updatedAt: "2026-11-01T00:00:00.000Z" },
  });
  try {
    await fixture.store.setActiveOrganization(`org-${fabrikam.id}`);
    await fixture.store.setActiveProvider("openai");
    const result = await fixture.store.pruneRunHistory("manual");
    assert.equal(result.prunedCount, 1);
    assert.deepEqual((await fixture.store.getAppState()).runs.map((entry) => entry.id), ["run-new"]);
  } catch (error) {
    await fixture.close();
    throw error;
  }
  return fixture;
}

const typesOf = (events: ConfigurationAuditEvent[]) => events.map((event) => event.type);

describe("configuration audit events", () => {
  it("records Microsoft 365 connect, added access and disconnect with the organization", async () => {
    const fixture = await makeFixture();
    try {
      await fixture.store.connectTenant();
      const connected = await fixture.recorded();
      assert.deepEqual(typesOf(connected), ["organization.created", "microsoft365.connected", "organization.switched"]);
      const organizationId = `org-${contoso.id}`;
      for (const event of connected) {
        assert.equal(event.timestamp, NOW);
        assert.equal(event.organizationId, organizationId);
        assert.equal(event.organizationName, "contoso.example");
        assert.equal(event.tenantId, contoso.id);
      }
      assert.deepEqual(connected[1]!.details, {
        tenantName: "contoso.example",
        account: contoso.username,
        registration: "openadminos",
        reconnected: false,
        grantedScopeCount: 1,
      });
      assert.deepEqual(connected[2]!.details, { noOrganization: false, previousNoOrganization: true });

      await fixture.store.addTenantAccess(contoso.id, ["defender.incidents"]);
      const added = (await fixture.recorded()).slice(connected.length);
      assert.deepEqual(typesOf(added), ["microsoft365.access-added"]);
      assert.equal(added[0]!.organizationId, organizationId);
      assert.deepEqual(added[0]!.details.scopes, ["graph:SecurityAlert.Read.All", "graph:SecurityIncident.Read.All"]);
      assert.ok((added[0]!.details.partIds as string[]).includes("defender.incidents"));

      await fixture.store.disconnectTenant(contoso.id);
      const disconnected = (await fixture.recorded()).slice(connected.length + added.length);
      assert.deepEqual(typesOf(disconnected), ["microsoft365.disconnected", "organization.removed", "organization.switched"]);
      assert.equal(disconnected[0]!.organizationId, organizationId);
      assert.equal(disconnected[1]!.organizationId, organizationId);
      assert.equal(disconnected[2]!.organizationId, undefined);
      assert.deepEqual(disconnected[2]!.details, {
        noOrganization: true,
        previousOrganizationId: organizationId,
        previousOrganizationName: "contoso.example",
      });
    } finally {
      await fixture.close();
    }
  });

  it("never records a token or secret value", async () => {
    const fixture = await makeFixture();
    try {
      await fixture.store.connectTenant();
      await fixture.store.addTenantAccess(contoso.id, ["defender.incidents"]);
      const raw = JSON.stringify(await fixture.recorded());
      assert.ok(raw.length > 2);
      for (const secret of [ACCESS_TOKEN, ID_TOKEN, "secret-access-token-value", "secret-id-token-value", "home-contoso"]) {
        assert.equal(raw.includes(secret), false, `${secret} is not recorded`);
      }
      for (const format of ["json", "csv"] as const) {
        const exported = await fixture.store.exportAuditLog({ format });
        assert.equal(exported.content.includes(ACCESS_TOKEN), false);
        assert.equal(exported.content.includes(ID_TOKEN), false);
      }
    } finally {
      await fixture.close();
    }
  });

  it("records organization rename, switch and switch to No organization", async () => {
    const fixture = await makeFixture({ tenants: [contoso, fabrikam], activeTenantId: contoso.id });
    try {
      await fixture.store.renameOrganization(`org-${contoso.id}`, "Contoso Ltd");
      await fixture.store.setActiveOrganization(`org-${fabrikam.id}`);
      await fixture.store.setActiveOrganization(null);
      const events = await fixture.recorded();
      assert.deepEqual(typesOf(events), ["organization.renamed", "organization.switched", "organization.switched"]);
      assert.equal(events[0]!.organizationName, "Contoso Ltd");
      assert.deepEqual(events[0]!.details, { previousName: "Contoso" });
      assert.equal(events[1]!.organizationId, `org-${fabrikam.id}`);
      assert.equal(events[1]!.tenantId, fabrikam.id);
      assert.deepEqual(events[1]!.details, {
        noOrganization: false,
        previousOrganizationId: `org-${contoso.id}`,
        previousOrganizationName: "Contoso Ltd",
      });
      assert.equal(events[2]!.organizationId, undefined);
      assert.deepEqual(events[2]!.details, {
        noOrganization: true,
        previousOrganizationId: `org-${fabrikam.id}`,
        previousOrganizationName: "Fabrikam",
      });
    } finally {
      await fixture.close();
    }
  });

  it("records nothing for a write that changes none of these settings", async () => {
    const fixture = await makeFixture({ tenants: [contoso], activeTenantId: contoso.id });
    try {
      await fixture.store.setActiveTenant(contoso.id);
      await fixture.store.dismissOrganizationMigrationNotice();
      assert.deepEqual(await fixture.recorded(), []);
    } finally {
      await fixture.close();
    }
  });

  it("records provider and model changes", async () => {
    const fixture = await makeFixture({ activeModelByProviderId: { ollama: "llama3.1:8b" } });
    try {
      await fixture.store.setActiveProvider("anthropic");
      await fixture.store.setActiveModel("ollama", null);
      const events = await fixture.recorded();
      assert.deepEqual(typesOf(events), ["provider.changed", "model.changed"]);
      assert.deepEqual(events[0]!.details, { providerId: "anthropic", previousProviderId: "ollama", chosenByAdmin: true });
      assert.deepEqual(events[1]!.details, { providerId: "ollama", model: "provider default", previousModel: "llama3.1:8b" });
      assert.equal(events[0]!.organizationId, undefined);
    } finally {
      await fixture.close();
    }
  });

  it("records public reference install, disable, enable and removal", async () => {
    const catalog: McpCatalogEntry[] = [{ ...MCP_CATALOG[0]!, id: "test-docs", name: "Test Docs", url: "http://127.0.0.1:9/mcp" }];
    const fixture = await makeFixture({}, { mcpCatalog: catalog });
    try {
      const host = (fixture.store as unknown as { mcpHost: McpHost }).mcpHost;
      host.connect = async () => ({ tools: [], missingTools: [] });
      host.revoke = async () => undefined;
      await fixture.store.installMcpServer("test-docs");
      await fixture.store.setMcpServerEnabled("test-docs", false);
      await fixture.store.setMcpServerEnabled("test-docs", true);
      await fixture.store.uninstallMcpServer("test-docs");
      const events = await fixture.recorded();
      assert.deepEqual(typesOf(events), [
        "public-reference.installed",
        "public-reference.disabled",
        "public-reference.enabled",
        "public-reference.removed",
      ]);
      assert.deepEqual(events[0]!.details, { serverId: "test-docs", serverName: "Test Docs", enabled: true });
      assert.deepEqual(events[3]!.details, { serverId: "test-docs", serverName: "Test Docs" });
    } finally {
      await fixture.close();
    }
  });

  it("records a schedule assigned to an organization", async () => {
    const schedule = { enabled: true, intervalSeconds: 3600, notifyOnSuccess: true, notifyOnFailure: true };
    const fixture = await makeFixture({
      tenants: [contoso, fabrikam],
      activeTenantId: contoso.id,
      organizations: [
        { id: `org-${contoso.id}`, name: "Contoso", createdAt: contoso.addedAt, connections: { microsoft365: { tenantId: contoso.id } } },
        { id: `org-${fabrikam.id}`, name: "Fabrikam", createdAt: fabrikam.addedAt, connections: { microsoft365: { tenantId: fabrikam.id } } },
      ],
      installedAgents: [agent("inventory", { ...schedule, organizationId: `org-${contoso.id}` })],
    });
    try {
      await fixture.store.assignAgentSchedule("inventory", `org-${fabrikam.id}`);
      const events = await fixture.recorded();
      assert.deepEqual(typesOf(events), ["schedule.assigned"]);
      assert.equal(events[0]!.organizationId, `org-${fabrikam.id}`);
      assert.equal(events[0]!.organizationName, "Fabrikam");
      assert.equal(events[0]!.tenantId, fabrikam.id);
      assert.deepEqual(events[0]!.details, {
        agentSlug: "inventory",
        agentName: "Agent inventory",
        previousOrganizationId: `org-${contoso.id}`,
        previousOrganizationName: "Contoso",
      });
    } finally {
      await fixture.close();
    }
  });

  it("keeps events when run history is pruned", async () => {
    const fixture = await prunedFixture();
    try {
      assert.deepEqual(typesOf(await fixture.recorded()), ["organization.switched", "provider.changed"]);
    } finally {
      await fixture.close();
    }
  });

  it("exports events in both formats with a valid hash chain after run history is pruned", async () => {
    const fixture = await prunedFixture();
    try {
      const exported = await fixture.store.exportAuditLog({ format: "json" });
      const document = JSON.parse(exported.content) as {
        retention: { note: string };
        hashChain: { finalHash: string };
        events: Array<Record<string, unknown> & { sha256: string; type: string; source: string }>;
      };
      const changes = document.events.filter((event) => event.source === "configuration-change");
      assert.deepEqual(changes.map((event) => event.type), ["organization.switched", "provider.changed"]);
      assert.equal((changes[0]!.details as Record<string, unknown>).organizationId, `org-${fabrikam.id}`);
      assert.equal((changes[0]!.details as Record<string, unknown>).organizationName, "Fabrikam");
      assert.equal(changes[0]!.tenantId, fabrikam.id);
      assert.match(document.retention.note, /Configuration changes are kept independently of run retention/);
      // The pruned run is gone from the export; the changes are not.
      assert.equal(document.events.some((event) => event.runId === "run-old"), false);
      assert.ok(document.events.some((event) => event.runId === "run-new"));

      let previousHash = ZERO_HASH;
      for (const event of document.events) {
        const { sha256, ...withoutHash } = event;
        assert.equal(sha256, createHash("sha256").update(previousHash).update(canonicalJson(withoutHash)).digest("hex"));
        previousHash = sha256;
      }
      assert.equal(document.hashChain.finalHash, previousHash);

      const csv = await fixture.store.exportAuditLog({ format: "csv" });
      const lines = csv.content.trim().split("\n");
      assert.equal(lines.length - 1, document.events.length);
      assert.equal(lines.filter((line) => line.includes(",configuration-change,")).length, 2);
      assert.ok(lines.some((line) => line.includes(",organization.switched,configuration-change,")));
      assert.equal(csv.hashChain.finalHash, previousHash);
    } finally {
      await fixture.close();
    }
  });
});

describe("configuration audit storage", () => {
  const event = (id: string): ConfigurationAuditEvent => ({ id, timestamp: NOW, type: "provider.changed", details: { providerId: "ollama" } });

  it("drops malformed stored events and detail fields of another shape", () => {
    const kept = sanitizeConfigurationAudit([
      event("a"),
      { ...event("b"), type: "unknown.kind" },
      { ...event("c"), timestamp: "not a date" },
      { ...event("d"), details: { nested: { token: "x" } } },
      { ...event("e"), organizationId: "org-1", details: { scopes: ["graph:User.Read"], count: 1, flag: true } },
      "not an event",
    ]);
    assert.deepEqual(kept?.map((entry) => entry.id), ["a", "d", "e"]);
    assert.deepEqual(kept?.[1]?.details, {});
    assert.equal(sanitizeConfigurationAudit("nothing"), undefined);
  });

  it("keeps the newest events up to the limit", () => {
    const existing = Array.from({ length: CONFIGURATION_AUDIT_MAX_EVENTS }, (_, index) => event(`old-${index}`));
    const combined = appendConfigurationAudit(existing, [event("new")])!;
    assert.equal(combined.length, CONFIGURATION_AUDIT_MAX_EVENTS);
    assert.equal(combined[0]!.id, "old-1");
    assert.equal(combined.at(-1)!.id, "new");
  });

  it("records a schedule removed while it was assigned as unassigned", () => {
    const organization = { id: "org-1", name: "Contoso", createdAt: NOW, connections: { microsoft365: { tenantId: contoso.id } } };
    const schedule = { enabled: true, intervalSeconds: 3600, notifyOnSuccess: true, notifyOnFailure: true, organizationId: "org-1" };
    const base = { activeProviderId: "ollama", tenants: [contoso as never], organizations: [organization as never] };
    const events = diffConfigurationAudit(
      { ...base, installedAgents: [agent("inventory", schedule) as never] },
      { ...base, installedAgents: [agent("inventory") as never] },
      { timestamp: NOW, newId: () => "id", publicReferenceName: () => undefined },
    );
    assert.deepEqual(typesOf(events), ["schedule.unassigned"]);
    assert.deepEqual(events[0]!.details, {
      agentSlug: "inventory",
      agentName: "Agent inventory",
      previousOrganizationId: "org-1",
      previousOrganizationName: "Contoso",
      scheduleRemoved: true,
    });
  });

  it("records a reconnect of the same tenant, and an automatic provider pick as not chosen by the admin", () => {
    const base = { activeProviderId: "ollama", installedAgents: [], tenants: [contoso as never] };
    let next = 0;
    const events = diffConfigurationAudit(
      base,
      { ...base, activeProviderId: "lm-studio", providerChosenByUser: false, tenants: [{ ...contoso, connectionId: "connection-2" } as never] },
      { timestamp: NOW, newId: () => `id-${next++}`, publicReferenceName: () => undefined },
    );
    assert.deepEqual(typesOf(events), ["microsoft365.connected", "provider.changed"]);
    assert.equal(events[0]!.details.reconnected, true);
    assert.equal(events[1]!.details.chosenByAdmin, false);
    assert.deepEqual(events.map((entry) => entry.id), ["id-0", "id-1"]);
  });
});

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
