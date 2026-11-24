import type { ChatDateTimeLocale } from "../../src/shared/chat-date-time.js";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { RunLlmApi } from "@openadminos/agent-sdk";

import { AppStateStore } from "../state.js";
import type { IntelligenceSqliteStore } from "./sqlite-store.js";
import { LOCAL_FALLBACK_NOTICES } from "./agentic-loop.js";
import { recordAgenticOutcome } from "./service.js";
import { chatResultContextFor, computedTraceEntry, computeStructuredResult, deviceComplianceReasonQuery, deviceRowFilters, structuredQueryForQuestion } from "./structured-question.js";
import { buildAnswerPack, GRAPH_CACHE_RESOURCES, planChatContext } from "./planner.js";
import { readPlannedChatRows } from "../state-helpers.js";

/**
 * The tester's tenant from 2026-11-18, as a seeded cache: 9 Intune managed
 * devices (Windows 5, macOS 2, Android 2), 6 of them not compliant
 * (Windows 4, macOS 1, Android 1), 22 Entra devices and 33 users. The
 * local 8B model said 3 instead of 6, gave no per OS split and named
 * unmanaged Entra devices; these tests hold the answers to the ground truth.
 */
const tenant = { id: "tenant-1", displayName: "Contoso", username: "admin@contoso.example", homeAccountId: "home-1", addedAt: "2026-06-01T10:00:00.000Z" };
const Q1 = "how many devices are there in Intune? show per OS, and show which are not compliant";
const NONCOMPLIANT = ["WIN-01", "WIN-02", "WIN-03", "WIN-04", "MAC-02", "AND-01"];
const NONCOMPLIANT_WINDOWS = ["WIN-01", "WIN-02", "WIN-03", "WIN-04"];
const ENTRA_ONLY = Array.from({ length: 13 }, (_, i) => `ENTRA-ONLY-${String(i + 1).padStart(2, "0")}`);
// Two days ago, so the sync windows in these tests hold on any day they run.
const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

const managedDevices = [
  { id: "md-w1", deviceName: "WIN-01", operatingSystem: "Windows", complianceState: "noncompliant", lastSyncDateTime: recent },
  { id: "md-w2", deviceName: "WIN-02", operatingSystem: "Windows", complianceState: "noncompliant", lastSyncDateTime: recent },
  { id: "md-w3", deviceName: "WIN-03", operatingSystem: "Windows", complianceState: "noncompliant", lastSyncDateTime: recent },
  { id: "md-w4", deviceName: "WIN-04", operatingSystem: "Windows", complianceState: "noncompliant", lastSyncDateTime: recent },
  { id: "md-w5", deviceName: "WIN-05", operatingSystem: "Windows", complianceState: "compliant", lastSyncDateTime: recent },
  { id: "md-m1", deviceName: "MAC-01", operatingSystem: "macOS", complianceState: "compliant", lastSyncDateTime: recent },
  // Six months without a sync: the only lead for "why is MAC-02 not compliant".
  { id: "md-m2", deviceName: "MAC-02", operatingSystem: "macOS", complianceState: "noncompliant", lastSyncDateTime: "2026-05-18T09:30:00.000Z", isEncrypted: false },
  { id: "md-a1", deviceName: "AND-01", operatingSystem: "Android", complianceState: "noncompliant", lastSyncDateTime: recent },
  { id: "md-a2", deviceName: "AND-02", operatingSystem: "Android", complianceState: "compliant", lastSyncDateTime: recent },
];
// The 9 managed devices have Entra objects too; 13 Entra devices are not managed, some of them noncompliant-looking.
const entraDevices = [
  ...managedDevices.map((device, i) => ({ id: `ed-${i}`, deviceId: device.id, displayName: device.deviceName, operatingSystem: device.operatingSystem, isManaged: true, isCompliant: device.complianceState === "compliant" })),
  ...ENTRA_ONLY.map((name, i) => ({ id: `ed-only-${i}`, displayName: name, operatingSystem: i % 2 ? "Windows" : "MacMDM", isManaged: false, isCompliant: false, approximateLastSignInDateTime: recent })),
];
const users = Array.from({ length: 33 }, (_, i) => ({ id: `user-${i}`, displayName: `User ${i}`, userPrincipalName: `user${i}@contoso.example`, accountEnabled: true }));

type Reply = (call: { system: string; prompt: string; loop: boolean }) => string;

interface Harness {
  store: AppStateStore;
  cache: IntelligenceSqliteStore;
  calls: Array<{ system: string; prompt: string; loop: boolean }>;
  graphPaths: string[];
  reply(next: Reply): void;
}

const originalProviderUrls = new Map<string, string | undefined>();
before(() => {
  for (const key of ["OPENAGENTS_OLLAMA_URL", "OPENADMINOS_LM_STUDIO_URL", "OPENADMINOS_LEMONADE_URL"]) {
    originalProviderUrls.set(key, process.env[key]);
    process.env[key] = "http://127.0.0.1:9";
  }
});
after(() => {
  for (const [key, value] of originalProviderUrls) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function withHarness(run: (harness: Harness) => Promise<void>, options: { model?: string; timestampLocale?: ChatDateTimeLocale } = {}): Promise<void> {
  const model = options.model ?? "openadminos/openadmin-8b";
  const dir = await mkdtemp(join(tmpdir(), "openadminos-local-accuracy-"));
  const statePath = join(dir, "state.json");
  await writeFile(statePath, JSON.stringify({
    activeProviderId: "ollama", providerChosenByUser: true,
    activeModelByProviderId: { ollama: model },
    installedAgents: [], runs: [], tenants: [tenant], activeTenantId: tenant.id,
  }));
  const calls: Harness["calls"] = [];
  const graphPaths: string[] = [];
  let reply: Reply = () => "No reply scripted.";
  const answer = (options: { system?: string; prompt: string }) => {
    const call = { system: options.system ?? "", prompt: options.prompt, loop: (options.system ?? "").includes("JSON protocol:") };
    calls.push(call);
    return reply(call);
  };
  const llm: RunLlmApi = {
    available: true,
    defaultModel: model,
    async complete(options) {
      return { text: answer(options), model: "openadminos/openadmin-8b" };
    },
    async *stream(options) {
      const text = answer(options);
      yield { delta: text, accumulated: text, done: true, model: "openadminos/openadmin-8b" };
    },
  };
  // The failure memory is per process; each test starts with the model's slate clean.
  recordAgenticOutcome("ollama", "openadminos/openadmin-8b", true);
  const store = new AppStateStore({
    filePath: statePath, userDataPath: dir, statsApiUrl: "", chatDateTimeLocale: options.timestampLocale,
    tokenStore: { read: async () => "", write: async () => undefined },
    graphFactory: () => ({
      listManagedDevices: async () => [],
      retireManagedDevice: async () => { throw new Error("no writes"); },
      request: async (request) => { graphPaths.push(request.path); return { value: [] }; },
    }),
    llmFactory: () => llm,
  });
  try {
    const cache = (store as unknown as { requireIntelligenceStore(): IntelligenceSqliteStore }).requireIntelligenceStore();
    const refreshedAt = new Date().toISOString();
    cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt, rows: managedDevices });
    cache.replaceGraphResources({ tenantId: tenant.id, resource: "entraDevices", label: "Entra devices", scopeSet: [], refreshedAt, rows: entraDevices });
    cache.replaceGraphResources({ tenantId: tenant.id, resource: "users", label: "Users", scopeSet: [], refreshedAt, rows: users });
    await run({ store, cache, calls, graphPaths, reply(next) { reply = next; calls.length = 0; graphPaths.length = 0; } });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const lastSyncDate = new Date("2026-05-18T09:30:00.000Z");
const lastSyncText = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  ...(lastSyncDate.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
}).format(lastSyncDate);

const final = (answer: string) => JSON.stringify({ final: true, answer });

function assertQ1(content: string): void {
  assert.match(content, /Intune managed devices: 9 \(per OS: Windows 5, Android 2, macOS 2\)\./);
  assert.match(content, /Not compliant: 6 \(Windows 4, Android 1, macOS 1\):/);
  for (const name of NONCOMPLIANT) assert.ok(content.includes(name), `${name} is listed`);
  for (const name of ["WIN-05", "MAC-01", "AND-02", ...ENTRA_ONLY]) assert.ok(!content.includes(name), `${name} is not listed`);
}

describe("local model accuracy on the tester's tenant", () => {
  it("answers Q1 exactly from code on a local model, in deterministic and auto mode, with no Entra-only device", async () => {
    await withHarness(async ({ store, calls, reply }) => {
      // A weak model that miscounts, as on 2026-11-18. A local model never writes this answer.
      reply(({ loop }) => (loop ? final("There are 9 devices. 3 are not compliant: WIN-01, ENTRA-ONLY-01.") : "There are 9 devices. 3 are not compliant: WIN-01, ENTRA-ONLY-01."));
      for (const mode of ["always-deterministic", "auto"] as const) {
        await store.setChatInvestigationMode(mode);
        for (const send of ["send", "stream"] as const) {
          const { conversation, assistantMessage: message } = send === "send"
            ? await store.sendIntuneChatMessage({ content: Q1, refreshIfStale: false })
            : await store.streamIntuneChatMessage({ content: Q1, refreshIfStale: false }, () => {});
          assertQ1(message.content);
          assert.match(message.content, /Counted from the Intune device cache refreshed /);
          assert.ok(message.toolTrace?.[0]?.cacheSource?.refreshedAt);
          assert.ok(!message.content.includes(message.toolTrace[0].cacheSource.refreshedAt));
          const saved = (await store.getIntuneChatMessages(conversation.id)).find((entry) => entry.id === message.id);
          assert.equal(saved?.content, message.content);
          assert.equal(calls.length, 0, `${mode} ${send}: no model call`);
          assert.equal(message.engineNotice, undefined);
          // What ran shows the cache read, with the filter of the listed set.
          assert.deepEqual(message.toolTrace?.map((entry) => [entry.tool, (entry.params as { filters: unknown }).filters]), [["count_cached", [{ field: "complianceState", op: "eq", value: "noncompliant" }]]]);
          assert.deepEqual(message.sources?.map((source) => source.resource), ["managedDevices"], "Entra devices are not planned for an Intune question");
        }
      }
      // Always investigative keeps the loop the admin chose.
      await store.setChatInvestigationMode("always-agentic");
      reply(({ loop, prompt }) => (!loop ? "unused" : prompt.includes("Observation:")
        ? final("9 devices, 6 not compliant.")
        : JSON.stringify({ kind: "tenant", sources: [], tool: "count_cached", params: { resource: "managedDevices", groupBy: ["operatingSystem"] } })));
      const investigated = (await store.sendIntuneChatMessage({ content: Q1, refreshIfStale: false })).assistantMessage;
      assert.ok(calls.length >= 2);
      assert.equal(investigated.content, "9 devices, 6 not compliant.");
    });
  });

  it("gives a model that writes the answer the computed result as authoritative, with no sample device rows", async () => {
    await withHarness(async ({ cache }) => {
      const query = structuredQueryForQuestion({ question: Q1, generatedAt: new Date().toISOString() })!;
      const cacheStatus = cache.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]);
      const computed = computeStructuredResult({ store: cache, tenantId: tenant.id, query, cacheStatus, generatedAt: new Date().toISOString() })!;
      const rows = cache.readGraphRows({ tenantId: tenant.id, resources: ["managedDevices"], searchTerms: [], limitPerResource: 40 });
      const pack = JSON.parse(buildAnswerPack({ question: Q1, tenant, cacheStatus, rows, hasWriteIntent: false, agentSuggestions: [], computed })) as {
        computedResult: { authoritative: boolean; total: number; breakdowns: Record<string, Record<string, number>>; focus: { total: number; rows: Array<{ name: string }> }; facts: string[] };
        resources: Array<{ resource: string; sampleRows: unknown[] }>;
        instruction: string;
        timestampInstruction: string;
      };
      assert.equal(pack.computedResult.authoritative, true);
      assert.deepEqual(pack.computedResult.facts, computed.facts);
      assert.equal(pack.computedResult.total, 9);
      assert.deepEqual(pack.computedResult.breakdowns.operatingSystem, { Windows: 5, Android: 2, macOS: 2 });
      assert.equal(pack.computedResult.focus.total, 6);
      assert.deepEqual(pack.computedResult.focus.rows.map((row) => row.name).sort(), [...NONCOMPLIANT].sort());
      assert.deepEqual(pack.resources.find((block) => block.resource === "managedDevices")?.sampleRows, []);
      assert.match(pack.instruction, /computedResult is authoritative/);
      assert.match(pack.timestampInstruction, /Never show an ISO timestamp to the user/);
      assert.ok(!planChatContext(Q1).resources.includes("entraDevices"));
    });
  });

  it("narrows a follow-up to the stored result: only Windows gives the 4 noncompliant Windows devices", async () => {
    await withHarness(async ({ store, calls, reply }) => {
      reply(({ loop }) => (loop ? final("4 of them run Windows.") : "Four Windows devices."));
      const first = await store.streamIntuneChatMessage({ content: Q1, refreshIfStale: false }, () => {});
      assertQ1(first.assistantMessage.content);

      const followUp = (await store.streamIntuneChatMessage({ content: "only Windows", conversationId: first.conversation.id, refreshIfStale: false }, () => {})).assistantMessage;
      assert.match(followUp.content, /Windows among the 6 Intune managed devices not compliant from the previous answer: 4:/);
      for (const name of NONCOMPLIANT_WINDOWS) assert.ok(followUp.content.includes(name), name);
      for (const name of ["WIN-05", "MAC-02", "AND-01", ...ENTRA_ONLY]) assert.ok(!followUp.content.includes(name), `${name} is not in the follow-up`);
      // No new full plan: only the managed device cache was read, with the stored filter.
      assert.deepEqual(followUp.sources?.map((source) => source.resource), ["managedDevices"]);
      const counted = (followUp.toolTrace ?? []).filter((entry) => entry.tool === "count_cached");
      assert.equal(counted.length, 1);
      assert.deepEqual((counted[0]!.params as { filters: unknown[] }).filters, [
        { field: "complianceState", op: "eq", value: "noncompliant" },
        { field: "operatingSystem", op: "eq", value: "Windows" },
      ]);
      // The trace names the filter, not hundreds of row ids.
      assert.equal((counted[0]!.params as { ids?: unknown }).ids, undefined);
      assert.equal(calls.length, 0);

      // The same narrowing on the deterministic path.
      await store.setChatInvestigationMode("always-deterministic");
      reply(() => "Four Windows devices.");
      const again = (await store.sendIntuneChatMessage({ content: Q1, conversationId: first.conversation.id, refreshIfStale: false })).assistantMessage;
      assertQ1(again.content);
      const deterministic = (await store.sendIntuneChatMessage({ content: "which of those are Windows?", conversationId: first.conversation.id, refreshIfStale: false })).assistantMessage;
      for (const name of NONCOMPLIANT_WINDOWS) assert.ok(deterministic.content.includes(name), name);
      assert.ok(!deterministic.content.includes("MAC-02"));
    });
  });

  it("says the failing rule is not in the cached data and gives the last sync as the only lead (Q2)", async () => {
    await withHarness(async ({ store, calls, reply }) => {
      // A weak model would invent a reason; for a local model the lookup is answered by code, with no model call.
      reply(() => "MAC-02 is not compliant because FileVault is off.");
      for (const mode of ["always-deterministic", "auto"] as const) {
        await store.setChatInvestigationMode(mode);
        reply(() => "MAC-02 is not compliant because FileVault is off.");
        const message = (await store.sendIntuneChatMessage({ content: "why is MAC-02 not compliant?", refreshIfStale: false })).assistantMessage;
        assert.match(message.content, /MAC-02 \(macOS\) is marked noncompliant/, mode);
        assert.match(message.content, /does not include which compliance policy or setting failed/, mode);
        assert.ok(message.content.includes(`the last sync was on ${lastSyncText}`), mode);
        assert.doesNotMatch(message.content, /FileVault/, mode);
        assert.equal(calls.length, 0, `${mode}: no model call`);
        assert.equal(message.engineNotice, undefined, mode);
        // What ran shows the cache read.
        assert.deepEqual(message.toolTrace?.map((entry) => entry.tool), ["count_cached"], mode);
      }
      // Always investigative keeps the loop the admin chose: the model reads the device, then answers.
      await store.setChatInvestigationMode("always-agentic");
      reply(({ loop, prompt }) => (!loop ? "unused" : prompt.includes("Observation:")
        ? final("The cached data does not include which setting failed for MAC-02. Its last sync was on 2026-05-18.")
        : JSON.stringify({ kind: "tenant", sources: [], tool: "query_cache", params: { resource: "managedDevices", where: { deviceName: "MAC-02" } } })));
      const investigated = (await store.sendIntuneChatMessage({ content: "why is MAC-02 not compliant?", refreshIfStale: false })).assistantMessage;
      assert.ok(calls.length > 0);
      assert.match(investigated.content, /does not include which setting failed/);

      // A docs question that names the device is not a device lookup, and its prompt carries no cached device facts.
      await store.setChatInvestigationMode("always-deterministic");
      reply(() => "Microsoft Learn describes compliance policies.");
      await store.sendIntuneChatMessage({ content: "According to Microsoft Learn, why is MAC-02 not compliant?", refreshIfStale: false });
      assert.equal(calls.length, 1);
      assert.doesNotMatch(calls[0]!.prompt, /computedResult/);
    });
  });

  it("leaves a device name two records share to the planner, and stores no context when a failed answer has no cache match", async () => {
    await withHarness(async ({ store, cache, reply }) => {
      cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: new Date().toISOString(),
        rows: [...managedDevices, { id: "md-m2-old", deviceName: "MAC-02", operatingSystem: "macOS", complianceState: "compliant", lastSyncDateTime: recent }] });
      assert.equal(deviceComplianceReasonQuery("why is MAC-02 not compliant?", cache, tenant.id), undefined);
      cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: new Date().toISOString(), rows: managedDevices });
      assert.equal(deviceComplianceReasonQuery("why is MAC-02 not compliant?", cache, tenant.id)?.deviceId, "md-m2");
      // The device name is read as typed: "NON-COMPLIANT" is not rewritten to another device's name.
      cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: new Date().toISOString(),
        rows: [...managedDevices, { id: "md-nc-1", deviceName: "NON-COMPLIANT", operatingSystem: "Windows", complianceState: "noncompliant", lastSyncDateTime: recent }, { id: "md-nc-2", deviceName: "NONCOMPLIANT", operatingSystem: "Windows", complianceState: "compliant", lastSyncDateTime: recent }] });
      assert.equal(deviceComplianceReasonQuery("Why is NON-COMPLIANT not compliant?", cache, tenant.id)?.deviceId, "md-nc-1");
      cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: new Date().toISOString(), rows: managedDevices });
      // A refresh between the lookup and the answer renames MAC-02's device and gives the name to another device:
      // the name now means a different device, so code does not answer and the planner takes the question.
      const lookup = deviceComplianceReasonQuery("why is MAC-02 not compliant?", cache, tenant.id)!;
      cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: new Date().toISOString(),
        rows: managedDevices.map((device) => (device.id === "md-m2" ? { ...device, deviceName: "MAC-02-OLD" } : device.id === "md-m1" ? { ...device, deviceName: "MAC-02" } : device)) });
      // A refresh that adds a "mac-02" next to "MAC-02" leaves two records of that name: code does not pick one.
      cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: new Date().toISOString(),
        rows: [...managedDevices, { id: "md-m2-lower", deviceName: "mac-02", operatingSystem: "macOS", complianceState: "compliant", lastSyncDateTime: recent }] });
      assert.equal(computeStructuredResult({ store: cache, tenantId: tenant.id, query: lookup, cacheStatus: cache.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]), generatedAt: new Date().toISOString() }), undefined);
      cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: new Date().toISOString(),
        rows: managedDevices.map((device) => (device.id === "md-m2" ? { ...device, deviceName: "MAC-02-OLD" } : device.id === "md-m1" ? { ...device, deviceName: "MAC-02" } : device)) });
      const renamed = computeStructuredResult({ store: cache, tenantId: tenant.id, query: lookup, cacheStatus: cache.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]), generatedAt: new Date().toISOString() });
      assert.equal(renamed, undefined);
      cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: new Date().toISOString(), rows: managedDevices });

      // A failed answer to an unmatched question supplies no result for a follow-up to narrow.
      await store.setChatInvestigationMode("always-agentic");
      reply(({ loop }) => (loop ? '```json\n{"tool": "query_ca\n```' : "   "));
      const blank = await store.streamIntuneChatMessage({ content: "Which of our devices need attention?", refreshIfStale: false }, () => {});
      assert.equal(blank.assistantMessage.status, "failed");
      await store.setChatInvestigationMode("auto");
      reply(({ loop }) => (loop ? final("Windows answer.") : "Windows answer."));
      const followUp = (await store.streamIntuneChatMessage({ content: "only Windows", conversationId: blank.conversation.id, refreshIfStale: false }, () => {})).assistantMessage;
      assert.doesNotMatch(followUp.content, /from the previous answer/);
    });
  });

  it("keeps the follow-up context of the shortest compliance question, and the previous answer's devices after a refresh changes them", async () => {
    await withHarness(async ({ store, cache }) => {
      // "Which devices are noncompliant?" is also a direct evidence question; on a local model code answers it and keeps its result.
      const first = await store.sendIntuneChatMessage({ content: "Which devices are noncompliant?", refreshIfStale: false });
      for (const name of NONCOMPLIANT) assert.ok(first.assistantMessage.content.includes(name), name);
      // WIN-01 is fixed and WIN-02 leaves the cache before the follow-up.
      cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: new Date().toISOString(),
        rows: managedDevices.filter((device) => device.id !== "md-w2").map((device) => (device.id === "md-w1" ? { ...device, complianceState: "compliant" } : device)) });
      const followUp = (await store.sendIntuneChatMessage({ content: "only Windows", conversationId: first.conversation.id, refreshIfStale: false })).assistantMessage;
      assert.match(followUp.content, /1 of the devices in the previous answer is no longer in the cache\./);
      assert.match(followUp.content, /Windows among the 6 Intune managed devices not compliant from the previous answer: 3:/);
      assert.match(followUp.content, /WIN-01 \(Windows, compliant/);
      assert.ok(!followUp.content.includes("WIN-02"));
    });
  });

  it("applies a repeated filter to the previous devices' current values, and a follow-up's breakdown to the narrowed rows", async () => {
    await withHarness(async ({ store, cache }) => {
      const first = await store.sendIntuneChatMessage({ content: "Which Windows devices are not compliant?", refreshIfStale: false });
      for (const name of NONCOMPLIANT_WINDOWS) assert.ok(first.assistantMessage.content.includes(name), name);
      // WIN-01 was reimaged as a Mac since the answer.
      cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: new Date().toISOString(),
        rows: managedDevices.map((device) => (device.id === "md-w1" ? { ...device, operatingSystem: "macOS" } : device)) });
      const again = (await store.sendIntuneChatMessage({ content: "only Windows", conversationId: first.conversation.id, refreshIfStale: false })).assistantMessage;
      assert.ok(!again.content.includes("WIN-01"), "a device that is no longer Windows is not listed as Windows");
      assert.match(again.content, /1 of them no longer matches "Intune managed Windows devices not compliant" with its current values/);

      const fleet = await store.sendIntuneChatMessage({ content: Q1, refreshIfStale: false });
      const split = (await store.sendIntuneChatMessage({ content: "how many of those are Windows by compliance state", conversationId: fleet.conversation.id, refreshIfStale: false })).assistantMessage;
      assert.match(split.content, /Windows among the 6 Intune managed devices not compliant from the previous answer: 3 \(per compliance state: noncompliant 3\)/);
    });
  });

  it("shows a requested OS split of a one-OS subset, and forgets the previous result when a turn is stopped", async () => {
    await withHarness(async ({ store }) => {
      const first = await store.sendIntuneChatMessage({ content: "Which Windows devices are not compliant?", refreshIfStale: false });
      const split = (await store.sendIntuneChatMessage({ content: "how many of those are not compliant by OS", conversationId: first.conversation.id, refreshIfStale: false })).assistantMessage;
      assert.match(split.content, /: 4 \(Windows 4\):/);

      // A stopped turn after the list: "only Windows" no longer narrows the older answer.
      const controller = new AbortController();
      const stopped = await store.streamIntuneChatMessage({ content: "Which recent sign-ins failed?", conversationId: first.conversation.id }, (event) => {
        if (event.type === "status" && event.message.startsWith("Refreshing")) controller.abort();
      }, { signal: controller.signal });
      assert.equal(stopped.assistantMessage.status, "cancelled");
      const after = (await store.sendIntuneChatMessage({ content: "only Windows", conversationId: first.conversation.id, refreshIfStale: false })).assistantMessage;
      assert.doesNotMatch(after.content, /from the previous answer/);
    });
  });

  it("leaves a question with attached workspace instructions to the model, which reads them", async () => {
    await withHarness(async ({ store, calls, reply }) => {
      await store.setChatInvestigationMode("always-deterministic");
      const workspace = await store.createWorkspace({ title: "Lab review", tenantId: tenant.id, instructions: "Exclude devices whose name starts with LAB-." });
      reply(() => "Model answer that applies the workspace instructions.");
      const message = (await store.sendIntuneChatMessage({ content: Q1, refreshIfStale: false, workspaceContext: { workspaceId: workspace.id, evidenceIds: [], noteIds: [], includeInstructions: true } })).assistantMessage;
      assert.equal(message.content, "Model answer that applies the workspace instructions.");
      assert.ok(calls.some((call) => /Exclude devices whose name starts with LAB-/.test(call.prompt)));
      assert.doesNotMatch(calls[0]!.prompt, /computedResult/);
    });
  });

  it("leaves the direct compliance answer to the model when workspace instructions are attached, in both send paths", async () => {
    await withHarness(async ({ store, calls, reply }) => {
      await store.setChatInvestigationMode("always-deterministic");
      const workspace = await store.createWorkspace({ title: "Lab review", tenantId: tenant.id, instructions: "Exclude devices whose name starts with WIN-." });
      reply(() => "Model answer that applies the workspace instructions.");
      const workspaceContext = { workspaceId: workspace.id, evidenceIds: [], noteIds: [], includeInstructions: true };
      for (const send of ["send", "stream"] as const) {
        const message = (send === "send"
          ? await store.sendIntuneChatMessage({ content: "Which devices are noncompliant?", refreshIfStale: false, workspaceContext })
          : await store.streamIntuneChatMessage({ content: "Which devices are noncompliant?", refreshIfStale: false, workspaceContext }, () => {})).assistantMessage;
        assert.equal(message.content, "Model answer that applies the workspace instructions.", send);
        assert.ok(calls.some((call) => /Exclude devices whose name starts with WIN-/.test(call.prompt)), send);
      }
    });
  });

  it("leaves a counted question to the model once a model answered in the chat, which may hold a standing instruction", async () => {
    await withHarness(async ({ store, calls, reply }) => {
      await store.setChatInvestigationMode("always-deterministic");
      reply(() => "Understood. Devices whose name starts with WIN- are left out from now on.");
      const first = await store.sendIntuneChatMessage({ content: "For the rest of this chat, exclude devices whose names start with WIN-.", refreshIfStale: false });
      reply(() => "Model answer without the WIN- devices.");
      const next = (await store.sendIntuneChatMessage({ content: Q1, conversationId: first.conversation.id, refreshIfStale: false })).assistantMessage;
      assert.equal(next.content, "Model answer without the WIN- devices.");
      assert.ok(calls.some((call) => /exclude devices whose names start with WIN-/i.test(call.prompt)), "the model read the earlier instruction");
    });
  });

  it("leaves the direct compliance answer to the model once a model answered in the chat, in both send paths", async () => {
    await withHarness(async ({ store, calls, reply }) => {
      await store.setChatInvestigationMode("always-deterministic");
      for (const send of ["send", "stream"] as const) {
        reply(() => "Understood. Devices whose name starts with WIN- are left out from now on.");
        const first = await store.sendIntuneChatMessage({ content: "For the rest of this chat, exclude devices whose names start with WIN-.", refreshIfStale: false });
        reply(() => "Model answer without the WIN- devices.");
        const request = { content: "Which devices are noncompliant?", conversationId: first.conversation.id, refreshIfStale: false };
        const message = (send === "send" ? await store.sendIntuneChatMessage(request) : await store.streamIntuneChatMessage(request, () => {})).assistantMessage;
        assert.equal(message.content, "Model answer without the WIN- devices.", send);
        assert.ok(calls.some((call) => /exclude devices whose names start with WIN-/i.test(call.prompt)), `${send}: the model read the earlier instruction`);
        for (const name of NONCOMPLIANT_WINDOWS) assert.ok(!message.content.includes(name), `${send}: ${name}`);
      }
    });
  });

  it("corrects the premise of a compliance question about a compliant device, with no failed rule guidance", async () => {
    await withHarness(async ({ store, calls, reply }) => {
      await store.setChatInvestigationMode("always-deterministic");
      reply(() => "WIN-05 is not compliant because BitLocker is off.");
      const message = (await store.sendIntuneChatMessage({ content: "why is WIN-05 not compliant?", refreshIfStale: false })).assistantMessage;
      assert.equal(calls.length, 0);
      assert.match(message.content, /WIN-05 \(Windows\) is marked compliant/);
      assert.match(message.content, /WIN-05 is compliant in this snapshot, so no compliance rule is failing for it here\./);
      assert.doesNotMatch(message.content, /failing setting|failed for this device|Lead in the data|BitLocker/);
      assert.match(message.content, /The last sync was on /);

      // A noncompliant device that synced two days ago: the guidance stays, but a recent sync is no lead.
      const recentSync = (await store.sendIntuneChatMessage({ content: "why is WIN-01 not compliant?", refreshIfStale: false })).assistantMessage;
      assert.match(recentSync.content, /does not include which compliance policy or setting failed/);
      assert.match(recentSync.content, /The last sync was on .*, 2 days before this answer\./);
      assert.doesNotMatch(recentSync.content, /Lead in the data/);
    });
  });

  it("finds a device by its exact cached name, also a short one or one with a space", async () => {
    await withHarness(async ({ store, cache, calls }) => {
      await store.setChatInvestigationMode("always-deterministic");
      cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: new Date().toISOString(),
        rows: [...managedDevices,
          { id: "md-pc1", deviceName: "PC1", operatingSystem: "Windows", complianceState: "noncompliant", lastSyncDateTime: recent },
          { id: "md-desk", deviceName: "Front Desk", operatingSystem: "Windows", complianceState: "noncompliant", lastSyncDateTime: recent }] });
      for (const name of ["PC1", "Front Desk"]) {
        const message = (await store.sendIntuneChatMessage({ content: `why is ${name} not compliant?`, refreshIfStale: false })).assistantMessage;
        assert.match(message.content, new RegExp(`^${name} \\(Windows\\) is marked noncompliant`), name);
      }
      assert.equal(calls.length, 0, "answered by code");
      assert.equal(deviceComplianceReasonQuery("why is my laptop not compliant?", cache, tenant.id), undefined);
      // A name that starts with "Device" is looked up whole first, never as the shorter name next to it.
      cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: new Date().toISOString(),
        rows: [...managedDevices,
          { id: "md-devlab", deviceName: "Device Lab", operatingSystem: "Windows", complianceState: "noncompliant", lastSyncDateTime: recent },
          { id: "md-lab", deviceName: "Lab", operatingSystem: "macOS", complianceState: "compliant", lastSyncDateTime: recent }] });
      assert.equal(deviceComplianceReasonQuery("Why is Device Lab not compliant?", cache, tenant.id)?.deviceId, "md-devlab");
      assert.equal(deviceComplianceReasonQuery("Why is the device WIN-01 not compliant?", cache, tenant.id)?.deviceId, "md-w1");

      // Resolved as "Lab" on a cache without "Device Lab": once the refresh adds "Device Lab", the asked name
      // means that device, so the stale lookup is not answered and the planner takes the question.
      const at = new Date().toISOString();
      cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: at,
        rows: [...managedDevices, { id: "md-lab", deviceName: "Lab", operatingSystem: "macOS", complianceState: "compliant", lastSyncDateTime: recent }] });
      const stale = deviceComplianceReasonQuery("Why is Device Lab not compliant?", cache, tenant.id)!;
      assert.equal(stale.deviceId, "md-lab");
      cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: at,
        rows: [...managedDevices,
          { id: "md-lab", deviceName: "Lab", operatingSystem: "macOS", complianceState: "compliant", lastSyncDateTime: recent },
          { id: "md-devlab", deviceName: "Device Lab", operatingSystem: "Windows", complianceState: "noncompliant", lastSyncDateTime: recent }] });
      assert.equal(computeStructuredResult({ store: cache, tenantId: tenant.id, query: stale, cacheStatus: cache.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]), generatedAt: at }), undefined);

      // The name keeps its own spacing: "Front  Desk" (two spaces) is not "Front Desk" (one).
      cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: at,
        rows: [...managedDevices,
          { id: "md-desk-1", deviceName: "Front Desk", operatingSystem: "Windows", complianceState: "compliant", lastSyncDateTime: recent },
          { id: "md-desk-2", deviceName: "Front  Desk", operatingSystem: "Windows", complianceState: "noncompliant", lastSyncDateTime: "2026-05-18T09:30:00.000Z" }] });
      const twoSpaces = deviceComplianceReasonQuery("Why is Front  Desk not compliant?", cache, tenant.id)!;
      assert.equal(twoSpaces.deviceId, "md-desk-2");
      const detail = computeStructuredResult({ store: cache, tenantId: tenant.id, query: twoSpaces, cacheStatus: cache.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]), generatedAt: at })!.facts.join("\n");
      assert.match(detail, /is marked noncompliant/);
      assert.ok(detail.includes(`the last sync was on ${lastSyncText}`));
      assert.equal(deviceComplianceReasonQuery("Why is Front Desk not compliant?", cache, tenant.id)?.deviceId, "md-desk-1");

      // A curly apostrophe is part of the name: "Alice’s iPhone" is not "Alice's iPhone".
      cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: at,
        rows: [...managedDevices,
          { id: "md-alice-curly", deviceName: "Alice’s iPhone", operatingSystem: "iOS", complianceState: "noncompliant", lastSyncDateTime: "2026-05-18T09:30:00.000Z" },
          { id: "md-alice-straight", deviceName: "Alice's iPhone", operatingSystem: "iOS", complianceState: "compliant", lastSyncDateTime: recent }] });
      const curly = deviceComplianceReasonQuery("Why is Alice’s iPhone not compliant?", cache, tenant.id)!;
      assert.equal(curly.deviceId, "md-alice-curly");
      assert.match(computeStructuredResult({ store: cache, tenantId: tenant.id, query: curly, cacheStatus: cache.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]), generatedAt: at })!.facts.join("\n"), /is marked noncompliant/);
      assert.equal(deviceComplianceReasonQuery("Why is Alice's iPhone not compliant?", cache, tenant.id)?.deviceId, "md-alice-straight");

      // A device the question names stays in the sample rows whatever its words filter on.
      cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: at,
        rows: [...managedDevices, { id: "md-wlab", deviceName: "Windows-Lab", operatingSystem: "macOS", complianceState: "noncompliant", lastSyncDateTime: recent }] });
      const sampled = readPlannedChatRows(cache, { tenantId: tenant.id, question: "Is Windows-Lab compliant?", generatedAt: at, resources: ["managedDevices"], searchTerms: ["windows-lab", "compliant"], limitPerResource: 5 });
      assert.ok((sampled.managedDevices ?? []).some((row) => (row as { id?: string }).id === "md-wlab"), "the named Mac is in the samples");
      // The marker reaches the model through the answer pack.
      const cacheStatus = cache.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]);
      const pack = buildAnswerPack({ question: "Is Windows-Lab compliant?", tenant, cacheStatus, rows: sampled, hasWriteIntent: false, agentSuggestions: [] });
      assert.match(pack, /"namedInQuestion":\s*true/);

      // The named device goes first even when twenty longer names that start with it fill the sample before it.
      cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: at,
        rows: [...Array.from({ length: 25 }, (_, i) => ({ id: `md-win01-${i}`, deviceName: `WIN-01-${String(i).padStart(2, "0")}`, operatingSystem: "Windows", complianceState: "compliant", lastSyncDateTime: recent })),
          { id: "md-win01", deviceName: "WIN-01", operatingSystem: "Windows", complianceState: "compliant", lastSyncDateTime: recent }] });
      const crowded = readPlannedChatRows(cache, { tenantId: tenant.id, question: "Is WIN-01 compliant?", generatedAt: at, resources: ["managedDevices"], searchTerms: ["win-01", "compliant"], limitPerResource: 20 });
      assert.equal((crowded.managedDevices?.[0] as { id?: string } | undefined)?.id, "md-win01");
      assert.equal(new Set((crowded.managedDevices ?? []).map((row) => (row as { id?: string }).id)).size, crowded.managedDevices?.length, "no duplicates");

      // A name in any script is read as typed and matched ignoring case: "élodie’s iphone" is "Élodie’s iPhone".
      cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: at,
        rows: [...managedDevices, { id: "md-elodie", deviceName: "Élodie’s iPhone", operatingSystem: "iOS", complianceState: "noncompliant", lastSyncDateTime: recent }] });
      assert.equal(deviceComplianceReasonQuery("Why is Élodie’s iPhone not compliant?", cache, tenant.id)?.deviceId, "md-elodie");
      assert.equal(deviceComplianceReasonQuery("why is ÉLODIE’S IPHONE not compliant?", cache, tenant.id)?.deviceId, "md-elodie");

      // A named device goes first in the samples also when the question sets no field filter, as a "why" does.
      cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: at,
        rows: [...Array.from({ length: 25 }, (_, i) => ({ id: `md-other-${i}`, deviceName: `OTHER-${String(i).padStart(2, "0")}`, operatingSystem: "Windows", complianceState: "compliant", lastSyncDateTime: recent })),
          { id: "md-shanghai", deviceName: "上海总部", operatingSystem: "Windows", complianceState: "noncompliant", lastSyncDateTime: recent }] });
      const unfiltered = readPlannedChatRows(cache, { tenantId: tenant.id, question: "Why is 上海总部 not compliant?", generatedAt: at, resources: ["managedDevices"], searchTerms: [], limitPerResource: 20 });
      assert.equal((unfiltered.managedDevices?.[0] as { id?: string } | undefined)?.id, "md-shanghai");
    });
  });

  it("words a device in its grace period as an unmet setting, not a failed rule", async () => {
    await withHarness(async ({ store, cache }) => {
      await store.setChatInvestigationMode("always-deterministic");
      cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: new Date().toISOString(),
        rows: [...managedDevices, { id: "md-grace", deviceName: "WIN-GRACE", operatingSystem: "Windows", complianceState: "inGracePeriod", lastSyncDateTime: "2026-05-18T09:30:00.000Z" }] });
      const message = (await store.sendIntuneChatMessage({ content: "why is WIN-GRACE not compliant?", refreshIfStale: false })).assistantMessage;
      assert.match(message.content, /WIN-GRACE is in its grace period/);
      assert.match(message.content, /which compliance setting this device does not meet/);
      assert.doesNotMatch(message.content, /setting failed|failing rule/);
      assert.ok(message.content.includes(`Lead in the data: the last sync was on ${lastSyncText}`));
    });
  });

  it("does not write the selected model on a blocked write request", async () => {
    await withHarness(async ({ store, reply }) => {
      reply(() => "unused");
      for (const send of ["send", "stream"] as const) {
        const request = { content: "Retire WIN-01", refreshIfStale: false };
        const message = (send === "send" ? await store.sendIntuneChatMessage(request) : await store.streamIntuneChatMessage(request, () => {})).assistantMessage;
        assert.equal(message.model, undefined, send);
      }
    });
  });

  it("lists stale devices with sync ages and cache evidence without asking the model", async () => {
    await withHarness(async ({ store, cache, calls }) => {
      const now = Date.now();
      cache.replaceGraphResources({
        tenantId: tenant.id,
        resource: "managedDevices",
        label: "Managed devices",
        scopeSet: [],
        refreshedAt: new Date(now).toISOString(),
        rows: managedDevices.slice(0, 3).map((row, index) => ({
          ...row,
          lastSyncDateTime: new Date(now - [13, 9, 1][index]! * 86_400_000).toISOString(),
        })),
      });
      const { assistantMessage } = await store.streamIntuneChatMessage({
        content: "Which managed devices have not synced in the last 7 days, and what evidence supports the answer?",
        refreshIfStale: false,
      }, () => {});
      assert.equal(calls.length, 0);
      assert.match(assistantMessage.content, /Intune managed devices not synced in the last 7 days: 2\./);
      assert.match(assistantMessage.content, /WIN-01 \(Windows, .*13 days ago\)/);
      assert.match(assistantMessage.content, /WIN-02 \(Windows, .*9 days ago\)/);
      assert.doesNotMatch(assistantMessage.content, /WIN-03/);
      assert.match(assistantMessage.content, /Counted from the Intune device cache refreshed/);
    });
  });

  it("says how many devices have no reported sync time instead of leaving them out silently", async () => {
    await withHarness(async ({ store, cache }) => {
      cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: new Date().toISOString(),
        rows: [...managedDevices, { id: "md-nosync", deviceName: "NEW-01", operatingSystem: "Windows", complianceState: "compliant" }] });
      const message = (await store.sendIntuneChatMessage({ content: "How many devices have not synced in the last 7 days?", refreshIfStale: false })).assistantMessage;
      assert.match(message.content, /Intune managed devices not synced in the last 7 days: 1\./);
      assert.match(message.content, /1 device has no reported sync time and is not counted in the sync window\./);
    });
  });

  it("reads \"which of those are compliant now\" on the previous answer's devices after a refresh", async () => {
    await withHarness(async ({ store, cache, calls, reply }) => {
      await store.setChatInvestigationMode("always-deterministic");
      const first = await store.sendIntuneChatMessage({ content: Q1, refreshIfStale: false });
      cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: new Date().toISOString(),
        rows: managedDevices.map((device) => (device.deviceName === "WIN-01" ? { ...device, complianceState: "compliant" } : device)) });
      const followUp = (await store.sendIntuneChatMessage({ content: "Which of those are compliant now?", conversationId: first.conversation.id, refreshIfStale: false })).assistantMessage;
      assert.equal(calls.length, 0, "answered by code");
      assert.match(followUp.content, /Compliant among the 6 /);
      assert.match(followUp.content, /: 1:/);
      assert.ok(followUp.content.includes("WIN-01"));
      // Devices already compliant in the first answer are not part of it.
      for (const name of ["WIN-05", "MAC-01", "AND-02"]) assert.ok(!followUp.content.includes(name), name);
      // "only the compliant ones" does not name the previous rows and stays with the planner.
      // "what about macOS?" after it is not rebuilt: the set and the subset would need both compliance values.
      reply(() => "Planner answer.");
      const switched = (await store.sendIntuneChatMessage({ content: "What about macOS?", conversationId: first.conversation.id, refreshIfStale: false })).assistantMessage;
      assert.doesNotMatch(switched.content, /: 0[.:]/);
      assert.ok(calls.length > 0, "the switch went to the planner");
      // The chain keeps the history safeguard through another narrowing: "only Windows", then "what about macOS?".
      const seed = (rows: typeof managedDevices) => cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: new Date().toISOString(), rows });
      seed(managedDevices);
      const chain = await store.sendIntuneChatMessage({ content: Q1, refreshIfStale: false });
      seed(managedDevices.map((device) => (device.deviceName === "WIN-01" ? { ...device, complianceState: "compliant" } : device)));
      await store.sendIntuneChatMessage({ content: "Which of those are compliant now?", conversationId: chain.conversation.id, refreshIfStale: false });
      const windows = (await store.sendIntuneChatMessage({ content: "only Windows", conversationId: chain.conversation.id, refreshIfStale: false })).assistantMessage;
      assert.ok(windows.content.includes("WIN-01"), "only Windows narrows the compliant-now devices");
      reply(() => "Planner answer.");
      const chainSwitch = (await store.sendIntuneChatMessage({ content: "What about macOS?", conversationId: chain.conversation.id, refreshIfStale: false })).assistantMessage;
      assert.equal(chainSwitch.content, "Planner answer.");
      assert.ok(!chainSwitch.content.includes("MAC-01"));
      const previous = { version: 1 as const, question: Q1, resource: "managedDevices" as const, filters: [{ field: "complianceState", op: "eq" as const, value: "noncompliant" }], label: "Intune managed devices not compliant", total: 6, ids: ["md-w1"], tenantId: tenant.id, computedAt: new Date().toISOString() };
      assert.equal(structuredQueryForQuestion({ question: "only the compliant ones", generatedAt: new Date().toISOString(), previous }), undefined);
    });
  });

  it("keeps a follow-up to the previous answer's devices after a refresh adds one", async () => {
    await withHarness(async ({ store, cache }) => {
      await store.setChatInvestigationMode("always-deterministic");
      const first = await store.sendIntuneChatMessage({ content: Q1, refreshIfStale: false });
      cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: new Date().toISOString(),
        rows: [...managedDevices, { id: "md-w6", deviceName: "WIN-06", operatingSystem: "Windows", complianceState: "noncompliant", lastSyncDateTime: recent }] });
      const followUp = (await store.sendIntuneChatMessage({ content: "only Windows", conversationId: first.conversation.id, refreshIfStale: false })).assistantMessage;
      for (const name of NONCOMPLIANT_WINDOWS) assert.ok(followUp.content.includes(name), name);
      assert.ok(!followUp.content.includes("WIN-06"), "the device added after the answer is not part of it");
    });
  });

  it("ends within four model calls and says why successive local investigations failed", async () => {
    await withHarness(async ({ store, calls, reply }) => {
      const input = { content: "Which of our devices need attention?", refreshIfStale: false };
      reply(() => '```json\n{"tool": "query_ca\n```');
      const malformed = (await store.streamIntuneChatMessage(input, () => {})).assistantMessage;
      assert.ok(calls.length <= 4);
      assert.match(malformed.content, /^The local model did not return a valid tool request\./);
      assert.equal(malformed.status, "failed");
      assert.equal(malformed.engineNotice, undefined);

      reply(() => JSON.stringify({ tool: "list_cached_resources", params: {} }));
      const endless = (await store.sendIntuneChatMessage(input)).assistantMessage;
      assert.equal(calls.length, 4);
      assert.match(endless.content, /^The local model did not finish its plan\./);
      assert.equal(endless.toolTrace?.length, 3, "there is no model call left to use the last tool's result");
      assert.equal(endless.status, "failed");

      reply(() => { throw new Error("a sidelined model must not receive an unverified cache pack"); });
      for (const send of ["send", "stream"] as const) {
        const skipped = (send === "send" ? await store.sendIntuneChatMessage(input) : await store.streamIntuneChatMessage(input, () => {})).assistantMessage;
        assert.equal(calls.length, 0);
        assert.equal(skipped.engineNotice, undefined);
        assert.equal(skipped.status, "failed");
        assert.match(skipped.content, /openadminos\/openadmin-8b did not complete its last 2 tool-loop answers: it did not return a valid tool request once; it did not finish its plan once\./);
      }
    });
  });
});

describe("The cache after a failed local investigation", () => {
  it("rejects an unrelated model fallback in both send paths even when fictional device rows are cached", async () => {
    await withHarness(async ({ store, calls, reply }) => {
      const wrongAnswer = `4 devices need attention: ${NONCOMPLIANT.join(", ")}.`;
      const input = { content: "Which of our devices need attention?", refreshIfStale: false };
      for (const send of ["send", "stream"] as const) {
        recordAgenticOutcome("ollama", "openadminos/openadmin-8b", true);
        reply(({ loop }) => loop ? JSON.stringify({ tool: "list_cached_resources", params: {} }) : wrongAnswer);
        const message = (send === "send" ? await store.sendIntuneChatMessage(input) : await store.streamIntuneChatMessage(input, () => {})).assistantMessage;
        assert.ok(calls.every((call) => call.loop));
        assert.equal(message.status, "failed");
        assert.doesNotMatch(message.content, /4 devices|WIN-01/);
      }
    });
  });

  it("builds a matched fallback count and list from the same cached rows in both send paths", async () => {
    await withHarness(async ({ store, calls, reply }) => {
      await store.setChatInvestigationMode("always-agentic");
      const input = { content: Q1, refreshIfStale: false };
      for (const send of ["send", "stream"] as const) {
        reply(({ loop }) => loop ? '```json\n{"tool": "query_ca\n```' : `Not compliant: 4. ${NONCOMPLIANT.join(", ")}.`);
        const message = (send === "send" ? await store.sendIntuneChatMessage(input) : await store.streamIntuneChatMessage(input, () => {})).assistantMessage;
        assert.ok(calls.length > 0 && calls.every((call) => call.loop));
        assert.equal(message.status, "completed");
        assert.equal(message.engineNotice, LOCAL_FALLBACK_NOTICES.malformed);
        assert.match(message.content, /Not compliant: 6\b/);
        assert.deepEqual(message.content.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.split(" ")[1]).sort(), [...NONCOMPLIANT].sort());
        assert.equal(message.toolTrace?.at(-1)?.resultSummary, "6 matching cached rows counted · 6 listed");
      }
    });
  });

  it("keeps the promise retries for a model too small for tool use", async () => {
    await withHarness(async ({ store, calls, reply }) => {
      let answered = 0;
      reply(({ loop }) => (loop ? "unused" : ++answered === 1 ? "I'll check that now." : "WIN-01 to WIN-04 need attention."));
      const message = (await store.sendIntuneChatMessage({ content: "Which of our devices need attention?", refreshIfStale: false })).assistantMessage;
      assert.equal(calls.filter((call) => call.loop).length, 0, "no tool loop for a too-small model");
      assert.equal(message.status, "completed");
      assert.equal(message.content, "WIN-01 to WIN-04 need attention.", "the progress reply was retried");
    }, { model: "llama3.2:3b" });
  });


});

describe("A provider that refuses every call", () => {
  it("fails the message without claiming a cached-data answer, in both send paths", async () => {
    await withHarness(async ({ store, reply }) => {
      for (const send of ["send", "stream"] as const) {
        recordAgenticOutcome("ollama", "openadminos/openadmin-8b", true);
        reply(() => { throw new Error("connect ECONNREFUSED 127.0.0.1:11434"); });
        const request = { content: "Which of our devices need attention?", refreshIfStale: false };
        const message = (send === "send" ? await store.sendIntuneChatMessage(request) : await store.streamIntuneChatMessage(request, () => {})).assistantMessage;
        assert.equal(message.status, "failed", send);
        assert.equal(message.engineNotice, undefined, `${send}: no "answered from cached data" notice on a failed message`);
      }
    });
  });
});

describe("A failed lookup on the compact budget", () => {
  it("blocks a zero count when the loop then ends on progress replies", async () => {
    await withHarness(async ({ store, reply }) => {
      let turn = 0;
      reply(({ loop }) => {
        if (!loop) return "0 devices match.";
        turn += 1;
        // A progress reply (nudged), then a rejected count, then progress again: the loop ends on the second
        // progress reply before a second final answer reaches the failed-lookup count.
        return turn === 2 ? JSON.stringify({ tool: "count_cached", params: { resource: "managedDevices", groupBy: ["noSuchField"] } }) : "I'll check that now.";
      });
      const message = (await store.sendIntuneChatMessage({ content: "Which of our devices need attention?", refreshIfStale: false })).assistantMessage;
      assert.match(message.content, /a data lookup failed/);
      assert.doesNotMatch(message.content, /0 devices match/);
    });
  });
});

describe("A retry that finds nothing cached", () => {
  it("keeps the failed lookup pending, so a zero count is not stated", async () => {
    await withHarness(async ({ store, reply }) => {
      let turn = 0;
      reply(({ loop }) => {
        if (!loop) return "0 groups.";
        turn += 1;
        if (turn === 1) return JSON.stringify({ tool: "count_cached", params: { resource: "users" } });
        if (turn === 2) return JSON.stringify({ tool: "count_cached", params: { resource: "groups", groupBy: ["noSuchField"] } });
        if (turn === 3) return JSON.stringify({ tool: "count_cached", params: { resource: "groups" } });
        return final("There are 0 groups.");
      });
      const message = (await store.sendIntuneChatMessage({ content: "How many users and groups do we have?", refreshIfStale: false })).assistantMessage;
      assert.doesNotMatch(message.content, /0 groups/);
      assert.match(message.content, /a data lookup failed/);
    });
  });

  it("keeps the failed lookup pending after a query_cache retry on an uncached resource, in both send paths", async () => {
    await withHarness(async ({ store, reply }) => {
      for (const send of ["send", "stream"] as const) {
        recordAgenticOutcome("ollama", "openadminos/openadmin-8b", true);
        let turn = 0;
        reply(({ loop }) => {
          if (!loop) return "There are 0 groups.";
          turn += 1;
          if (turn === 1) return JSON.stringify({ tool: "count_cached", params: { resource: "users" } });
          if (turn === 2) return JSON.stringify({ tool: "count_cached", params: { resource: "groups", groupBy: ["noSuchField"] } });
          if (turn === 3) return JSON.stringify({ tool: "query_cache", params: { resource: "groups" } });
          return final("There are 0 groups.");
        });
        const input = { content: "How many users and groups do we have?", refreshIfStale: false };
        const message = (send === "send" ? await store.sendIntuneChatMessage(input) : await store.streamIntuneChatMessage(input, () => {})).assistantMessage;
        assert.doesNotMatch(message.content, /0 groups/, send);
      }
    });
  });
});

describe("Local context overflows in the failure memory", () => {
  it("keeps trying the tool loop after consecutive context overflows", async () => {
    await withHarness(async ({ store, calls, reply }) => {
      reply(({ loop }) => {
        if (loop) throw new Error("the prompt exceeds the model's maximum context length (8192 tokens)");
        return "Deterministic answer.";
      });
      for (let turn = 0; turn < 3; turn += 1) {
        const overflow = (await store.sendIntuneChatMessage({ content: "Which of our devices need attention?", refreshIfStale: false })).assistantMessage;
        assert.equal(overflow.status, "failed");
        assert.match(overflow.content, /did not fit the local model.s context window/);
      }
      assert.equal(calls.filter((call) => call.loop).length, 3, "each question tries the tool loop");
    });
  });
});

describe("A local model that cannot be reached", () => {
  it("ends the loop as provider-unavailable and does not count it against the model", async () => {
    await withHarness(async ({ store, calls, reply }) => {
      reply(({ loop }) => {
        if (loop) throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
        return "Deterministic answer.";
      });
      for (let turn = 0; turn < 3; turn += 1) {
        const before = calls.filter((call) => call.loop).length;
        const message = (await store.sendIntuneChatMessage({ content: "Which of our devices need attention?", refreshIfStale: false })).assistantMessage;
        assert.match(message.content, /^The local model is not available\./, `turn ${turn}`);
        assert.equal(calls.filter((call) => call.loop).length, before + 1, `turn ${turn}: the tool loop is still tried`);
      }
    });
  });
});

describe("Stop during the refresh before an answer", () => {
  it("ends in the designed cancelled answer, not an abort error out of the send", async () => {
    const controller = new AbortController();
    await withHarness(async ({ store }) => {
      await store.setChatInvestigationMode("always-deterministic");
      const events: string[] = [];
      // Sign-ins are not cached, so the answer refreshes them first; Stop lands as the refresh starts.
      const result = await store.streamIntuneChatMessage({ content: "Which recent sign-ins failed?" }, (event) => {
        events.push(event.type);
        if (event.type === "status" && event.message.startsWith("Refreshing")) controller.abort();
      }, { signal: controller.signal });
      assert.equal(result.assistantMessage.status, "cancelled");
      assert.match(result.assistantMessage.content, /stopped by user/i);
      assert.ok(events.includes("cancelled"));
    });
  });

  it("ends in the cancelled answer when Stop arrives before the providers are read", async () => {
    await withHarness(async ({ store, calls }) => {
      const controller = new AbortController();
      controller.abort();
      const events: string[] = [];
      const result = await store.streamIntuneChatMessage({ content: "Which of our devices need attention?", refreshIfStale: false }, (event) => { events.push(event.type); }, { signal: controller.signal });
      assert.equal(result.assistantMessage.status, "cancelled");
      assert.ok(events.includes("cancelled"));
      assert.equal(calls.length, 0, "no model call after Stop");
    });
  });
});

describe("an OS switch after a relative sync window", () => {
  it("reads the window again at the switch, so \"today\" is the day of the switch", async () => {
    await withHarness(async ({ cache }) => {
      const monday = new Date(2026, 10, 16, 15, 0, 0).toISOString();
      const tuesday = new Date(2026, 10, 17, 9, 0, 0).toISOString();
      const question = "Which Windows devices synced today?";
      const first = structuredQueryForQuestion({ question, generatedAt: monday })!;
      const computed = computeStructuredResult({ store: cache, tenantId: tenant.id, query: first, cacheStatus: cache.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]), generatedAt: monday })!;
      const previous = chatResultContextFor(computed, { tenantId: tenant.id, question, computedAt: monday })!;
      const switched = structuredQueryForQuestion({ question: "What about macOS?", generatedAt: tuesday, previous })!;
      const sync = [...switched.filters, ...(switched.focus?.filters ?? [])].find((filter) => filter.field === "lastSyncDateTime");
      assert.equal(sync?.value, new Date(2026, 10, 17).toISOString(), "the cutoff is Tuesday's start, not Monday's");
      assert.ok(switched.filters.some((filter) => filter.field === "operatingSystem" && filter.value === "macOS"));

      // A second switch still reads the window from the question that set it, not from "What about macOS?".
      const wednesday = new Date(2026, 10, 18, 9, 0, 0).toISOString();
      const second = computeStructuredResult({ store: cache, tenantId: tenant.id, query: switched, cacheStatus: cache.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]), generatedAt: tuesday })!;
      const afterSwitch = chatResultContextFor(second, { tenantId: tenant.id, question: "What about macOS?", computedAt: tuesday })!;
      const android = structuredQueryForQuestion({ question: "What about Android?", generatedAt: wednesday, previous: afterSwitch })!;
      const androidSync = [...android.filters, ...(android.focus?.filters ?? [])].find((filter) => filter.field === "lastSyncDateTime");
      assert.equal(androidSync?.value, new Date(2026, 10, 18).toISOString(), "the cutoff is Wednesday's start");
      assert.ok(android.filters.some((filter) => filter.field === "operatingSystem" && filter.value === "Android"));
    });
  });
});

describe("computed answers on partial and never-synced data", () => {
  it("leads an unfiltered count with the Graph total when the cache is partial, and labels its splits", async () => {
    await withHarness(async ({ cache }) => {
      const at = new Date().toISOString();
      const partial = (tenantTotal?: number) => cache.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]).map((status) => status.resource === "managedDevices" ? { ...status, ...(tenantTotal ? { tenantTotal } : { pageLimitReached: true }) } : status);
      const count = (question: string, cacheStatus: ReturnType<typeof partial>) => computeStructuredResult({ store: cache, tenantId: tenant.id, query: structuredQueryForQuestion({ question, generatedAt: at })!, cacheStatus, generatedAt: at })!.facts.join("\n");
      const reported = count(Q1, partial(90));
      assert.match(reported, /^Intune managed devices: 90, as Microsoft Graph reported\. The cache holds 9 of them \(per OS: Windows 5, Android 2, macOS 2, cached part only\)\./);
      assert.match(reported, /these counts cover the cached part only/);
      assert.match(count("How many devices are there in Intune?", partial()), /^Intune managed devices: at least 9, the part the cache holds\./);
      assert.match(count("How many noncompliant devices are there?", partial(90)), /^Intune managed devices not compliant in the cached part: 6\./);
    });
  });

  it("uses the desktop timestamp preferences in typed and voice answers", async () => {
    const timestampLocale = { locale: "de-DE", timeZone: "Asia/Tokyo" };
    await withHarness(async ({ store }) => {
      const formatter = new Intl.DateTimeFormat(timestampLocale.locale, {
        timeZone: timestampLocale.timeZone, year: "numeric", month: "short",
        day: "numeric", hour: "2-digit", minute: "2-digit",
      });
      await store.setChatInvestigationMode("always-deterministic");
      const input = { content: Q1, refreshIfStale: false };
      const results = [
        await store.sendIntuneChatMessage(input),
        await store.streamIntuneChatMessage(input, () => {}),
        await store.streamIntuneChatMessage(
          { ...input, content: "List devices that are not encrypted" }, () => {}, { voice: true },
        ),
      ];
      for (const { assistantMessage } of results) {
        const raw = assistantMessage.toolTrace?.[0]?.cacheSource?.refreshedAt;
        assert.ok(raw, assistantMessage.content);
        assert.ok(assistantMessage.content.includes(formatter.format(new Date(raw))));
      }
    }, { timestampLocale });
  });

  it("shows an older refresh in the device's time zone and preserves the exact evidence time", async () => {
    await withHarness(async ({ cache }) => {
      const refreshedAt = "2026-11-21T23:27:04.026Z";
      const generatedAt = "2026-11-23T10:00:00.000Z";
      const cacheStatus = cache.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]).map((status) => status.resource === "managedDevices" ? { ...status, refreshedAt, lastError: "Forbidden" } : status);
      const base = { store: cache, tenantId: tenant.id, cacheStatus, generatedAt };
      const query = structuredQueryForQuestion({ question: Q1, generatedAt })!;
      const berlin = { locale: "en-GB", timeZone: "Europe/Berlin" };
      const count = computeStructuredResult({ ...base, query, timestampLocale: berlin })!;
      assert.equal(count.facts[0], "The latest refresh failed, so these counts are from the snapshot refreshed 22 Nov 2026, 00:27.");
      assert.equal(count.facts.at(-1), "Counted from the Intune device cache refreshed 22 Nov 2026, 00:27.");
      assert.equal(count.snapshot?.refreshedAt, refreshedAt);
      assert.equal(computedTraceEntry(count).cacheSource?.refreshedAt, refreshedAt);

      const lookup = deviceComplianceReasonQuery("why is MAC-02 not compliant?", cache, tenant.id)!;
      const detail = computeStructuredResult({ ...base, query: lookup, timestampLocale: { locale: "en-GB", timeZone: "America/Los_Angeles" } })!.facts;
      assert.equal(detail[0], "The latest refresh failed, so this is the device's state in the snapshot refreshed 21 Nov 2026, 15:27.");
      assert.equal(detail[1], "MAC-02 (macOS) is marked noncompliant in the Intune device cache refreshed 21 Nov 2026, 15:27.");
    });
  });

  it("never shows an unreadable sync time as a date", async () => {
    await withHarness(async ({ cache }) => {
      const at = new Date().toISOString();
      cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: at,
        rows: [...managedDevices, { id: "md-garbled", deviceName: "WIN-GARBLED", operatingSystem: "Windows", complianceState: "noncompliant", lastSyncDateTime: "not-a-date" }] });
      const cacheStatus = cache.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]);
      const listed = computeStructuredResult({ store: cache, tenantId: tenant.id, query: structuredQueryForQuestion({ question: "Which devices are not compliant?", generatedAt: at })!, cacheStatus, generatedAt: at })!.facts.join("\n");
      assert.match(listed, /- WIN-GARBLED \(Windows, noncompliant, no readable sync time\)/);
      assert.doesNotMatch(listed, /last sync not-a-da/);
      const detail = computeStructuredResult({ store: cache, tenantId: tenant.id, query: deviceComplianceReasonQuery("why is WIN-GARBLED not compliant?", cache, tenant.id)!, cacheStatus, generatedAt: at })!.facts.join("\n");
      assert.match(detail, /The cached last sync time for this device is not readable\./);
      assert.doesNotMatch(detail, /not-a-da|Intune reports no sync/);
    });
  });

  it("says no sync reported for a device Intune lists as never synced, in any time zone", async () => {
    await withHarness(async ({ cache }) => {
      const at = new Date().toISOString();
      cache.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: at,
        rows: [...managedDevices, { id: "md-never", deviceName: "WIN-NEVER", operatingSystem: "Windows", complianceState: "noncompliant", lastSyncDateTime: "0001-01-01T00:00:00Z" }] });
      const cacheStatus = cache.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]);
      const listed = computeStructuredResult({ store: cache, tenantId: tenant.id, query: structuredQueryForQuestion({ question: "Which devices have not synced in the last 7 days?", generatedAt: at })!, cacheStatus, generatedAt: at })!.facts.join("\n");
      assert.match(listed, /- WIN-NEVER \(Windows, noncompliant, no sync reported\)/);
      assert.doesNotMatch(listed, /0001|0-12-31/);
      const lookup = deviceComplianceReasonQuery("why is WIN-NEVER not compliant?", cache, tenant.id)!;
      const detail = computeStructuredResult({ store: cache, tenantId: tenant.id, query: lookup, cacheStatus, generatedAt: at })!.facts.join("\n");
      assert.match(detail, /Lead in the data: Intune reports no sync for this device\./);
      assert.doesNotMatch(detail, /0001|0-12-31|days before this answer/);
    });
  });
});

describe("structured device questions", () => {
  const at = "2026-11-19T12:00:00.000Z";
  it("reads Q1 into a count with a per OS breakdown and a not compliant list", () => {
    assert.deepEqual(structuredQueryForQuestion({ question: Q1, generatedAt: at }), {
      kind: "count",
      resource: "managedDevices",
      scopeLabel: "Intune managed devices",
      filters: [],
      breakdown: ["operatingSystem"],
      focus: { label: "not compliant", filters: [{ field: "complianceState", op: "eq", value: "noncompliant" }] },
      list: true,
    });
  });

  it("computes only the listed question shapes and leaves every other question to the planner", () => {
    for (const question of [
      // Review round 7: a noun that also covers phones, two lists at once, a window outside the supported range.
      "How many computers are there in Intune?", "How many devices are there in Intune? List their names, and show which are not compliant", "Which devices synced in the last 5000 days?",
      // Review rounds 5 and 6: independent clauses, two sync windows, qualifiers no filter expresses, a breakdown the set fixes.
      "How many noncompliant devices are there, and how many Windows devices are there?", "Which devices synced in the last 7 days but have not synced in the last 2 days?",
      "How many managed Entra devices are there?", "How many Android tablets are there?", "How many Windows devices are there and show per OS",
      "How many devices are not compliant and synced today?", "how many devices are there without a sync in the last 7 days", "How many devices synced in the last month?",
      "How many Entra devices and Intune devices are there?", "How many devices synced last month?", "How many devices are noncompliant or synced in the last 7 days?", "How many Windows 11 devices are there?", "How many devices are there without Windows?", "How many devices have never synced?", "how many devices are not managed in Intune?", "how many noncompliant devices have not synced", "how many devices have synced?", "how many devices are failing?", "how many devices are not in grace period", "How many devices in Intune are not Windows?", "how many non-Windows devices are there", "How many Windows or macOS devices are there?", "how many devices are not currently compliant", "how many are compliant and how many are not compliant", "which devices are no longer compliant"]) {
      assert.equal(structuredQueryForQuestion({ question, generatedAt: at }), undefined, question);
    }
    for (const question of ["how many devices have not synced in the last 7 days", "Which devices haven't synced in the last 7 days?"]) {
      assert.deepEqual(structuredQueryForQuestion({ question, generatedAt: at })?.filters, [
        { field: "lastSyncDateTime", op: "lt", value: "2026-11-12T12:00:00.000Z" },
      ], question);
    }
    assert.equal(structuredQueryForQuestion({ question: "which devices are not compliant or in grace period", generatedAt: at }), undefined);
    // A second count clause is the subset, never a filter on the whole count.
    const twoParts = structuredQueryForQuestion({ question: "how many Windows devices are there in Intune and how many are not compliant", generatedAt: at });
    // Compliance named only in the second clause does not make the counted Windows devices the Intune inventory.
    assert.equal(structuredQueryForQuestion({ question: "how many Windows devices are there and how many are not compliant", generatedAt: at }), undefined);
    assert.deepEqual(twoParts?.filters, [{ field: "operatingSystem", op: "eq", value: "Windows" }]);
    assert.deepEqual(twoParts?.focus?.filters, [{ field: "complianceState", op: "eq", value: "noncompliant" }]);
    // An OS named only in the second clause is the subset too: the fleet total is still counted.
    for (const question of ["how many devices do we have in Intune, and how many are Windows", "how many devices are there in Intune and which are Windows"]) {
      const subset = structuredQueryForQuestion({ question, generatedAt: at });
      assert.deepEqual(subset?.filters, [], question);
      assert.deepEqual(subset?.focus?.filters, [{ field: "operatingSystem", op: "eq", value: "Windows" }], question);
    }
    // Each filter belongs to its clause: a noncompliant first clause is the counted set, not the subset.
    const bound = structuredQueryForQuestion({ question: "How many noncompliant devices are there, and how many are Windows?", generatedAt: at });
    assert.deepEqual(bound?.filters, [{ field: "complianceState", op: "eq", value: "noncompliant" }]);
    assert.deepEqual(bound?.focus?.filters, [{ field: "operatingSystem", op: "eq", value: "Windows" }]);
    assert.equal(bound?.scopeLabel, "Intune managed devices not compliant");
    // "iOS" is Intune's iOS/iPadOS platform; whether iPads report "iPadOS" is unverified, so "iPadOS" goes to the planner.
    const ios = structuredQueryForQuestion({ question: "How many iOS devices are there in Intune?", generatedAt: at });
    assert.deepEqual(ios?.filters, [{ field: "operatingSystem", op: "in", value: ["iOS", "iPadOS"] }]);
    assert.equal(ios?.scopeLabel, "Intune managed iOS/iPadOS devices");
    assert.equal(structuredQueryForQuestion({ question: "How many iPadOS devices are there in Intune?", generatedAt: at }), undefined);
    // A split after the subset clause could mean the subset or the set.
    assert.equal(structuredQueryForQuestion({ question: "How many devices are there? Show which are Windows, and show them by compliance state", generatedAt: at }), undefined);
    // A second sentence with its own subject is its own question, not a subset of the first.
    assert.equal(structuredQueryForQuestion({ question: "How many Windows devices are there? Which devices are not compliant?", generatedAt: at }), undefined);
    // A clause after a space is read like one after a comma.
    assert.deepEqual(structuredQueryForQuestion({ question: "how many devices are there in Intune per OS", generatedAt: at })?.breakdown, ["operatingSystem"]);
    // A plain or tenant-wide device count can mean Intune or Entra devices: the planner counts both.
    for (const question of ["How many devices are there in our tenant?", "How many devices are there?", "How many devices are there? Show which are not compliant."]) assert.equal(structuredQueryForQuestion({ question, generatedAt: at }), undefined, question);
    assert.deepEqual(structuredQueryForQuestion({ question: "How many devices are there in Intune?", generatedAt: at })?.filters, []);
    // A list is labelled in the question's words.
    assert.equal(structuredQueryForQuestion({ question: "Which managed devices have not synced in the last 7 days?", generatedAt: at })?.scopeLabel, "Intune managed devices not synced in the last 7 days");
    // A union samples no ANDed rows.
    assert.deepEqual(deviceRowFilters("Which devices are Windows or noncompliant?"), []);
    // The sample rows never get the inverse filter either.
    assert.deepEqual(deviceRowFilters("How many devices in Intune are not Windows?"), []);
    // In a "why" question the state and an OS word are the premise or part of a name: the named device stays in the rows.
    assert.deepEqual(deviceRowFilters("Why is PC1 not compliant?"), []);
    assert.deepEqual(deviceRowFilters("Why is Windows-Lab not compliant?"), []);
    // Every other question keeps its filters, whatever its opening words.
    const noncompliant = { field: "complianceState", op: "eq", value: "noncompliant" };
    const windows = { field: "operatingSystem", op: "eq", value: "Windows" };
    assert.deepEqual(deviceRowFilters("Which devices are noncompliant?"), [noncompliant]);
    assert.deepEqual(deviceRowFilters("What devices are noncompliant?"), [noncompliant]);
    assert.deepEqual(deviceRowFilters("Are any Windows devices noncompliant?"), [windows, noncompliant]);
    assert.deepEqual(deviceRowFilters("Tell me the noncompliant devices"), [noncompliant]);
  });

  it("leaves questions it does not fully understand to the planner", () => {
    for (const question of ["Which of our macOS devices need attention?", "How many devices have BitLocker enabled?", "Which apps are installed on WIN-01?", "Why is WIN-01 not compliant?", "How many users are there?"]) {
      assert.equal(structuredQueryForQuestion({ question, generatedAt: at }), undefined, question);
    }
  });

  it("narrows a previous result only for a follow-up, and reads sync windows", () => {
    const previous = { version: 1 as const, tenantId: "t", question: Q1, resource: "managedDevices" as const, filters: [{ field: "complianceState", op: "eq" as const, value: "noncompliant" }], label: "Intune managed devices not compliant", total: 6, ids: ["md-w1", "md-w2", "md-w3", "md-w4", "md-m2", "md-a1"], computedAt: at };
    const synced = structuredQueryForQuestion({ question: "which of those synced this month", generatedAt: at, previous });
    assert.deepEqual(synced?.focus, { label: "synced this month", filters: [{ field: "lastSyncDateTime", op: "gte", value: new Date(2026, 10, 1).toISOString() }] });
    assert.equal(synced?.followUp?.previousQuestion, Q1);
    // A new question with its own subject starts over.
    assert.equal(structuredQueryForQuestion({ question: "how many macOS devices are there?", generatedAt: at, previous })?.followUp, undefined);
    assert.equal(structuredQueryForQuestion({ question: "And how many devices are there in total?", generatedAt: at, previous })?.followUp, undefined);
    // A complete question after a follow-up-able answer is asked afresh: 5 Windows devices, not the 4 noncompliant ones.
    const complete = structuredQueryForQuestion({ question: "And how many Windows devices are there in Intune?", generatedAt: at, previous });
    assert.equal(complete?.followUp, undefined);
    assert.deepEqual(complete?.filters, [{ field: "operatingSystem", op: "eq", value: "Windows" }]);
    assert.equal(structuredQueryForQuestion({ question: "how many macs?", generatedAt: at, previous })?.followUp, undefined);
    // A different value on a filtered field is a new question, not a narrowing to nothing.
    const windows = { ...previous, filters: [{ field: "complianceState", op: "eq" as const, value: "noncompliant" }, { field: "operatingSystem", op: "eq" as const, value: "Windows" }], label: "Intune managed Windows devices not compliant", ids: ["md-w1"],
      shape: { filters: [{ field: "complianceState", op: "eq" as const, value: "noncompliant" }, { field: "operatingSystem", op: "eq" as const, value: "Windows" }], breakdown: [], list: true } };
    // "what about macOS?" asks the same question of macOS: a fresh set, not the previous rows.
    const macos = structuredQueryForQuestion({ question: "what about macOS?", generatedAt: at, previous: windows });
    assert.deepEqual(macos?.filters, [{ field: "complianceState", op: "eq", value: "noncompliant" }, { field: "operatingSystem", op: "eq", value: "macOS" }]);
    assert.equal(macos?.scopeLabel, "Intune managed macOS devices not compliant");
    assert.equal(macos?.ids, undefined);
    assert.equal(macos?.followUp, undefined);
    // A switch keeps the previous question's split and shape: "Same for macOS?" after a Windows count by state.
    const byState = { ...previous, filters: [{ field: "operatingSystem", op: "eq" as const, value: "Windows" }], label: "Intune managed Windows devices", ids: ["md-w1"],
      shape: { filters: [{ field: "operatingSystem", op: "eq" as const, value: "Windows" }], breakdown: ["complianceState"], list: false } };
    const same = structuredQueryForQuestion({ question: "Same for macOS?", generatedAt: at, previous: byState });
    assert.deepEqual(same?.filters, [{ field: "operatingSystem", op: "eq", value: "macOS" }]);
    assert.deepEqual(same?.breakdown, ["complianceState"]);
    assert.equal(same?.list, false);
    // Also when the stored question covered every platform: the OS is added, the split kept.
    const fleetByState = { ...previous, filters: [], label: "Intune managed devices", ids: ["md-w1"], shape: { filters: [], breakdown: ["complianceState"], list: false } };
    const macByState = structuredQueryForQuestion({ question: "Same for macOS?", generatedAt: at, previous: fleetByState });
    assert.deepEqual(macByState?.filters, [{ field: "operatingSystem", op: "eq", value: "macOS" }]);
    assert.deepEqual(macByState?.breakdown, ["complianceState"]);
    // After "Which Windows devices are not compliant?" and "Only Windows", the OS is in the set and the subset: both are swapped.
    const twice = { ...previous, filters: [{ field: "operatingSystem", op: "eq" as const, value: "Windows" }, { field: "complianceState", op: "eq" as const, value: "noncompliant" }], label: "Intune managed Windows devices not compliant", ids: ["md-w1"],
      shape: { filters: [{ field: "operatingSystem", op: "eq" as const, value: "Windows" }, { field: "complianceState", op: "eq" as const, value: "noncompliant" }], focus: { label: "Windows", filters: [{ field: "operatingSystem", op: "eq" as const, value: "Windows" }] }, breakdown: [], list: true } };
    const swapped = structuredQueryForQuestion({ question: "Same for macOS?", generatedAt: at, previous: twice });
    assert.deepEqual(swapped?.filters, [{ field: "operatingSystem", op: "eq", value: "macOS" }, { field: "complianceState", op: "eq", value: "noncompliant" }]);
    assert.deepEqual(swapped?.focus?.filters, [{ field: "operatingSystem", op: "eq", value: "macOS" }]);
    // A split that was over a follow-up's subset is not rebuilt as a split over a new set.
    assert.equal(structuredQueryForQuestion({ question: "what about macOS?", generatedAt: at, previous: { ...fleetByState, shape: { ...fleetByState.shape, focus: { label: "Windows", filters: [{ field: "operatingSystem", op: "eq" as const, value: "Windows" }] }, breakdownOnSubset: true } } }), undefined);
    // Without a switch lead it is not read as one.
    assert.equal(structuredQueryForQuestion({ question: "only macOS", generatedAt: at, previous: windows }), undefined);
    assert.equal(structuredQueryForQuestion({ question: "only the compliant ones", generatedAt: at, previous }), undefined);
    // More than the kept row ids: "of those" cannot be reproduced from the current cache, so it goes to the planner.
    const large = { ...previous, ids: undefined, total: 900 };
    assert.equal(structuredQueryForQuestion({ question: "only Windows", generatedAt: at, previous: large }), undefined);
    // A different compliance value without a switch lead is ambiguous at any size, never a silent swap.
    assert.equal(structuredQueryForQuestion({ question: "only the compliant ones", generatedAt: at, previous: large }), undefined);
  });
});

/** A mock Ollama that answers only the model list: the on-device check reads it, nothing loads a model. */
async function withMockOllamaTags(run: () => Promise<void>): Promise<string[]> {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    if (request.url === "/api/tags") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ models: [{ name: "openadminos/openadmin-8b", model: "openadminos/openadmin-8b" }] }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const saved = process.env.OPENAGENTS_OLLAMA_URL;
  process.env.OPENAGENTS_OLLAMA_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await run();
  } finally {
    if (saved === undefined) delete process.env.OPENAGENTS_OLLAMA_URL;
    else process.env.OPENAGENTS_OLLAMA_URL = saved;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.ok(paths.every((path) => !path.startsWith("/api/chat") && !path.startsWith("/api/generate")), paths.join(", "));
  return paths;
}

describe("Model fit after a local model failure (PR #213 with #215)", () => {
  it("offers a provider when the 8B model's context is too small, with the numbers", async () => {
    await withMockOllamaTags(() => withHarness(async ({ store, reply }) => {
      // The loop overflows the 16k context, as the Ollama adapter reports it.
      reply(({ loop }) => {
        if (loop) throw new Error("Ollama context size too small: This request needs 40,652 tokens of context, but Ollama could only give openadminos/openadmin-8b 16,384, usually because free memory ran out.");
        return "Deterministic answer.";
      });
      const answered = (await store.streamIntuneChatMessage({ content: "Which of our devices need attention?", refreshIfStale: false }, () => {})).assistantMessage;
      assert.equal(answered.status, "failed");
      assert.equal(answered.engineNotice, undefined);
      assert.match(answered.content, /did not fit the local model.s context window/);
      // The answer carries the offer, with the numbers from the provider error; nothing went elsewhere.
      assert.equal(answered.modelFit?.reason, "context-too-small");
      assert.equal(answered.modelFit?.model, "openadminos/openadmin-8b");
      assert.equal(answered.modelFit?.neededTokens, 40652);
      assert.equal(answered.modelFit?.limitTokens, 16384);
      assert.ok(answered.modelFit?.offerId);
      assert.equal(answered.switchedFrom, undefined);
    }));
  });

  it("reports each question's token counts after repeated context overflows", async () => {
    await withMockOllamaTags(() => withHarness(async ({ store, reply }) => {
      let neededTokens = 40000;
      reply(({ loop }) => {
        if (loop) throw new Error(`request (${++neededTokens} tokens) exceeds the available context size (16384 tokens)`);
        return "Deterministic answer.";
      });
      for (const expected of [40001, 40002, 40003]) {
        const { assistantMessage } = await store.streamIntuneChatMessage(
          { content: "Which of our devices need attention?", refreshIfStale: false }, () => {},
        );
        assert.equal(assistantMessage.modelFit?.reason, "context-too-small");
        assert.equal(assistantMessage.modelFit?.neededTokens, expected);
        assert.equal(assistantMessage.modelFit?.limitTokens, 16384);
        assert.ok(assistantMessage.modelFit?.offerId);
      }
    }));
  });

  it("keeps the overflow's offer without asking the model for another answer", async () => {
    await withMockOllamaTags(() => withHarness(async ({ store, calls, reply }) => {
      reply(({ loop }) => {
        if (loop) throw new Error("Ollama context size too small: This request needs 40,652 tokens of context, but Ollama could only give openadminos/openadmin-8b 16,384, usually because free memory ran out.");
        throw new Error("Ollama stopped while answering.");
      });
      const answered = (await store.streamIntuneChatMessage({ content: "Which of our devices need attention?", refreshIfStale: false }, () => {})).assistantMessage;
      assert.equal(answered.status, "failed");
      assert.equal(calls.length, 1);
      assert.equal(answered.modelFit?.reason, "context-too-small");
      assert.equal(answered.modelFit?.neededTokens, 40652);
      assert.ok(answered.modelFit?.offerId);
    }));
  });

  it("fails with the reasoning cause and offers no context fit when the error text reads like a context limit", async () => {
    await withMockOllamaTags(() => withHarness(async ({ store, reply }) => {
      reply(() => {
        throw Object.assign(new Error('Ollama returned only reasoning from "exceed_context_size_error:latest" and no answer.'), { name: "OllamaReasoningWithoutAnswerError" });
      });
      const answered = (await store.streamIntuneChatMessage({ content: "Which of our devices need attention?", refreshIfStale: false }, () => {})).assistantMessage;
      assert.equal(answered.status, "failed");
      assert.match(answered.error ?? "", /returned only reasoning/);
      assert.equal(answered.modelFit, undefined);
    }));
  });

  it("offers a provider once the 8B model has failed the tool loop repeatedly, and not after one malformed answer", async () => {
    await withMockOllamaTags(() => withHarness(async ({ store, reply }) => {
      reply(({ loop }) => (loop ? '```json\n{"tool": "query_ca\n```' : "Deterministic answer."));
      const first = (await store.streamIntuneChatMessage({ content: "Which of our devices need attention?", refreshIfStale: false }, () => {})).assistantMessage;
      assert.match(first.content, /^The local model did not return a valid tool request\./);
      assert.equal(first.modelFit, undefined);
      await store.streamIntuneChatMessage({ content: "Which of our devices need attention?", refreshIfStale: false }, () => {});
      // Two failed answers: Chat stops trying the tool loop on this model and offers the alternatives with its answer.
      const third = (await store.streamIntuneChatMessage({ content: "Which of our devices need attention?", refreshIfStale: false }, () => {})).assistantMessage;
      assert.equal(third.status, "failed");
      assert.equal(third.modelFit?.reason, "repeated-failure");
      assert.ok(third.modelFit?.offerId);
    }));
  });
});
