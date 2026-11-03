import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { AppStateStore } from "../state.js";
import { MCP_CATALOG, mcpHost, type McpCatalogEntry } from "./catalog.js";
import { McpHost, McpHostError, type McpEndpoint } from "./host.js";

/** A stateless in-process MCP server with tools that exercise each host path. */
function buildServer(): McpServer {
  const server = new McpServer({ name: "test-docs", version: "1.2.3" });
  server.registerTool("search_docs", { description: "Search   test\ndocs.", inputSchema: { query: z.string() } },
    async ({ query }) => ({ content: [{ type: "text", text: `Result for ${query}` }] }));
  server.registerTool("slow", { description: "Sleeps.", inputSchema: {} },
    async () => { await new Promise((resolve) => setTimeout(resolve, 400)); return { content: [{ type: "text", text: "late" }] }; });
  server.registerTool("fails", { description: "Fails.", inputSchema: {} },
    async () => ({ isError: true, content: [{ type: "text", text: "Index unavailable" }] }));
  server.registerTool("big", { description: "Large output.", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "x".repeat(5_000) }] }));
  // The SDK warns about the invalid name it is asked to register; the host must drop it.
  const warn = console.warn;
  console.warn = () => {};
  try {
    server.registerTool("bad name!", { description: "Invalid name.", inputSchema: {} }, async () => ({ content: [] }));
  } finally { console.warn = warn; }
  return server;
}

let httpServer: Server;
let endpoint: McpEndpoint;
const originalOllamaUrl = process.env.OPENAGENTS_OLLAMA_URL;

before(async () => {
  // Provider detection must not reach a real local Ollama.
  process.env.OPENAGENTS_OLLAMA_URL = "http://127.0.0.1:9";
  httpServer = createServer((request, response) => {
    void (async () => {
      const server = buildServer();
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
  const { port } = httpServer.address() as AddressInfo;
  endpoint = { id: "test-docs", name: "Test Docs", url: `http://127.0.0.1:${port}/mcp` };
});

after(async () => {
  if (originalOllamaUrl === undefined) delete process.env.OPENAGENTS_OLLAMA_URL;
  else process.env.OPENAGENTS_OLLAMA_URL = originalOllamaUrl;
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe("MCP host", () => {
  it("connects and lists sanitized tools live", async () => {
    const host = new McpHost({ clientVersion: "test" });
    try {
      const connected = await host.connect(endpoint);
      assert.equal(connected.serverName, "test-docs");
      assert.equal(connected.serverVersion, "1.2.3");
      const names = connected.tools.map((tool) => tool.name);
      assert.deepEqual(names, ["search_docs", "slow", "fails", "big"]);
      assert.equal(connected.tools[0]!.description, "Search test docs.");
      assert.equal((connected.tools[0]!.inputSchema as { type?: string }).type, "object");
    } finally { await host.closeAll(); }
  });

  it("calls a tool and returns its text", async () => {
    const host = new McpHost({ clientVersion: "test" });
    try {
      const result = await host.callTool(endpoint, "search_docs", { query: "grace period" });
      assert.deepEqual(result, { text: "Result for grace period", truncated: false });
    } finally { await host.closeAll(); }
  });

  it("rejects a tool the server did not list", async () => {
    const host = new McpHost({ clientVersion: "test" });
    try {
      await assert.rejects(host.callTool(endpoint, "delete_everything", {}),
        (error: unknown) => error instanceof McpHostError && error.code === "unknown-tool");
    } finally { await host.closeAll(); }
  });

  it("times out a slow tool with a designed message", async () => {
    const host = new McpHost({ clientVersion: "test", callTimeoutMs: 100 });
    try {
      await assert.rejects(host.callTool(endpoint, "slow", {}), (error: unknown) =>
        error instanceof McpHostError && error.code === "timeout" && /did not answer within/.test(error.message));
    } finally { await host.closeAll(); }
  });

  it("surfaces a tool error from the server", async () => {
    const host = new McpHost({ clientVersion: "test" });
    try {
      await assert.rejects(host.callTool(endpoint, "fails", {}), (error: unknown) =>
        error instanceof McpHostError && error.code === "tool-error" && /Index unavailable/.test(error.message));
    } finally { await host.closeAll(); }
  });

  it("caps tool output", async () => {
    const host = new McpHost({ clientVersion: "test", maxOutputChars: 1_000 });
    try {
      const result = await host.callTool(endpoint, "big", {});
      assert.equal(result.text.length, 1_000);
      assert.equal(result.truncated, true);
    } finally { await host.closeAll(); }
  });

  it("cuts off a response larger than the byte limit", async () => {
    const host = new McpHost({ clientVersion: "test", maxResponseBytes: 2_000 });
    try {
      await assert.rejects(host.callTool(endpoint, "big", {}), McpHostError);
    } finally { await host.closeAll(); }
  });

  it("reports an unreachable server with the host name", async () => {
    const host = new McpHost({ clientVersion: "test", connectTimeoutMs: 2_000 });
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    try {
      await assert.rejects(host.connect({ id: "gone", name: "Gone", url: `http://127.0.0.1:${port}/mcp` }), (error: unknown) =>
        error instanceof McpHostError && error.code === "unreachable" && /Gone could not be reached at 127\.0\.0\.1/.test(error.message));
    } finally { await host.closeAll(); }
  });

  it("reports an HTTP error status", async () => {
    const failing = createServer((_request, response) => { response.writeHead(503).end(); });
    await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve));
    const { port } = failing.address() as AddressInfo;
    const host = new McpHost({ clientVersion: "test" });
    try {
      await assert.rejects(host.connect({ id: "down", name: "Down", url: `http://127.0.0.1:${port}/mcp` }), (error: unknown) =>
        error instanceof McpHostError && error.code === "server-error" && /HTTP 503/.test(error.message));
    } finally {
      await host.closeAll();
      await new Promise<void>((resolve) => failing.close(() => resolve()));
    }
  });
});

describe("MCP catalog", () => {
  it("lists three public read-only servers over HTTPS without sign-in", () => {
    assert.deepEqual(MCP_CATALOG.map((entry) => mcpHost(entry.url)), [
      "learn.microsoft.com",
      "www.kqlsearch.com",
      "www.intuneautomation.com",
    ]);
    for (const entry of MCP_CATALOG) {
      assert.equal(new URL(entry.url).protocol, "https:");
      assert.equal(entry.auth, "none");
      assert.equal(entry.readOnly, true);
      assert.match(entry.id, /^[a-z0-9-]+$/);
    }
  });
});

describe("MCP installs in app state", () => {
  async function withStore(run: (store: AppStateStore, statePath: string, catalog: McpCatalogEntry[]) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-mcp-state-"));
    const statePath = join(dir, "state.json");
    const catalog: McpCatalogEntry[] = [
      { ...MCP_CATALOG[0]!, id: "test-docs", name: "Test Docs", url: endpoint.url },
      { ...MCP_CATALOG[1]!, id: "gone", name: "Gone", url: "http://127.0.0.1:9/mcp" },
    ];
    const store = new AppStateStore({ filePath: statePath, tokenStore: { read: async () => "", write: async () => undefined }, statsApiUrl: "", mcpCatalog: catalog });
    try { await run(store, statePath, catalog); } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
  }
  const persisted = async (statePath: string) => JSON.parse(await readFile(statePath, "utf8")).mcpServers;

  it("installs, disables, enables and uninstalls a server in state.json", async () => {
    await withStore(async (store, statePath) => {
      const installed = await store.installMcpServer("test-docs");
      const summary = installed.find((entry) => entry.id === "test-docs")!;
      assert.equal(summary.installed, true);
      assert.equal(summary.enabled, true);
      assert.equal(summary.host, "127.0.0.1");
      assert.deepEqual(summary.tools.map((tool) => tool.name), ["search_docs", "slow", "fails", "big"]);
      assert.equal((await persisted(statePath))["test-docs"].tools[0].name, "search_docs");

      const disabled = await store.setMcpServerEnabled("test-docs", false);
      assert.equal(disabled.find((entry) => entry.id === "test-docs")!.enabled, false);
      assert.equal((await persisted(statePath))["test-docs"].enabled, false);
      await store.setMcpServerEnabled("test-docs", true);

      const checked = await store.checkMcpServer("test-docs");
      assert.equal(checked.find((entry) => entry.id === "test-docs")!.enabled, true);

      const removed = await store.uninstallMcpServer("test-docs");
      assert.equal(removed.find((entry) => entry.id === "test-docs")!.installed, false);
      assert.equal(await persisted(statePath), undefined);
    });
  });

  it("records nothing when the server is unreachable", async () => {
    await withStore(async (store, statePath) => {
      await assert.rejects(store.installMcpServer("gone"), /Gone could not be reached at 127\.0\.0\.1/);
      const servers = await store.listMcpServers();
      assert.equal(servers.find((entry) => entry.id === "gone")!.installed, false);
      await readFile(statePath, "utf8").then((raw) => assert.equal(JSON.parse(raw).mcpServers, undefined), () => undefined);
    });
  });

  it("answers a Chat question through an installed server and traces its host", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-mcp-chat-e2e-"));
    const statePath = join(dir, "state.json");
    const tenant = { id: "tenant-1", displayName: "Contoso", username: "admin@contoso.example", homeAccountId: "home-1", addedAt: "2026-06-01T10:00:00.000Z" };
    await writeFile(statePath, JSON.stringify({
      activeProviderId: "ollama", providerChosenByUser: true, activeModelByProviderId: { ollama: "llama3.1:8b" },
      installedAgents: [], runs: [], tenants: [tenant], activeTenantId: tenant.id,
    }));
    const prompts: string[] = [];
    const replies = [
      JSON.stringify({ tool: "mcp__test-docs__search_docs", params: { query: "Intune compliance grace period" } }),
      JSON.stringify({ final: true, answer: "The grace period is set per noncompliance action." }),
    ];
    const store = new AppStateStore({
      filePath: statePath, userDataPath: dir, statsApiUrl: "",
      tokenStore: { read: async () => "", write: async () => undefined },
      mcpCatalog: [{ ...MCP_CATALOG[0]!, id: "test-docs", name: "Test Docs", url: endpoint.url }],
      graphFactory: () => ({ listManagedDevices: async () => [], retireManagedDevice: async () => { throw new Error("no writes"); }, request: async () => ({ value: [] }) }),
      llmFactory: () => ({
        available: true, defaultModel: "llama3.1:8b",
        async complete(options) { prompts.push(options.prompt); return { text: replies[Math.min(prompts.length - 1, replies.length - 1)]!, model: "llama3.1:8b" }; },
        async *stream() { yield { delta: "", accumulated: "", done: true, model: "llama3.1:8b" }; },
      }),
    });
    try {
      await store.installMcpServer("test-docs");
      const result = await store.sendIntuneChatMessage({ content: "How long is the Intune compliance grace period?" });
      assert.equal(result.assistantMessage.content, "The grace period is set per noncompliance action.");
      const trace = result.assistantMessage.toolTrace?.find((entry) => entry.mcpSource);
      assert.equal(trace?.mcpSource?.host, "127.0.0.1");
      assert.match(trace!.resultSummary, /Test Docs answered from 127\.0\.0\.1/);
      assert.ok(prompts.some((prompt) => /Result for Intune compliance grace period/.test(prompt)));

      // A disabled server offers nothing to Chat.
      await store.setMcpServerEnabled("test-docs", false);
      prompts.length = 0;
      const disabled = await store.sendIntuneChatMessage({ content: "How long is the Intune compliance grace period?" });
      assert.equal(disabled.assistantMessage.toolTrace?.some((entry) => entry.mcpSource) ?? false, false);
    } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects servers outside the catalog and toggles on servers that are not installed", async () => {
    await withStore(async (store) => {
      await assert.rejects(store.installMcpServer("evil"), /not in the Marketplace catalog/);
      await assert.rejects(store.setMcpServerEnabled("test-docs", true), /Test Docs is not installed/);
      await assert.rejects(store.checkMcpServer("test-docs"), /Test Docs is not installed/);
    });
  });
});
