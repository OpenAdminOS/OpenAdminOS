import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { MCP_CATALOG, mcpHost } from "./catalog.js";
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

before(async () => {
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
