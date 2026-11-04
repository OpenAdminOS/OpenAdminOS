import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DEFAULT_GRAPH_READ_SCOPE_NAMES, type IntuneChatStep, type RunLlmApi, type TenantRecord } from "@openadminos/agent-sdk";

import { runAgenticChat, type RunAgenticChatInput } from "./agentic-loop.js";
import {
  ChatStepRecorder,
  CitationRegistry,
  planChatSources,
  relabelUnverifiedLearn,
  tenantTieInFollowUp,
  toolStepFinish,
  toolStepStart,
  validFollowUps,
} from "./chat-steps.js";
import { classifyChatQuestion, planChatContext } from "./planner.js";
import { IntelligenceSqliteStore } from "./sqlite-store.js";
import { TenantValueIndex } from "./tenant-values.js";
import { mcpChatToolName, mcpPrivateTermsForTenant, parseMcpResults, type McpChatContext, type McpChatServer, type McpChatTool } from "./tools.js";

const tenant: TenantRecord = { id: "tenant-1", displayName: "Contoso", username: "admin@contoso.example", homeAccountId: "home-1", addedAt: "2026-06-01T10:00:00.000Z" };

const learn: McpChatServer = { id: "microsoft-learn", name: "Microsoft Learn", host: "learn.microsoft.com", useFor: "Official docs.", aliases: ["microsoft learn", "ms learn"], topics: [] };
const kql: McpChatServer = { id: "kql-search", name: "KQL Search", host: "www.kqlsearch.com", useFor: "Example KQL.", aliases: ["kql search"], topics: ["kql", "advanced hunting"] };

const learnTool: McpChatTool = {
  name: mcpChatToolName("microsoft-learn", "microsoft_docs_search"), serverId: "microsoft-learn", serverName: "Microsoft Learn",
  host: "learn.microsoft.com", tool: "microsoft_docs_search", description: "Search docs.",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

function kind(question: string): string {
  return classifyChatQuestion(question, { plannedResources: planChatContext(question).resources, namesSource: /microsoft learn/i.test(question) });
}

describe("question classification", () => {
  it("keeps docs questions off the tenant even when they name a platform", () => {
    for (const question of [
      "What does the microsoft learn say about defender for macos?",
      "Write a KQL query that lists failed sign-ins in the last 24 hours",
      "Microsoft Learn on FileVault escrow requirements",
    ]) assert.equal(kind(question), "docs", question);
  });

  it("treats tenant state as tenant and how-to about our tenant as mixed", () => {
    for (const question of ["How many devices are noncompliant?", "Show stale devices", "Why is HR-LAPTOP-07 noncompliant?", "What is the status of device KIOSK-0042?", "Which users have no MFA?"]) {
      assert.equal(kind(question), "tenant", question);
    }
    // General wording without a docs signal is ambiguous: mixed still needs tenant evidence.
    for (const question of ["What are the noncompliant devices?", "What are the stale devices?", "Is there a macOS device with FileVault off?", "What is the compliance rate?"]) {
      assert.equal(kind(question), "mixed", question);
    }
    for (const question of ["Which of our macOS devices are noncompliant, and what does Microsoft Learn recommend for them?", "How do I fix our noncompliant Windows devices?"]) {
      assert.equal(kind(question), "mixed", question);
    }
    // The grace period is set per compliance policy, so the tenant's own value matters too.
    assert.equal(kind("How long is the Intune compliance grace period?"), "mixed");
    // Questions that only sound general never skip tenant evidence when they mention tenant resources.
    for (const question of [
      "Can I see the noncompliant devices?",
      "Describe the stale devices",
      "Explain why Bob's laptop is noncompliant",
      "Why does Bob's device show noncompliant?",
      "What is the oldest device?",
      "What's the largest group?",
      "What is the last sign-in for jdoe?",
      "What's the default compliance policy?",
      "What's the Autopilot profile for HR?",
      "Do any devices fail the BitLocker requirements?",
      "Are all devices meeting the minimum requirements?",
      "Is there a policy that runs a PowerShell script on Macs?",
      "What are unmanaged devices?",
      "What are jailbroken devices?",
      "What are guest users doing?",
      "What is Bob's device?",
      "What is jdoe's last sign-in?",
      "What are your devices?",
      "What's wrong with enrollment?",
      "Is Bob's laptop compliant according to Intune?",
      "Does Bob's phone meet the compliance requirements according to Intune?",
      "Give me examples of stale devices",
      "Give me a sample of devices not checked in",
      "Give me the script that failed on Bob's device",
      "Create a sample list of noncompliant devices",
      "What do the docs say about our devices?",
      "Write a KQL query that lists Bob's devices",
      "What is Windows Autopatch?",
    ]) assert.notEqual(kind(question), "docs", question);
  });
});

describe("source plan", () => {
  it("requires a named server and prefers Learn over the local index", () => {
    const named = planChatSources({ question: "What does the microsoft learn say about defender for macos?", kind: "docs", servers: [learn, kql], docsIndexAvailable: true });
    assert.deepEqual(named.requiredServerIds, ["microsoft-learn"]);
    assert.equal(named.learnFirst, true);
    assert.equal(named.detail, "Documentation question. Sources: Microsoft Learn, then the local docs index if Microsoft Learn is unavailable. Your tenant is not checked.");
  });

  it("chooses a server by topic and keeps the index direct when Learn is not chosen", () => {
    const plan = planChatSources({ question: "Write a KQL query for failed sign-ins", kind: "docs", servers: [learn, kql], docsIndexAvailable: true });
    assert.deepEqual(plan.requiredServerIds, ["kql-search"]);
    assert.equal(plan.learnFirst, false);
    assert.equal(plan.detail, "Documentation question. Sources: KQL Search and the local docs index. Your tenant is not checked.");
  });

  it("names tenant sources for tenant questions and asks nothing of servers that are not named", () => {
    const plan = planChatSources({ question: "How many devices are noncompliant?", kind: "tenant", servers: [learn], docsIndexAvailable: true });
    assert.deepEqual(plan.requiredServerIds, []);
    assert.equal(plan.detail, "Tenant question. Sources: cached tenant data and Microsoft Graph.");
    const mixed = planChatSources({ question: "How do I fix our noncompliant devices?", kind: "mixed", servers: [learn], docsIndexAvailable: true });
    assert.deepEqual(mixed.requiredServerIds, [], "a mixed question gets no third-party call it did not ask for");
    assert.equal(mixed.detail, "Documentation and tenant question. Sources: the local docs index, and cached tenant data and Microsoft Graph.");
    const named = planChatSources({ question: "What does Microsoft Learn recommend for our noncompliant devices?", kind: "mixed", servers: [learn], docsIndexAvailable: false });
    assert.equal(named.detail, "Documentation and tenant question. Sources: Microsoft Learn, and cached tenant data and Microsoft Graph.");
    assert.match(planChatSources({ question: "What is Autopatch?", kind: "docs", servers: [], docsIndexAvailable: false }).detail, /No documentation source is available/);
  });
});

describe("citations and MCP results", () => {
  it("numbers MCP results after the local passages and reuses a number for the same URL", () => {
    const registry = new CitationRegistry();
    assert.deepEqual(registry.addPassages([{ file: "intune/compliance.md", title: "Compliance", text: "x", indexVersion: "2026-08-26" }]), [1]);
    const cited = registry.addMcpResults([{ title: "Defender on Mac", url: "https://learn.microsoft.com/mac" }, { title: "Again", url: "https://learn.microsoft.com/mac" }], learnTool);
    assert.deepEqual(cited.map((entry) => entry.cite), ["[2]", "[2]"]);
    assert.deepEqual(registry.addMcpResults([], learnTool).map((entry) => entry.cite), ["[3]"]);
    assert.deepEqual(registry.sources.map((source) => [source.citation, source.kind, source.title]), [
      [1, "docs-index", "Compliance"], [2, "mcp", "Defender on Mac"], [3, "mcp", "Microsoft Learn result"],
    ]);
    assert.equal(registry.sources[0]!.indexVersion, "2026-08-26");
  });

  it("reads titles and links from JSON and Markdown results, and drops unsafe links", () => {
    assert.deepEqual(parseMcpResults(JSON.stringify({ results: [
      { title: "Defender for Endpoint on Mac", content: "...", contentUrl: "https://learn.microsoft.com/defender-endpoint/mac" },
      { title: "Bad", contentUrl: "javascript:alert(1)" },
    ] })), [{ title: "Defender for Endpoint on Mac", url: "https://learn.microsoft.com/defender-endpoint/mac" }]);
    assert.deepEqual(parseMcpResults("See [Failed sign-ins](https://www.kqlsearch.com/query/1) and [x](ftp://a)."), [{ title: "Failed sign-ins", url: "https://www.kqlsearch.com/query/1" }]);
    assert.equal(parseMcpResults(JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ name: `Q${i}`, url: `https://example.com/${i}` })))).length, 10);
  });
});

describe("follow-ups", () => {
  it("keeps at most two trimmed, short, read-only follow-ups", () => {
    assert.deepEqual(validFollowUps(["  Which Macs miss the  system extension profile? ", "Retire the 5 Macs that are not onboarded", "x".repeat(121), "which macs miss the system extension profile?", "Show onboarding state", "Third one"]), [
      "Which Macs miss the system extension profile?", "Show onboarding state",
    ]);
    assert.deepEqual(validFollowUps("not a list"), []);
    assert.deepEqual(validFollowUps(["Read https://evil.example/x", "Open www.contoso.com", "See learn.microsoft.com", "Which Macs miss the profile?"]), ["Which Macs miss the profile?"]);
    assert.deepEqual(validFollowUps(["Why is MAC-07 offline?", "Which Macs are offline?"], (text) => /MAC-07/.test(text)), ["Which Macs are offline?"]);
  });

  it("offers a tenant check for a docs question with a tenant tie-in, counted from the cache", () => {
    const question = "What does the microsoft learn say about defender for macos?";
    const base = { question, kind: "docs" as const, tieInResources: planChatContext(question).resources };
    assert.equal(tenantTieInFollowUp({ ...base, deviceCountsByOs: { macOS: 5, Windows: 4 } }), "Check our 5 macOS devices for Defender in Intune");
    assert.equal(tenantTieInFollowUp({ ...base }), "Check our macOS devices for Defender in Intune");
    assert.equal(tenantTieInFollowUp({ ...base, deviceCountsByOs: { Windows: 4 } }), undefined);
    assert.equal(tenantTieInFollowUp({ ...base, kind: "tenant" }), undefined);
    const kqlQuestion = "Write a KQL query that lists failed sign-ins in the last 24 hours";
    assert.equal(tenantTieInFollowUp({ question: kqlQuestion, kind: "docs", tieInResources: planChatContext(kqlQuestion).resources }), "Check how this applies to our sign-in logs");
  });
});

describe("source labels and steps", () => {
  it("calls text Microsoft Learn only when a Learn call ran", () => {
    assert.equal(relabelUnverifiedLearn("Microsoft Learn says X [1]. Also, the Microsoft Learn article recommends Y.", false), "The Microsoft documentation says X [1]. Also, the Microsoft Learn article recommends Y.");
    assert.equal(relabelUnverifiedLearn("According to Microsoft Learn, X. It is X, according to the Microsoft Learn.", false), "According to the Microsoft documentation, X. It is X, according to the Microsoft documentation.");
    assert.equal(relabelUnverifiedLearn("X, as Microsoft Learn recommends.", false), "X, as the Microsoft documentation recommends.");
    // Statements about Learn itself and code are left alone.
    for (const text of ["Microsoft Learn is not installed, so this comes from the local docs index.", "Run `echo Microsoft Learn says hi`.", "```\n# Microsoft Learn says\n```"]) {
      assert.equal(relabelUnverifiedLearn(text, false), text);
    }
    assert.equal(relabelUnverifiedLearn("Microsoft Learn says X.", true), "Microsoft Learn says X.");
  });

  it("keeps the model step last while it runs and settles open steps", () => {
    const seen: IntuneChatStep[][] = [];
    const steps = new ChatStepRecorder((list) => seen.push(list));
    steps.start({ kind: "answer", title: "Working on the answer", origin: "model", originLabel: "OpenAI" });
    const tool = steps.start({ kind: "tool", title: "Querying cached data", origin: "device", originLabel: "On device" });
    assert.deepEqual(steps.steps.map((step) => step.kind), ["tool", "answer"]);
    steps.finish(tool);
    steps.settle("completed");
    assert.ok(steps.steps.every((step) => step.status === "completed" && typeof step.durationMs === "number"));
    assert.equal(seen.length, 4);
  });

  it("shows the exact text an MCP call sent, and no sent text when it was blocked", () => {
    const start = toolStepStart(learnTool.name, { query: "Defender for Endpoint on macOS requirements" }, learnTool, "OpenAI");
    assert.deepEqual([start.kind, start.origin, start.originLabel, start.sent], ["mcp", "third-party", "learn.microsoft.com", "Defender for Endpoint on macOS requirements"]);
    const blocked = toolStepFinish({ id: "t", tool: learnTool.name, params: {}, resultSummary: "Blocked", durationMs: 1, createdAt: "", completedAt: "", error: "the Microsoft Learn query contained a tenant name. Nothing was sent to learn.microsoft.com.",
      mcpSource: { serverId: learn.id, serverName: learn.name, host: learn.host, tool: "microsoft_docs_search", blocked: true } });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.sent, undefined);
    assert.match(blocked.detail!, /Nothing was sent/);
    const done = toolStepFinish({ id: "t", tool: learnTool.name, params: {}, resultSummary: "", durationMs: 1, createdAt: "", completedAt: "",
      mcpSource: { serverId: learn.id, serverName: learn.name, host: learn.host, tool: "microsoft_docs_search", results: [{ title: "a", url: "https://a" }, { title: "b", url: "https://b" }] } });
    assert.deepEqual([done.status, done.title, done.detail], ["completed", "Asked Microsoft Learn", "microsoft_docs_search · 2 results"]);
    const failure = { id: "t", tool: learnTool.name, params: {}, resultSummary: "", durationMs: 1, createdAt: "", completedAt: "", error: "params must be an object." };
    const notSent = toolStepFinish({ ...failure, mcpSource: { serverId: learn.id, serverName: learn.name, host: learn.host, tool: "microsoft_docs_search", sentToHost: false } });
    assert.ok("sent" in notSent && notSent.sent === undefined, "a call that failed before sending clears its sent text");
    const reached = toolStepFinish({ ...failure, mcpSource: { serverId: learn.id, serverName: learn.name, host: learn.host, tool: "microsoft_docs_search", sentToHost: true } });
    assert.equal("sent" in reached, false, "a call that reached the host keeps its sent text");
  });
});

function scripted(responses: string[], prompts: Array<{ system?: string; prompt: string }>): RunLlmApi {
  let index = 0;
  return {
    available: true,
    defaultModel: "llama3.1:8b",
    async complete(options) {
      prompts.push({ ...(options.system ? { system: options.system } : {}), prompt: options.prompt });
      return { text: responses[Math.min(index++, responses.length - 1)]!, model: "llama3.1:8b" };
    },
    async *stream() { yield { delta: "", accumulated: "", done: true, model: "llama3.1:8b" }; },
  };
}

async function withStore(run: (store: IntelligenceSqliteStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-steps-"));
  const store = new IntelligenceSqliteStore(join(dir, "openadminos.db"));
  try { await run(store); } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
}

function loopInput(store: IntelligenceSqliteStore, llm: RunLlmApi, mcp: McpChatContext, overrides: Partial<RunAgenticChatInput>): RunAgenticChatInput {
  return {
    question: "What does Microsoft Learn say about Defender for macOS?",
    tenant, providerId: "ollama", providerIsLocal: true, model: "llama3.1:8b", llm,
    tools: {
      tenantId: tenant.id, store, grantedScopes: new Set(DEFAULT_GRAPH_READ_SCOPE_NAMES),
      graphForScopes: async () => ({ listManagedDevices: async () => [], retireManagedDevice: async () => { throw new Error("no writes"); }, request: async () => ({ value: [] }) }),
      refreshResource: async (resource) => ({ resource, label: resource, rows: 0, refreshedAt: "2026-06-01T10:01:00.000Z", ok: true }),
      getDriftTimeline: async () => ({ tenantId: tenant.id, entries: [], resourceCoverage: [], truncated: false } as never),
      mcp,
    },
    plannedResources: ["managedDevices"], agentSuggestions: [], generatedAt: "2026-06-01T10:00:00.000Z", maxTokens: 900,
    ...overrides,
  };
}

function learnContext(call: McpChatContext["call"]): McpChatContext {
  return { tools: [learnTool], servers: [learn], privateTerms: mcpPrivateTermsForTenant(tenant), tenantValues: new TenantValueIndex(), call };
}

const callLearn = JSON.stringify({ tool: learnTool.name, params: { query: "Defender for Endpoint on macOS" } });

describe("agentic loop sources", () => {
  it("offers no tenant tools for a docs question and refuses one the model asks for", async () => {
    await withStore(async (store) => {
      const prompts: Array<{ system?: string; prompt: string }> = [];
      const result = await runAgenticChat(loopInput(store, scripted([
        '{"tool":"query_cache","params":{"resource":"managedDevices"}}',
        '{"final":true,"answer":"Defender for Endpoint supports the three latest macOS releases."}',
      ], prompts), learnContext(async () => ({ text: "", truncated: false })), { questionKind: "docs" }));
      assert.equal(result.ok, true);
      assert.equal(result.toolTrace.length, 0);
      assert.doesNotMatch(prompts[0]!.system!, /- query_cache:|- list_cached_resources:|- graph_get:/);
      assert.match(prompts[1]!.prompt, /This is a documentation question, so the tenant is not checked/);
    });
  });

  it("makes the model call a required source before it answers", async () => {
    await withStore(async (store) => {
      const prompts: Array<{ system?: string; prompt: string }> = [];
      const calls: string[] = [];
      const result = await runAgenticChat(loopInput(store, scripted([
        '{"final":true,"answer":"From memory."}',
        callLearn,
        '{"final":true,"answer":"Microsoft Learn says it needs full disk access [1].","next":["Check our Macs for the system extension profile"]}',
      ], prompts), learnContext(async (_tool, args) => {
        calls.push(String(args.query));
        return { text: JSON.stringify({ results: [{ title: "Microsoft Defender for Endpoint on Mac", contentUrl: "https://learn.microsoft.com/defender-endpoint/microsoft-defender-endpoint-mac" }] }), truncated: false };
      }), { questionKind: "docs", requiredServerIds: ["microsoft-learn"] }));
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.match(prompts[0]!.system!, /Call Microsoft Learn before you answer/);
      assert.match(prompts[1]!.prompt, /Call Microsoft Learn before answering/);
      assert.deepEqual(calls, ["Defender for Endpoint on macOS"]);
      assert.match(prompts[2]!.prompt, /"cite": "\[1\]"/);
      assert.deepEqual(result.documentationSources?.map((source) => [source.citation, source.kind, source.url]), [[1, "mcp", "https://learn.microsoft.com/defender-endpoint/microsoft-defender-endpoint-mac"]]);
      assert.deepEqual(result.followUps, ["Check our Macs for the system extension profile"]);
      // The tenant name and observed values are rejected the same way as MCP queries.
      const tainted = await runAgenticChat(loopInput(store, scripted([callLearn, JSON.stringify({ final: true, answer: "Done [1].", next: ["Which Contoso devices need the profile?", "Ask admin@contoso.example", "Which Macs need the profile?"] })], []),
        learnContext(async () => ({ text: "docs", truncated: false })), { questionKind: "docs" }));
      assert.equal(tainted.ok, true);
      if (tainted.ok) assert.deepEqual(tainted.followUps, ["Which Macs need the profile?"]);
    });
  });

  it("falls back to the local index when Learn does not answer", async () => {
    await withStore(async (store) => {
      const prompts: Array<{ system?: string; prompt: string }> = [];
      let fallbackCalls = 0;
      const result = await runAgenticChat(loopInput(store, scripted([callLearn, '{"final":true,"answer":"The local docs index says it needs full disk access [1]."}'], prompts),
        learnContext(async () => { throw new Error("Microsoft Learn could not be reached at learn.microsoft.com."); }), {
          questionKind: "docs",
          requiredServerIds: ["microsoft-learn"],
          documentationFallback: async () => { fallbackCalls += 1; return [{ file: "defender/mac-install.md", title: "Deploy on macOS", text: "Grant full disk access.", indexVersion: "2026-08-26" }]; },
        }));
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(fallbackCalls, 1);
      assert.doesNotMatch(prompts[0]!.prompt, /local docs index on this device/);
      assert.match(prompts[1]!.prompt, /\[1\] Deploy on macOS - defender\/mac-install\.md/);
      assert.match(prompts[1]!.prompt, /Microsoft Learn did not answer/);
      assert.deepEqual(result.documentationSources?.map((source) => [source.citation, source.kind, source.file]), [[1, "docs-index", "defender/mac-install.md"]]);
    });
  });

  it("still requires tenant evidence for a mixed question after a docs call", async () => {
    await withStore(async (store) => {
      store.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Devices", scopeSet: [], refreshedAt: new Date().toISOString(),
        rows: [{ id: "dev-1", deviceName: "MAC-01", operatingSystem: "macOS", complianceState: "noncompliant" }] });
      const prompts: Array<{ system?: string; prompt: string }> = [];
      const result = await runAgenticChat(loopInput(store, scripted([callLearn, '{"final":true,"answer":"Done."}', '{"tool":"query_cache","params":{"resource":"managedDevices"}}', '{"final":true,"answer":"Done."}'], prompts),
        learnContext(async () => ({ text: "docs", truncated: false })), { questionKind: "mixed", requiredServerIds: ["microsoft-learn"] }));
      assert.equal(result.ok, true);
      assert.match(prompts[2]!.prompt, /That answer used no tenant evidence/);
      assert.deepEqual(result.toolTrace.map((entry) => entry.tool), [learnTool.name, "query_cache"]);
    });
  });
});
