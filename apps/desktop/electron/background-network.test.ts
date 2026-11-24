import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { ManagedPolicyStatus } from "@openadminos/agent-sdk";
import { DEFAULT_REGISTRY_SOURCE } from "./registry-client.js";
import { INDEX_MANIFEST_URL } from "./retrieval/install.js";
import { AppStateStore, type AppStateStoreOptions } from "./state.js";

const slug = "find-inactive-devices";
const secondSlug = "user-license-overview";
const statsUrl = "https://stats.example";

async function fixture(t: TestContext, preferences: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-background-network-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, "state.json");
  await writeFile(filePath, JSON.stringify({
    activeProviderId: "ollama", installedAgents: [], runs: [], tenants: [],
    ...preferences,
  }));
  const store = (overrides: Partial<AppStateStoreOptions> = {}) => new AppStateStore({
    filePath,
    userDataPath: dir,
    tokenStore: { read: async () => "", write: async () => undefined },
    providerListFactory: () => [],
    statsApiUrl: statsUrl,
    appVersion: "0.8.0",
    ...overrides,
  });
  return { store, filePath };
}

function lockedPolicy(values: ManagedPolicyStatus["values"]): ManagedPolicyStatus {
  return {
    files: [],
    values,
    sources: {},
    locked: Object.keys(values) as ManagedPolicyStatus["locked"],
    issues: [],
  };
}

test("install reports have no identifier and deduplicate each slug by UTC year across restarts", async (t) => {
  const { store, filePath } = await fixture(t, { installId: "old-install-id", usageTelemetryEnabled: true });
  let now = new Date("2026-12-31T23:59:59.999Z");
  const clock = () => now;
  let desktop = store({ clock });
  const pings: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    assert.equal(String(input), `${statsUrl}/api/install`);
    assert.equal(init?.method, "POST");
    pings.push(JSON.parse(String(init?.body)));
    return Response.json({ counted: true });
  });
  await desktop.removeLegacyTelemetryState();
  const migrated = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(Object.hasOwn(migrated, "installId"), false);
  assert.equal(Object.hasOwn(migrated, "usageTelemetryEnabled"), false);
  assert.equal((await desktop.getAppState()).registryInstallCountsEnabled, true);

  await Promise.all([desktop.installAgent(slug), desktop.installAgent(slug)]);
  await desktop.uninstallAgent(slug);
  desktop = store({ clock });
  await desktop.setRegistryInstallCountsEnabled(false);
  await desktop.setRegistryInstallCountsEnabled(true);
  await desktop.installAgent(slug);
  await desktop.installAgent(secondSlug);
  assert.deepEqual(pings, [slug, secondSlug].map((agent) => ({
    slug: agent, version: "0.8.0", platform: process.platform,
  })));

  await desktop.uninstallAgent(slug);
  now = new Date("2027-01-01T00:00:00.000Z");
  await desktop.installAgent(slug);
  assert.equal(pings.length, 3);
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")).registryInstallCountYears, {
    [slug]: 2027, [secondSlug]: 2026,
  });
});

test("the install count preference and both policy locks suppress reports", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ counted: true }));
  const { store } = await fixture(t, { automaticNetworkRequestsEnabled: true, registryInstallCountsEnabled: true });
  const desktop = store();
  await desktop.setRegistryInstallCountsEnabled(false);
  await desktop.installAgent(slug);
  await desktop.uninstallAgent(slug);
  await desktop.setRegistryInstallCountsEnabled(true);
  await desktop.setAutomaticNetworkRequestsEnabled(false);
  await desktop.installAgent(slug);
  await desktop.uninstallAgent(slug);
  // Restore the saved user choice without starting a download in this test.
  await desktop.setRetrievalAutoInstallEnabled(false);
  await desktop.setAutomaticNetworkRequestsEnabled(true);

  for (const key of ["registryInstallCounts", "automaticNetworkRequests"] as const) {
    const managed = store({ managedPolicy: lockedPolicy({ [key]: "off" }) });
    await managed.installAgent(slug);
    assert.equal((await managed.getAppState()).registryInstallCountsEnabled, false);
    await assert.rejects(
      key === "registryInstallCounts" ? managed.setRegistryInstallCountsEnabled(true) : managed.setAutomaticNetworkRequestsEnabled(true),
      /set by your IT department/,
    );
    await managed.uninstallAgent(slug);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("automatic registry refresh honours the toggle and policy while manual refresh still works", async (t) => {
  const { store } = await fixture(t);
  const desktop = store();
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    requests.push(String(input));
    return Response.json({ schemaVersion: 1, revision: 1, agents: [] });
  });
  assert.equal(await desktop.getAutomaticNetworkRequestsEnabled(), true);
  await desktop.initRegistry("automatic");
  assert.deepEqual(requests, [`${DEFAULT_REGISTRY_SOURCE}/index.json`]);

  await desktop.setAutomaticNetworkRequestsEnabled(false);
  await desktop.initRegistry("automatic");
  assert.equal(requests.length, 1);
  await desktop.initRegistry();
  assert.equal(requests.length, 2);

  const savedOn = await fixture(t, { automaticNetworkRequestsEnabled: true });
  const managed = savedOn.store({ managedPolicy: lockedPolicy({ automaticNetworkRequests: "off" }) });
  assert.equal(await managed.getAutomaticNetworkRequestsEnabled(), false);
  await managed.initRegistry("automatic");
  assert.equal(requests.length, 2);
  await managed.initRegistry();
  assert.equal(requests.length, 3);
});

test("the live registry index and its offline cache keep the bundled install counts", async (t) => {
  const { store } = await fixture(t);
  const index = await readFile(new URL("../../../agents/index.json", import.meta.url), "utf8");
  const desktop = store();
  const bundledCount = desktop.listRegistryAgents().find((agent) => agent.slug === slug)?.installs;
  assert.equal(typeof bundledCount, "number");
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(index));
  assert.equal((await desktop.initRegistry()).error, null);
  assert.equal(desktop.listRegistryAgents().find((agent) => agent.slug === slug)?.installs, bundledCount);

  await desktop.setAutomaticNetworkRequestsEnabled(false);
  const restarted = store();
  assert.equal((await restarted.initRegistry("automatic")).fromCache, true);
  assert.equal(restarted.listRegistryAgents().find((agent) => agent.slug === slug)?.installs, bundledCount);
  assert.equal(fetch.mock.callCount(), 1);
});

test("automatic documentation setup needs both switches, while a manual index download works with both off", async (t) => {
  let modelPulls = 0;
  const ollama = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/pull") {
      modelPulls++;
      response.end(JSON.stringify({ status: "success" }) + "\n");
    } else {
      response.end(JSON.stringify({ models: [] }));
    }
  });
  t.after(() => new Promise<void>((resolve) => ollama.close(() => resolve())));
  await new Promise<void>((resolve) => ollama.listen(0, "127.0.0.1", resolve));
  const address = ollama.address();
  assert.ok(address && typeof address !== "string");
  const previousEndpoint = process.env.OPENADMINOS_EMBEDDING_ENDPOINT;
  process.env.OPENADMINOS_EMBEDDING_ENDPOINT = `http://127.0.0.1:${address.port}`;
  t.after(() => {
    if (previousEndpoint === undefined) delete process.env.OPENADMINOS_EMBEDDING_ENDPOINT;
    else process.env.OPENADMINOS_EMBEDDING_ENDPOINT = previousEndpoint;
  });

  const baseUrl = "https://github.com/example/docs-index";
  const files = new Map<string, BodyInit>([
    ["index-meta.json", JSON.stringify({ dim: 1, embeddingModel: "nomic-embed-text", builtAt: "2026-11-24", chunkCount: 1 })],
    ["chunks.jsonl", JSON.stringify({ file: "example.md", text: "Example" }) + "\n"],
    ["embeddings.f32", new Float32Array([1]).buffer],
  ]);
  let pointerFetches = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = String(input);
    if (url === INDEX_MANIFEST_URL) {
      pointerFetches++;
      return Response.json({ version: "2026-11-24", baseUrl });
    }
    assert.ok(url.startsWith(baseUrl));
    const file = files.get(url.slice(baseUrl.length + 1));
    return file ? new Response(file) : new Response(null, { status: 404 });
  });

  const automaticSetup = (desktop: AppStateStore) => Promise.all([
    desktop.autoInstallRetrievalIndex(), desktop.autoInstallEmbeddingModel(),
  ]);
  const defaults = (await fixture(t)).store();
  assert.equal(await defaults.getRetrievalAutoInstallEnabled(), true);
  await automaticSetup(defaults);
  assert.equal(pointerFetches, 1);
  assert.equal(modelPulls, 1);
  assert.equal((await defaults.getRetrievalStatus()).available, true);

  for (const preferences of [{ retrievalAutoInstall: false }, { automaticNetworkRequestsEnabled: false }]) {
    const desktop = (await fixture(t, preferences)).store();
    await automaticSetup(desktop);
    assert.equal((await desktop.getRetrievalStatus()).available, false);
  }
  const managed = (await fixture(t, { automaticNetworkRequestsEnabled: true, retrievalAutoInstall: true }))
    .store({ managedPolicy: lockedPolicy({ automaticNetworkRequests: "off" }) });
  await automaticSetup(managed);
  assert.equal(pointerFetches, 1);
  assert.equal(modelPulls, 1);

  const disabled = (await fixture(t, { automaticNetworkRequestsEnabled: false, retrievalAutoInstall: false })).store();
  assert.equal((await disabled.installRetrievalIndex({ baseUrl })).available, true);
  assert.equal((await disabled.getRetrievalStatusWithUpdates()).available, true);
  assert.equal(pointerFetches, 1);
  assert.equal(modelPulls, 1);
});
