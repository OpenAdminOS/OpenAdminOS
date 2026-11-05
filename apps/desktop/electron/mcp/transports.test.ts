import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { McpHost, McpHostError, type McpEndpoint } from "./host.js";

/**
 * Replies captured from the three second-wave servers on 2026-11-05,
 * trimmed. Each server answers in a different shape: Release
 * Communications sends SSE without a session id, endoflife.ai sends plain
 * JSON, and WindowsForum sends SSE with log notifications before the
 * result. The replay below serves those shapes; the session variant also
 * issues and requires a session id.
 */
interface SecondWaveFixture {
  probedAt: string;
  transport: string;
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
  calls: Record<string, Record<string, unknown>>;
}

const SECOND_WAVE = JSON.parse(readFileSync(new URL("./fixtures/second-wave-servers.json", import.meta.url), "utf8")) as Record<
  "release-communications" | "windowsforum" | "endoflife-ai",
  SecondWaveFixture
>;

type Shape = "sse" | "json" | "sse-session";

interface Replay {
  url: string;
  /** Session ids the server saw on requests after initialize. */
  sessionHeaders: Array<string | undefined>;
  calls: Array<{ name: string; arguments: unknown }>;
  close(): Promise<void>;
}

/** Serves one fixture in the reply shape its live server used. */
async function replayServer(fixture: SecondWaveFixture, shape: Shape, answer?: (name: string, args: Record<string, unknown>) => Record<string, unknown> | undefined): Promise<Replay> {
  const sessionId = "replay-session-1";
  const sessionHeaders: Array<string | undefined> = [];
  const calls: Replay["calls"] = [];
  const send = (response: ServerResponse, messages: unknown[], extraHeaders: Record<string, string> = {}) => {
    if (shape === "json") {
      response.writeHead(200, { "content-type": "application/json", ...extraHeaders }).end(JSON.stringify(messages.at(-1)));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", ...extraHeaders });
    response.end(messages.map((message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`).join(""));
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      if (message.method !== "initialize") {
        const header = request.headers["mcp-session-id"];
        sessionHeaders.push(typeof header === "string" ? header : undefined);
        if (shape === "sse-session" && header !== sessionId) { response.writeHead(400).end("Missing session"); return; }
      }
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      const reply = (result: unknown, logs: string[] = []) => [
        ...(shape === "json" ? [] : logs.map((msg) => ({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: { msg, extra: null } } }))),
        { jsonrpc: "2.0", id: message.id, result },
      ];
      if (message.method === "initialize") {
        send(response, reply({ protocolVersion: "2025-06-18", capabilities: { logging: {}, tools: {} }, serverInfo: { name: "replay", version: "1.0.0" } }),
          shape === "sse-session" ? { "mcp-session-id": sessionId } : {});
        return;
      }
      if (message.method === "tools/list") { send(response, reply({ tools: fixture.tools })); return; }
      if (message.method === "tools/call") {
        const name = message.params?.name ?? "";
        calls.push({ name, arguments: message.params?.arguments });
        const result = answer?.(name, message.params?.arguments ?? {}) ?? fixture.calls[name];
        if (!result) { send(response, [{ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `Unknown tool: ${name}` } }]); return; }
        send(response, reply(result, [`Running ${name}`, "Done"]));
        return;
      }
      send(response, [{ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }]);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    sessionHeaders,
    calls,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

describe("MCP transports seen on second-wave servers", () => {
  it("works with SSE replies that carry no session id (Release Communications)", async () => {
    const fixture = SECOND_WAVE["release-communications"];
    const replay = await replayServer(fixture, "sse", (_name, args) => (args.id === "1" ? fixture.calls.unknown_id : undefined));
    const host = new McpHost({ clientVersion: "test" });
    const endpoint: McpEndpoint = { id: "rc", name: "Release Communications", url: replay.url, tools: fixture.tools.map((tool) => tool.name) };
    try {
      const connected = await host.connect(endpoint);
      assert.deepEqual(connected.tools.map((tool) => tool.name).sort(), ["get_azure_update_by_id", "get_m365_roadmap_by_id", "get_recent_azure_updates", "get_recent_m365_roadmaps"]);
      assert.deepEqual(connected.missingTools, []);
      // The OData guidance makes the list schemas too large; names and types are kept.
      const recent = connected.tools.find((tool) => tool.name === "get_recent_m365_roadmaps")!;
      assert.equal(recent.unavailable, undefined);
      assert.deepEqual(Object.keys((recent.inputSchema as { properties: object }).properties), ["filter", "search", "skip", "include_facets"]);
      const listed = await host.callTool(endpoint, "get_recent_m365_roadmaps", { search: "Intune" });
      assert.equal((listed.structured as { items: unknown[] }).items.length, 3);
      const byId = await host.callTool(endpoint, "get_m365_roadmap_by_id", { id: "109560" });
      assert.equal((byId.structured as { id: number }).id, 109560);
      // An unknown ID answers with no content at all.
      const unknown = await host.callTool(endpoint, "get_azure_update_by_id", { id: "1" });
      assert.deepEqual([unknown.text, unknown.structured], ["", undefined]);
      assert.ok(replay.sessionHeaders.every((header) => header === undefined));
    } finally { await host.closeAll(); await replay.close(); }
  });

  it("works with plain JSON replies (endoflife.ai)", async () => {
    const fixture = SECOND_WAVE["endoflife-ai"];
    const replay = await replayServer(fixture, "json", (_name, args) => (args.product === "nothing" ? fixture.calls.unknown_product : undefined));
    const host = new McpHost({ clientVersion: "test" });
    const allowed = fixture.tools.map((tool) => tool.name).filter((name) => name !== "scan_stack" && name !== "check_sbom");
    const endpoint: McpEndpoint = { id: "eol", name: "endoflife.ai", url: replay.url, tools: allowed };
    try {
      const connected = await host.connect(endpoint);
      assert.deepEqual(connected.tools.map((tool) => tool.name), allowed);
      assert.ok(!connected.tools.some((tool) => tool.name === "scan_stack" || tool.name === "check_sbom"));
      const checked = await host.callTool(endpoint, "check_eol", { product: "windows-server", version: "2016" });
      assert.equal((checked.structured as { eol_date: string }).eol_date, "2027-01-12");
      // The server answers an unknown product with isError and its own hint.
      await assert.rejects(host.callTool(endpoint, "get_risk_score", { product: "nothing" }), (error: unknown) => error instanceof McpHostError && error.code === "tool-error" && /No data for/.test(error.message));
      await assert.rejects(host.callTool(endpoint, "check_sbom", { sbom: "{}" }), (error: unknown) => error instanceof McpHostError && error.sent === false);
      assert.equal(replay.calls.filter((call) => call.name === "check_sbom").length, 0);
    } finally { await host.closeAll(); await replay.close(); }
  });

  it("works with SSE replies with a session and log notifications before the result (WindowsForum)", async () => {
    const fixture = SECOND_WAVE.windowsforum;
    const replay = await replayServer(fixture, "sse-session");
    const host = new McpHost({ clientVersion: "test" });
    const endpoint: McpEndpoint = { id: "wf", name: "WindowsForum", url: replay.url, tools: ["search_kb", "get_kb_article"] };
    try {
      const connected = await host.connect(endpoint);
      assert.deepEqual(connected.tools.map((tool) => tool.name), ["get_kb_article", "search_kb"]);
      assert.deepEqual(connected.missingTools, []);
      const searched = await host.callTool(endpoint, "search_kb", { query: "Windows 11 24H2 cumulative update", limit: 3 });
      assert.equal((searched.structured as { results: unknown[] }).results.length, 3);
      const article = await host.callTool(endpoint, "get_kb_article", { kb_id: "KB5058919" });
      assert.match((article.structured as { title: string }).title, /KB5058919/);
      // Member lookups are listed by the server but never offered or called.
      await assert.rejects(host.callTool(endpoint, "get_user", { user_id: 1 }), (error: unknown) => error instanceof McpHostError && error.sent === false);
      assert.ok(replay.sessionHeaders.length > 0);
      assert.ok(replay.sessionHeaders.every((header) => header === "replay-session-1"));
      assert.deepEqual(replay.calls.map((call) => call.name), ["search_kb", "get_kb_article"]);
    } finally { await host.closeAll(); await replay.close(); }
  });
});
