import assert from "node:assert/strict";
import { lookup } from "node:dns/promises";
import { describe, it } from "node:test";

import { mcpCatalogEntry, mcpHost } from "../mcp/catalog.js";
import { McpHost } from "../mcp/host.js";

/**
 * Live probe of Splashtop Docs MCP: one public Help Center search and article
 * read. No sign-in is involved. Skipped in CI, when OPENADMINOS_SKIP_LIVE
 * is set, and when the hosts do not resolve.
 */
const IDS = ["splashtop-kb"] as const;

async function resolves(host: string): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      lookup(host).then(() => true, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 3_000); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const skipReason = process.env.CI
  ? "live probe skipped in CI"
  : process.env.OPENADMINOS_SKIP_LIVE
    ? "live probe skipped by OPENADMINOS_SKIP_LIVE"
    : (await Promise.all(IDS.map((id) => resolves(mcpHost(mcpCatalogEntry(id)!.url))))).every(Boolean)
      ? undefined
      : "live probe skipped: offline";

describe("Splashtop support assistant, live", { skip: skipReason ?? false }, () => {
  it("the Help Center search and article read answer without sign-in", async () => {
    const entry = mcpCatalogEntry("splashtop-kb")!;
    const host = new McpHost({ clientVersion: "live-probe", callTimeoutMs: 20_000 });
    const search = await host.callTool(entry, "search_articles", { query: "reboot computer" });
    const results = (search.structured as { results: Array<{ id: number; title: string; url?: string }> }).results;
    assert.ok(results.length > 0, "the search found no article");
    assert.match(results[0]!.url ?? "", /^https:\/\/support-splashtopbusiness\.splashtop\.com\/hc\//);
    const article = await host.callTool(entry, "get_article", { id: results[0]!.id });
    assert.ok((article.structured as { body: string }).body.length > 50);
  });
});
