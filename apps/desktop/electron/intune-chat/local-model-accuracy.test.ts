import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { RunLlmApi } from "@openadminos/agent-sdk";

import { AppStateStore } from "../state.js";
import type { IntelligenceSqliteStore } from "./sqlite-store.js";
import { LOCAL_FALLBACK_NOTICES } from "./agentic-loop.js";
import { COMPUTED_ANSWER_NOTICE, structuredQueryForQuestion } from "./structured-question.js";

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
const recent = "2026-11-17T08:00:00.000Z";

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

let originalOllamaUrl: string | undefined;
before(() => {
  originalOllamaUrl = process.env.OPENAGENTS_OLLAMA_URL;
  process.env.OPENAGENTS_OLLAMA_URL = "http://127.0.0.1:9";
});
after(() => {
  if (originalOllamaUrl === undefined) delete process.env.OPENAGENTS_OLLAMA_URL;
  else process.env.OPENAGENTS_OLLAMA_URL = originalOllamaUrl;
});

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-local-accuracy-"));
  const statePath = join(dir, "state.json");
  await writeFile(statePath, JSON.stringify({
    activeProviderId: "ollama", providerChosenByUser: true,
    activeModelByProviderId: { ollama: "openadminos/openadmin-8b" },
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
    defaultModel: "openadminos/openadmin-8b",
    async complete(options) {
      return { text: answer(options), model: "openadminos/openadmin-8b" };
    },
    async *stream(options) {
      const text = answer(options);
      yield { delta: text, accumulated: text, done: true, model: "openadminos/openadmin-8b" };
    },
  };
  const store = new AppStateStore({
    filePath: statePath, userDataPath: dir, statsApiUrl: "",
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

/** A model that copies the computed facts it was given: the pack's computedResult, or the host's observation. */
function factsIn(prompt: string): string[] {
  const at = [...prompt.matchAll(/"facts":\s*\[/g)].at(-1)?.index;
  if (at === undefined) return [];
  const start = prompt.indexOf("[", at);
  let depth = 0;
  for (let index = start; index < prompt.length; index += 1) {
    if (prompt[index] === "[") depth += 1;
    if (prompt[index] === "]" && --depth === 0) return JSON.parse(prompt.slice(start, index + 1)) as string[];
  }
  return [];
}

const final = (answer: string) => JSON.stringify({ final: true, answer });

function assertQ1(content: string): void {
  assert.match(content, /Intune managed devices: 9 \(per OS: Windows 5, Android 2, macOS 2\)\./);
  assert.match(content, /Not compliant: 6 \(Windows 4, Android 1, macOS 1\):/);
  for (const name of NONCOMPLIANT) assert.ok(content.includes(name), `${name} is listed`);
  for (const name of ["WIN-05", "MAC-01", "AND-02", ...ENTRA_ONLY]) assert.ok(!content.includes(name), `${name} is not listed`);
}

describe("local model accuracy on the tester's tenant", () => {
  it("answers Q1 exactly in deterministic mode, from code-computed counts, with no Entra-only device", async () => {
    await withHarness(async ({ store, calls, reply }) => {
      await store.setChatInvestigationMode("always-deterministic");
      // A weak model that copies the facts it was given.
      reply(({ prompt }) => factsIn(prompt).join("\n"));
      const copied = (await store.sendIntuneChatMessage({ content: Q1, refreshIfStale: false })).assistantMessage;
      assertQ1(copied.content);
      assert.equal(copied.engineNotice, undefined);
      // The pack carries the computed result as authoritative and no Entra or sample device rows.
      const prompt = calls[0]!.prompt;
      assert.match(prompt, /"computedResult"/);
      assert.match(prompt, /computedResult is authoritative/);
      for (const name of ENTRA_ONLY) assert.ok(!prompt.includes(name), `${name} never reaches the prompt`);
      assert.ok(!/"resource": "entraDevices"/.test(prompt), "Entra devices are not planned for an Intune question");

      // A weak model that miscounts, as on 2026-11-18: its answer is replaced by the computed one.
      reply(() => "There are 9 devices in Intune. 3 are not compliant: WIN-01, ENTRA-ONLY-01 and ENTRA-ONLY-02.");
      const streamed = (await store.streamIntuneChatMessage({ content: Q1, refreshIfStale: false }, () => {})).assistantMessage;
      assertQ1(streamed.content);
      assert.equal(streamed.engineNotice, COMPUTED_ANSWER_NOTICE);
    });
  });

  it("answers Q1 exactly in auto mode: the host counts first and a weak model's miscount is replaced", async () => {
    await withHarness(async ({ store, calls, reply }) => {
      // Auto is the default mode.
      reply(({ loop }) => (loop ? final("There are 9 devices. 3 are not compliant.") : "unused"));
      const message = (await store.streamIntuneChatMessage({ content: Q1, refreshIfStale: false }, () => {})).assistantMessage;
      assertQ1(message.content);
      assert.equal(message.engineNotice, COMPUTED_ANSWER_NOTICE);
      // One model call: the counts were in its first prompt, run by the host through count_cached.
      assert.equal(calls.length, 1);
      assert.match(calls[0]!.prompt, /computedByHost/);
      const hostCalls = (message.toolTrace ?? []).filter((entry) => entry.tool === "count_cached");
      assert.equal(hostCalls.length, 2);
      assert.deepEqual(hostCalls.map((entry) => (entry.params as { resource: string }).resource), ["managedDevices", "managedDevices"]);

      // A model that states the facts keeps its own answer.
      reply(({ loop, prompt }) => (loop ? final(factsIn(prompt).join("\n")) : "unused"));
      const kept = (await store.sendIntuneChatMessage({ content: Q1, refreshIfStale: false })).assistantMessage;
      assertQ1(kept.content);
      assert.equal(kept.engineNotice, undefined);
    });
  });

  it("narrows a follow-up to the stored result: only Windows gives the 4 noncompliant Windows devices", async () => {
    await withHarness(async ({ store, calls, reply }) => {
      reply(({ loop, prompt }) => (loop ? final(factsIn(prompt).join("\n")) : factsIn(prompt).join("\n")));
      const first = await store.streamIntuneChatMessage({ content: Q1, refreshIfStale: false }, () => {});
      assertQ1(first.assistantMessage.content);

      // The weak model gives the count without the names; the computed list stands in.
      reply(({ loop }) => (loop ? final("4 of them run Windows.") : "unused"));
      const followUp = (await store.streamIntuneChatMessage({ content: "only Windows", conversationId: first.conversation.id, refreshIfStale: false }, () => {})).assistantMessage;
      assert.match(followUp.content, /Windows among the 6 Intune managed devices not compliant from the previous answer: 4:/);
      for (const name of NONCOMPLIANT_WINDOWS) assert.ok(followUp.content.includes(name), name);
      for (const name of ["WIN-05", "MAC-02", "AND-01", ...ENTRA_ONLY]) assert.ok(!followUp.content.includes(name), `${name} is not in the follow-up`);
      // No new full plan: only the managed device cache was read, by the host, with the stored filter.
      assert.deepEqual(followUp.sources?.map((source) => source.resource), ["managedDevices"]);
      const counted = (followUp.toolTrace ?? []).filter((entry) => entry.tool === "count_cached");
      assert.equal(counted.length, 1);
      assert.deepEqual((counted[0]!.params as { filters: unknown[] }).filters, [
        { field: "complianceState", op: "neq", value: "compliant" },
        { field: "operatingSystem", op: "eq", value: "Windows" },
      ]);
      assert.equal(calls.length, 1);

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
    await withHarness(async ({ store, reply }) => {
      await store.setChatInvestigationMode("always-deterministic");
      // A weak model that invents a reason.
      reply(() => "MAC-02 is not compliant because BitLocker is disabled and its OS is out of date.");
      const message = (await store.sendIntuneChatMessage({ content: "why is MAC-02 not compliant?", refreshIfStale: false })).assistantMessage;
      assert.match(message.content, /MAC-02 \(macOS\) is marked noncompliant/);
      assert.match(message.content, /does not include which compliance policy or setting failed/);
      assert.match(message.content, /the last sync was on 2026-05-18/);
      assert.doesNotMatch(message.content, /BitLocker|out of date/);
      assert.equal(message.engineNotice, COMPUTED_ANSWER_NOTICE);

      // A model that says so in its own words keeps its answer.
      reply(() => "The cached data does not include which setting failed for MAC-02. Its last sync was on 2026-05-18, about six months ago.");
      const own = (await store.sendIntuneChatMessage({ content: "why is MAC-02 not compliant?", refreshIfStale: false })).assistantMessage;
      assert.match(own.content, /does not include which setting failed/);
      assert.equal(own.engineNotice, undefined);
    });
  });

  it("falls back to cached data within four model calls when a local model fails, with a plain notice", async () => {
    await withHarness(async ({ store, calls, reply }) => {
      // Never valid tool JSON.
      reply(({ loop }) => (loop ? '```json\n{"tool": "query_ca\n```' : "Deterministic answer."));
      const malformed = (await store.streamIntuneChatMessage({ content: "Which of our devices need attention?", refreshIfStale: false }, () => {})).assistantMessage;
      const loopCalls = calls.filter((call) => call.loop).length;
      assert.ok(loopCalls <= 4, `${loopCalls} loop calls`);
      assert.equal(malformed.engineNotice, LOCAL_FALLBACK_NOTICES.malformed);
      assert.equal(malformed.content, "Deterministic answer.");

      // Valid tool calls that never finish: the compact budget ends the plan at four calls.
      reply(({ loop }) => (loop ? JSON.stringify({ tool: "list_cached_resources", params: {} }) : "Deterministic answer."));
      const endless = (await store.sendIntuneChatMessage({ content: "Which of our devices need attention?", refreshIfStale: false })).assistantMessage;
      assert.equal(calls.filter((call) => call.loop).length, 4);
      assert.equal(endless.engineNotice, LOCAL_FALLBACK_NOTICES["iteration-cap"]);

      // Two failed answers: the model skips the tool loop, and the notice says why.
      reply(() => "Deterministic answer.");
      const skipped = (await store.sendIntuneChatMessage({ content: "Which of our devices need attention?", refreshIfStale: false })).assistantMessage;
      assert.equal(calls.filter((call) => call.loop).length, 0);
      assert.match(skipped.engineNotice ?? "", /openadminos\/openadmin-8b did not complete its last 2 tool-loop answers; on the last one it did not finish its plan\./);
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
      focus: { label: "not compliant", filters: [{ field: "complianceState", op: "neq", value: "compliant" }] },
      list: true,
    });
  });

  it("leaves questions it does not fully understand to the planner", () => {
    for (const question of ["Which of our macOS devices need attention?", "How many devices have BitLocker enabled?", "Which apps are installed on WIN-01?", "Why is WIN-01 not compliant?", "How many users are there?"]) {
      assert.equal(structuredQueryForQuestion({ question, generatedAt: at }), undefined, question);
    }
  });

  it("narrows a previous result only for a follow-up, and reads sync windows", () => {
    const previous = { version: 1 as const, tenantId: "t", question: Q1, resource: "managedDevices" as const, filters: [{ field: "complianceState", op: "neq" as const, value: "compliant" }], label: "Intune managed devices not compliant", total: 6, computedAt: at };
    const synced = structuredQueryForQuestion({ question: "which of those synced this month", generatedAt: at, previous });
    assert.deepEqual(synced?.focus, { label: "synced this month", filters: [{ field: "lastSyncDateTime", op: "gte", value: "2026-11-01T00:00:00.000Z" }] });
    assert.equal(synced?.followUp?.previousQuestion, Q1);
    // A new question with its own subject starts over.
    assert.equal(structuredQueryForQuestion({ question: "how many macOS devices are there?", generatedAt: at, previous })?.followUp, undefined);
  });
});
