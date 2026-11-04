import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { IntuneChatStep, IntuneChatStreamEvent } from "@openadminos/agent-sdk";

import { AppStateStore } from "../state.js";
import { MCP_CATALOG } from "../mcp/catalog.js";
import type { IntelligenceSqliteStore } from "./sqlite-store.js";

/**
 * Drives Chat end to end through the app store: question planning, the
 * MCP client against an in-process server that stands in for Microsoft
 * Learn and KQL Search, the cache, the loop, persistence and reload.
 */
function buildServer(kind: "learn" | "kql"): McpServer {
  const server = new McpServer({ name: kind, version: "1.0.0" });
  if (kind === "learn") {
    server.registerTool("microsoft_docs_search", { description: "Search Microsoft documentation.", inputSchema: { query: z.string() } },
      async ({ query }) => ({ content: [{ type: "text", text: JSON.stringify({ results: [
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
  store: AppStateStore;
  cache: IntelligenceSqliteStore;
  graphPaths: string[];
  prompts: Array<{ system: string; prompt: string }>;
  script(replies: unknown[]): void;
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-steps-e2e-"));
  const statePath = join(dir, "state.json");
  await writeFile(statePath, JSON.stringify({
    activeProviderId: "ollama", providerChosenByUser: true, activeModelByProviderId: { ollama: "llama3.1:8b" },
    installedAgents: [], runs: [], tenants: [tenant], activeTenantId: tenant.id,
  }));
  const graphPaths: string[] = [];
  const prompts: Array<{ system: string; prompt: string }> = [];
  let replies: string[] = [];
  let reply = 0;
  const learn = MCP_CATALOG.find((entry) => entry.id === "microsoft-learn")!;
  const kql = MCP_CATALOG.find((entry) => entry.id === "kql-search")!;
  const store = new AppStateStore({
    filePath: statePath, userDataPath: dir, statsApiUrl: "",
    tokenStore: { read: async () => "", write: async () => undefined },
    mcpCatalog: [{ ...learn, url: `${baseUrl}/learn` }, { ...kql, url: `${baseUrl}/kql` }],
    graphFactory: () => ({
      listManagedDevices: async () => [],
      retireManagedDevice: async () => { throw new Error("no writes"); },
      request: async (request) => { graphPaths.push(request.path); return { value: [] }; },
    }),
    llmFactory: () => ({
      available: true, defaultModel: "llama3.1:8b",
      async complete(options) {
        prompts.push({ system: options.system ?? "", prompt: options.prompt });
        return { text: replies[Math.min(reply++, replies.length - 1)]!, model: "llama3.1:8b" };
      },
      async *stream() { yield { delta: "", accumulated: "", done: true, model: "llama3.1:8b" }; },
    }),
  });
  try {
    await store.installMcpServer("microsoft-learn");
    await store.installMcpServer("kql-search");
    const cache = (store as unknown as { requireIntelligenceStore(): IntelligenceSqliteStore }).requireIntelligenceStore();
    // A fresh device cache: 5 Macs, 2 of them noncompliant, and 4 Windows PCs.
    cache.replaceGraphResources({
      tenantId: tenant.id, resource: "managedDevices", label: "Managed devices", scopeSet: [], refreshedAt: new Date().toISOString(),
      rows: [
        ...Array.from({ length: 5 }, (_, i) => ({ id: `mac-${i}`, deviceName: `MAC-0${i}`, operatingSystem: "macOS", complianceState: i < 2 ? "noncompliant" : "compliant" })),
        ...Array.from({ length: 4 }, (_, i) => ({ id: `pc-${i}`, deviceName: `PC-0${i}`, operatingSystem: "Windows", complianceState: "compliant" })),
      ],
    });
    await run({
      store, cache, graphPaths, prompts,
      script(next) { replies = next.map((item) => JSON.stringify(item)); reply = 0; prompts.length = 0; graphPaths.length = 0; },
    });
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
}

const learnTool = "mcp__microsoft-learn__microsoft_docs_search";
const kqlTool = "mcp__kql-search__search_kql_queries";
const kinds = (steps: readonly IntuneChatStep[] | undefined) => (steps ?? []).map((step) => step.kind);

describe("Chat steps, sources and follow-ups end to end", () => {
  it("answers the Defender for macOS docs question from Microsoft Learn without touching the tenant", async () => {
    await withHarness(async ({ store, cache, graphPaths, prompts, script }) => {
      script([
        { tool: learnTool, params: { query: "Defender for Endpoint on macOS" } },
        { final: true, answer: "Microsoft Learn says Defender for Endpoint on macOS needs full disk access [1] and one of the three latest macOS releases [2]. [9]", next: ["Which Macs miss the system extension profile?"] },
      ]);
      const events: IntuneChatStreamEvent[] = [];
      const result = await store.streamIntuneChatMessage({ content: DOCS_QUESTION }, (event) => events.push(event));
      const message = result.assistantMessage;

      // Live steps: the plan first, the MCP row shows what it sent while it runs, then the answer.
      const snapshots = events.flatMap((event) => (event.type === "steps" ? [event.steps] : []));
      assert.equal(snapshots[0]![0]!.kind, "plan");
      assert.match(snapshots[0]![0]!.detail!, /^Documentation question\. Sources: Microsoft Learn\. Your tenant is not checked\.$/);
      const live = snapshots.find((list) => list.some((step) => step.kind === "mcp" && step.status === "active"));
      const liveMcp = live!.find((step) => step.kind === "mcp")!;
      assert.equal(liveMcp.sent, "Defender for Endpoint on macOS");
      assert.deepEqual([liveMcp.origin, liveMcp.originLabel], ["third-party", "127.0.0.1"]);
      assert.equal(live!.at(-1)!.kind, "answer", "the model step stays last while it runs");

      assert.equal(message.questionKind, "docs");
      assert.deepEqual(kinds(message.steps), ["plan", "mcp", "answer"]);
      const [, mcp, answer] = message.steps!;
      assert.deepEqual([mcp!.status, mcp!.title, mcp!.detail], ["completed", "Asked Microsoft Learn", "microsoft_docs_search · 2 results"]);
      assert.deepEqual([answer!.title, answer!.origin, answer!.originLabel], ["Wrote the answer", "device", "On device"]);
      assert.ok(message.steps!.every((step) => typeof step.durationMs === "number"));

      // No refresh, no tenant tools, and none offered to the model.
      assert.deepEqual(graphPaths, []);
      assert.equal(cache.listToolCalls(result.conversation.id).some((call) => call.type === "graph-cache-refresh"), false);
      assert.deepEqual(message.toolTrace?.map((entry) => entry.tool), [learnTool]);
      assert.doesNotMatch(prompts[0]!.system, /- query_cache:|- graph_get:|- refresh_resource:/);

      // Citations map to Learn articles; [9] has no source.
      assert.deepEqual(message.documentationSources?.map((source) => [source.citation, source.kind, source.serverName, source.url]), [
        [1, "mcp", "Microsoft Learn", "https://learn.microsoft.com/defender-endpoint/microsoft-defender-endpoint-mac"],
        [2, "mcp", "Microsoft Learn", "https://learn.microsoft.com/defender-endpoint/mac-requirements"],
      ]);
      assert.match(message.content, /^Microsoft Learn says/);
      assert.deepEqual(message.followUps, ["Check our 5 macOS devices for Defender in Intune", "Which Macs miss the system extension profile?"]);

      // A reload shows the same steps, sources and follow-ups.
      const reloaded = (await store.getIntuneChatMessages(result.conversation.id)).at(-1)!;
      assert.deepEqual(reloaded.steps, message.steps);
      assert.deepEqual(reloaded.documentationSources, message.documentationSources);
      assert.deepEqual(reloaded.followUps, message.followUps);
      assert.equal(reloaded.questionKind, "docs");
    });
  });

  it("calls KQL Search for a KQL question, even when the model tries to answer first", async () => {
    await withHarness(async ({ store, graphPaths, prompts, script }) => {
      script([
        { final: true, answer: "Use SigninLogs." },
        { tool: kqlTool, params: { query: "failed sign-ins last 24 hours" } },
        { final: true, answer: "Start from this community query [1]:\n\n```kql\nSigninLogs | where TimeGenerated > ago(24h) | where ResultType != 0\n```" },
      ]);
      const result = await store.sendIntuneChatMessage({ content: KQL_QUESTION });
      const message = result.assistantMessage;
      assert.equal(message.questionKind, "docs");
      assert.match(message.steps![0]!.detail!, /^Documentation question\. Sources: KQL Search\. Your tenant is not checked\.$/);
      assert.match(prompts[1]!.prompt, /Call KQL Search before answering/);
      assert.deepEqual(message.toolTrace?.map((entry) => entry.tool), [kqlTool]);
      assert.deepEqual(kinds(message.steps), ["plan", "mcp", "answer"]);
      assert.equal(message.steps![1]!.sent, "failed sign-ins last 24 hours");
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
      assert.deepEqual(message.followUps, ["Check our 5 macOS devices for Defender in Intune"]);
      assert.deepEqual(graphPaths, []);
    });
  });

  it("refreshes, asks Learn and still requires tenant evidence for a mixed tenant question", async () => {
    await withHarness(async ({ store, cache, graphPaths, prompts, script }) => {
      script([
        { tool: learnTool, params: { query: "Intune noncompliant macOS device remediation" } },
        { final: true, answer: "Microsoft Learn recommends checking the compliance policy [1]." },
        { tool: "query_cache", params: { resource: "managedDevices", where: { operatingSystem: "macOS", complianceState: "noncompliant" } } },
        { final: true, answer: "Microsoft Learn recommends reviewing the failed setting first [1].\n\n2 of your macOS devices are noncompliant.", next: ["Show the compliance policies assigned to these Macs"] },
      ]);
      const result = await store.sendIntuneChatMessage({ content: MIXED_QUESTION });
      const message = result.assistantMessage;
      assert.equal(message.questionKind, "mixed");
      assert.match(message.steps![0]!.detail!, /^Documentation and tenant question\. Sources: Microsoft Learn, and cached tenant data and Microsoft Graph\.$/);
      assert.deepEqual(kinds(message.steps), ["plan", "graph-refresh", "mcp", "tool", "answer"]);
      const refresh = message.steps![1]!;
      assert.deepEqual([refresh.origin, refresh.originLabel], ["graph", "Microsoft Graph"]);
      assert.ok(graphPaths.length > 0, "stale planned resources were refreshed from Graph");
      assert.equal(cache.listToolCalls(result.conversation.id).some((call) => call.type === "graph-cache-refresh"), true);
      const tool = message.steps![3]!;
      assert.deepEqual([tool.title, tool.origin, tool.originLabel], ["Queried cached data", "device", "On device"]);
      assert.match(tool.detail!, /^Intune managed devices · 2 of 2 cached rows returned$/);
      assert.ok(prompts.some((entry) => /That answer used no tenant evidence/.test(entry.prompt)));
      assert.match(message.content, /2 of your macOS devices are noncompliant/);
      assert.deepEqual(message.followUps, ["Show the compliance policies assigned to these Macs"]);
    });
  });
});
