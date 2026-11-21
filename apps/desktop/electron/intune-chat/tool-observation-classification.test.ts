import assert from "node:assert/strict";
import { test } from "node:test";
import type { IntuneChatInvestigationToolName } from "@openadminos/agent-sdk";
import { escapeTenantDataBody } from "@openadminos/runtime";
import { traceToolObservation } from "./tool-observation-classification.js";

test("tool traces locate clipped wrappers, derived fields and escaped prose at the original offsets", () => {
  const fixtures: Array<[IntuneChatInvestigationToolName, object, string[]]> = [
    ["graph_get", { observation: { observation: {
      result: { rows: [{ totalCount: 44 }], totalCount: 88, valuePreview: '{"returnedRows":4}' },
      trace: { graphSource: { totalCount: 88 }, resultSummary: "2 of 4 live rows returned" },
    } } }, ["88", String.raw`{\"returnedRows\":4}`, "88", "2 of 4 live rows returned"]],
    ["query_cache", { result: { rows: [{ row: { rows: 25 }, refreshedAt: "fixture-time" }],
      coverage: "Newest 20 entries from the 14 days before refresh." },
    trace: { cacheSource: { rows: 20 }, error: "Read failed: <fixture>" } },
    ["fixture-time", "Newest 20 entries from the 14 days before refresh.", "20", String.raw`Read failed: \u003cfixture\u003e`]],
    ["query_drift", { result: { rows: [{ resource: "users", fieldsChanged: 6 }], matchedRows: 30,
      note: "Results capped at 10 rows." } },
    ["6", "30", "Results capped at 10 rows."]],
    ["find_graph_endpoint", { result: { candidates: [{ path: "/users", usable: false, blockedReason: "Consent needed." }] },
      trace: { resultSummary: "1 candidate endpoint" } }, ["false", "Consent needed.", "1 candidate endpoint"]],
    ["splashtop_list_computers", { result: { records: [{ users: 20 }], page: { total: 200, next: true } } }, ["200", "true"]],
    ["web_search", { result: { content: "Public content", sources: ["https://example.test"] },
      trace: { resultSummary: "Public web research completed with 1 source" } }, ["Public web research completed with 1 source"]],
    ["mcp__fixture__search", { result: { matched: 100, counts: { more: true }, content: "Listed 10 of 100." },
      trace: { mcpSource: { matched: 100, truncated: true } } }, ["100", "true", "Listed 10 of 100.", "100", "true"]],
  ];
  for (const [tool, result, expected] of fixtures) {
    for (const indent of [undefined, 2]) {
      const body = escapeTenantDataBody(JSON.stringify(result, null, indent));
      const prefix = "😀 fixture\n";
      const trace = traceToolObservation(tool, body, prefix.length);
      const found: string[] = [];
      let entry = trace.next();
      while (!entry.done) {
        if (entry.value) {
          assert.equal(entry.value.incomplete, true);
          found.push((prefix + body).slice(entry.value.start, entry.value.end));
        }
        entry = trace.next();
      }
      assert.equal(entry.value, true, tool);
      assert.deepEqual(found, expected, tool);
    }
  }
});
