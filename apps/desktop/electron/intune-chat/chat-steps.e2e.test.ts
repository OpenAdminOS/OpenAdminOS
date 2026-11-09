import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { partIdsFor, providerCatalog, qualifyScope, requestedScopes, type IntuneChatStep, type IntuneChatStreamEvent } from "@openadminos/agent-sdk";

import { AppStateStore } from "../state.js";
import { MCP_CATALOG } from "../mcp/catalog.js";
import type { IntelligenceSqliteStore } from "./sqlite-store.js";
import { isMcpQueryWriterRequest } from "./mcp-query-writer.js";
import { FIRST_RUN_CHAT_COPY } from "../../src/copy/chat.js";

/**
 * Drives Chat end to end through the app store: question planning, the
 * MCP client against an in-process server that stands in for Microsoft
 * Learn and KQL Search, the cache, the loop, persistence and reload.
 */
/** microsoft_docs_search for Defender onboarding on macOS, recorded from https://learn.microsoft.com/api/mcp on 2026-11-04. */
const RECORDED_LEARN_SEARCH = readFileSync(new URL("./fixtures/learn-docs-search.json", import.meta.url), "utf8");

function buildServer(kind: "learn" | "kql"): McpServer {
  const server = new McpServer({ name: kind, version: "1.0.0" });
  if (kind === "learn") {
    server.registerTool("microsoft_docs_search", { description: "Search Microsoft documentation.", inputSchema: { query: z.string() } },
      async ({ query }) => ({ content: [{ type: "text", text: query.includes("recorded") ? JSON.stringify(JSON.parse(RECORDED_LEARN_SEARCH)) : JSON.stringify({ results: query.includes("nothing") ? [] : [
        { title: "Microsoft Defender for Endpoint on Mac", content: `Results for ${query}: needs full disk access.`, contentUrl: "https://learn.microsoft.com/defender-endpoint/microsoft-defender-endpoint-mac" },
        { title: "Prerequisites and system requirements", content: "Three latest macOS releases.", contentUrl: "https://learn.microsoft.com/defender-endpoint/mac-requirements" },
      ] }) }] }));
  } else {
    server.registerTool("search_kql_queries", { description: "Search community KQL queries.", inputSchema: { query: z.string() } },
      async () => ({ content: [{ type: "text", text: JSON.stringify({ queries: [
        { title: "Failed sign-ins in the last 24 hours", url: "https://www.kqlsearch.com/query/failed-sign-ins-24h", query: "SigninLogs | where ResultType != 0" },
      ] }) }] }));
  }
  return server;
}

const tenant = { id: "tenant-1", displayName: "Contoso", username: "admin@contoso.example", homeAccountId: "home-1", addedAt: "2026-06-01T10:00:00.000Z" };
const DOCS_QUESTION = "What does the microsoft learn say about defender for macos?";
const KQL_QUESTION = "Write a KQL query that lists failed sign-ins in the last 24 hours";
const MIXED_QUESTION = "Which of our macOS devices are noncompliant, and what does Microsoft Learn recommend for them?";

let httpServer: Server;
let baseUrl: string;
const originalOllamaUrl = process.env.OPENAGENTS_OLLAMA_URL;

before(async () => {
  process.env.OPENAGENTS_OLLAMA_URL = "http://127.0.0.1:9";
  httpServer = createServer((request, response) => {
    void (async () => {
      const server = buildServer(request.url === "/kql" ? "kql" : "learn");
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      response.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      await transport.handleRequest(request, response, raw ? JSON.parse(raw) : undefined);
    })();
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

after(async () => {
  if (originalOllamaUrl === undefined) delete process.env.OPENAGENTS_OLLAMA_URL;
  else process.env.OPENAGENTS_OLLAMA_URL = originalOllamaUrl;
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

interface Harness {
  /** Local docs index searches, when the harness has an index. */
  docsSearches: string[];
  store: AppStateStore;
  cache: IntelligenceSqliteStore;
  graphPaths: string[];
  /** Tenants a Graph client was built for. */
  graphBuilds: string[];
  prompts: Array<{ system: string; prompt: string }>;
  /** Prompts of the MCP query writer, which the model double answers apart from the script. */
  writerPrompts: string[];
  script(replies: unknown[]): void;
}

async function withHarness(run: (harness: Harness) => Promise<void>, options: {
  emptyCache?: boolean; graphError?: string; incremental?: boolean; docsIndex?: boolean; chunkDelayMs?: number;
  /** Answers the query writer from its prompt instead of the script's last MCP params. */
  writer?: (prompt: string) => string | undefined;
  /** Graph responses by path, in place of an empty collection. */
  graphResponses?: Record<string, unknown>;
  /** Granted scopes for the tenant, in place of the fixture's. */
  grantedScopes?: string[];
  /** No tenant is connected: the state has none and no active tenant. */
  noTenant?: boolean;
  /** The active provider and its model, in place of Ollama with llama3.1:8b. */
  provider?: { id: string; model: string };
} = {}): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-steps-e2e-"));
  const statePath = join(dir, "state.json");
  await writeFile(statePath, JSON.stringify({
    activeProviderId: options.provider?.id ?? "ollama", providerChosenByUser: true,
    activeModelByProviderId: { [options.provider?.id ?? "ollama"]: options.provider?.model ?? "llama3.1:8b" },
    installedAgents: [], runs: [],
    ...(options.noTenant
      ? { tenants: [] }
      : { tenants: [options.grantedScopes ? { ...tenant, grantedScopes: options.grantedScopes } : tenant], activeTenantId: tenant.id }),
  }));
  const graphPaths: string[] = [];
  const graphBuilds: string[] = [];
  const prompts: Array<{ system: string; prompt: string }> = [];
  let replies: string[] = [];
  const chunkDelayMs = options.chunkDelayMs;
  const writer = options.writer;
  let reply = 0;
  // Stands in for the MCP query writer: it answers with the params the
  // script gave the last MCP tool call, so scripts read as before.
  const writerPrompts: string[] = [];
  let lastParams = "{}";
  const nextReply = () => {
    const text = replies[Math.min(reply++, replies.length - 1)]!;
    try {
      const value = JSON.parse(text) as { tool?: string; params?: unknown };
      if (value.tool?.startsWith("mcp__")) lastParams = JSON.stringify(value.params ?? {});
    } catch {
      // A prose reply.
    }
    return text;
  };
  const learn = MCP_CATALOG.find((entry) => entry.id === "microsoft-learn")!;
  const kql = MCP_CATALOG.find((entry) => entry.id === "kql-search")!;
  const store = new AppStateStore({
    filePath: statePath, userDataPath: dir, statsApiUrl: "",
    tokenStore: { read: async () => "", write: async () => undefined },
    mcpCatalog: [{ ...learn, url: `${baseUrl}/learn` }, { ...kql, url: `${baseUrl}/kql` }],
    // A hosted provider reports its model, so the window and the host resolve the same one; no CLI on this device is probed.
    ...(options.provider
      ? {
          providerListFactory: () => providerCatalog.map((entry) =>
            entry.id === options.provider!.id ? { ...entry, status: "available" as const, models: [options.provider!.model] } : entry),
        }
      : {}),
    graphFactory: (input) => {
      graphBuilds.push(input.tenantId);
      if (options.graphError) throw new Error(options.graphError);
      return {
      listManagedDevices: async () => [],
      retireManagedDevice: async () => { throw new Error("no writes"); },
      request: async (request) => { graphPaths.push(request.path); return options.graphResponses?.[request.path] ?? { value: [] }; },
      };
    },
    llmFactory: () => ({
      available: true, defaultModel: "llama3.1:8b",
      ...(options.incremental ? { streamsIncrementally: true } : {}),
      async complete(options) {
        if (isMcpQueryWriterRequest(options.system)) {
          writerPrompts.push(options.prompt);
          return { text: writer?.(options.prompt) ?? lastParams, model: "llama3.1:8b" };
        }
        prompts.push({ system: options.system ?? "", prompt: options.prompt });
        return { text: nextReply(), model: "llama3.1:8b" };
      },
      async *stream(options) {
        prompts.push({ system: options.system ?? "", prompt: options.prompt });
        const text = nextReply();
        let accumulated = "";
        for (const delta of text.split(/(?<= )/)) {
          if (chunkDelayMs) await new Promise((resolve) => setTimeout(resolve, chunkDelayMs));
          accumulated += delta;
          yield { delta, accumulated, done: false, model: "llama3.1:8b" };
        }
        yield { delta: "", accumulated, done: true, model: "llama3.1:8b" };
      },
    }),
  });
  const docsSearches: string[] = [];
  if (options.docsIndex) {
    // A local docs index with two passages, in place of the installed index.
    Object.assign(store, {
      documentationIndexVersion: () => "2026-08-26",
      retrieveDocumentation: async (query: string) => {
        docsSearches.push(query);
        return [
          { file: "defender/mac-install-manually.md", title: "Manual deployment for Defender on macOS", text: "Download the onboarding package.", score: 0.9 },
          { file: "defender/mac-prerequisites.md", title: "Prerequisites for Defender on macOS", text: "Grant full disk access.", score: 0.8 },
        ];
      },
    });
  }
  try {
    await store.installMcpServer("microsoft-learn");
    await store.installMcpServer("kql-search");
    const cache = (store as unknown as { requireIntelligenceStore(): IntelligenceSqliteStore }).requireIntelligenceStore();
    // A fresh device cache: 5 Macs, 2 of them noncompliant, and 4 Windows PCs.
    if (!options.emptyCache) cache.replaceGraphResources({
      tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: new Date().toISOString(),
      rows: [
        ...Array.from({ length: 5 }, (_, i) => ({ id: `mac-${i}`, deviceName: `MAC-0${i}`, operatingSystem: "macOS", complianceState: i < 2 ? "noncompliant" : "compliant" })),
        ...Array.from({ length: 4 }, (_, i) => ({ id: `pc-${i}`, deviceName: `PC-0${i}`, operatingSystem: "Windows", complianceState: "compliant" })),
      ],
    });
    await run({
      docsSearches, store, cache, graphPaths, graphBuilds, prompts, writerPrompts,
      script(next) { replies = next.map((item) => (typeof item === "string" ? item : JSON.stringify(item))); reply = 0; prompts.length = 0; writerPrompts.length = 0; graphPaths.length = 0; graphBuilds.length = 0; },
    });
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
}

const learnTool = "mcp__microsoft-learn__microsoft_docs_search";
const kqlTool = "mcp__kql-search__search_kql_queries";
const kinds = (steps: readonly IntuneChatStep[] | undefined) => (steps ?? []).map((step) => step.kind);
/** The model's classification, shown on the model step that decided the kind. */
const classifiedAs = (steps: readonly IntuneChatStep[] | undefined) =>
  (steps ?? []).flatMap((step) => (step.kind === "answer" ? (step.detail ?? "").split(" · ") : [])).find((part) => /^(?:Classified as|Treated as|The model gave no)/.test(part));

describe("Chat steps, sources and follow-ups end to end", () => {
  it("answers the Defender for macOS docs question from Microsoft Learn without touching the tenant", async () => {
    await withHarness(async ({ store, cache, graphPaths, prompts, writerPrompts, script }) => {
      script([
        { kind: "docs", sources: ["microsoft-learn"], tool: learnTool, params: { query: "Defender for Endpoint on macOS" } },
        { final: true, answer: "Microsoft Learn says Defender for Endpoint on macOS needs full disk access [1] and one of the three latest macOS releases [2]. [9]", next: ["Which Macs miss the system extension profile?"] },
      ]);
      const events: IntuneChatStreamEvent[] = [];
      const result = await store.streamIntuneChatMessage({ content: DOCS_QUESTION }, (event) => events.push(event));
      const message = result.assistantMessage;

      // Live steps: the plan first, the MCP row shows what it sent while it runs, then the answer.
      const snapshots = events.flatMap((event) => (event.type === "steps" ? [event.steps] : []));
      // The plan step shows at once and finishes before the model is asked; the model's kind shows on its own step.
      assert.deepEqual([snapshots[0]![0]!.kind, snapshots[0]![0]!.status, snapshots[0]![0]!.title], ["plan", "active", "Reading the question"]);
      const working = snapshots.find((list) => list.some((step) => step.kind === "answer"))!;
      assert.deepEqual([working[0]!.status, working[0]!.title], ["completed", "Read the question"]);
      assert.deepEqual([working[1]!.title, working[1]!.status], ["Working", "active"]);
      // While the query is written nothing has been sent, so no sent text shows; then the exact checked text does.
      const writing = snapshots.find((list) => list.some((step) => step.kind === "mcp" && step.status === "active"))!.find((step) => step.kind === "mcp")!;
      assert.deepEqual([writing.sent, writing.detail], [undefined, "microsoft_docs_search · writing the query from your question"]);
      const live = snapshots.find((list) => list.some((step) => step.kind === "mcp" && step.status === "active" && step.sent));
      const liveMcp = live!.find((step) => step.kind === "mcp")!;
      assert.equal(liveMcp.sent, "Defender for Endpoint on macOS");
      // The query writer saw the admin's question and the tool, never the tenant name or the answering model's prompt.
      assert.equal(writerPrompts.length, 1);
      assert.ok(writerPrompts[0]!.includes(`\n${DOCS_QUESTION}\n`), "the admin's question, fenced");
      assert.match(writerPrompts[0]!, /Tool: microsoft_docs_search on 127\.0\.0\.1/);
      assert.doesNotMatch(writerPrompts[0]!, /Contoso|contoso\.example|Tenant:|MAC-0/);
      assert.deepEqual([liveMcp.origin, liveMcp.originLabel], ["third-party", "127.0.0.1"]);
      assert.equal(live!.at(-1)!.kind, "mcp", "a new step appends below the model step that chose it");
      // Append-only: every snapshot starts with the previous one's step ids.
      snapshots.forEach((list, index) => {
        if (index > 0) assert.deepEqual(list.slice(0, snapshots[index - 1]!.length).map((step) => step.id), snapshots[index - 1]!.map((step) => step.id));
      });

      assert.equal(message.questionKind, "docs");
      assert.deepEqual(kinds(message.steps), ["plan", "answer", "mcp", "answer"]);
      const [, chose, mcp, answer] = message.steps!;
      assert.equal(chose!.title, "Chose to ask Microsoft Learn");
      assert.equal(classifiedAs(message.steps), "Classified as a docs question. Sources: Microsoft Learn. Your tenant is not checked.");
      assert.deepEqual([mcp!.status, mcp!.title, mcp!.detail], ["completed", "Asked Microsoft Learn", "microsoft_docs_search · 2 results"]);
      assert.deepEqual([answer!.title, answer!.origin, answer!.originLabel], ["Wrote the answer", "device", "On device"]);
      assert.ok(message.steps!.every((step) => typeof step.durationMs === "number"));

      // No refresh, no tenant tools, and none offered once the model said docs.
      assert.deepEqual(graphPaths, []);
      assert.equal(cache.listToolCalls(result.conversation.id).some((call) => call.type === "graph-cache-refresh"), false);
      assert.deepEqual(message.toolTrace?.map((entry) => entry.tool), [learnTool]);
      assert.match(prompts[0]!.system, /Your first reply must also give the question kind/);
      assert.doesNotMatch(prompts[1]!.system, /- query_cache:|- graph_get:|- refresh_resource:|question kind/);

      // Citations map to Learn articles; [9] has no source.
      assert.deepEqual(message.documentationSources?.map((source) => [source.citation, source.kind, source.serverName, source.url]), [
        [1, "mcp", "Microsoft Learn", "https://learn.microsoft.com/defender-endpoint/microsoft-defender-endpoint-mac"],
        [2, "mcp", "Microsoft Learn", "https://learn.microsoft.com/defender-endpoint/mac-requirements"],
      ]);
      assert.match(message.content, /^Microsoft Learn says/);
      assert.deepEqual(message.followUps, ["Show compliance and last sync for our 5 macOS devices", "Which Macs miss the system extension profile?"]);
      // Both would read tenant data: the tie-in, and a "which" question about our Macs.
      assert.deepEqual(message.tenantFollowUps, message.followUps);

      // A reload shows the same steps, sources and follow-ups.
      const reloaded = (await store.getIntuneChatMessages(result.conversation.id)).at(-1)!;
      assert.deepEqual(reloaded.steps, message.steps);
      assert.deepEqual(reloaded.documentationSources, message.documentationSources);
      assert.deepEqual(reloaded.followUps, message.followUps);
      assert.deepEqual(reloaded.tenantFollowUps, message.tenantFollowUps);
      assert.deepEqual(reloaded.documentationSources?.map((source) => source.excerpt), ["Results for Defender for Endpoint on macOS: needs full disk access.", "Three latest macOS releases."]);
      assert.equal(reloaded.questionKind, "docs");
    });
  });

  it("streams the final answer and relabels unverified Microsoft Learn attribution while it streams", async () => {
    await withHarness(async ({ store, script }) => {
      script([
        { kind: "docs", sources: ["microsoft-learn"], tool: learnTool, params: { query: "Contoso Defender for macOS setup" } },
        { final: true, answer: "Microsoft Learn says Defender for Endpoint on macOS needs full disk access and a system extension." },
      ]);
      const deltas: string[] = [];
      const result = await store.streamIntuneChatMessage({ content: DOCS_QUESTION }, (event) => {
        if (event.type === "delta") deltas.push(event.content);
      });
      assert.ok(deltas.length > 2, "the answer arrives in pieces before the stored answer");
      assert.ok(deltas.every((content) => !/Microsoft Learn says/.test(content)), "live text is relabelled too");
      assert.ok(deltas.slice(0, -1).some((content) => content.startsWith("The Microsoft documentation says Defender") && !content.endsWith("extension.")));
      assert.equal(deltas.at(-1), "The Microsoft documentation says Defender for Endpoint on macOS needs full disk access and a system extension.");
      assert.equal(result.assistantMessage.content, deltas.at(-1));
    }, { incremental: true, chunkDelayMs: 40 });
  });

  it("sends live answer text at most every few frames, and the whole answer at the end", async () => {
    await withHarness(async ({ store, script }) => {
      const answer = Array.from({ length: 120 }, (_, index) => `word${index}`).join(" ");
      script([
        { kind: "docs", sources: ["microsoft-learn"], tool: learnTool, params: { query: "Defender for Endpoint on macOS" } },
        { final: true, answer },
      ]);
      const deltas: string[] = [];
      const result = await store.streamIntuneChatMessage({ content: DOCS_QUESTION }, (event) => {
        if (event.type === "delta") deltas.push(event.content);
      });
      // 120 chunks arrived at once: the first is sent live, then the stored answer.
      assert.ok(deltas.length <= 3, `${deltas.length} live updates`);
      assert.equal(deltas.at(-1), answer);
      assert.equal(result.assistantMessage.content, answer);
    }, { incremental: true });
  });

  const ONBOARDING_QUESTION = "how does defender onboarding for macos work?";

  it("keeps the local docs index back while Microsoft Learn answers a docs question", async () => {
    await withHarness(async ({ store, docsSearches, prompts, script }) => {
      script([
        { kind: "docs", sources: ["microsoft-learn"], tool: learnTool, params: { query: "Defender for Endpoint onboarding on macOS" } },
        { final: true, answer: "Deploy the onboarding package [1] and grant full disk access [2]." },
      ]);
      const message = (await store.streamIntuneChatMessage({ content: ONBOARDING_QUESTION }, () => {})).assistantMessage;
      assert.equal(message.questionKind, "docs");
      assert.deepEqual(kinds(message.steps), ["plan", "answer", "mcp", "answer"]);
      assert.deepEqual(docsSearches, []);
      assert.ok(prompts.every((entry) => !entry.prompt.includes("passages from the local docs index")));
      assert.deepEqual(message.documentationSources?.map((source) => source.kind), ["mcp", "mcp"]);
    }, { docsIndex: true });
  });

  it("searches the local docs index after Microsoft Learn returns nothing, as its own step after the Learn call", async () => {
    await withHarness(async ({ store, docsSearches, prompts, script }) => {
      script([
        { kind: "docs", sources: ["microsoft-learn"], tool: learnTool, params: { query: "nothing about onboarding" } },
        { final: true, answer: "Microsoft Learn says to deploy the onboarding package [1]." },
      ]);
      const message = (await store.streamIntuneChatMessage({ content: ONBOARDING_QUESTION }, () => {})).assistantMessage;
      assert.deepEqual(kinds(message.steps), ["plan", "answer", "mcp", "docs-index", "answer"]);
      assert.equal(message.steps![3]!.title, "Searched the local docs index, because Microsoft Learn returned nothing");
      assert.equal(docsSearches.length, 1);
      assert.match(prompts[1]!.prompt, /Microsoft Learn returned nothing\. Passages from the local docs index are now in the prompt/);
      assert.deepEqual(message.documentationSources?.map((source) => [source.citation, source.kind]), [[1, "docs-index"], [2, "docs-index"]]);
      assert.match(message.content, /^The Microsoft documentation says/);
    }, { docsIndex: true });
  });

  it("searches the local docs index after a blocked Microsoft Learn query, and says why", async () => {
    await withHarness(async ({ store, script }) => {
      script([
        { kind: "docs", sources: ["microsoft-learn"], tool: learnTool, params: { query: "Contoso Defender onboarding" } },
        { final: true, answer: "Deploy the onboarding package [1]." },
      ]);
      const message = (await store.streamIntuneChatMessage({ content: ONBOARDING_QUESTION }, () => {})).assistantMessage;
      assert.deepEqual(kinds(message.steps), ["plan", "answer", "mcp", "docs-index", "answer"]);
      assert.equal(message.steps![2]!.status, "blocked");
      assert.equal(message.steps![3]!.title, "Searched the local docs index, because the Microsoft Learn query was blocked");
    }, { docsIndex: true });
  });

  it("searches the local docs index once the model's kind leaves Microsoft Learn out", async () => {
    await withHarness(async ({ store, docsSearches, script }) => {
      script([
        { kind: "mixed", sources: ["docs-index"], tool: "query_cache", params: { resource: "managedDevices", where: { operatingSystem: "macOS" }, limit: 5 } },
        { final: true, answer: "Five Macs are enrolled; onboarding needs the package [1]." },
      ]);
      const message = (await store.streamIntuneChatMessage({ content: ONBOARDING_QUESTION }, () => {})).assistantMessage;
      assert.equal(message.questionKind, "mixed");
      // The index search follows the model step that decided the kind, in the order it ran.
      assert.deepEqual(kinds(message.steps), ["plan", "answer", "docs-index", "graph-refresh", "tool", "answer"]);
      assert.equal(message.steps!.find((step) => step.kind === "docs-index")!.title, "Searched the local docs index");
      assert.equal(docsSearches.length, 1);
    }, { docsIndex: true });
  });

  it("numbers a real Microsoft Learn search for the model and makes its results citable", async () => {
    await withHarness(async ({ store, prompts, script }) => {
      script([
        { kind: "docs", sources: ["microsoft-learn"], tool: learnTool, params: { query: "recorded Defender onboarding on macOS with Intune" } },
        { final: true, answer: "Download the onboarding package [1], or follow Defender for Business [2]." },
      ]);
      const message = (await store.streamIntuneChatMessage({ content: ONBOARDING_QUESTION }, () => {})).assistantMessage;
      // The recorded payload is longer than the host's output cap; the results are read from the whole payload.
      assert.deepEqual(message.documentationSources?.map((source) => [source.citation, source.title, source.url]), [
        [1, "Deploy Microsoft Defender for Endpoint on macOS with Microsoft Intune", "https://learn.microsoft.com/defender-endpoint/mac-install-with-intune#create-system-configuration-profiles"],
        [2, "Onboard devices to Microsoft Defender for Business", "https://learn.microsoft.com/defender-business/mdb-onboard-devices#mac"],
        [3, "Deploy Microsoft Defender for Endpoint on macOS with another MDM solution", "https://learn.microsoft.com/defender-endpoint/mac-install-with-other-mdm#deploy-defender-for-endpoint"],
      ]);
      assert.equal(message.steps?.find((step) => step.kind === "mcp")?.detail, "microsoft_docs_search · 10 results");
      assert.match(prompts[1]!.prompt, /\[1\] Deploy Microsoft Defender for Endpoint on macOS with Microsoft Intune, https:\/\/learn\.microsoft\.com\/defender-endpoint\/mac-install-with-intune#create-system-configuration-profiles\\n# Deploy/);
      assert.match(prompts[1]!.system, /Each MCP result is listed as \[n\] Title, URL before its excerpt\. Cite it with that \[n\]/);
    });
  });

  it("does not search the local docs index for a tenant question, in the tool loop or the deterministic path", async () => {
    await withHarness(async ({ store, docsSearches, prompts, script }) => {
      script([
        { kind: "tenant", sources: [], tool: "query_cache", params: { resource: "managedDevices", where: { operatingSystem: "macOS" }, limit: 5 } },
        { final: true, answer: "5 Macs are cached; 2 are noncompliant." },
      ]);
      const message = (await store.streamIntuneChatMessage({ content: "Check our 5 macOS devices for Defender in Intune" }, () => {})).assistantMessage;
      assert.equal(message.questionKind, "tenant");
      assert.ok(!kinds(message.steps).includes("docs-index"));
      assert.deepEqual(docsSearches, []);
      assert.equal(message.documentationSources, undefined);
      assert.ok(prompts.every((entry) => !entry.prompt.includes("passages from the local docs index")));

      await store.setChatInvestigationMode("always-deterministic");
      script(["2 of the 5 Macs are noncompliant."]);
      const direct = (await store.sendIntuneChatMessage({ content: "Which of our macOS devices are noncompliant?" })).assistantMessage;
      assert.equal(direct.questionKind, "tenant");
      assert.deepEqual(docsSearches, []);
    }, { docsIndex: true });
  });

  it("does not label the answer Microsoft Learn when the Learn call was blocked", async () => {
    await withHarness(async ({ store, script }) => {
      script([
        { kind: "docs", sources: ["microsoft-learn"], tool: learnTool, params: { query: "Contoso Defender for macOS setup" } },
        { final: true, answer: "Microsoft Learn says Defender for Endpoint on macOS needs full disk access." },
      ]);
      const message = (await store.sendIntuneChatMessage({ content: DOCS_QUESTION })).assistantMessage;
      assert.equal(message.toolTrace?.[0]?.mcpSource?.blocked, true);
      assert.equal(message.steps?.find((step) => step.kind === "mcp")?.status, "blocked");
      assert.equal(message.content, "The Microsoft documentation says Defender for Endpoint on macOS needs full disk access.");
      assert.equal(message.documentationSources, undefined);
    });
  });

  it("calls KQL Search for a KQL question, even when the model tries to answer first", async () => {
    await withHarness(async ({ store, graphPaths, prompts, script }) => {
      script([
        { kind: "docs", sources: [], final: true, answer: "Use SigninLogs." },
        { tool: kqlTool, params: { query: "failed sign-ins last 24 hours" } },
        { final: true, answer: "Start from this community query [1]:\n\n```kql\nSigninLogs | where TimeGenerated > ago(24h) | where ResultType != 0\n```" },
      ]);
      const result = await store.sendIntuneChatMessage({ content: KQL_QUESTION });
      const message = result.assistantMessage;
      assert.equal(message.questionKind, "docs");
      assert.equal(classifiedAs(message.steps), "Classified as a docs question. Sources: KQL Search. Your tenant is not checked.");
      assert.match(prompts[1]!.prompt, /Call KQL Search before answering/);
      assert.deepEqual(message.toolTrace?.map((entry) => entry.tool), [kqlTool]);
      // The answer before the required source is its own model step, then the one that chose KQL Search.
      assert.deepEqual(message.steps!.map((step) => step.kind === "answer" ? step.title : step.kind), ["plan", "Answered before asking the chosen source", "Chose to ask KQL Search", "mcp", "Wrote the answer"]);
      assert.equal(message.steps![3]!.sent, "failed sign-ins last 24 hours");
      assert.deepEqual(graphPaths, []);
      assert.deepEqual(message.documentationSources?.map((source) => [source.citation, source.serverName, source.url]), [[1, "KQL Search", "https://www.kqlsearch.com/query/failed-sign-ins-24h"]]);
      assert.deepEqual(message.followUps, ["Check how this applies to our sign-in logs"]);
    });
  });

  it("gives the deterministic path the same plan step and tenant follow-up, and says MCP tools were not used", async () => {
    await withHarness(async ({ store, graphPaths, script }) => {
      await store.setChatInvestigationMode("always-deterministic");
      script(["Defender for Endpoint on macOS needs full disk access."]);
      const message = (await store.sendIntuneChatMessage({ content: DOCS_QUESTION })).assistantMessage;
      assert.equal(message.questionKind, "docs");
      assert.deepEqual(kinds(message.steps), ["plan", "answer"]);
      assert.match(message.steps![0]!.detail!, /Documentation question\. No documentation source is available/);
      assert.match(message.engineNotice ?? "", /Installed MCP tools were not used because Chat is set to deterministic retrieval/);
      assert.deepEqual(message.followUps, ["Show compliance and last sync for our 5 macOS devices"]);
      assert.deepEqual(graphPaths, []);
      assert.equal(message.tenantContext, undefined, "a docs answer carries no tenant rows");

      // The deterministic path puts cached tenant rows in the prompt for a tenant question.
      script(["5 of your 9 devices run macOS."]);
      const tenantAnswer = (await store.sendIntuneChatMessage({ content: "How many managed devices run macOS?" })).assistantMessage;
      assert.equal(tenantAnswer.questionKind, "tenant");
      assert.equal(tenantAnswer.tenantContext, true);
      const reloaded = (await store.getIntuneChatMessages(tenantAnswer.conversationId)).at(-1)!;
      assert.equal(reloaded.tenantContext, true);
    });
  });

  it("streams the same relabelled text that it stores", async () => {
    await withHarness(async ({ store, script }) => {
      await store.setChatInvestigationMode("always-deterministic");
      script(["Microsoft Learn says Defender for Endpoint on macOS needs full disk access."]);
      const deltas: string[] = [];
      const result = await store.streamIntuneChatMessage({ content: DOCS_QUESTION }, (event) => { if (event.type === "delta") deltas.push(event.content); });
      assert.ok(deltas.length > 3);
      assert.ok(deltas.every((content) => !/Microsoft Learn says/.test(content)), "no live delta attributes text to Learn");
      assert.equal(deltas.at(-1), "The Microsoft documentation says Defender for Endpoint on macOS needs full disk access.");
      assert.equal(result.assistantMessage.content, deltas.at(-1));
    }, { chunkDelayMs: 40 });
  });

  it("falls back to the keyword kind when the model gives none, and never treats an ambiguous tenant question as docs-only", async () => {
    await withHarness(async ({ store, prompts, script }) => {
      // A missing kind gets one repair; an invalid one counts as missing, then the keyword kind decides.
      script([{ final: true, answer: "There are none." }, { kind: "documentation", final: true, answer: "There are none." }, { tool: "query_cache", params: { resource: "managedDevices", where: { complianceState: "noncompliant" } } }, { final: true, answer: "2 devices are noncompliant." }]);
      const message = (await store.sendIntuneChatMessage({ content: "What are the noncompliant devices?" })).assistantMessage;
      assert.equal(message.questionKind, "mixed");
      assert.match(prompts[1]!.prompt, /That reply did not give the question kind/);
      assert.match(classifiedAs(message.steps)!, /^The model gave no question kind, so keyword rules decided: a docs and tenant question\. /);
      assert.equal(message.steps![1]!.title, "Reply gave no question kind");
      assert.match(prompts[2]!.prompt, /That answer used no tenant evidence/);
      assert.ok(message.toolTrace?.some((entry) => entry.tool === "query_cache" && !entry.error));
      assert.equal(message.content, "2 devices are noncompliant.");
      assert.equal(message.tenantContext, true);
    });
  });

  it("answers docs questions the model calls docs with no refresh and no Graph calls", async () => {
    await withHarness(async ({ store, cache, graphPaths, script }) => {
      for (const question of ["How do I enroll macOS devices?", "Is there a script to find stale devices?"]) {
        script([
          { kind: "docs", sources: ["microsoft-learn"], tool: learnTool, params: { query: question } },
          { final: true, answer: "Microsoft Learn describes the steps [1]." },
        ]);
        const result = await store.sendIntuneChatMessage({ content: question });
        const message = result.assistantMessage;
        assert.equal(message.questionKind, "docs", question);
        assert.equal(classifiedAs(message.steps), "Classified as a docs question. Sources: Microsoft Learn. Your tenant is not checked.", question);
        assert.deepEqual(kinds(message.steps), ["plan", "answer", "mcp", "answer"], question);
        assert.deepEqual(graphPaths, [], question);
        assert.equal(cache.listToolCalls(result.conversation.id).some((call) => call.type === "graph-cache-refresh"), false, question);
        assert.equal(message.tenantContext, undefined, question);
      }
    });
  });

  it("treats a model docs label as mixed when the question mentions the tenant", async () => {
    await withHarness(async ({ store, graphPaths, prompts, script }) => {
      script([
        { kind: "docs", sources: ["microsoft-learn"], tool: learnTool, params: { query: "Intune device enrollment" } },
        { final: true, answer: "Microsoft Learn describes enrollment [1]." },
        { tool: "query_cache", params: { resource: "managedDevices", limit: 25 } },
        { final: true, answer: "Microsoft Learn describes enrollment [1]. 9 of your devices are enrolled." },
      ]);
      const message = (await store.sendIntuneChatMessage({ content: "What do the docs say about our devices?" })).assistantMessage;
      assert.equal(message.questionKind, "mixed");
      assert.match(classifiedAs(message.steps)!, /^Treated as docs and tenant: the question mentions your tenant\. Sources: /);
      // The refresh the mixed kind needs runs after the model step that decided it.
      assert.deepEqual(kinds(message.steps), ["plan", "answer", "graph-refresh", "mcp", "answer", "answer", "tool", "answer"]);
      assert.ok(graphPaths.length > 0, "the mixed question refreshed the stale planned resources");
      assert.ok(prompts.some((entry) => /That answer used no tenant evidence/.test(entry.prompt)));
    });
  });

  it("takes the model's tenant kind for a question keyword rules call mixed, and refreshes before the tool", async () => {
    await withHarness(async ({ store, cache, graphPaths, script }) => {
      script([
        { kind: "tenant", sources: [], tool: "query_cache", params: { resource: "managedDevices", limit: 25 } },
        { final: true, answer: "None of the 9 cached devices is unmanaged." },
      ]);
      const result = await store.sendIntuneChatMessage({ content: "What are unmanaged devices?" });
      const message = result.assistantMessage;
      assert.equal(message.questionKind, "tenant");
      assert.equal(classifiedAs(message.steps), "Classified as a tenant question. Sources: cached tenant data and Microsoft Graph.");
      assert.deepEqual(message.steps!.map((step) => step.kind === "answer" ? step.title : step.kind), ["plan", "Chose to query cached Intune managed devices", "graph-refresh", "tool", "Wrote the answer"]);
      assert.ok(graphPaths.length > 0);
      assert.equal(cache.listToolCalls(result.conversation.id).some((call) => call.type === "graph-cache-refresh"), true);
    });
  });

  it("upgrades a docs run that calls a tenant tool to mixed, refreshes, then runs the tool", async () => {
    await withHarness(async ({ store, graphPaths, script }) => {
      const events: IntuneChatStreamEvent[] = [];
      script([
        { kind: "docs", sources: ["microsoft-learn"], tool: learnTool, params: { query: "enroll macOS devices in Intune" } },
        { tool: "query_cache", params: { resource: "managedDevices", where: { operatingSystem: "macOS" }, limit: 25 } },
        { final: true, answer: "Microsoft Learn describes enrollment [1]. 5 Macs are already enrolled." },
      ]);
      const message = (await store.streamIntuneChatMessage({ content: "How do I enroll macOS devices?" }, (event) => events.push(event))).assistantMessage;
      assert.equal(message.questionKind, "mixed");
      assert.deepEqual(kinds(message.steps), ["plan", "answer", "mcp", "answer", "plan", "graph-refresh", "tool", "answer"]);
      const upgrade = message.steps![4]!;
      assert.deepEqual([upgrade.title, upgrade.detail], ["Treated as docs and tenant", "The model asked for tenant data, so the answer now needs tenant evidence."]);
      assert.equal(message.steps![6]!.status, "completed");
      assert.ok(graphPaths.length > 0, "the refresh ran before the tool");
      // The refresh step showed live before the tool step started.
      const live = events.flatMap((event) => (event.type === "steps" ? [event.steps] : []));
      const refreshAt = live.findIndex((list) => list.some((step) => step.kind === "graph-refresh"));
      const toolAt = live.findIndex((list) => list.some((step) => step.kind === "tool"));
      assert.ok(refreshAt >= 0 && refreshAt < toolAt);
      assert.equal(message.tenantContext, true);
    });
  });

  it("keeps the keyword kind and the refresh before the answer on the deterministic path", async () => {
    await withHarness(async ({ store, graphPaths, prompts, script }) => {
      await store.setChatInvestigationMode("always-deterministic");
      script(["Enroll Macs with Apple Business Manager."]);
      const message = (await store.sendIntuneChatMessage({ content: "How do I enroll macOS devices?" })).assistantMessage;
      assert.equal(message.questionKind, "mixed");
      assert.deepEqual(kinds(message.steps), ["plan", "graph-refresh", "answer"]);
      assert.doesNotMatch(message.steps![0]!.detail!, /keyword rules/);
      assert.ok(graphPaths.length > 0);
      assert.equal(prompts.length, 1, "one model call, with no kind protocol");
      assert.doesNotMatch(prompts[0]!.system, /question kind/);
    });
  });

  it("refreshes an empty cache before a direct device answer", async () => {
    for (const send of ["sendIntuneChatMessage", "streamIntuneChatMessage"] as const) {
      await withHarness(async ({ store, graphPaths, script }) => {
        script([{ kind: "tenant", sources: [], final: true, answer: "unused" }]);
        const result = send === "sendIntuneChatMessage"
          ? await store.sendIntuneChatMessage({ content: "How many non-compliant devices are there?" })
          : await store.streamIntuneChatMessage({ content: "How many non-compliant devices are there?" }, () => undefined);
        const message = result.assistantMessage;
        assert.doesNotMatch(message.content, /inventory is unavailable/, send);
        assert.match(message.content, /0 devices are marked non-compliant/, send);
        assert.ok(graphPaths.length > 0, send);
        assert.ok(kinds(message.steps).includes("graph-refresh"), send);
      }, { emptyCache: true });
    }
  });

  it("does not let a follow-up be docs only when an earlier answer in the chat used tenant data", async () => {
    await withHarness(async ({ store, prompts, script }) => {
      script([
        { kind: "tenant", sources: [], tool: "query_cache", params: { resource: "managedDevices", where: { operatingSystem: "macOS", complianceState: "noncompliant" } } },
        { final: true, answer: "2 of your 5 Macs are noncompliant." },
      ]);
      const first = await store.sendIntuneChatMessage({ content: "Which of our Macs are noncompliant?" });
      assert.equal(first.assistantMessage.questionKind, "tenant");

      // The follow-up carries no tenant wording, but the memory in its prompt holds tenant numbers.
      script([
        { kind: "docs", sources: ["microsoft-learn"], tool: learnTool, params: { query: "Intune Windows compliance" } },
        { final: true, answer: "2 of your 4 Windows PCs are noncompliant." },
        { tool: "query_cache", params: { resource: "managedDevices", where: { operatingSystem: "Windows" } } },
        { final: true, answer: "None of your 4 Windows PCs is noncompliant." },
      ]);
      const followUp = (await store.sendIntuneChatMessage({ conversationId: first.conversation.id, content: "And for Windows?" })).assistantMessage;
      assert.equal(followUp.questionKind, "mixed");
      assert.match(classifiedAs(followUp.steps)!, /^Treated as docs and tenant: earlier answers in this chat used your tenant data\. Sources: /);
      assert.ok(prompts.some((entry) => /That answer used no tenant evidence/.test(entry.prompt)));
      assert.equal(followUp.content, "None of your 4 Windows PCs is noncompliant.");

      // A new chat with no tenant answers keeps the model's docs label.
      script([
        { kind: "docs", sources: ["microsoft-learn"], tool: learnTool, params: { query: "Intune Windows compliance" } },
        { final: true, answer: "Microsoft Learn describes compliance policies [1]." },
      ]);
      assert.equal((await store.sendIntuneChatMessage({ content: "And for Windows?" })).assistantMessage.questionKind, "docs");
    });
  });

  it("shows a failed refresh on its step and still answers from the cache", async () => {
    for (const send of ["sendIntuneChatMessage", "streamIntuneChatMessage"] as const) {
      await withHarness(async ({ store, script }) => {
        script([
          { kind: "tenant", sources: [], tool: "query_cache", params: { resource: "managedDevices", limit: 25 } },
          { final: true, answer: "9 devices are cached; none is unmanaged." },
        ]);
        const result = send === "sendIntuneChatMessage"
          ? await store.sendIntuneChatMessage({ content: "What are unmanaged devices?" })
          : await store.streamIntuneChatMessage({ content: "What are unmanaged devices?" }, () => undefined);
        const message = result.assistantMessage;
        assert.equal(message.status, "completed", send);
        assert.equal(message.content, "9 devices are cached; none is unmanaged.", send);
        assert.doesNotMatch(message.content, /LLM provider failed/, send);
        const refresh = message.steps!.find((step) => step.kind === "graph-refresh")!;
        assert.deepEqual([refresh.status, refresh.title, refresh.detail], ["failed", "Could not refresh tenant data", "Sign-in for Contoso expired. Reconnect the tenant."], send);
        assert.deepEqual(kinds(message.steps), ["plan", "answer", "graph-refresh", "tool", "answer"], send);
      }, { graphError: "Sign-in for Contoso expired. Reconnect the tenant." });
    }
  });

  it("refreshes, asks Learn and still requires tenant evidence for a mixed tenant question", async () => {
    await withHarness(async ({ store, cache, graphPaths, prompts, script }) => {
      script([
        { kind: "mixed", sources: ["microsoft-learn"], tool: learnTool, params: { query: "Intune noncompliant macOS device remediation" } },
        { final: true, answer: "Microsoft Learn recommends checking the compliance policy [1]." },
        { tool: "query_cache", params: { resource: "managedDevices", where: { operatingSystem: "macOS", complianceState: "noncompliant" } } },
        { final: true, answer: "Microsoft Learn recommends reviewing the failed setting first [1].\n\n2 of your macOS devices are noncompliant.", next: ["Show the compliance policies assigned to these Macs"] },
      ]);
      const result = await store.sendIntuneChatMessage({ content: MIXED_QUESTION });
      const message = result.assistantMessage;
      assert.equal(message.questionKind, "mixed");
      assert.equal(classifiedAs(message.steps), "Classified as a docs and tenant question. Sources: Microsoft Learn, and cached tenant data and Microsoft Graph.");
      assert.deepEqual(message.steps!.map((step) => step.kind === "answer" ? step.title : step.kind), [
        "plan", "Chose to ask Microsoft Learn", "graph-refresh", "mcp", "Answered without checking tenant data", "Chose to query cached Intune managed devices", "tool", "Wrote the answer",
      ]);
      const refresh = message.steps![2]!;
      assert.deepEqual([refresh.origin, refresh.originLabel], ["graph", "Microsoft Graph"]);
      assert.ok(graphPaths.length > 0, "stale planned resources were refreshed from Graph");
      assert.equal(cache.listToolCalls(result.conversation.id).some((call) => call.type === "graph-cache-refresh"), true);
      const tool = message.steps![6]!;
      assert.deepEqual([tool.title, tool.origin, tool.originLabel], ["Queried cached data", "device", "On device"]);
      assert.match(tool.detail!, /^Intune managed devices · 2 of 2 cached rows returned$/);
      assert.ok(prompts.some((entry) => /That answer used no tenant evidence/.test(entry.prompt)));
      assert.match(message.content, /2 of your macOS devices are noncompliant/);
      // The answer read tenant data, so the model's follow-up is dropped and the device template is offered.
      assert.deepEqual(message.followUps, ["Show compliance and last sync for our 5 macOS devices"]);
    });
  });

  it("keeps the partial-answer note with the lazy refresh, the step timeline and streaming when a service is not connected", async () => {
    const intuneOnly = requestedScopes(partIdsFor(["intune"])).map((scope) => qualifyScope(scope.name));
    const note = "Not included in this answer: Defender alerts and Defender incidents. Defender is not connected for this tenant. Add it in Connections.";
    for (const send of ["sendIntuneChatMessage", "streamIntuneChatMessage"] as const) {
      await withHarness(async ({ store, graphPaths, script }) => {
        script([
          { kind: "tenant", sources: [], tool: "query_cache", params: { resource: "managedDevices", limit: 25 } },
          { final: true, answer: "9 devices are cached." },
        ]);
        const deltas: string[] = [];
        const input = { content: "Show devices with security alerts" };
        const result = send === "sendIntuneChatMessage"
          ? await store.sendIntuneChatMessage(input)
          : await store.streamIntuneChatMessage(input, (event: IntuneChatStreamEvent) => { if (event.type === "delta") deltas.push(event.content); });
        const message = result.assistantMessage;
        assert.equal(message.status, "completed", send);
        assert.equal(message.content, `9 devices are cached.\n\n${note}`, send);
        if (send === "streamIntuneChatMessage") assert.equal(deltas.at(-1), message.content, "the streamed text ends with the note");
        assert.equal(graphPaths.some((path) => path.includes("/security/")), false, send);
        assert.deepEqual(kinds(message.steps), ["plan", "answer", "graph-refresh", "tool", "answer"], send);
        assert.notEqual(message.steps!.find((step) => step.kind === "graph-refresh")!.status, "failed", send);
      }, { grantedScopes: intuneOnly });
    }
  });

  it("adds no partial-answer note to a docs answer, which reads no tenant data", async () => {
    const intuneOnly = requestedScopes(partIdsFor(["intune"])).map((scope) => qualifyScope(scope.name));
    await withHarness(async ({ store, graphPaths, script }) => {
      script([
        { kind: "docs", sources: ["microsoft-learn"], tool: learnTool, params: { query: "Defender alerts on devices" } },
        { final: true, answer: "Microsoft Learn describes Defender alerts [1]." },
      ]);
      const message = (await store.sendIntuneChatMessage({ content: "What does Microsoft Learn say about devices with security alerts?" })).assistantMessage;
      assert.equal(message.questionKind, "docs");
      assert.doesNotMatch(message.content, /Not included in this answer/);
      assert.deepEqual(graphPaths, []);
    }, { grantedScopes: intuneOnly });
  });

  it("names a new chat with the answer's title, keeps it on later answers, and falls back to the question", async () => {
    await withHarness(async ({ store, script, prompts }) => {
      script([
        { kind: "docs", sources: ["microsoft-learn"], tool: learnTool, params: { query: "Defender for Endpoint on macOS" } },
        { final: true, answer: "Grant full disk access [1].", title: "Defender for Endpoint on macOS", next: ["Explain the system extension profile", "Which Macs miss the system extension profile?"] },
      ]);
      const first = await store.streamIntuneChatMessage({ content: DOCS_QUESTION }, () => {});
      assert.equal(first.conversation.title, "Defender for Endpoint on macOS");
      assert.match(prompts.at(-1)!.system, /Also add "title"/);
      // The excerpt the model read is stored with its source and survives a reload.
      const reloaded = (await store.getIntuneChatMessages(first.conversation.id)).at(-1)!;
      assert.match(reloaded.documentationSources?.[0]?.excerpt ?? "", /needs full disk access/);
      // The deterministic tie-in reads tenant data; the model's own follow-up is marked only when it refers to the tenant.
      assert.deepEqual(reloaded.followUps, ["Show compliance and last sync for our 5 macOS devices", "Explain the system extension profile"]);
      assert.deepEqual(reloaded.tenantFollowUps, ["Show compliance and last sync for our 5 macOS devices"]);

      script([
        { kind: "docs", sources: ["microsoft-learn"], tool: learnTool, params: { query: "Defender for Endpoint on macOS requirements" } },
        { final: true, answer: "The three latest releases [1].", title: "Something else" },
      ]);
      const second = await store.streamIntuneChatMessage({ content: "And which macOS versions does it support?", conversationId: first.conversation.id }, () => {});
      assert.equal(second.conversation.title, "Defender for Endpoint on macOS", "only the first answer names the chat");
      assert.doesNotMatch(prompts.at(-1)!.system, /"title"/);

      script([
        { kind: "docs", sources: ["microsoft-learn"], tool: learnTool, params: { query: "Defender for Endpoint on macOS" } },
        { final: true, answer: "Grant full disk access [1].", title: "Visit learn.microsoft.com for this" },
      ]);
      const fallback = await store.streamIntuneChatMessage({ content: `  ${DOCS_QUESTION}  ` }, () => {});
      assert.equal(fallback.conversation.title, DOCS_QUESTION.slice(0, 51).trim() + "...", "an invalid title leaves the trimmed question");
    });
  });

  it("writes a later answer's Learn query from that question only, never from earlier messages, results or queries", async () => {
    // A writer that copies the fenced question verbatim, so anything else in its prompt would be visible in the sent query too.
    const echoQuestion = (prompt: string) => {
      const body = prompt.match(/^The admin's question:\n<tenant_data [^>]*>\n([\s\S]*?)\n<\/tenant_data /)?.[1];
      return body && !body.includes("420 Cedar") ? JSON.stringify({ query: body }) : '{"query":"Defender for Endpoint on macOS"}';
    };
    await withHarness(async ({ store, writerPrompts, script }) => {
      script([
        { kind: "docs", sources: ["microsoft-learn"], tool: learnTool, params: {} },
        { final: true, answer: "Grant full disk access [1]." },
      ]);
      const first = await store.streamIntuneChatMessage({ content: 'A sample record shows streetAddress: "420 Cedar Avenue". What does Microsoft Learn say about Defender for macOS?' }, () => {});
      assert.equal(first.assistantMessage.steps?.find((step) => step.kind === "mcp")?.sent, "Defender for Endpoint on macOS");
      assert.match(first.assistantMessage.documentationSources?.[0]?.title ?? "", /Microsoft Defender for Endpoint on Mac/);

      script([
        { kind: "docs", sources: ["microsoft-learn"], tool: learnTool, params: {} },
        { final: true, answer: "Microsoft Learn describes the grace period [1]." },
      ]);
      const later = "How long is the Intune compliance grace period?";
      const second = await store.streamIntuneChatMessage({ content: later, conversationId: first.conversation.id }, () => {});
      // The persisted history holds the address, the earlier result title and the earlier query.
      const stored = await store.getIntuneChatMessages(first.conversation.id);
      assert.match(stored[0]!.content, /420 Cedar Avenue/);
      assert.equal(writerPrompts.length, 1);
      const prompt = writerPrompts[0]!;
      assert.ok(prompt.startsWith(`The admin's question:\n`) && prompt.includes(`\n${later}\n`));
      for (const earlier of [/420 Cedar/, /streetAddress/, /Microsoft Defender for Endpoint on Mac/, /Defender for Endpoint on macOS/, /Earlier results/, /Queries already sent/]) {
        assert.doesNotMatch(prompt, earlier);
      }
      const mcp = second.assistantMessage.steps?.find((step) => step.kind === "mcp");
      assert.equal(mcp?.sent, later);
      assert.deepEqual(second.assistantMessage.toolTrace?.find((entry) => entry.tool === learnTool)?.params, { query: later });
    }, { writer: echoQuestion });
  });
  it("offers only a code-built follow-up after a tenant read, and the address never reaches a later query", async () => {
    const echoQuestion = (prompt: string) => {
      const body = prompt.match(/^The admin's question:\n<tenant_data [^>]*>\n([\s\S]*?)\n<\/tenant_data /)?.[1];
      return body ? JSON.stringify({ query: body }) : undefined;
    };
    await withHarness(async ({ store, prompts, writerPrompts, script }) => {
      script([
        { kind: "tenant", tool: "graph_get", params: { path: "/users", query: { $select: "displayName,streetAddress" } } },
        { final: true, answer: "Ana Diaz uses MAC-00.", next: ["Which Macs are at 420 Cedar Avenue?", "Check Defender on the Macs at 420 Cedar Avenue"], title: "Primary users of our Macs" },
      ]);
      const first = await store.streamIntuneChatMessage({ content: "Who are the primary users of our macOS devices?" }, () => {});
      assert.equal(first.assistantMessage.status, "completed");
      assert.ok(prompts.some((entry) => /420 Cedar Avenue/.test(entry.prompt)), "the answering model read the address");
      const stored = (await store.getIntuneChatMessages(first.conversation.id)).at(-1)!;
      for (const text of [...(stored.followUps ?? []), ...(stored.tenantFollowUps ?? [])]) assert.doesNotMatch(text, /420 Cedar/);
      assert.deepEqual(stored.followUps, ["Show compliance and last sync for our 5 macOS devices"]);
      assert.equal(first.conversation.title, "Primary users of our Macs", "the title may stay model-written");

      // The admin sends the offered follow-up; the model asks Microsoft Learn on that turn.
      const offered = stored.followUps![0]!;
      script([
        { kind: "mixed", sources: ["microsoft-learn"], tool: learnTool, params: { query: "Macs at 420 Cedar Avenue" } },
        { tool: "query_cache", params: { resource: "managedDevices", where: { operatingSystem: "macOS" } } },
        { final: true, answer: "All 5 Macs synced today [1]." },
      ]);
      const second = await store.streamIntuneChatMessage({ content: offered, conversationId: first.conversation.id }, () => {});
      assert.equal(writerPrompts.length, 1);
      assert.ok(writerPrompts[0]!.includes(`\n${offered}\n`));
      for (const secret of [/420 Cedar/, /streetAddress/, /Ana Diaz/]) assert.doesNotMatch(writerPrompts[0]!, secret);
      const mcp = second.assistantMessage.steps?.find((step) => step.kind === "mcp");
      assert.equal(mcp?.sent, offered);
      assert.deepEqual(second.assistantMessage.toolTrace?.find((entry) => entry.tool === learnTool)?.params, { query: offered });
    }, { writer: echoQuestion, graphResponses: { "/users": { value: [{ id: "user-1", displayName: "Ana Diaz", streetAddress: "420 Cedar Avenue" }] } } });
  });
  describe("follow-up provenance", () => {
    const ADDRESS_FOLLOW_UP = "Explain support at 420 Cedar Avenue";
    const docsReplies = [
      { kind: "docs", sources: ["microsoft-learn"], tool: learnTool, params: { query: "Intune macOS enrollment" } },
      { final: true, answer: "Microsoft Learn describes macOS enrollment [1].", next: [ADDRESS_FOLLOW_UP, "Explain the system extension profile"] },
    ];
    const ask = (store: AppStateStore, send: "sendIntuneChatMessage" | "streamIntuneChatMessage", input: Parameters<AppStateStore["sendIntuneChatMessage"]>[0]) =>
      send === "sendIntuneChatMessage" ? store.sendIntuneChatMessage(input) : store.streamIntuneChatMessage(input, () => {});

    it("drops model follow-ups after a legacy tenant answer in the conversation memory, and the flag survives a reload", async () => {
      for (const send of ["sendIntuneChatMessage", "streamIntuneChatMessage"] as const) {
        await withHarness(async ({ store, cache, prompts, script }) => {
          // An answer stored before steps and tenant markers existed: only its source rows say it read the tenant.
          const conversationId = `chat_legacy_${send}`;
          const at = "2026-06-02T10:00:00.000Z";
          cache.createConversation({ id: conversationId, title: "Legacy", tenantId: tenant.id, now: at });
          cache.insertMessage({ id: `${conversationId}_u`, conversationId, role: "user", content: "Where is Ana Diaz based?", status: "completed", createdAt: at });
          cache.insertMessage({
            id: `${conversationId}_a`, conversationId, role: "assistant", status: "completed", createdAt: "2026-06-02T10:00:01.000Z",
            content: "Ana Diaz has streetAddress: 420 Cedar Avenue.",
            sources: [{ resource: "users", label: "Users", rows: 1, source: "cache" }],
          });
          script(docsReplies);
          const message = (await ask(store, send, { content: "How do I enroll macOS devices?", conversationId })).assistantMessage;
          assert.equal(message.questionKind, "docs", send);
          assert.ok(prompts.some((entry) => /420 Cedar Avenue/.test(entry.prompt)), `${send}: the answering model read the legacy answer`);
          assert.equal(message.privatePrompt, true, send);
          for (const text of message.followUps ?? []) assert.doesNotMatch(text, /420 Cedar|system extension/, send);
          const reloaded = (await store.getIntuneChatMessages(conversationId)).at(-1)!;
          assert.equal(reloaded.privatePrompt, true, send);
          assert.deepEqual(reloaded.followUps, message.followUps, send);
        });
      }
    });

    it("drops model follow-ups when workspace evidence, notes or instructions were attached", async () => {
      for (const send of ["sendIntuneChatMessage", "streamIntuneChatMessage"] as const) {
        for (const attached of ["evidence", "note", "instructions"] as const) {
          await withHarness(async ({ store, prompts, script }) => {
            const workspace = await store.createWorkspace({ title: "Support review", tenantId: tenant.id, ...(attached === "instructions" ? { instructions: "Support sits at 420 Cedar Avenue." } : {}) });
            const note = attached === "note" ? await store.addWorkspaceNote(workspace.id, "Support sits at 420 Cedar Avenue.") : undefined;
            const evidence = attached === "evidence"
              ? await store.pinWorkspaceEvidence({ workspaceId: workspace.id, tenantId: tenant.id, title: "Support desk", sourceType: "manual", content: { streetAddress: "420 Cedar Avenue" } })
              : undefined;
            script(docsReplies);
            const message = (await ask(store, send, {
              content: "How do I enroll macOS devices?",
              workspaceContext: { workspaceId: workspace.id, evidenceIds: evidence ? [evidence.id] : [], noteIds: note ? [note.id] : [], includeInstructions: attached === "instructions" },
            })).assistantMessage;
            const label = `${send} with ${attached}`;
            assert.equal(message.questionKind, "docs", label);
            assert.ok(prompts.some((entry) => /420 Cedar Avenue/.test(entry.prompt)), `${label}: the answering model read the workspace context`);
            assert.equal(message.privatePrompt, true, label);
            for (const text of message.followUps ?? []) assert.doesNotMatch(text, /420 Cedar|system extension/, label);
          });
        }
      }
    });

    it("keeps the model's follow-ups for a fresh docs question with no history or context", async () => {
      for (const send of ["sendIntuneChatMessage", "streamIntuneChatMessage"] as const) {
        await withHarness(async ({ store, script }) => {
          script([docsReplies[0], { final: true, answer: "Microsoft Learn describes macOS enrollment [1].", next: ["Explain the system extension profile"] }]);
          const result = await ask(store, send, { content: "How do I enroll macOS devices?" });
          const message = result.assistantMessage;
          assert.equal(message.questionKind, "docs", send);
          assert.equal(message.privatePrompt, undefined, send);
          assert.ok(message.followUps?.includes("Explain the system extension profile"), send);
          assert.equal((await store.getIntuneChatMessages(result.conversation.id)).at(-1)!.privatePrompt, undefined, send);
        });
      }
    });
  });

  describe("access blocks and docs questions", () => {
    const intuneOnly = requestedScopes(partIdsFor(["intune"])).map((scope) => qualifyScope(scope.name));
    const blocked = "Defender is not connected for this tenant. Add it in Connections.";
    const ask = (store: AppStateStore, send: "sendIntuneChatMessage" | "streamIntuneChatMessage", content: string) =>
      send === "sendIntuneChatMessage" ? store.sendIntuneChatMessage({ content }) : store.streamIntuneChatMessage({ content }, () => {});

    it("answers a Defender docs question from Microsoft Learn on an Intune-only tenant, and still blocks a Defender tenant question", async () => {
      for (const send of ["sendIntuneChatMessage", "streamIntuneChatMessage"] as const) {
        await withHarness(async ({ store, graphPaths, script }) => {
          script([
            { kind: "docs", sources: ["microsoft-learn"], tool: learnTool, params: { query: "Microsoft Sentinel incident grouping" } },
            { final: true, answer: "Microsoft Learn says Sentinel groups related alerts into incidents [1]." },
          ]);
          const docs = (await ask(store, send, "How does Microsoft Sentinel correlate alerts into incidents?")).assistantMessage;
          assert.equal(docs.questionKind, "docs", send);
          assert.match(docs.content, /^Microsoft Learn says Sentinel groups related alerts into incidents \[1\]\./, send);
          assert.doesNotMatch(docs.content, /not connected/, send);
          assert.deepEqual(graphPaths, [], send);

          script([{ kind: "tenant", sources: [], final: true, answer: "You have 3 open incidents." }]);
          const tenantAnswer = (await ask(store, send, "List our open security incidents")).assistantMessage;
          assert.equal(tenantAnswer.questionKind, "tenant", send);
          assert.equal(tenantAnswer.content, blocked, send);
          assert.equal(tenantAnswer.status, "completed", send);
          assert.equal(tenantAnswer.followUps, undefined, send);
          assert.deepEqual(graphPaths, [], send);
        }, { grantedScopes: intuneOnly });
      }
    });

    it("keeps the access line for a docs question when no documentation source is installed", async () => {
      await withHarness(async ({ store, prompts, script }) => {
        await store.uninstallMcpServer("microsoft-learn");
        await store.uninstallMcpServer("kql-search");
        script([{ kind: "docs", sources: [], final: true, answer: "Sentinel groups alerts." }]);
        const message = (await store.sendIntuneChatMessage({ content: "How does Microsoft Sentinel correlate alerts into incidents?" })).assistantMessage;
        assert.equal(message.content, blocked);
        assert.equal(prompts.length, 0, "no model call");
      }, { grantedScopes: intuneOnly });
    });
  });
});

describe("Graph cache status with no tenant (Muse round 5, A)", () => {
  it("reports an empty cache without an id when nothing is connected, and still refuses an unknown id", async () => {
    await withHarness(async ({ store }) => {
      assert.deepEqual(await store.getGraphCacheStatus(), { resources: [] });
      await assert.rejects(() => store.getGraphCacheStatus("00000000-0000-0000-0000-000000000000"));
    }, { noTenant: true });
  });
});

describe("Chat with no tenant connected (SPEC.md 4a, 2026-11-08)", () => {
  const DEVICE_QUESTION = "Which devices have not synced in 30 days?";
  const ask = (store: AppStateStore, send: "sendIntuneChatMessage" | "streamIntuneChatMessage", input: Parameters<AppStateStore["sendIntuneChatMessage"]>[0]) =>
    send === "sendIntuneChatMessage" ? store.sendIntuneChatMessage(input) : store.streamIntuneChatMessage(input, () => {});
  const noTenantConsent = (providerId = "anthropic", model = "claude-sonnet-5-5") => ({ noTenant: true as const, providerId: providerId as "anthropic", model, acknowledgedAt: new Date().toISOString() });

  it("answers a docs question from Microsoft Learn with no Graph call and no tenant on the conversation", async () => {
    for (const send of ["sendIntuneChatMessage", "streamIntuneChatMessage"] as const) {
      await withHarness(async ({ store, graphPaths, graphBuilds, prompts, script }) => {
        script([
          { kind: "docs", sources: ["microsoft-learn"], tool: learnTool, params: { query: "Defender for Endpoint on macOS" } },
          { final: true, answer: "Defender on macOS needs full disk access [1]." },
        ]);
        const result = await ask(store, send, { content: DOCS_QUESTION });
        assert.equal(result.assistantMessage.questionKind, "docs", send);
        assert.equal(result.assistantMessage.status, "completed", send);
        assert.match(result.assistantMessage.content, /full disk access/, send);
        assert.equal(result.assistantMessage.notConnected, undefined, send);
        // The model is told plainly that nothing is connected, so it classifies against that.
        assert.match(prompts[0]!.system, /No tenant is connected, so there is no tenant data to read\./, send);
        assert.match(prompts[0]!.system, /Tenant: none connected/, send);
        assert.doesNotMatch(prompts[0]!.system, /You can investigate read-only tenant data/, send);
        assert.equal(result.conversation.tenantId, undefined, send);
        assert.equal(result.cacheStatus.tenantId, undefined, send);
        assert.deepEqual(graphPaths, [], send);
        assert.deepEqual(graphBuilds, [], send);
        assert.deepEqual((await store.listIntuneChatConversations()).map((entry) => entry.id).includes(result.conversation.id), true, send);
      }, { noTenant: true });
    }
  });

  it("answers a docs question from the model alone when no reference or docs index is installed", async () => {
    await withHarness(async ({ store, graphBuilds, prompts, script }) => {
      await store.uninstallMcpServer("microsoft-learn");
      await store.uninstallMcpServer("kql-search");
      script([{ kind: "docs", sources: [], final: true, answer: "Autopatch rings are deployment groups that Microsoft manages." }]);
      const message = (await store.sendIntuneChatMessage({ content: "Explain Windows Autopatch rings" })).assistantMessage;
      assert.equal(message.questionKind, "docs");
      assert.match(message.content, /deployment groups/);
      assert.equal(message.notConnected, undefined);
      assert.ok(prompts.length > 0, "the model answered");
      assert.deepEqual(graphBuilds, []);
    }, { noTenant: true });
  });

  it("returns the not-connected result for a tenant question, keeps the question and reads nothing", async () => {
    for (const send of ["sendIntuneChatMessage", "streamIntuneChatMessage"] as const) {
      await withHarness(async ({ store, cache, graphPaths, graphBuilds, script }) => {
        script([{ kind: "tenant", sources: [], tool: "query_cache", params: { resource: "managedDevices" } }]);
        const result = await ask(store, send, { content: DEVICE_QUESTION });
        const message = result.assistantMessage;
        assert.equal(message.status, "completed", send);
        assert.deepEqual(message.notConnected, { reason: "no-tenant", partIds: ["intune.devices"] }, send);
        assert.match(message.content, /^This needs Intune\. Nothing is connected, so no tenant data was read\./, send);
        assert.equal(message.followUps, undefined, send);
        assert.deepEqual(graphPaths, [], send);
        assert.deepEqual(graphBuilds, [], send);
        // The cached rows of another tenant on this device are never read into the answer.
        assert.doesNotMatch(message.content, /MAC-0/, send);
        const stored = cache.listMessages(result.conversation.id);
        assert.equal(stored[0]?.role, "user", send);
        assert.equal(stored[0]?.content, DEVICE_QUESTION, send);
        assert.deepEqual(stored[1]?.notConnected, message.notConnected, send);
      }, { noTenant: true });
    }
  });

  it("returns the not-connected result for a mixed question and for a docs answer that calls a tenant tool", async () => {
    await withHarness(async ({ store, graphBuilds, script }) => {
      script([{ kind: "mixed", sources: ["microsoft-learn"], tool: learnTool, params: { query: "macOS compliance" } }]);
      const mixed = (await store.sendIntuneChatMessage({ content: MIXED_QUESTION })).assistantMessage;
      assert.equal(mixed.notConnected?.reason, "no-tenant");
      assert.ok(mixed.notConnected?.partIds.includes("intune.devices"));

      script([{ kind: "docs", sources: [], tool: "query_cache", params: { resource: "managedDevices" } }]);
      const upgraded = (await store.sendIntuneChatMessage({ content: "How does Intune report compliance?" })).assistantMessage;
      assert.equal(upgraded.questionKind, "mixed");
      assert.equal(upgraded.notConnected?.reason, "no-tenant");
      assert.deepEqual(graphBuilds, []);
    }, { noTenant: true });
  });

  it("keeps an explicit request to write a query as docs, and still blocks it when the model reaches for tenant data", async () => {
    await withHarness(async ({ store, prompts, graphBuilds, script }) => {
      script([{ final: true, answer: "SigninLogs | where ResultType != \"0\" | summarize count() by UserPrincipalName" }]);
      const docs = (await store.sendIntuneChatMessage({ content: KQL_QUESTION })).assistantMessage;
      assert.equal(docs.questionKind, "docs");
      assert.equal(docs.notConnected, undefined);
      assert.match(docs.content, /SigninLogs/);
      // The model was not asked to classify it.
      assert.doesNotMatch(prompts[0]!.system, /Your first reply must also give the question kind/);

      script([{ tool: "query_cache", params: { resource: "signIns" } }]);
      const upgraded = (await store.sendIntuneChatMessage({ content: KQL_QUESTION })).assistantMessage;
      assert.equal(upgraded.notConnected?.reason, "no-tenant");
      assert.deepEqual(graphBuilds, []);
    }, { noTenant: true });
  });

  it("treats a request to write code as docs even when it says our or which (review round 1, finding M)", async () => {
    await withHarness(async ({ store, graphBuilds, script }) => {
      for (const content of ["Write a KQL query for our failed sign-ins", "Write a script which shows stale devices"]) {
        script([{ final: true, answer: "Here is the code you can run yourself." }]);
        const message = (await store.sendIntuneChatMessage({ content })).assistantMessage;
        assert.equal(message.questionKind, "docs", content);
        assert.equal(message.notConnected, undefined, content);
      }
      assert.deepEqual(graphBuilds, []);
    }, { noTenant: true });
  });

  it("names the voice surface when Nova is used with no tenant (finding P)", async () => {
    await withHarness(async ({ store }) => {
      await assert.rejects(
        () => store.streamIntuneChatMessage({ content: "How many devices?" }, () => {}, { voice: true }),
        /Nova voice needs a connected tenant\. Connect a Microsoft 365 tenant, or ask in Chat, which answers without one\./,
      );
    }, { noTenant: true });
  });

  it("blocks a tenant question with no model call on deterministic retrieval, and answers a docs question there", async () => {
    await withHarness(async ({ store, prompts, graphBuilds, script }) => {
      await store.setChatInvestigationMode("always-deterministic");
      script(["Should not run."]);
      const message = (await store.sendIntuneChatMessage({ content: DEVICE_QUESTION })).assistantMessage;
      assert.equal(message.notConnected?.reason, "no-tenant");
      assert.deepEqual(message.notConnected?.partIds, ["intune.devices"]);
      assert.equal(prompts.length, 0);

      script(["A KQL query for failed sign-ins filters SigninLogs on a non-zero ResultType."]);
      const docs = (await store.sendIntuneChatMessage({ content: KQL_QUESTION })).assistantMessage;
      assert.equal(docs.questionKind, "docs");
      assert.equal(docs.notConnected, undefined);
      assert.match(docs.content, /SigninLogs/);
      // The Works now starters answer with nothing connected, also without the model's classification.
      for (const starter of FIRST_RUN_CHAT_COPY.worksNowStarters) {
        const answer = (await store.sendIntuneChatMessage({ content: starter })).assistantMessage;
        assert.equal(answer.questionKind, "docs", starter);
        assert.equal(answer.notConnected, undefined, starter);
      }
      assert.deepEqual(graphBuilds, []);
    }, { noTenant: true });
  });

  it("refuses to continue a tenant conversation while no tenant is connected", async () => {
    await withHarness(async ({ store, cache }) => {
      const now = new Date().toISOString();
      cache.createConversation({ id: "chat_tenant", title: "Contoso devices", tenantId: tenant.id, now });
      await assert.rejects(
        () => store.sendIntuneChatMessage({ content: DOCS_QUESTION, conversationId: "chat_tenant" }),
        /belongs to a tenant/,
      );
      cache.createConversation({ id: "chat_legacy", title: "Old devices", tenantId: null, now });
      cache.insertMessage({ id: "msg_legacy", conversationId: "chat_legacy", role: "assistant", content: "9 devices.", status: "completed", createdAt: now, tenantContext: true });
      await assert.rejects(
        () => store.sendIntuneChatMessage({ content: DOCS_QUESTION, conversationId: "chat_legacy" }),
        /used tenant data/,
      );
    }, { noTenant: true });
  });

  it("binds a conversation started without a tenant to the tenant it is continued in", async () => {
    await withHarness(async ({ store, cache, script }) => {
      const now = new Date().toISOString();
      cache.createConversation({ id: "chat_guest", title: "Devices not synced", tenantId: null, now });
      script([{ kind: "docs", sources: [], final: true, answer: "Devices sync every eight hours." }]);
      await store.sendIntuneChatMessage({ content: "How often do Intune devices sync?", conversationId: "chat_guest" });
      assert.equal(cache.getConversation("chat_guest")?.tenantId, tenant.id);
    });
  });

  it("returns the not-connected result with the tenant when the tenant has not connected the service", async () => {
    await withHarness(async ({ store, graphPaths, script }) => {
      script([{ kind: "tenant", sources: [], final: true, answer: "You have 3 open incidents." }]);
      const message = (await store.sendIntuneChatMessage({ content: "List our open security incidents" })).assistantMessage;
      assert.equal(message.content, "Defender is not connected for this tenant. Add it in Settings, Tenants.");
      assert.deepEqual(message.notConnected, { reason: "service-missing", partIds: ["defender.incidents"], tenantId: tenant.id });
      assert.deepEqual(graphPaths, []);
    }, { grantedScopes: requestedScopes(partIdsFor(["intune"])).map((scope) => qualifyScope(scope.name)) });
  });

  describe("hosted provider acknowledgement", () => {
    const hosted = { id: "anthropic", model: "claude-sonnet-5-5" };

    it("requires a fresh no-tenant acknowledgement and accepts it for a send without a tenant", async () => {
      await withHarness(async ({ store, prompts, graphBuilds, script }) => {
        script([{ kind: "docs", sources: [], final: true, answer: "Autopatch rings are deployment groups." }]);
        await assert.rejects(
          () => store.sendIntuneChatMessage({ content: "Explain Windows Autopatch rings" }),
          /Hosted provider confirmation is required before Chat can send your question/,
        );
        assert.equal(prompts.length, 0);
        await assert.rejects(
          () => store.sendIntuneChatMessage({ content: "Explain Windows Autopatch rings", hostedProviderConsent: { tenantId: tenant.id, providerId: "anthropic", acknowledgedAt: new Date().toISOString() } }),
          /names a tenant, and no tenant is connected/,
        );
        await assert.rejects(
          () => store.sendIntuneChatMessage({ content: "Explain Windows Autopatch rings", hostedProviderConsent: noTenantConsent("openai") }),
          /does not match the selected provider/,
        );
        // The confirmation names the model; a decision for another model, or none, is refused (Muse round 2, Q).
        await assert.rejects(
          () => store.sendIntuneChatMessage({ content: "Explain Windows Autopatch rings", hostedProviderConsent: noTenantConsent("anthropic", "claude-opus-5-5") }),
          /names a different model than the one selected/,
        );
        await assert.rejects(
          () => store.sendIntuneChatMessage({ content: "Explain Windows Autopatch rings", hostedProviderConsent: { noTenant: true, providerId: "anthropic", acknowledgedAt: new Date().toISOString() } }),
          /names a different model than the one selected/,
        );
        assert.equal(prompts.length, 0);
        const message = (await store.sendIntuneChatMessage({ content: "Explain Windows Autopatch rings", hostedProviderConsent: noTenantConsent() })).assistantMessage;
        assert.equal(message.status, "completed");
        assert.match(message.content, /deployment groups/);
        assert.deepEqual(graphBuilds, []);
      }, { noTenant: true, provider: hosted });
    });

    it("accepts a fresh no-tenant acknowledgement on the stream path too", async () => {
      await withHarness(async ({ store, graphBuilds, script }) => {
        script([{ kind: "docs", sources: [], final: true, answer: "Autopatch rings are deployment groups." }]);
        const message = (await store.streamIntuneChatMessage({ content: "Explain Windows Autopatch rings", hostedProviderConsent: noTenantConsent() }, () => {})).assistantMessage;
        assert.equal(message.status, "completed");
        assert.match(message.content, /deployment groups/);
        assert.deepEqual(graphBuilds, []);
      }, { noTenant: true, provider: hosted });
    });

    it("needs no confirmation for a question blocked on the device, and previews that (review round 1, finding 9)", async () => {
      await withHarness(async ({ store, prompts, script }) => {
        await store.setChatInvestigationMode("always-deterministic");
        script(["Should not run."]);
        assert.deepEqual(await store.previewIntuneChatSend({ content: DEVICE_QUESTION }), { reachesModel: false });
        assert.deepEqual(await store.previewIntuneChatSend({ content: KQL_QUESTION }), { reachesModel: true });
        const message = (await store.sendIntuneChatMessage({ content: DEVICE_QUESTION })).assistantMessage;
        assert.equal(message.notConnected?.reason, "no-tenant");
        assert.equal(prompts.length, 0);
        await assert.rejects(() => store.sendIntuneChatMessage({ content: KQL_QUESTION }), /Hosted provider confirmation is required/);
      }, { noTenant: true, provider: hosted });
    });

    it("uses one routing decision for preview and send, on both send paths (review round 2, item 1)", async () => {
      for (const send of ["sendIntuneChatMessage", "streamIntuneChatMessage"] as const) {
        await withHarness(async ({ store, prompts, script }) => {
          await store.setChatInvestigationMode("always-deterministic");
          script(["Autopatch rings are deployment groups."]);
          const question = "Explain Windows Autopatch rings";
          // The send answers this docs question with the model, so the preview must say so.
          assert.deepEqual(await store.previewIntuneChatSend({ content: question }), { reachesModel: true }, send);
          await assert.rejects(() => ask(store, send, { content: question }), /Hosted provider confirmation is required/, send);
          assert.equal(prompts.length, 0, send);
          const answered = (await ask(store, send, { content: question, hostedProviderConsent: noTenantConsent() })).assistantMessage;
          assert.equal(answered.status, "completed", send);
          assert.ok(prompts.length > 0, send);
        }, { noTenant: true, provider: hosted });
      }
    });

    it("asks for confirmation when the tool loop classifies a tenant question (round 2, item T)", async () => {
      await withHarness(async ({ store, prompts }) => {
        assert.deepEqual(await store.previewIntuneChatSend({ content: DEVICE_QUESTION }), { reachesModel: true });
        await assert.rejects(() => store.sendIntuneChatMessage({ content: DEVICE_QUESTION }), /Hosted provider confirmation is required/);
        assert.equal(prompts.length, 0);
      }, { noTenant: true, provider: hosted });
    });

    it("refuses a no-tenant acknowledgement for a send that includes tenant context", async () => {
      for (const send of ["sendIntuneChatMessage", "streamIntuneChatMessage"] as const) {
        await withHarness(async ({ store, prompts, graphBuilds, graphPaths, script }) => {
          script([{ kind: "tenant", sources: [], final: true, answer: "9 devices." }]);
          await assert.rejects(
            () => ask(store, send, { content: DEVICE_QUESTION, hostedProviderConsent: noTenantConsent() }),
            /covered a send without a tenant\. This send includes tenant context, so confirm it again/,
            send,
          );
          assert.equal(prompts.length, 0, send);
          assert.deepEqual(graphBuilds, [], send);
          assert.deepEqual(graphPaths, [], send);
          assert.equal((await store.listIntuneChatConversations()).length, 0, send);
          // A tenant confirmation that names another model is refused (Muse round 2, Q).
          await assert.rejects(
            () => ask(store, send, { content: DEVICE_QUESTION, hostedProviderConsent: { tenantId: tenant.id, providerId: "anthropic", model: "claude-opus-5-5", acknowledgedAt: new Date().toISOString() } }),
            /names a different model than the one selected/,
            send,
          );
          assert.equal(prompts.length, 0, send);
          // The tenant-bound confirmation still works for the same send.
          const message = (await ask(store, send, { content: DEVICE_QUESTION, hostedProviderConsent: { tenantId: tenant.id, providerId: "anthropic", model: "claude-sonnet-5-5", acknowledgedAt: new Date().toISOString() } })).assistantMessage;
          assert.equal(message.status, "completed", send);
        }, { provider: hosted });
      }
    });
  });
});

describe("hosted model gate (review round 2, item 1)", () => {
  it("refuses every model call until the confirmation is verified", async () => {
    const { gateHostedLlm } = await import("./service.js");
    let calls = 0;
    let verified = false;
    const gated = gateHostedLlm(
      { complete: async () => { calls += 1; return { text: "x", model: "m" }; }, stream: () => { calls += 1; return [] as never; } },
      () => { if (!verified) throw new Error("Hosted provider confirmation is required."); },
    );
    await assert.rejects(async () => gated.complete(), /confirmation is required/);
    assert.throws(() => gated.stream(), /confirmation is required/);
    assert.equal(calls, 0);
    verified = true;
    await gated.complete();
    assert.equal(calls, 1);
  });
});

describe("code requests with nothing connected (Muse round 2, item H)", () => {
  it("treats common request wording as a code request, and keeps run-against and tenant values out", async () => {
    const { isExplicitDocsRequest } = await import("./planner.js");
    for (const question of [
      "Write a KQL query for our failed sign-ins",
      "Can you write a KQL query for failed sign-ins?",
      "Could you draft a PowerShell script that lists stale devices",
      "Please write a script which shows stale devices",
      "Generate a KQL query for risky sign-ins",
      "Give me a PowerShell script to export compliance policies",
      "I need you to create a query for devices without BitLocker",
      "Help me write a Graph PowerShell script for app registrations",
    ]) {
      assert.equal(isExplicitDocsRequest(question), true, question);
    }
    for (const question of [
      "Write a KQL query and run it against our tenant",
      "Generate a script and execute it",
      "Write a script that retires HR-LAPTOP-07",
      "Which devices have not synced in 30 days?",
      "List our stale devices",
    ]) {
      assert.equal(isExplicitDocsRequest(question), false, question);
    }
  });
});
