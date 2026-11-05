import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { McpResultFormat } from "../mcp/catalog.js";
import { toolStepFinish } from "./chat-steps.js";
import { readMcpResult } from "./tools.js";

const format: McpResultFormat = {
  items: [
    { title: [["title"]], url: ["url", "links.page"], text: ["summary"], facts: ["status", "tags", "dates"], id: ["id"] },
    { title: [["product_name", "product"], ["version"]], requires: ["ends"], url: ["page"], facts: ["ends"] },
  ],
  whole: { url: ["source.url"], emptyWhenZero: ["returned"] },
};

describe("MCP results read by a catalog format", () => {
  it("makes each matching record one source with title, link, excerpt and ID", () => {
    const read = readMcpResult(JSON.stringify({ items: [
      { id: 42, title: "Feature one", summary: "Does a thing.", status: "Rolling out", tags: ["A", "B"], dates: [{ ring: "GA", year: 2026 }, { ring: "Preview", year: 2025 }], links: { page: "https://example.com/42" } },
      { id: "x", title: null, summary: "No title, so not a source." },
      { title: "Unsafe link", url: "http://example.com/plain" },
    ] }), { format, tool: "list" });
    assert.equal(read.empty, false);
    assert.deepEqual(read.items, [
      { title: "Feature one", url: "https://example.com/42", excerpt: "Does a thing.\nstatus: Rolling out\ntags: A, B\ndates: GA 2026; Preview 2025", id: "42" },
      { title: "Unsafe link" },
    ]);
  });

  it("joins title parts, needs every part and the required keys, and does not search a matched record further", () => {
    const read = readMcpResult("", { format, structured: { versions: [
      { product_name: "Windows Server", product: "windows-server", version: "2016", ends: "2027-01-12", page: "https://example.com/ws/2016", nested: { title: "Inner" } },
      { product: "windows-server", version: "2012", page: "https://example.com/ws/2012" },
    ] } });
    assert.deepEqual(read.items.map((item) => [item.title, item.url, item.excerpt]), [["Windows Server 2016", "https://example.com/ws/2016", "ends: 2027-01-12"]]);
  });

  it("gives a nested record without a link the nearest enclosing link under inheritUrl, and keeps a record's own link", () => {
    const nested: McpResultFormat = { items: [{ title: [["cve"]], url: ["page"] }], inheritUrl: ["source.url", "product_url"] };
    const read = readMcpResult("", { format: nested, structured: {
      product_url: "https://example.com/outer",
      entries: [{ cve: "CVE-1" }, { cve: "CVE-2", page: "https://example.com/cve-2" }],
      family: { source: { url: "https://example.com/inner" }, entries: [{ cve: "CVE-3" }] },
      plain: { product_url: "http://example.com/not-https", entries: [{ cve: "CVE-4" }] },
    } });
    assert.deepEqual(read.items.map((item) => [item.title, item.url]), [
      ["CVE-1", "https://example.com/outer"],
      ["CVE-2", "https://example.com/cve-2"],
      ["CVE-3", "https://example.com/inner"],
      ["CVE-4", "https://example.com/outer"],
    ]);
    // Without inheritUrl, nothing is inherited.
    assert.equal(readMcpResult("", { format: { items: nested.items }, structured: { product_url: "https://example.com/outer", entries: [{ cve: "CVE-1" }] } }).items[0]!.url, undefined);
  });

  it("reads a single-record answer as one source titled by the tool and params, unless a count is zero", () => {
    const record = { product: "windows", recommended: { cycle: "11" }, source: { url: "https://example.com/windows" } };
    const whole = readMcpResult(JSON.stringify(record), { format, tool: "get_upgrade_path", args: { product: "windows", version: "10" } });
    assert.deepEqual(whole.items, [{ title: "get_upgrade_path: windows 10", url: "https://example.com/windows", excerpt: JSON.stringify(record) }]);
    assert.deepEqual(readMcpResult(JSON.stringify({ returned: 0, products: [], source: { url: "https://example.com/p" } }), { format, tool: "list_products", args: { query: "nothing" } }), { items: [], empty: true });
  });

  it("is empty for blank text, and for a structure with nothing to match when the format has no whole-result rule", () => {
    assert.deepEqual(readMcpResult("", {}), { items: [], empty: true });
    assert.deepEqual(readMcpResult("  ", { format }), { items: [], empty: true });
    const strict: McpResultFormat = { items: format.items };
    assert.deepEqual(readMcpResult(JSON.stringify({ results: [] }), { format: strict }), { items: [], empty: true });
    assert.deepEqual(readMcpResult(JSON.stringify({ title: null, content: "No article was found." }), { format: strict }), { items: [], empty: true });
    // Servers without a format keep the default reading: text with no items is still passed on.
    assert.deepEqual(readMcpResult("Plain text answer.", {}), { items: [], empty: false });
  });

  it("shows designed steps for an empty answer and an error result", () => {
    const base = { id: "t", tool: "mcp__s__list" as const, params: {}, resultSummary: "", durationMs: 5, createdAt: "2026-11-05T10:00:00.000Z", completedAt: "2026-11-05T10:00:00.005Z" };
    const mcpSource = { serverId: "s", serverName: "Release Communications", host: "www.microsoft.com", tool: "get_recent_m365_roadmaps" };
    assert.deepEqual(toolStepFinish({ ...base, mcpSource: { ...mcpSource, empty: true, results: [], sentToHost: true } }), {
      status: "completed", title: "Release Communications found nothing", detail: "get_recent_m365_roadmaps · no results for this query", durationMs: 5,
    });
    assert.deepEqual(toolStepFinish({ ...base, error: "endoflife.ai returned an error: Error: No data for windows 11.", mcpSource: { ...mcpSource, serverName: "endoflife.ai", tool: "check_eol", toolError: true, sentToHost: true } }), {
      status: "failed", title: "endoflife.ai returned an error", detail: "check_eol · endoflife.ai returned an error: Error: No data for windows 11.", durationMs: 5,
    });
  });
});
