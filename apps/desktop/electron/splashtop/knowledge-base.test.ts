import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { namedServers, planChatSources } from "../intune-chat/chat-steps.js";
import { mcpChatServerOf, type McpChatServer } from "../intune-chat/tools.js";
import { MCP_CATALOG, mcpCatalogEntry } from "../mcp/catalog.js";
import { McpHost, McpHostError } from "../mcp/host.js";
import { articleText, SPLASHTOP_KB_HOST, SPLASHTOP_PACKR_KB_HOST } from "./knowledge-base.js";

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

describe("Splashtop Agentic Packr Docs MCP (built-in reference)", () => {
  const packr = mcpCatalogEntry("splashtop-packr-kb")!;

  it("is a public, read-only catalog entry with the two tools, on the Agentic Packr Help Center host", async () => {
    assert.ok(packr.builtin);
    assert.equal(packr.name, "Splashtop Agentic Packr Docs MCP");
    assert.equal(packr.publisher, "Splashtop");
    assert.equal(new URL(packr.url).hostname, SPLASHTOP_PACKR_KB_HOST);
    assert.equal(packr.auth, "none");
    assert.deepEqual(packr.tools, ["search_articles", "get_article"]);
    assert.deepEqual(packr.itemIds?.get_article, { params: ["id"], form: { kind: "number" } });
    const { host, requests } = hostWith(() => json(500, {}));
    const connected = await host.connect(packr);
    assert.equal(connected.serverName, "Splashtop Agentic Packr Docs MCP");
    assert.deepEqual(connected.tools.map((tool) => tool.name), ["search_articles", "get_article"]);
    assert.equal(requests.length, 0);
  });

  it("searches and reads only on its own Help Center host", async () => {
    const { host, requests } = hostWith((url) => url.pathname.endsWith("/search.json")
      ? json(200, {
        count: 2,
        page: 1,
        page_count: 1,
        results: [
          { id: 57274342939291, title: "Create an Intune Deployment Template", html_url: `https://${SPLASHTOP_PACKR_KB_HOST}/hc/en-us/articles/57274342939291`, snippet: "a <em>template</em>" },
          // A Business Help Center link is another host for this listing, so it is not passed on.
          { id: 2, title: "Elsewhere", html_url: `https://${SPLASHTOP_KB_HOST}/hc/en-us/articles/2` },
        ],
      })
      : json(200, { article: { id: 57274342939291, title: "Create an Intune Deployment Template", html_url: `https://${SPLASHTOP_PACKR_KB_HOST}/hc/en-us/articles/57274342939291`, body: "<p>Open Templates</p>" } }));
    const search = await host.callTool(packr, "search_articles", { query: "deployment template" });
    const results = (search.structured as { results: Array<{ id: number; url?: string }> }).results;
    assert.match(results[0]!.url ?? "", /^https:\/\/support-splashtopagenticpackr\.splashtop\.com\/hc\//);
    assert.equal(results[1]!.url, undefined);
    const article = await host.callTool(packr, "get_article", { id: results[0]!.id });
    assert.equal((article.structured as { body: string }).body, "Open Templates");
    assert.deepEqual(requests.map((url) => `${url.hostname}${url.pathname}`), [
      `${SPLASHTOP_PACKR_KB_HOST}/api/v2/help_center/articles/search.json`,
      `${SPLASHTOP_PACKR_KB_HOST}/api/v2/help_center/en-us/articles/57274342939291.json`,
    ]);
  });

  it("names itself and its host in its errors", async () => {
    const down = hostWith(() => { throw new TypeError("fetch failed"); });
    await assert.rejects(down.host.callTool(packr, "search_articles", { query: "sso" }), /Splashtop Agentic Packr Docs MCP could not be reached at support-splashtopagenticpackr\.splashtop\.com/);
    const missing = hostWith(() => json(404, {}));
    await assert.rejects(missing.host.callTool(packr, "get_article", { id: 7 }), /Splashtop Agentic Packr Docs MCP has no article 7 in en-us \(HTTP 404\)/);
  });

  it("shows the Splashtop logo, like Splashtop Docs MCP", () => {
    assert.equal(packr.logo, "splashtop");
    assert.equal(entry.logo, "splashtop");
  });
});

describe("Chat sources for the two Splashtop Help Centers", () => {
  const servers: McpChatServer[] = MCP_CATALOG.map(mcpChatServerOf);
  const chosen = (question: string, kind: "docs" | "mixed" | "tenant" = "docs") => planChatSources({ question, kind, servers, docsIndexAvailable: true }).requiredServerIds;

  it("an Agentic Packr question asks only the Agentic Packr Help Center", () => {
    assert.deepEqual(chosen("How do I create a deployment template in Splashtop Agentic Packr?"), ["splashtop-packr-kb"]);
    assert.deepEqual(chosen("Does Agentic Packr support Entra ID single sign-on?"), ["splashtop-packr-kb"]);
    assert.deepEqual(chosen("Ask the Splashtop Agentic Packr Docs MCP about branding", "tenant"), ["splashtop-packr-kb"]);
    assert.deepEqual(namedServers("What can Packr do?", servers).map((server) => server.id), ["splashtop-packr-kb"]);
    for (const question of ["How does Splashtop's Agentic Packr connect to Intune?", "How does Splashtop\u2019s Agentic Packr connect to Intune?", "How do I configure Splashtop Packr?", "How do I configure Splashtop's Packr?"]) {
      assert.deepEqual(chosen(question), ["splashtop-packr-kb"]);
      assert.deepEqual(chosen(question, "tenant"), ["splashtop-packr-kb"]);
    }
  });

  it("a Splashtop question still asks Splashtop Docs MCP, and naming both asks both", () => {
    assert.deepEqual(chosen("How do I reboot a computer with Splashtop?"), ["splashtop-kb"]);
    assert.deepEqual(chosen("Ask Splashtop Docs MCP about SOS", "tenant"), ["splashtop-kb"]);
    assert.deepEqual(chosen("Compare Splashtop Streamer deployment with Splashtop Agentic Packr").sort(), ["splashtop-kb", "splashtop-packr-kb"]);
  });

  it("the Agentic Packr host or an article link asks only the Agentic Packr Help Center", () => {
    assert.deepEqual(chosen("Ask support-splashtopagenticpackr.splashtop.com how to create a deployment template"), ["splashtop-packr-kb"]);
    assert.deepEqual(chosen("Ask support-splashtopagenticpackr.splashtop.com how to create a deployment template", "mixed"), ["splashtop-packr-kb"]);
    assert.deepEqual(chosen("Summarize https://support-splashtopagenticpackr.splashtop.com/hc/en-us/articles/57274342939291-Create-an-Intune-Deployment-Template"), ["splashtop-packr-kb"]);
    assert.deepEqual(chosen("Summarize https://support-splashtopagenticpackr.splashtop.com/hc/en-us/articles/57274342939291-Create-an-Intune-Deployment-Template?utm_source=splashtop#splashtop"), ["splashtop-packr-kb"]);
    assert.deepEqual(chosen("What does support-splashtopbusiness.splashtop.com say about SOS?"), ["splashtop-kb"]);
    // The query of a Packr link names no other reference either.
    assert.deepEqual(chosen("Summarize https://support-splashtopagenticpackr.splashtop.com/hc/en-us/articles/1?utm_source=windowsforum"), ["splashtop-packr-kb"]);
    assert.deepEqual(chosen("Summarize https://support-splashtopagenticpackr.splashtop.com/hc/en-us/articles/1?utm_source=kql"), ["splashtop-packr-kb"]);
    assert.deepEqual(chosen("Summarize https://support-splashtopagenticpackr.splashtop.com/hc/en-us/articles/1?utm_source=kql", "tenant"), ["splashtop-packr-kb"]);
    // A link ends at the delimiters around it, so a source named right after it still counts.
    assert.deepEqual(chosen("Compare <https://learn.microsoft.com/mem/intune/>,<https://www.microsoft.com/releasecommunications/mcp>").sort(), ["microsoft-learn", "release-communications"]);
    assert.deepEqual(chosen("See [article](https://support-splashtopagenticpackr.splashtop.com/hc/en-us/articles/1)(WindowsForum has more details)").sort(), ["splashtop-packr-kb", "windowsforum"]);
    assert.deepEqual(chosen("Read \"https://support-splashtopagenticpackr.splashtop.com/hc/en-us/articles/1\",KQL Search too", "tenant").sort(), ["kql-search", "splashtop-packr-kb"]);
    // A separate mention outside the link still counts.
    assert.deepEqual(chosen("Read https://support-splashtopagenticpackr.splashtop.com/hc/en-us/articles/1 and find KQL for it").sort(), ["kql-search", "splashtop-packr-kb"]);
    assert.deepEqual(chosen("Read https://support-splashtopagenticpackr.splashtop.com/hc/en-us/articles/1?ref=splashtop and compare it with Splashtop Streamer").sort(), ["splashtop-kb", "splashtop-packr-kb"]);
  });

  it("an Agentic Packr question does not fall back to Splashtop Docs MCP when Agentic Packr is off or not installed", () => {
    const withoutPackr = servers.filter((server) => server.id !== "splashtop-packr-kb");
    const only = (question: string, kind: "docs" | "mixed" | "tenant" = "docs") => planChatSources({ question, kind, servers: withoutPackr, docsIndexAvailable: true }).requiredServerIds;
    assert.deepEqual(only("How do I configure Splashtop Agentic Packr?").includes("splashtop-kb"), false);
    assert.deepEqual(only("Ask support-splashtopagenticpackr.splashtop.com about templates").includes("splashtop-kb"), false);
    assert.deepEqual(namedServers("How do I configure Splashtop Agentic Packr?", withoutPackr), []);
    assert.equal(only("How does Splashtop's Agentic Packr connect to Intune?").includes("splashtop-kb"), false);
    assert.equal(only("How do I configure Splashtop Packr?").includes("splashtop-kb"), false);
    assert.equal(only("How do I configure Splashtop's Packr?").includes("splashtop-kb"), false);
    assert.equal(only("Summarize https://support-splashtopagenticpackr.splashtop.com/hc/en-us/articles/1-Template?utm_source=splashtop").includes("splashtop-kb"), false);
    for (const source of ["windowsforum", "kql"]) {
      const required = only(`Summarize https://support-splashtopagenticpackr.splashtop.com/hc/en-us/articles/1?utm_source=${source}`);
      assert.equal(required.includes("windowsforum") || required.includes("kql-search"), false);
    }
    // Splashtop on its own still asks Splashtop Docs MCP.
    assert.deepEqual(only("How do I reboot a computer with Splashtop?"), ["splashtop-kb"]);
    assert.deepEqual(only("Compare Splashtop Streamer deployment with Splashtop Agentic Packr"), ["splashtop-kb"]);
  });
});
