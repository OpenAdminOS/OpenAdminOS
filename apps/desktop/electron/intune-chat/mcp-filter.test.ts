import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonicalMcpFilter, McpFilterItemError, McpFilterSyntaxError } from "./mcp-filter.js";

const known = new Set(["109560", "124890", "466774"]);
const roadmaps = { fields: ["id", "baseId"], literal: "number" as const, itemId: (value: string) => (known.has(value.trim()) ? value.trim() : undefined) };
const azure = { ...roadmaps, literal: "string" as const };

describe("MCP OData filter reader", () => {
  it("keeps every filter shape the Release Communications schemas document, as written", () => {
    for (const filter of [
      "status eq 'Rolling out'",
      "status eq null",
      "products/any(p: p eq 'Microsoft Teams') and status eq 'Launched'",
      "products/any(p: p eq 'Microsoft Copilot (Microsoft 365)') and (generalAvailabilityDate eq '2026-02' or previewAvailabilityDate eq '2026-02')",
      "availabilities/any(a: a/ring eq 'General Availability' and a/month eq 'February' and a/year eq 2026)",
      "availabilities/any(a: a/ring eq 'Preview' and a/year ge 2025)",
      "created ge 2026-02-01T00:00:00Z and created le 2026-02-28T23:59:59Z",
      "cloudInstances/any(ci: ci eq 'GCC High') and status eq 'Launched'",
      "tags/any(t: t eq 'Retirements') and availabilities/any(a: a/ring eq 'Retirement' and a/month eq 'February' and a/year eq 2026)",
      "releaseRings/any(r: r eq 'Targeted Release (Entire Organization)')",
      "contains(status, 'Roll')",
      "not (status eq 'Launched')",
      "products/any(p: p eq 'Teams ''Premium''')",
    ]) {
      assert.equal(canonicalMcpFilter(filter, roadmaps), filter);
    }
  });

  it("sends the filter as it was read: spacing and keyword case are canonical", () => {
    assert.equal(canonicalMcpFilter("  status EQ 'Rolling out'   AND products/ANY( p :p eq 'Microsoft Intune')", roadmaps), "status eq 'Rolling out' and products/any(p: p eq 'Microsoft Intune')");
  });

  it("refuses an ID on an item field that the rule does not allow, wherever it stands", () => {
    for (const filter of [
      "id eq 999999",
      "status eq 'Launched' and id eq 999999",
      "(status eq 'Launched' or (baseId eq 999999))",
      "ID eq 999999",
      "not id ne 999999",
      "id in (109560, 999999)",
      "contains(id, '9999')",
      "id gt 0",
      "id eq null",
      "id eq 1.09560",
      "products/any(id: id eq '999999')",
      "id/any(x: x eq 999999)",
    ]) {
      assert.throws(() => canonicalMcpFilter(filter, roadmaps), McpFilterItemError, filter);
    }
  });

  it("allows an ID the rule allows, in the literal kind the server compares", () => {
    assert.equal(canonicalMcpFilter("id eq 109560", roadmaps), "id eq 109560");
    assert.equal(canonicalMcpFilter("id eq '109560'", roadmaps), "id eq 109560");
    assert.equal(canonicalMcpFilter("id in (109560,124890) and status eq 'Launched'", roadmaps), "id in (109560, 124890) and status eq 'Launched'");
    assert.equal(canonicalMcpFilter("id eq 466774", azure), "id eq '466774'");
    // A lambda variable that shadows an item variable is an ordinary name again.
    assert.equal(canonicalMcpFilter("id/any(x: x eq 109560 and tags/any(x: x eq 'Retirements'))", roadmaps), "id/any(x: x eq 109560 and tags/any(x: x eq 'Retirements'))");
  });

  it("refuses text that is not a filter in this grammar", () => {
    for (const filter of [
      "",
      "Intune",
      "Microsoft Intune retirements",
      "status eq",
      "status eq 'Rolling out",
      "status eq 'Launched' status eq 'Launched'",
      "'109560' eq id",
      "id eq 109560-109561",
      "id eq 109560abc",
      "status eq \"Launched\"",
      "status eq 'x'; drop",
      "products/any(p: p eq 'Teams'",
      "substringof('Teams', title)",
      `${"(".repeat(40)}status eq 'Launched'${")".repeat(40)}`,
    ]) {
      assert.throws(() => canonicalMcpFilter(filter, roadmaps), McpFilterSyntaxError, filter);
    }
  });
});
