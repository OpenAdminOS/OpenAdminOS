import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { planChatSources } from "../intune-chat/chat-steps.js";
import { canonicalMcpFilter } from "../intune-chat/mcp-filter.js";
import { buildMcpQueryWriterPrompt } from "../intune-chat/mcp-query-writer.js";
import { canonicalItemId, itemIdsInText, mcpChatToolName, readMcpResult, type McpChatServer } from "../intune-chat/tools.js";
import { MCP_CATALOG, mcpCatalogEntry, mcpHost } from "./catalog.js";

/** Trimmed live captures from 2026-11-05; see transports.test.ts. */
const FIXTURES = JSON.parse(readFileSync(new URL("./fixtures/second-wave-servers.json", import.meta.url), "utf8")) as Record<string, {
  tools: Array<{ name: string }>;
  calls: Record<string, { content?: Array<{ text?: string }>; structuredContent?: unknown }>;
}>;

function read(serverId: string, call: string, tool: string, args: Record<string, unknown> = {}) {
  const entry = mcpCatalogEntry(serverId)!;
  const result = FIXTURES[serverId]!.calls[call]!;
  const text = (result.content ?? []).map((part) => part.text ?? "").join("\n\n").trim();
  return readMcpResult(text, { tool, args, host: mcpHost(entry.url), format: entry.results!, ...(result.structuredContent !== undefined ? { structured: result.structuredContent } : {}) });
}

const servers: McpChatServer[] = MCP_CATALOG.map((entry) => ({ id: entry.id, name: entry.name, host: mcpHost(entry.url), useFor: entry.useFor, aliases: entry.aliases, topics: entry.topics }));
const chosen = (question: string, kind: "docs" | "mixed" | "tenant" = "docs") => planChatSources({ question, kind, servers, docsIndexAvailable: true }).requiredServerIds;

describe("Second-wave catalog entries", () => {
  it("lists each server with its operator, policy page and allowlist", () => {
    const rc = mcpCatalogEntry("release-communications")!;
    const wf = mcpCatalogEntry("windowsforum")!;
    const eol = mcpCatalogEntry("endoflife-ai")!;
    assert.deepEqual(rc.tools, ["get_recent_m365_roadmaps", "get_m365_roadmap_by_id", "get_recent_azure_updates", "get_azure_update_by_id"]);
    assert.deepEqual(wf.tools, ["search_kb", "get_kb_article"]);
    assert.deepEqual(eol.tools, FIXTURES["endoflife-ai"]!.tools.map((tool) => tool.name).filter((name) => name !== "scan_stack" && name !== "check_sbom"));
    // Every allowlisted tool is one the live server listed.
    for (const entry of [rc, wf, eol]) {
      for (const name of entry.tools!) assert.ok(FIXTURES[entry.id]!.tools.some((tool) => tool.name === name), `${entry.id} lists ${name}`);
      assert.equal(entry.auth, "none");
      assert.ok(entry.operator && entry.policy && /^https:\/\//.test(entry.policy.url));
      for (const text of [entry.description, entry.pitch, entry.useFor, entry.operator, ...(entry.notes ?? [])]) {
        assert.doesNotMatch(text, /[–—!]| - |USD|\$\d|price|paid/i, `${entry.id}: ${text}`);
      }
    }
    // Only the server Microsoft runs names Microsoft as its publisher.
    assert.equal(rc.publisher, "Microsoft");
    assert.equal(wf.publisher, "WindowsForum.com");
    assert.match(wf.operator!, /not affiliated with Microsoft/);
    assert.equal(eol.publisher, "EndofLife AI Inc.");
    assert.ok(wf.notes?.some((note) => /community text/.test(note)));
    assert.deepEqual(rc.itemIds, {
      get_m365_roadmap_by_id: { params: ["id"], form: { kind: "number" } },
      get_azure_update_by_id: { params: ["id"], form: { kind: "slug" } },
      get_recent_m365_roadmaps: { filter: { param: "filter", fields: ["id", "baseId"], literal: "number" }, form: { kind: "number" } },
      get_recent_azure_updates: { filter: { param: "filter", fields: ["id", "baseId"], literal: "string" }, form: { kind: "slug" } },
    });
    // Every tool with a free-text filter declares where IDs can stand in it.
    for (const tool of FIXTURES["release-communications"]!.tools as Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>) {
      if (tool.inputSchema?.properties?.filter) assert.equal(rc.itemIds?.[tool.name]?.filter?.param, "filter", tool.name);
    }
    assert.deepEqual(wf.itemIds, { get_kb_article: { params: ["kb_id"], form: { kind: "number", prefix: "KB", sendPrefix: true } } });
  });
});

describe("Second-wave item ID forms", () => {
  it("fits every ID the live servers returned to its tool's form", () => {
    const rc = mcpCatalogEntry("release-communications")!;
    const wf = mcpCatalogEntry("windowsforum")!;
    const text = (serverId: string, call: string) => (FIXTURES[serverId]!.calls[call]!.content ?? []).map((part) => part.text ?? "").join("");
    const ids = (serverId: string, call: string) => [...text(serverId, call).matchAll(/"(?:id|kb_id)":"?([^",}]+)/g)].map((match) => match[1]!);
    for (const id of ids("release-communications", "get_recent_m365_roadmaps")) assert.ok(canonicalItemId(id, rc.itemIds!.get_m365_roadmap_by_id!.form), id);
    for (const id of [...ids("release-communications", "get_recent_azure_updates"), "2021regions", "3-years-reserved-capacity-now-available"]) assert.ok(canonicalItemId(id, rc.itemIds!.get_azure_update_by_id!.form), id);
    assert.ok(ids("windowsforum", "search_kb").length > 0);
    for (const id of ids("windowsforum", "search_kb")) assert.deepEqual(canonicalItemId(id, wf.itemIds!.get_kb_article!.form)?.send, id.toUpperCase());
    assert.equal(canonicalItemId("1.09560", rc.itemIds!.get_m365_roadmap_by_id!.form), undefined);
    assert.equal(canonicalItemId("2021Regions", rc.itemIds!.get_azure_update_by_id!.form), undefined);
  });

  it("reads the filter examples in the catalog hints, so the writer is shown filters that are sent", () => {
    const rc = mcpCatalogEntry("release-communications")!;
    for (const tool of ["get_recent_m365_roadmaps", "get_recent_azure_updates"]) {
      const examples = [...rc.queryHints![tool]!.matchAll(/such as (.+?)(?: or (status eq .+?))?;/g)].flatMap((match) => [match[1]!, ...(match[2] ? [match[2]] : [])]);
      assert.ok(examples.length > 0, tool);
      const rule = rc.itemIds![tool]!.filter!;
      for (const example of examples) assert.equal(canonicalMcpFilter(example, { ...rule, itemId: () => undefined }), example);
    }
  });

  it("reads typed IDs as tokens split on characters an ID cannot hold", () => {
    assert.deepEqual(itemIdsInText("Compare roadmap 109560-109561, and #124890.", { kind: "number" }), ["109560", "109561", "124890"]);
    assert.deepEqual(itemIdsInText("What does 50344\u00e941 fix, and KB5058919?", { kind: "number", prefix: "KB" }), ["50344", "41", "5058919"]);
    assert.deepEqual(itemIdsInText("Updates 466774-466779 and 2021regions", { kind: "slug" }), ["466774-466779", "466774", "466779", "and", "2021regions"]);
  });
});

describe("Second-wave query hints", () => {
  it("gives the query writer our own note on params the server schema cannot explain", () => {
    const rc = mcpCatalogEntry("release-communications")!;
    const hint = rc.queryHints!.get_recent_m365_roadmaps!;
    const prompt = buildMcpQueryWriterPrompt({
      question: "What is rolling out for Intune?",
      tool: { name: mcpChatToolName(rc.id, "get_recent_m365_roadmaps"), serverId: rc.id, serverName: rc.name, host: mcpHost(rc.url), tool: "get_recent_m365_roadmaps",
        description: "Retrieves M365 roadmap posts.", inputSchema: { type: "object", properties: { filter: { type: "string" }, search: { type: "string" } } }, queryHint: hint },
      earlierResults: [],
      sentQueries: [],
    });
    // The note is the app's own text, outside the third-party fence.
    const fenceEnd = prompt.indexOf("</tenant_data>", prompt.indexOf("third-party:www.microsoft.com:tool"));
    assert.ok(prompt.indexOf(`How to fill these params (from OpenAdminOS): ${hint}`) > fenceEnd);
    assert.match(hint, /filter takes only an OData expression/);
    assert.ok(mcpCatalogEntry("endoflife-ai")!.queryHints!.check_eol!.includes("windows-server"));
    assert.ok(mcpCatalogEntry("windowsforum")!.queryHints!.get_kb_article!.includes("KB5058919"));
  });
});

describe("Second-wave source routing", () => {
  it("chooses each server by its topic words for docs questions, and Learn otherwise", () => {
    assert.deepEqual(chosen("What is on the Microsoft 365 roadmap for Intune?"), ["release-communications"]);
    assert.deepEqual(chosen("Which Azure retirements land next year?"), ["release-communications"]);
    assert.deepEqual(chosen("What’s new in Intune this month?"), ["release-communications"]);
    assert.deepEqual(chosen("Is the Azure update about Stream Analytics rolling out?"), ["release-communications"]);
    assert.deepEqual(chosen("What are the known issues in the latest cumulative update?"), ["windowsforum"]);
    assert.deepEqual(chosen("What does KB5058919 fix?"), ["windowsforum"]);
    assert.deepEqual(chosen("Show the Windows 11 update history"), ["windowsforum"]);
    assert.deepEqual(chosen("When does Windows Server 2016 reach end of support?"), ["endoflife-ai"]);
    assert.deepEqual(chosen("Is Windows 10 22H2 EOL?"), ["endoflife-ai"]);
    assert.deepEqual(chosen("When support ends for Windows 11 23H2, what then?"), ["endoflife-ai"]);
    assert.deepEqual(chosen("How do I configure a compliance policy grace period?"), ["microsoft-learn"]);
  });

  it("calls a server the question names, also in a tenant question, and does not read a parent domain as a name", () => {
    assert.deepEqual(chosen("Ask WindowsForum about our devices", "tenant"), ["windowsforum"]);
    assert.deepEqual(chosen("Check endoflife.ai for our servers", "tenant"), ["endoflife-ai"]);
    assert.deepEqual(chosen("Use release communications for our tenant", "tenant"), ["release-communications"]);
    assert.deepEqual(chosen("Read https://learn.microsoft.com/mem/intune/ and support.microsoft.com", "tenant"), ["microsoft-learn"]);
    assert.deepEqual(chosen("Why can admin@microsoft.com not sign in?", "tenant"), []);
  });
});

describe("Second-wave results read by structure", () => {
  it("reads Release Communications roadmap and update items with their IDs and dates", () => {
    const roadmaps = read("release-communications", "get_recent_m365_roadmaps", "get_recent_m365_roadmaps", { search: "Intune" });
    assert.equal(roadmaps.items.length, 3);
    assert.deepEqual([roadmaps.items[0]!.title, roadmaps.items[0]!.id, roadmaps.items[0]!.url], ["Microsoft Intune: iOS app multiple managed accounts", "109560", undefined]);
    assert.match(roadmaps.items[0]!.excerpt!, /^Allows people to use a single device[\s\S]*\nid: 109560\nstatus: In development\nproducts: Microsoft Intune[\s\S]*availabilities: General Availability 2026 March; Preview 2025 November/);
    const azure = read("release-communications", "get_azure_update_by_id", "get_azure_update_by_id", { id: "466774" });
    assert.deepEqual(azure.items.map((item) => [item.title, item.id]), [["Retirement: Azure Stream Analytics PowerBI output connector", "466774"]]);
    assert.match(azure.items[0]!.excerpt!, /tags: Retirements/);
    assert.deepEqual(read("release-communications", "empty_search", "get_recent_m365_roadmaps"), { items: [], empty: true });
    assert.deepEqual(read("release-communications", "unknown_id", "get_m365_roadmap_by_id"), { items: [], empty: true });
  });

  it("reads WindowsForum KB results with their support.microsoft.com links, and a missing article as empty", () => {
    const search = read("windowsforum", "search_kb", "search_kb", { query: "Windows 11 24H2 cumulative update" });
    assert.equal(search.items.length, 3);
    assert.deepEqual([search.items[0]!.id, search.items[0]!.url], ["KB5134133", "https://support.microsoft.com/help/5134133"]);
    assert.match(search.items[0]!.excerpt!, /release_date: 2026-10-26\napplies_to: Windows 11/);
    const article = read("windowsforum", "get_kb_article", "get_kb_article", { kb_id: "KB5058919" });
    assert.equal(article.items.length, 1);
    assert.match(article.items[0]!.excerpt!, /^## April 11, 2025/);
    assert.deepEqual(read("windowsforum", "not_found", "get_kb_article"), { items: [], empty: true });
    assert.deepEqual(read("windowsforum", "empty_search", "search_kb"), { items: [], empty: true });
  });

  it("reads endoflife.ai versions, KEV entries and single-record answers, and an empty listing as empty", () => {
    const check = read("endoflife-ai", "check_eol", "check_eol", { product: "windows-server", version: "2016" });
    assert.deepEqual(check.items.map((item) => [item.title, item.url]), [["windows-server 2016", "https://endoflife.ai/score/windows-server/2016"]]);
    assert.match(check.items[0]!.excerpt!, /status: warn\nis_supported: yes\neol_date: 2027-01-12\ndays_until_eol: 68/);
    assert.equal(read("endoflife-ai", "get_product_lifecycle", "get_product_lifecycle", { product: "windows-server" }).items.length, 3);
    const upcoming = read("endoflife-ai", "get_upcoming_eol", "get_upcoming_eol", { products: ["windows", "windows-server"], days: 365 });
    assert.deepEqual(upcoming.items.map((item) => item.title), ["Windows 11-23h2-e", "Windows 10-21h2-e-lts", "Windows Server 2016"]);
    const kev = read("endoflife-ai", "get_kev_exposure", "get_kev_exposure", { product: "windows-server" });
    assert.deepEqual(kev.items.map((item) => item.title), ["CVE-2021-34527 Microsoft Windows Print Spooler Remote Code Execution Vulnerability"]);
    const upgrade = read("endoflife-ai", "get_upgrade_path", "get_upgrade_path", { product: "windows", version: "10" });
    assert.deepEqual(upgrade.items.map((item) => [item.title, item.url]), [["get_upgrade_path: windows 10", "https://endoflife.ai/windows"]]);
    assert.match(upgrade.items[0]!.excerpt!, /recommended_target/);
    assert.equal(read("endoflife-ai", "list_products", "list_products", { query: "windows" }).items[0]!.title, "list_products: windows");
    assert.deepEqual(read("endoflife-ai", "empty_list", "list_products", { query: "nothing" }), { items: [], empty: true });
  });
});
