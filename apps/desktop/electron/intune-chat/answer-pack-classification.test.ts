import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { GraphCacheResourceKind } from "@openadminos/agent-sdk";
import { fenceTenantData } from "@openadminos/runtime";
import { ClassificationLedger, withClassificationScope } from "@openadminos/runtime/data-classification";
import { traceAnswerPack, traceMultiTenantCounts } from "./answer-pack-classification.js";
import { IntelligenceSqliteStore } from "./sqlite-store.js";

test("cache breakdowns use the highest stored class per bucket and flag missing contributions", async t => {
  const dir = await mkdtemp(join(tmpdir(), "fixture-cache-breakdown-"));
  const file = join(dir, "fixture.db");
  const store = new IntelligenceSqliteStore(file);
  const db = new DatabaseSync(file);
  t.after(async () => { db.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const tenantId = "fixture";
  const refresh = (resource: GraphCacheResourceKind, rows: unknown[]) => store.replaceGraphResources({
    tenantId, resource, rows, label: resource, scopeSet: [], refreshedAt: "2026-01-01T00:00:00.000Z",
  });

  const resource = "configurationPolicies";
  const policies = [
    { id: "fixture-ordinary", isAssigned: true, platforms: ["windows10", "macOS"], templateReference: { templateFamily: "none" } },
    { id: "fixture-security", isAssigned: true, platforms: "windows10,android", templateReference: { templateFamily: "endpointSecurityAntivirus" } },
    { id: "fixture-false", isAssigned: false, platforms: ["macOS"], templateReference: { templateFamily: "none" } },
  ];
  refresh(resource, policies);
  refresh("signIns", [{ id: "fixture-signin", status: { errorCode: 700 } }]);
  refresh("managedDevices", [{ id: "fixture-device", complianceState: "compliant" }]);
  refresh("deviceConfigurations", [{ id: "fixture-config", "@odata.type": "#microsoft.graph.windows10EndpointProtectionConfiguration" }]);
  const inspect = async (
    target: GraphCacheResourceKind,
    checks: Array<[field: string, bucket: string, count: number, expected: string | undefined]>,
    beforeScan?: () => void,
    fallback?: boolean,
  ) => {
    const ledger = new ClassificationLedger();
    try {
      const prompt = withClassificationScope(ledger, () => {
        const aggregate = store.aggregateGraphResource(tenantId, target);
        const evidence = { resources: [{ resource: target, breakdowns: aggregate.breakdowns, breakdownsCoverAllCachedRows: !fallback }] };
        const fence = fenceTenantData(evidence, "chat:answer-pack");
        ledger.registerFencedRendering(fence, 0, (body, offset) => traceAnswerPack(evidence, body, offset, { [target]: aggregate }));
        return fence;
      });
      beforeScan?.();
      const { spans, unexamined } = await ledger.classifyProviderRequest({ prompt });
      for (const [field, bucket, count, expected] of checks) {
        const anchor = prompt.indexOf(`"${field}":{`);
        const key = prompt.indexOf(`"${bucket}":${count}`, anchor) + 1;
        assert.ok(anchor >= 0 && key > anchor, prompt);
        const value = key + bucket.length + 2;
        for (const [start, end] of [[key, key + bucket.length], [value, value + String(count).length]]) {
          if (expected) assert.ok(spans.some(span => span.start === start && span.end === end && span.kind === expected), prompt.slice(start, end));
          else assert.ok(unexamined.ranges.some(range => range.start === start && range.end === end &&
            range.reason === "rendered-provenance-unavailable"), prompt.slice(start, end));
        }
      }
    } finally { ledger.dispose(); }
  };

  const assignment: [string, string, number, string] = ["isAssigned", "1", 2, "security"];
  await inspect(resource, [
    assignment, ["isAssigned", "0", 1, "configuration"],
    ["platforms", "windows10", 2, "security"], ["platforms", "macOS", 2, "configuration"],
  ]);
  await inspect("signIns", [["status.errorCode", "700", 1, "activity"]]);
  await inspect("managedDevices", [["complianceState", "compliant", 1, "security"], ["isEncrypted", "unknown", 1, undefined]]);
  await inspect("deviceConfigurations", [["policyPlatform", "Windows", 1, undefined]]);
  await inspect(resource, [["isAssigned", "1", 2, undefined]], undefined, true);
  await inspect(resource, [["isAssigned", "1", 2, undefined]], () => refresh(resource, policies.slice(0, 1)));
  refresh(resource, policies);
  db.prepare("UPDATE graph_resources SET classification_json = NULL WHERE graph_id = ?").run("fixture-security");
  await inspect(resource, [["isAssigned", "1", 2, undefined], ["isAssigned", "0", 1, "configuration"]]);
});

test("aggregate traces report an unavailable source for filtered counts and multi-tenant rollups", () => {
  const evidence = { deterministicFindings: [{ resource: "managedDevices", id: "managed-devices-last-sync-before",
    matchingRows: 123, evaluatedSelectedRows: 999 }] };
  const body = JSON.stringify(evidence);
  const findings = [...traceAnswerPack(evidence, body, 0)].flatMap(entry =>
    entry?.incomplete ? [body.slice(entry.start, entry.end)] : []);
  assert.deepEqual(findings, ["123", "999"]);
  const rollup = '{"compliant": 12, "nonCompliant": 13, "unknown": 4, "windowsDevices": 25, "tenantsScanned": 2}';
  assert.deepEqual([...traceMultiTenantCounts(rollup, 0)].map(entry =>
    [entry.incomplete, rollup.slice(entry.start, entry.end)]), [
    [true, "12"], [true, "13"], [true, "4"], [true, "25"], [true, "2"],
  ]);
});
