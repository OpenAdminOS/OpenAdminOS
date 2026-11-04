import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { AgentSummary, RunGraphApi, RunRecord, TenantRecord } from "@openadminos/agent-sdk";

import { RunService, type RunPersistedState, type RunServiceHost } from "./runs.js";
import { AppStateStore } from "./state.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/** Recording is fire-and-forget, so wait until the expected grants appear. */
async function eventually(read: () => Promise<unknown>, expected: unknown): Promise<void> {
  const deadline = Date.now() + 3_000;
  let actual = await read();
  while (JSON.stringify(actual) !== JSON.stringify(expected) && Date.now() < deadline) {
    await settle();
    actual = await read();
  }
  assert.deepEqual(actual, expected);
}

function tenantRecord(grantedScopes?: string[]): TenantRecord {
  return {
    id: "tenant-1",
    displayName: "Contoso",
    username: "admin@contoso.example",
    homeAccountId: "home-1",
    addedAt: "2026-11-04T10:00:00.000Z",
    appRegistration: { kind: "openadminos", clientId: "d1de0a94-f67a-421d-8804-a235955ffd69" },
    ...(grantedScopes ? { grantedScopes } : {}),
  };
}

async function storeWithToken(tenant: TenantRecord, tokenScopes: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-run-grants-"));
  const filePath = join(dir, "state.json");
  await writeFile(filePath, JSON.stringify({
    activeProviderId: "ollama", installedAgents: [], runs: [], activeTenantId: tenant.id, tenants: [tenant],
  }));
  const store = new AppStateStore({
    filePath, userDataPath: dir, statsApiUrl: "",
    tokenStore: { read: async () => "", write: async () => undefined },
  });
  const account = { homeAccountId: tenant.homeAccountId, tenantId: tenant.id, username: tenant.username };
  Object.defineProperty(store, "msalClientForTenant", { value: () => ({
    getTokenCache: () => ({ getAllAccounts: async () => [account] }),
    acquireTokenSilent: async () => ({ accessToken: "opaque-token", scopes: tokenScopes, account, tenantId: tenant.id }),
  }) });
  const internal = store as unknown as {
    buildGraph(tenantId: string, scopes: string[]): Promise<{ createGraph(log: () => void): RunGraphApi }>;
  };
  return {
    internal,
    async grants(): Promise<unknown> {
      const persisted = JSON.parse(await readFile(filePath, "utf8")) as { tenants: TenantRecord[] };
      return persisted.tenants[0]?.grantedScopes;
    },
    async close() { store.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

async function withGraphResponse<T>(task: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ value: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    return await task();
  } finally {
    globalThis.fetch = original;
  }
}

describe("run-time grants", () => {
  it("records the scopes the token returned and never the undelivered declared ones", async () => {
    const fixture = await storeWithToken(
      tenantRecord(["graph:User.Read.All"]),
      ["openid", "profile", "User.Read.All", "AuditLog.Read.All", "https://graph.microsoft.com/.default"],
    );
    try {
      const selection = await fixture.internal.buildGraph("tenant-1", ["AuditLog.Read.All", "Policy.Read.All"]);
      await withGraphResponse(() =>
        selection.createGraph(() => undefined).request({ method: "GET", path: "/auditLogs/signIns" }),
      );
      await eventually(() => fixture.grants(), ["graph:User.Read.All", "graph:AuditLog.Read.All"]);
    } finally {
      await fixture.close();
    }
  });

  it("keeps the all-defaults assumption for tenants without recorded grants", async () => {
    const fixture = await storeWithToken(tenantRecord(), ["AuditLog.Read.All"]);
    try {
      const selection = await fixture.internal.buildGraph("tenant-1", ["AuditLog.Read.All"]);
      await withGraphResponse(() =>
        selection.createGraph(() => undefined).request({ method: "GET", path: "/auditLogs/signIns" }),
      );
      await settle();
      assert.equal(await fixture.grants(), undefined);
    } finally {
      await fixture.close();
    }
  });

  it("does not merge an agent's declared scopes when its run completes", async () => {
    const agent = { slug: "declares-policy", scopes: ["Policy.Read.All", "Directory.Read.All"], mode: "read" } as AgentSummary;
    let state: RunPersistedState = {
      activeProviderId: "ollama",
      installedAgents: [agent],
      runs: [],
      tenants: [tenantRecord(["graph:User.Read.All"])],
    };
    let tail: Promise<unknown> = Promise.resolve();
    const host = {
      read: async () => structuredClone(state),
      write: async (next: RunPersistedState) => { state = structuredClone(next); },
      serialize: <T>(task: () => Promise<T>): Promise<T> => {
        const next = tail.then(task); tail = next.catch(() => undefined); return next;
      },
      recordLearningEventSafely: () => undefined,
      emitStateChanged: () => undefined,
      notifyRunFinished: () => undefined,
      enqueueRunDeliveries: async () => undefined,
      processPendingRunDeliveries: async () => undefined,
    } satisfies Partial<RunServiceHost>;
    const service = new RunService(host as unknown as RunServiceHost);
    const run = {
      id: "run-1",
      agentSlug: agent.slug,
      tenantId: "tenant-1",
      status: "completed",
      steps: [],
      logs: [],
      queuedAt: "2026-11-04T10:00:00.000Z",
      finishedAt: "2026-11-04T10:01:00.000Z",
    } as unknown as RunRecord;
    await service.persistRunSnapshot(run);
    await settle();
    assert.equal(state.runs[0]?.status, "completed");
    assert.deepEqual(state.tenants[0]?.grantedScopes, ["graph:User.Read.All"]);
  });
});
