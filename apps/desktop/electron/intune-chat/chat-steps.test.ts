import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DEFAULT_GRAPH_READ_SCOPE_NAMES, type IntuneChatStep, type RunLlmApi, type TenantRecord } from "@openadminos/agent-sdk";

import { numberedMcpResults, runAgenticChat, type RunAgenticChatInput } from "./agentic-loop.js";
import {
  ChatStepRecorder,
  modelStepHooks,
  toolDecision,
  CitationRegistry,
  planChatSources,
  QuestionKindTracker,
  relabelUnverifiedLearn,
  tenantTieInFollowUp,
  toolStepFinish,
  toolStepSending,
  toolStepStart,
  validFollowUps,
  mergeFollowUps,
  nearDuplicateFollowUp,
  sourceExcerpt,
  validTitle,
} from "./chat-steps.js";
import { classifyChatQuestion, hasTenantReference, planChatContext, resolveQuestionKind } from "./planner.js";
import { isMcpQueryWriterRequest } from "./mcp-query-writer.js";
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
      "Who are the global admins? Check the docs.",
      "Are any devices noncompliant per Microsoft Learn?",
      "Are all licenses assigned? Cite docs.",
      "Write a KQL query for failed sign-ins and run it for yesterday",
    ]) assert.notEqual(kind(question), "docs", question);
  });
});

describe("model-declared question kinds", () => {
  it("keeps a model docs label only when the wording refers to nothing in the tenant", () => {
    for (const question of [
      "What does the microsoft learn say about defender for macos?",
      "How do I enroll macOS devices?",
      "Is there a script to find stale devices?",
      "What are unmanaged devices?",
    ]) assert.deepEqual(resolveQuestionKind("docs", hasTenantReference(question)), { kind: "docs", vetoed: false }, question);
    for (const question of [
      "What do the docs say about our devices?",
      "How do I fix Bob's laptop?",
      "Why is HR-LAPTOP-07 noncompliant per the docs?",
      "Explain the status of device KIOSK-0042",
      "Which devices need Defender?",
    ]) assert.deepEqual(resolveQuestionKind("docs", hasTenantReference(question)), { kind: "mixed", vetoed: true }, question);
    // Tenant and mixed stand as given, with or without a tenant reference.
    assert.deepEqual(resolveQuestionKind("tenant", false), { kind: "tenant", vetoed: false });
    assert.deepEqual(resolveQuestionKind("mixed", true), { kind: "mixed", vetoed: false });
  });

  it("says when the veto fired and when keyword rules decided", () => {
    const steps = new ChatStepRecorder();
    const context = { question: "What do the docs say about our devices?", servers: [learn], docsIndexAvailable: false };
    const vetoed = new QuestionKindTracker(steps, steps.start({ kind: "plan", title: "Reading the question", origin: "device", originLabel: "On device" }), context, planChatSources({ ...context, kind: "mixed" }));
    vetoed.resolve("mixed", "veto");
    assert.equal(steps.steps[0]!.detail, "Treated as docs and tenant: the question mentions your tenant. Sources: cached tenant data and Microsoft Graph.");
    // Decided once: later calls change nothing.
    vetoed.resolve("docs", "model");
    assert.equal(vetoed.sources.kind, "mixed");
    const fallback = new QuestionKindTracker(steps, steps.start({ kind: "plan", title: "Reading the question", origin: "device", originLabel: "On device" }), context, planChatSources({ ...context, kind: "mixed" }));
    fallback.resolve("mixed", "fallback");
    assert.match(steps.steps[1]!.detail!, /^The model gave no question kind, so keyword rules decided: a docs and tenant question\. Sources:/);
    // A declared server is shown as the model's intent, never required; an unknown id is ignored.
    const declared = new QuestionKindTracker(steps, steps.start({ kind: "plan", title: "Reading the question", origin: "device", originLabel: "On device" }), { ...context, servers: [learn, kql] }, planChatSources({ ...context, kind: "mixed" }));
    const declaredPlan = declared.resolve("tenant", "model", ["kql-search", "evil"]);
    assert.deepEqual(declaredPlan.requiredServerIds, []);
    assert.equal(declaredPlan.detail, "Classified as a tenant question. Sources: cached tenant data and Microsoft Graph. The model also plans to ask KQL Search.");
    // A declared server that is required anyway is named once, as a source.
    const named = planChatSources({ question: "Ask Microsoft Learn about LAPS", kind: "docs", servers: [learn, kql], docsIndexAvailable: false, declaredServerIds: ["microsoft-learn"] });
    assert.deepEqual(named.requiredServerIds, ["microsoft-learn"]);
    assert.doesNotMatch(named.detail, /plans to ask/);
    // An upgrade turns docs into mixed and shows its own step; tenant and mixed never change.
    const docs = new QuestionKindTracker(steps, steps.start({ kind: "plan", title: "Reading the question", origin: "device", originLabel: "On device" }), context, planChatSources({ ...context, kind: "docs" }));
    docs.resolve("docs", "model");
    assert.equal(docs.upgrade().kind, "mixed");
    assert.deepEqual([steps.steps.at(-1)!.kind, steps.steps.at(-1)!.title], ["plan", "Treated as docs and tenant"]);
    const count = steps.steps.length;
    assert.equal(declared.upgrade().kind, "tenant");
    assert.equal(steps.steps.length, count);
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

  it("gives chunks of one article one number, across fragments, locale segments and trailing slashes", () => {
    const registry = new CitationRegistry();
    const cites = registry.addMcpResults([
      { title: "Deploy Microsoft Defender for Endpoint on macOS with Microsoft Intune", url: "https://learn.microsoft.com/defender-endpoint/mac-install-with-intune#create-system-configuration-profiles" },
      { title: "Onboard devices to Microsoft Defender for Business", url: "https://learn.microsoft.com/defender-business/mdb-onboard-devices#mac" },
      { title: "Deploy Microsoft Defender for Endpoint on macOS with Microsoft Intune", url: "https://learn.microsoft.com/en-us/defender-endpoint/mac-install-with-intune/#deploy" },
    ], { serverName: "Microsoft Learn", host: "learn.microsoft.com" });
    assert.deepEqual(cites.map((entry) => entry.cite), ["[1]", "[2]", "[1]"]);
    assert.equal(registry.sources.length, 2);
  });

  it("reads titles and links from JSON and Markdown results, and drops unsafe links", () => {
    assert.deepEqual(parseMcpResults(JSON.stringify({ results: [
      { title: "Defender for Endpoint on Mac", content: "...", contentUrl: "https://learn.microsoft.com/defender-endpoint/mac" },
      { title: "Bad", contentUrl: "javascript:alert(1)" },
    ] })), [{ title: "Defender for Endpoint on Mac", url: "https://learn.microsoft.com/defender-endpoint/mac", excerpt: "..." }]);
    assert.deepEqual(parseMcpResults("See [Failed sign-ins](https://www.kqlsearch.com/query/1) and [x](ftp://a)."), [{ title: "Failed sign-ins", url: "https://www.kqlsearch.com/query/1" }]);
    assert.equal(parseMcpResults(JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ name: `Q${i}`, url: `https://example.com/${i}` })))).length, 10);
  });

  it("reads a recorded Microsoft Learn search by its structure, even when the text the model sees is capped", async () => {
    // microsoft_docs_search for Defender onboarding on macOS, recorded from https://learn.microsoft.com/api/mcp on 2026-11-04.
    const recorded = JSON.parse(await readFile(new URL("./fixtures/learn-docs-search.json", import.meta.url), "utf8")) as { results: Array<{ title: string; content: string; contentUrl: string }> };
    const capped = JSON.stringify(recorded).slice(0, 12_000);
    const items = parseMcpResults(capped, { structured: recorded });
    assert.deepEqual(items.map((item) => [item.title, item.url]), recorded.results.map((result) => [result.title, result.contentUrl]));
    assert.ok(items.every((item) => item.excerpt && item.excerpt.length > 1000));
    // Links inside the content are never results.
    assert.ok(items.every((item) => !/Apple Configurator|iMazing|Network protection for macOS/.test(item.title)));

    // The model sees each result numbered as its source card is, one number per page.
    const registry = new CitationRegistry();
    registry.addPassages([{ file: "a.md", text: "Local passage." }]);
    const cites = registry.addMcpResults(items, { serverName: "Microsoft Learn", host: "learn.microsoft.com" }).map((entry) => entry.cite);
    const observation = numberedMcpResults(items, cites);
    assert.match(observation, /^\[2\] Deploy Microsoft Defender for Endpoint on macOS with Microsoft Intune, https:\/\/learn\.microsoft\.com\/defender-endpoint\/mac-install-with-intune#create-system-configuration-profiles\n# Deploy/);
    assert.match(observation, /\n\n\[3\] Onboard devices to Microsoft Defender for Business, https:\/\/learn\.microsoft\.com\/defender-business\/mdb-onboard-devices#mac\n/);
    assert.deepEqual(registry.sources.slice(1).map((source) => [source.citation, source.title]), [
      [2, "Deploy Microsoft Defender for Endpoint on macOS with Microsoft Intune"],
      [3, "Onboard devices to Microsoft Defender for Business"],
      [4, "Deploy Microsoft Defender for Endpoint on macOS with another MDM solution"],
    ]);
    assert.ok(observation.length < 14_000);
  });

  it("reads a fetched Learn page as one result titled by its heading, and items of other servers by name and link", () => {
    const page = "# Deploy Microsoft Defender for Endpoint on macOS with Microsoft Intune\n\nSee [Apple Configurator](https://support.apple.com/apple-configurator).";
    assert.deepEqual(parseMcpResults(page, { host: "learn.microsoft.com", args: { url: "https://learn.microsoft.com/defender-endpoint/mac-install-with-intune" } }).map(({ title, url }) => [title, url]), [
      ["Deploy Microsoft Defender for Endpoint on macOS with Microsoft Intune", "https://learn.microsoft.com/defender-endpoint/mac-install-with-intune"],
    ]);
    // A fetched URL the model chose on another host never becomes a card link.
    assert.deepEqual(parseMcpResults(page, { host: "learn.microsoft.com", args: { url: "https://evil.example/learn.microsoft.com" } }).map(({ url }) => url), ["https://support.apple.com/apple-configurator"]);
    // IntuneAutomation and KQL Search shapes.
    assert.deepEqual(parseMcpResults(JSON.stringify({ scripts: [{ id: "get-stale-devices", title: "Get Stale Intune Devices", synopsis: "Reports devices that have not checked in.", githubUrl: "https://github.com/ugurkocde/intuneautomation/blob/main/scripts/devices/get-stale-devices.ps1" }] })), [
      { title: "Get Stale Intune Devices", url: "https://github.com/ugurkocde/intuneautomation/blob/main/scripts/devices/get-stale-devices.ps1", excerpt: "Reports devices that have not checked in." },
    ]);
    assert.deepEqual(parseMcpResults(JSON.stringify({ items: [{ id: "q1", title: "Failed sign-ins", sourceUrl: "https://github.com/example/kql/blob/main/failed.md" }] })), [
      { title: "Failed sign-ins", url: "https://github.com/example/kql/blob/main/failed.md" },
    ]);
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

  it("keeps follow-ups in the admin's voice: offers to the admin are rewritten, other questions to the admin dropped", () => {
    assert.deepEqual(validFollowUps([
      "Would you like to check this tenant\u2019s macOS onboarding status?",
      "Do you want me to list Macs without the system extension?",
      "Should I show the onboarding package steps?",
    ]), ["Check our macOS onboarding status", "List Macs without the system extension"]);
    assert.deepEqual(validFollowUps(["Shall I compare your Defender settings?", "Are you using Platform SSO?", "Which Macs miss full disk access?"]), [
      "Compare our Defender settings", "Which Macs miss full disk access?",
    ]);
  });

  it("drops a model follow-up that repeats the deterministic one, and keeps the next distinct one", () => {
    const tieIn = "Check our 5 macOS devices for Defender in Intune";
    assert.deepEqual(mergeFollowUps([tieIn], ["Would you like to check this tenant's macOS onboarding status?", "How do I deploy the onboarding package with Intune?"]), [
      tieIn, "How do I deploy the onboarding package with Intune?",
    ]);
    assert.deepEqual(mergeFollowUps([tieIn], ["Check Defender on our Macs in Intune", "Which Macs miss the system extension profile?"]), [
      tieIn, "Which Macs miss the system extension profile?",
    ]);
    assert.equal(nearDuplicateFollowUp("Which Macs miss full disk access?", tieIn), false);
  });

  it("offers a tenant check for a docs question with a tenant tie-in, counted from the cache", () => {
    const question = "What does the microsoft learn say about defender for macos?";
    const base = { question, kind: "docs" as const, tieInResources: planChatContext(question).resources };
    // Defender status is not in the device records, so the tie-in asks for what they hold.
    assert.equal(tenantTieInFollowUp({ ...base, deviceCountsByOs: { macOS: 5, Windows: 4 } }), "Show compliance and last sync for our 5 macOS devices");
    assert.equal(tenantTieInFollowUp({ ...base }), "Show compliance and last sync for our macOS devices");
    const fileVault = "How do I enable FileVault on macOS?";
    assert.equal(tenantTieInFollowUp({ question: fileVault, kind: "docs", tieInResources: ["managedDevices"], deviceCountsByOs: { macOS: 5 } }), "Check our 5 macOS devices for FileVault in Intune");
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

  it("appends steps in the order they start, never above a running step, and settles open steps", () => {
    const seen: IntuneChatStep[][] = [];
    const steps = new ChatStepRecorder((list) => seen.push(list));
    steps.start({ kind: "answer", title: "Working", origin: "model", originLabel: "OpenAI" });
    const tool = steps.start({ kind: "tool", title: "Querying cached data", origin: "device", originLabel: "On device" });
    assert.deepEqual(steps.steps.map((step) => step.kind), ["answer", "tool"]);
    steps.finish(tool);
    steps.settle("completed");
    assert.ok(steps.steps.every((step) => step.status === "completed" && typeof step.durationMs === "number"));
    assert.equal(seen.length, 4);
  });

  it("finishes the plan step when the local plan is ready and shows the model's classification on its model step", () => {
    const steps = new ChatStepRecorder();
    const context = { question: "how do I configure defender for macos?", servers: [learn], docsIndexAvailable: true };
    const kind = new QuestionKindTracker(steps, steps.start({ kind: "plan", title: "Reading the question", origin: "device", originLabel: "On device" }), context, planChatSources({ ...context, kind: "mixed" }));
    kind.awaitModel();
    assert.deepEqual([steps.steps[0]!.status, steps.steps[0]!.title, steps.steps[0]!.detail], [
      "completed", "Read the question", "Sources available: Microsoft Learn and the local docs index. The model classifies the question.",
    ]);
    const model = modelStepHooks(steps, { name: "gpt-6-sol", hosted: true, providerName: "OpenAI Codex" }, undefined);
    model.start();
    assert.deepEqual([steps.steps[1]!.title, steps.steps[1]!.detail, steps.steps[1]!.originLabel, steps.steps[1]!.status], ["Working", "gpt-6-sol", "OpenAI Codex", "active"]);
    const plan = kind.resolve("docs", "model", ["microsoft-learn"]);
    model.finish({ kind: "tool", tool: mcpChatToolName("microsoft-learn", "microsoft_docs_search"), params: { query: "x" } }, plan.detail);
    assert.equal(steps.steps[0]!.detail, "Sources available: Microsoft Learn and the local docs index. The model classifies the question.");
    assert.equal(steps.steps[1]!.title, "Chose to ask an MCP server");
    assert.equal(steps.steps[1]!.detail, "gpt-6-sol · Classified as a docs question. Sources: Microsoft Learn, then the local docs index if Microsoft Learn is unavailable. Your tenant is not checked.");
    model.start();
    model.writing();
    assert.equal(steps.steps[2]!.title, "Writing the answer");
    model.finish({ kind: "final", passages: 0, trace: [] });
    assert.deepEqual(steps.steps.map((step) => [step.kind, step.title]), [["plan", "Read the question"], ["answer", "Chose to ask an MCP server"], ["answer", "Wrote the answer"]]);
    assert.equal(toolDecision("query_cache", { resource: "managedDevices" }, undefined), "Chose to query cached Intune managed devices");
    assert.equal(toolDecision("list_cached_resources", {}, undefined), "Chose to check the cache inventory");
  });

  it("shows the exact text an MCP call sent, and no sent text when it was blocked", () => {
    // The model's own params are never sent, so the step shows sent text only once the written query passed the checks.
    const start = toolStepStart(learnTool.name, { query: "Contoso Macs" }, learnTool, "OpenAI");
    assert.deepEqual([start.kind, start.origin, start.originLabel, start.sent, start.detail], ["mcp", "third-party", "learn.microsoft.com", undefined, "microsoft_docs_search · writing the query from your question"]);
    assert.deepEqual(toolStepSending(learnTool.name, { query: "Defender for Endpoint on macOS requirements" }, learnTool), { detail: "microsoft_docs_search", sent: "Defender for Endpoint on macOS requirements" });
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
    assert.deepEqual([notSent.status, notSent.title, notSent.detail], ["failed", "Did not send a Microsoft Learn query", "microsoft_docs_search · params must be an object."]);
    const reached = toolStepFinish({ ...failure, mcpSource: { serverId: learn.id, serverName: learn.name, host: learn.host, tool: "microsoft_docs_search", sentToHost: true } });
    assert.equal("sent" in reached, false, "a call that reached the host keeps its sent text");
    assert.equal(reached.title, "Could not reach Microsoft Learn");
  });
});

/**
 * A model that replies from a script. It stands in for the MCP query
 * writer too: that request gets the params the script gave the last MCP
 * tool call, so scripts read as before.
 */
function scripted(responses: string[], prompts: Array<{ system?: string; prompt: string }>): RunLlmApi {
  let index = 0;
  let lastParams = "{}";
  return {
    available: true,
    defaultModel: "llama3.1:8b",
    async complete(options) {
      if (isMcpQueryWriterRequest(options.system)) return { text: lastParams, model: "llama3.1:8b" };
      prompts.push({ ...(options.system ? { system: options.system } : {}), prompt: options.prompt });
      const text = responses[Math.min(index++, responses.length - 1)]!;
      try {
        const value = JSON.parse(text) as { tool?: string; params?: unknown };
        if (value.tool?.startsWith("mcp__")) lastParams = JSON.stringify(value.params ?? {});
      } catch {
        // A prose reply.
      }
      return { text, model: "llama3.1:8b" };
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
    adminQuestion: "What does Microsoft Learn say about Defender for macOS?",
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
  it("offers no tenant tools for a docs question, and upgrades it to mixed with a refresh when the model calls one", async () => {
    await withStore(async (store) => {
      store.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Devices", scopeSet: [], refreshedAt: new Date().toISOString(),
        rows: [{ id: "dev-1", deviceName: "MAC-01", operatingSystem: "macOS" }] });
      const prompts: Array<{ system?: string; prompt: string }> = [];
      const events: string[] = [];
      const result = await runAgenticChat(loopInput(store, scripted([
        '{"tool":"query_cache","params":{"resource":"managedDevices"}}',
        '{"final":true,"answer":"1 Mac is enrolled."}',
      ], prompts), learnContext(async () => ({ text: "", truncated: false })), {
        questionKind: "docs",
        onUpgrade: () => events.push("upgrade"),
        ensureTenantData: async () => { events.push("refresh"); },
        onToolStart: (event) => events.push(event.tool),
      }));
      assert.equal(result.ok, true);
      assert.deepEqual(events, ["upgrade", "refresh", "query_cache"]);
      assert.deepEqual(result.toolTrace.map((entry) => entry.tool), ["query_cache"]);
      assert.doesNotMatch(prompts[0]!.system!, /- query_cache:|- list_cached_resources:|- graph_get:/);
      assert.match(prompts[1]!.system!, /- query_cache:/, "a mixed question is offered tenant tools");
    });
  });

  it("asks once for a missing kind, then lets the keyword kind decide; a declared docs label with a tenant reference is mixed", async () => {
    await withStore(async (store) => {
      const decided: string[] = [];
      let refreshes = 0;
      const classify = (tenantReference: boolean) => ({
        tenantReference,
        onKind: (kind: string, reason: string) => { decided.push(`${kind}:${reason}`); return { requiredServerIds: [], learnFirst: false }; },
      });
      const prompts: Array<{ system?: string; prompt: string }> = [];
      const fallback = await runAgenticChat(loopInput(store, scripted(['{"final":true,"answer":"From memory."}', '{"kind":"Docs?","final":true,"answer":"From memory."}'], prompts),
        learnContext(async () => ({ text: "", truncated: false })), { questionKind: "docs", classify: classify(false), ensureTenantData: async () => { refreshes += 1; } }));
      assert.equal(fallback.ok, true);
      assert.match(prompts[0]!.system!, /kind is "docs" when the answer needs only public product knowledge and no fact about this tenant/);
      assert.match(prompts[0]!.system!, /When unsure, choose "mixed"/);
      assert.match(prompts[1]!.prompt, /That reply did not give the question kind/);
      assert.equal(prompts.length, 2, "one repair, then the keyword kind");
      assert.deepEqual(decided, ["docs:fallback"]);
      assert.equal(refreshes, 0, "a docs question reads nothing from the tenant");

      decided.length = 0;
      prompts.length = 0;
      const vetoed = await runAgenticChat(loopInput(store, scripted(['{"kind":"docs","sources":[],"final":true,"answer":"From memory."}'], prompts),
        learnContext(async () => ({ text: "", truncated: false })), { questionKind: "docs", classify: classify(true), ensureTenantData: async () => { refreshes += 1; } }));
      assert.deepEqual(decided, ["mixed:veto"]);
      assert.equal(refreshes, 1, "a mixed question refreshes as soon as the kind is decided");
      assert.match(prompts[1]!.prompt, /That answer used no tenant evidence/, "the evidence guard uses the final kind");
      assert.equal(vetoed.ok, false);
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

  it("says no Learn query was sent when the call stopped before sending, and falls back to the local index", async () => {
    await withStore(async (store) => {
      const prompts: Array<{ system?: string; prompt: string }> = [];
      const calls: unknown[] = [];
      // The written params name a param the schema does not declare, so nothing is sent.
      const result = await runAgenticChat(loopInput(store, scripted([JSON.stringify({ tool: learnTool.name, params: { q: "Defender" } }), '{"final":true,"answer":"The local docs index says so [1]."}'], prompts),
        learnContext(async (_tool, args) => { calls.push(args); return { text: "", truncated: false }; }), {
          questionKind: "docs",
          requiredServerIds: ["microsoft-learn"],
          documentationFallback: async (reason) => [{ file: "defender/mac-install.md", title: `Deploy on macOS (${reason})`, text: "Grant full disk access." }],
        }));
      assert.equal(calls.length, 0);
      assert.equal(result.toolTrace[0]!.mcpSource?.sentToHost, false);
      assert.match(prompts[1]!.prompt, /No Microsoft Learn query was sent\. Passages from the local docs index are now in the prompt/);
      assert.doesNotMatch(prompts[1]!.prompt, /Microsoft Learn did not answer/);
      assert.match(prompts[1]!.prompt, /Deploy on macOS \(no Microsoft Learn query was sent\)/);
      assert.deepEqual(toolStepFinish(result.toolTrace[0]!).title, "Did not send a Microsoft Learn query");
    });
  });

  it("answers again when the classification loads local docs passages after a final answer, and cites only passages the model saw", async () => {
    await withStore(async (store) => {
      const prompts: Array<{ system?: string; prompt: string }> = [];
      const outcomes: string[] = [];
      const classify = { tenantReference: false, onKind: () => ({ requiredServerIds: [], learnFirst: false }) };
      const modelStep = { start() {}, writing() {}, finish(outcome: { kind: string; reason?: string }) { outcomes.push(outcome.kind === "repair" ? `repair:${outcome.reason}` : outcome.kind); } };
      const result = await runAgenticChat(loopInput(store, scripted([
        '{"kind":"docs","sources":["docs-index"],"final":true,"answer":"From memory [1] [2]."}',
        '{"final":true,"answer":"It needs full disk access [1]."}',
      ], prompts), learnContext(async () => ({ text: "", truncated: false })), {
        questionKind: "docs",
        classify,
        modelStep,
        documentationFallback: async () => [{ file: "defender/mac-install.md", title: "Deploy on macOS", text: "Grant full disk access." }],
      }));
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.answer, "It needs full disk access [1].");
      assert.deepEqual(outcomes, ["repair:documentation", "final"]);
      assert.doesNotMatch(prompts[0]!.prompt, /Deploy on macOS/);
      assert.match(prompts[1]!.prompt, /\[1\] Deploy on macOS - defender\/mac-install\.md/);
      assert.match(prompts[1]!.prompt, /Passages from the local docs index are now in the prompt\. Answer again using them/);
      assert.deepEqual(result.documentationSources?.map((source) => [source.citation, source.file]), [[1, "defender/mac-install.md"]]);

      // With no passages for the question, the first answer stands and cites nothing.
      prompts.length = 0;
      const none = await runAgenticChat(loopInput(store, scripted(['{"kind":"docs","sources":[],"final":true,"answer":"From memory."}'], prompts),
        learnContext(async () => ({ text: "", truncated: false })), { questionKind: "docs", classify, documentationFallback: async () => [] }));
      assert.equal(none.ok && none.answer, "From memory.");
      assert.equal(prompts.length, 1);
      assert.deepEqual(none.ok && none.documentationSources, []);
    });
  });

  it("retries an empty final answer, then fails with a designed notice", async () => {
    await withStore(async (store) => {
      const prompts: Array<{ system?: string; prompt: string }> = [];
      const retried = await runAgenticChat(loopInput(store, scripted(['{"final":true,"answer":""}', '{"final":true}', '{"final":true,"answer":"Grant full disk access."}'], prompts),
        learnContext(async () => ({ text: "", truncated: false })), { questionKind: "docs" }));
      assert.equal(retried.ok && retried.answer, "Grant full disk access.");
      assert.match(prompts[1]!.prompt, /That final answer was empty/);
      assert.equal(prompts.length, 3);

      const fenced = '{"final":true,"answer":"<tenant_data source=\\"x\\" nonce=\\"1\\"></tenant_data nonce=\\"1\\">"}';
      const failed = await runAgenticChat(loopInput(store, scripted(['{"final":true,"answer":"   "}', fenced, ""], []),
        learnContext(async () => ({ text: "", truncated: false })), { questionKind: "docs" }));
      assert.equal(failed.ok, false);
      if (failed.ok) return;
      assert.equal(failed.reason, "empty-answer");
      assert.equal(failed.fallbackNotice, "The model returned an empty answer 3 times. Deterministic retrieval was used instead.");
    });
  });

  it("checks titles and follow-ups for the tenant name and cached values also without an MCP server", async () => {
    await withStore(async (store) => {
      store.replaceGraphResources({ tenantId: tenant.id, resource: "managedDevices", label: "Devices", scopeSet: [], refreshedAt: new Date().toISOString(),
        rows: [{ id: "dev-1", deviceName: "HR-LAPTOP-07", operatingSystem: "Windows" }] });
      const run = (title: string) => {
        const input = loopInput(store, scripted([JSON.stringify({ final: true, answer: "Done.", title, next: [`Why is HR-LAPTOP-07 offline?`, "Which Contoso Macs are stale?", "Which Macs are stale?"] })], []),
          learnContext(async () => ({ text: "", truncated: false })), { questionKind: "docs", askTitle: true });
        const { mcp: _mcp, ...tools } = input.tools;
        return runAgenticChat({ ...input, tools: { ...tools, privateTerms: mcpPrivateTermsForTenant(tenant), cachedTenantValues: () => store.tenantIdentityValues(tenant.id) } });
      };
      for (const title of ["Contoso device review", "Why HR-LAPTOP-07 is offline"]) {
        const result = await run(title);
        assert.equal(result.ok, true);
        if (!result.ok) continue;
        assert.equal(result.title, undefined, title);
        assert.deepEqual(result.followUps, ["Which Macs are stale?"]);
      }
      const plain = await run("Stale Mac review");
      assert.equal(plain.ok && plain.title, "Stale Mac review");
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

describe("chat titles", () => {
  it("keeps a short plain title and rejects links, write intent, tenant values, markup and long text", () => {
    assert.equal(validTitle("  \u201cDefender onboarding for  Windows 11.\u201d "), "Defender onboarding for Windows 11");
    assert.equal(validTitle("x".repeat(60)), "x".repeat(60));
    assert.equal(validTitle("x".repeat(61)), undefined);
    assert.equal(validTitle("See learn.microsoft.com for onboarding"), undefined);
    assert.equal(validTitle("Read https://evil.example/x"), undefined);
    assert.equal(validTitle("Retire the stale Macs"), undefined);
    assert.equal(validTitle("**Defender** onboarding"), undefined);
    assert.equal(validTitle("Defender\nonboarding"), undefined);
    assert.equal(validTitle("Why MAC-07 is offline", (text) => /MAC-07/.test(text)), undefined);
    assert.equal(validTitle(42), undefined);
    assert.equal(validTitle(""), undefined);
  });

  it("asks for a title only on the first answer of a new chat, and returns it validated", async () => {
    await withStore(async (store) => {
      const final = JSON.stringify({ kind: "docs", sources: [], final: true, answer: "Use the Intune connector.", title: "Defender onboarding for Windows 11" });
      const prompts: Array<{ system?: string; prompt: string }> = [];
      const first = await runAgenticChat(loopInput(store, scripted([final], prompts), learnContext(async () => ({ text: "", truncated: false })), { questionKind: "docs", askTitle: true }));
      assert.equal(first.ok, true);
      if (first.ok) assert.equal(first.title, "Defender onboarding for Windows 11");
      assert.match(prompts[0]!.system!, /Also add "title" to the final JSON/);

      prompts.length = 0;
      const later = await runAgenticChat(loopInput(store, scripted([final], prompts), learnContext(async () => ({ text: "", truncated: false })), { questionKind: "docs" }));
      assert.equal(later.ok && later.title, undefined);
      assert.doesNotMatch(prompts[0]!.system!, /"title"/);

      const unsafe = JSON.stringify({ final: true, answer: "Done.", title: "Macs of admin@contoso.example" });
      const rejected = await runAgenticChat(loopInput(store, scripted([unsafe], []), learnContext(async () => ({ text: "", truncated: false })), { questionKind: "docs", askTitle: true }));
      assert.equal(rejected.ok, true);
      assert.equal(rejected.ok && rejected.title, undefined);
    });
  });
});

describe("source excerpts", () => {
  it("keeps the start of a passage as plain text, cut at a word", () => {
    assert.equal(sourceExcerpt("## Prerequisites\n\n- Grant **full disk access** to [Defender](https://learn.microsoft.com/x).\n```bash\nsudo x\n```"), "Prerequisites Grant full disk access to Defender.");
    const long = sourceExcerpt(`${"word ".repeat(100)}end`)!;
    assert.ok(long.length <= 323 && long.endsWith("..."), long);
    assert.doesNotMatch(long, /\s\.\.\.$/);
    assert.equal(sourceExcerpt("   "), undefined);
    assert.equal(sourceExcerpt(undefined), undefined);
  });

  it("stores the excerpt the model read with each numbered source, the first chunk for a merged article", () => {
    const registry = new CitationRegistry();
    registry.addPassages([{ file: "intune/compliance.md", title: "Compliance", text: "Compliance policies mark a device." }]);
    registry.addMcpResults([
      { title: "Defender on Mac", url: "https://learn.microsoft.com/mac#a", excerpt: "Grant full disk access." },
      { title: "Defender on Mac", url: "https://learn.microsoft.com/mac#b", excerpt: "A later chunk." },
      { title: "No excerpt", url: "https://learn.microsoft.com/other" },
    ], learnTool);
    assert.deepEqual(registry.sources.map((source) => source.excerpt), ["Compliance policies mark a device.", "Grant full disk access.", undefined]);
  });
});
