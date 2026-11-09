import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mcpCatalogEntry } from "../mcp/catalog.js";
import { McpHost, McpHostError } from "../mcp/host.js";
import { articleText, SPLASHTOP_KB_HOST } from "./knowledge-base.js";

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function hostWith(route: (url: URL) => Response | Promise<Response>, options: { revoked?: () => "disabled" | "uninstalled" | undefined; callTimeoutMs?: number } = {}) {
  const requests: URL[] = [];
  const host = new McpHost({
    clientVersion: "test",
    ...(options.callTimeoutMs ? { callTimeoutMs: options.callTimeoutMs } : {}),
    fetch: async (url, init) => {
      const target = new URL(url);
      requests.push(target);
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return route(target);
    },
    revocation: () => options.revoked?.(),
  });
  return { host, requests };
}

const entry = mcpCatalogEntry("splashtop-kb")!;

const SEARCH = {
  count: 492,
  page: 1,
  page_count: 50,
  per_page: 10,
  results: [
    {
      id: 115000983226,
      title: "Remote Reboot and Restart Streamer",
      html_url: `https://${SPLASHTOP_KB_HOST}/hc/en-us/articles/115000983226-Remote-Reboot-Restart-Streamer`,
      snippet: "doing a safe mode <em>reboot</em>, the next <em>reboot</em> will be normal",
      locale: "en-us",
      updated_at: "2026-10-16T00:52:44Z",
    },
    { id: 1, title: "Phishing", html_url: "https://evil.example/hc/1", snippet: "x" },
  ],
};

describe("Splashtop Docs MCP (built-in reference)", () => {
  it("is a public, read-only catalog entry with the two tools, on Splashtop's Help Center host", () => {
    assert.ok(entry.builtin);
    assert.equal(new URL(entry.url).hostname, SPLASHTOP_KB_HOST);
    assert.equal(entry.auth, "none");
    assert.deepEqual(entry.tools, ["search_articles", "get_article"]);
    assert.deepEqual(entry.itemIds?.get_article, { params: ["id"], form: { kind: "number" } });
  });

  it("lists its tools without a network call", async () => {
    const { host, requests } = hostWith(() => json(500, {}));
    const connected = await host.connect(entry);
    assert.deepEqual(connected.tools.map((tool) => tool.name), ["search_articles", "get_article"]);
    assert.deepEqual(connected.missingTools, []);
    assert.equal(connected.serverName, "Splashtop Docs MCP");
    assert.equal(requests.length, 0);
  });

  it("searches articles and returns titles, Help Center links and plain excerpts", async () => {
    const { host, requests } = hostWith(() => json(200, SEARCH, { "x-rate-limit": "700" }));
    const result = await host.callTool(entry, "search_articles", { query: "reboot computer", page: 1 });
    assert.equal(requests[0]!.hostname, SPLASHTOP_KB_HOST);
    assert.equal(requests[0]!.pathname, "/api/v2/help_center/articles/search.json");
    assert.equal(requests[0]!.searchParams.get("query"), "reboot computer");
    assert.equal(requests[0]!.searchParams.get("per_page"), "10");
    const data = result.structured as { results: Array<{ id: number; title: string; url?: string; snippet?: string }>; has_more: boolean };
    assert.equal(data.results.length, 2);
    assert.equal(data.results[0]!.snippet, "doing a safe mode reboot, the next reboot will be normal");
    assert.match(data.results[0]!.url ?? "", /^https:\/\/support-splashtopbusiness\.splashtop\.com\/hc\//);
    // A link to another host is never passed on as a source.
    assert.equal(data.results[1]!.url, undefined);
    assert.equal(data.has_more, true);
  });

  it("reads one article as plain text, by id and locale", async () => {
    const { host, requests } = hostWith(() => json(200, {
      article: {
        id: 115000983226,
        title: "Remote Reboot",
        html_url: `https://${SPLASHTOP_KB_HOST}/hc/de/articles/115000983226`,
        locale: "de",
        body: "<h3>Supported</h3><ul><li>Enterprise</li></ul><p>Use &amp; restart<script>alert(1)</script></p>",
      },
    }));
    const result = await host.callTool(entry, "get_article", { id: 115000983226, locale: "de" });
    assert.equal(requests[0]!.pathname, "/api/v2/help_center/de/articles/115000983226.json");
    const data = result.structured as { body: string; title: string };
    assert.equal(data.title, "Remote Reboot");
    assert.equal(data.body, "Supported\n- Enterprise\n\nUse & restart");
  });

  it("refuses bad params before anything is sent", async () => {
    const { host, requests } = hostWith(() => json(200, SEARCH));
    for (const [tool, args] of [
      ["search_articles", { query: "" }],
      ["search_articles", { query: "x".repeat(201) }],
      ["search_articles", { query: "sos", page: 99 }],
      ["get_article", { id: "abc" }],
      ["get_article", { id: 1, locale: "../../x" }],
    ] as const) {
      await assert.rejects(host.callTool(entry, tool, args as Record<string, unknown>), (error: McpHostError) => error.sent === false && /Nothing was sent/.test(error.message));
    }
    assert.equal(requests.length, 0);
  });

  it("gives designed errors for 404, 429, 5xx, network failures, unreadable answers and timeouts", async () => {
    const cases: Array<[() => Response | Promise<Response>, RegExp]> = [
      [() => json(404, {}), /has no article 7 in en-us \(HTTP 404\)/],
      [() => json(429, {}, { "retry-after": "12" }), /limiting requests \(HTTP 429\)\. Wait 12 seconds/],
      [() => json(502, {}), /answered HTTP 502\. Retry later/],
      [() => { throw new TypeError("fetch failed"); }, /could not be reached at support-splashtopbusiness\.splashtop\.com/],
      [() => new Response("<html>", { status: 200 }), /could not read/],
    ];
    for (const [route, message] of cases) {
      const { host } = hostWith(route);
      await assert.rejects(host.callTool(entry, "get_article", { id: 7 }), message);
    }
    const slow = hostWith(() => new Promise<Response>(() => undefined), { callTimeoutMs: 30 });
    await assert.rejects(slow.host.callTool(entry, "search_articles", { query: "sos" }), /did not answer within 1 second/);
  });

  it("sends nothing once it is turned off", async () => {
    const { host, requests } = hostWith(() => json(200, SEARCH), { revoked: () => "disabled" });
    await assert.rejects(host.callTool(entry, "search_articles", { query: "sos" }), /turned off during this answer\. Nothing was sent/);
    assert.equal(requests.length, 0);
  });

  it("never follows a redirect to another host", async () => {
    const { host, requests } = hostWith((url) =>
      url.hostname === SPLASHTOP_KB_HOST ? new Response(null, { status: 302, headers: { location: "https://tracker.example/x" } }) : json(200, SEARCH));
    await assert.rejects(host.callTool(entry, "search_articles", { query: "sos" }), /does not follow redirects to another host/);
    assert.deepEqual(requests.map((url) => url.hostname), [SPLASHTOP_KB_HOST]);
  });

  it("turns article HTML into plain text", () => {
    assert.equal(articleText("<p>One&nbsp;two</p><p>&#x41;&#66;</p>"), "One two\nAB");
  });
});
