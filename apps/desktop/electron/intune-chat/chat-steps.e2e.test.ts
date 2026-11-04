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

async function withHarness(run: (harness: Harness) => Promise<void>, options: { emptyCache?: boolean; graphError?: string; incremental?: boolean } = {}): Promise<void> {
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
    graphFactory: () => {
      if (options.graphError) throw new Error(options.graphError);
      return {
      listManagedDevices: async () => [],
      retireManagedDevice: async () => { throw new Error("no writes"); },
      request: async (request) => { graphPaths.push(request.path); return { value: [] }; },
      };
    },
    llmFactory: () => ({
      available: true, defaultModel: "llama3.1:8b",
      ...(options.incremental ? { streamsIncrementally: true } : {}),
      async complete(options) {
        prompts.push({ system: options.system ?? "", prompt: options.prompt });
        return { text: replies[Math.min(reply++, replies.length - 1)]!, model: "llama3.1:8b" };
      },
      async *stream(options) {
        prompts.push({ system: options.system ?? "", prompt: options.prompt });
        const text = replies[Math.min(reply++, replies.length - 1)]!;
        let accumulated = "";
        for (const delta of text.split(/(?<= )/)) {
          accumulated += delta;
          yield { delta, accumulated, done: false, model: "llama3.1:8b" };
        }
        yield { delta: "", accumulated, done: true, model: "llama3.1:8b" };
      },
    }),
  });
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
      store, cache, graphPaths, prompts,
      script(next) { replies = next.map((item) => (typeof item === "string" ? item : JSON.stringify(item))); reply = 0; prompts.length = 0; graphPaths.length = 0; },
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
        { kind: "docs", sources: ["microsoft-learn"], tool: learnTool, params: { query: "Defender for Endpoint on macOS" } },
        { final: true, answer: "Microsoft Learn says Defender for Endpoint on macOS needs full disk access [1] and one of the three latest macOS releases [2]. [9]", next: ["Which Macs miss the system extension profile?"] },
      ]);
      const events: IntuneChatStreamEvent[] = [];
      const result = await store.streamIntuneChatMessage({ content: DOCS_QUESTION }, (event) => events.push(event));
      const message = result.assistantMessage;

      // Live steps: the plan first, the MCP row shows what it sent while it runs, then the answer.
      const snapshots = events.flatMap((event) => (event.type === "steps" ? [event.steps] : []));
      // The plan step shows before the MCP tools load, then gets the model's kind and sources from its first reply.
      assert.deepEqual([snapshots[0]![0]!.kind, snapshots[0]![0]!.status, snapshots[0]![0]!.title], ["plan", "active", "Reading the question"]);
      const decided = snapshots.findIndex((list) => list[0]!.status === "completed");
      assert.ok(decided > snapshots.findIndex((list) => list.some((step) => step.kind === "answer")), "the kind is decided once the model replies");
      assert.equal(snapshots[decided]![0]!.title, "Read the question");
      assert.match(snapshots[decided]![0]!.detail!, /^Documentation question\. Sources: Microsoft Learn\. Your tenant is not checked\.$/);
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
      assert.deepEqual(message.followUps, ["Check our 5 macOS devices for Defender in Intune", "Which Macs miss the system extension profile?"]);

      // A reload shows the same steps, sources and follow-ups.
      const reloaded = (await store.getIntuneChatMessages(result.conversation.id)).at(-1)!;
      assert.deepEqual(reloaded.steps, message.steps);
      assert.deepEqual(reloaded.documentationSources, message.documentationSources);
      assert.deepEqual(reloaded.followUps, message.followUps);
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
    }, { incremental: true });
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
    });
  });

  it("falls back to the keyword kind when the model gives none, and never treats an ambiguous tenant question as docs-only", async () => {
    await withHarness(async ({ store, prompts, script }) => {
      // A missing kind gets one repair; an invalid one counts as missing, then the keyword kind decides.
      script([{ final: true, answer: "There are none." }, { kind: "documentation", final: true, answer: "There are none." }, { tool: "query_cache", params: { resource: "managedDevices", where: { complianceState: "noncompliant" } } }, { final: true, answer: "2 devices are noncompliant." }]);
      const message = (await store.sendIntuneChatMessage({ content: "What are the noncompliant devices?" })).assistantMessage;
      assert.equal(message.questionKind, "mixed");
      assert.match(prompts[1]!.prompt, /That reply did not give the question kind/);
      assert.match(message.steps![0]!.detail!, /^Documentation and tenant question\. .* The model gave no question kind, so keyword rules decided\.$/);
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
        assert.match(message.steps![0]!.detail!, /^Documentation question\. Sources: Microsoft Learn\. Your tenant is not checked\.$/, question);
        assert.deepEqual(kinds(message.steps), ["plan", "mcp", "answer"], question);
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
      assert.match(message.steps![0]!.detail!, /^Treated as docs and tenant: the question mentions your tenant\. Sources: /);
      assert.deepEqual(kinds(message.steps), ["plan", "graph-refresh", "mcp", "tool", "answer"]);
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
      assert.match(message.steps![0]!.detail!, /^Tenant question\. Sources: cached tenant data and Microsoft Graph\.$/);
      assert.deepEqual(kinds(message.steps), ["plan", "graph-refresh", "tool", "answer"]);
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
      assert.deepEqual(kinds(message.steps), ["plan", "mcp", "plan", "graph-refresh", "tool", "answer"]);
      const upgrade = message.steps![2]!;
      assert.deepEqual([upgrade.title, upgrade.detail], ["Treated as docs and tenant", "The model asked for tenant data, so the answer now needs tenant evidence."]);
      assert.equal(message.steps![4]!.status, "completed");
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
      assert.match(followUp.steps![0]!.detail!, /^Treated as docs and tenant: earlier answers in this chat used your tenant data\. Sources: /);
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
        assert.deepEqual(kinds(message.steps), ["plan", "graph-refresh", "tool", "answer"], send);
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
