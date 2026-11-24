import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync(
  new URL("../../../supabase/migrations/20261124205137_openadminos_stats.sql", import.meta.url),
  "utf8",
);

test("migration grants only schema usage and RPC execution to the service role", () => {
  const grants = sql.match(/^grant\b[^;]+;/gim) ?? [];
  assert.equal(grants.length, 2);
  assert.match(grants[0] ?? "", /^grant usage on schema openadminos to service_role;$/i);
  assert.match(grants[1] ?? "", /^grant execute on function[\s\S]+\bto service_role;$/i);
  for (const grant of grants) assert.doesNotMatch(grant, /\b(?:anon|authenticated|public)\b/i);
  for (const object of ["schema openadminos", "all tables in schema openadminos", "all functions in schema openadminos"]) {
    assert.ok(sql.includes(`revoke all on ${object} from public, anon, authenticated, service_role;`));
  }

  for (const table of ["install_counts_daily", "rate_limits", "support_issue_dedup"]) {
    assert.ok(sql.includes(`alter table openadminos.${table} enable row level security;`));
  }
  assert.doesNotMatch(sql, /\bcreate policy\b/i);
});
