import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { bucketSupportAge, bucketSupportCount, formatSupportIssue, SupportIssueSizeError, supportIssuePreviewDigest } from "./issue-format";

const issue = {
  title: "Cache shows a blank page",
  description: "Opening Data settings gives a blank page.",
  source: "settings-about",
  appVersion: "0.8.0",
};

test("the desktop and web formatters match byte for byte", () => {
  const desktop = "../../../../apps/desktop/electron/";
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.equal(read(`${desktop}support-issue-format.ts`), read("./issue-format.ts"));
});

test("support count ranges are contiguous and become coarser", () => {
  assert.deepEqual(
    [0, 1, 10, 11, 100, 101, 1_000, 1_001, 10_000, 10_001].map(bucketSupportCount),
    ["0", "1-10", "1-10", "11-100", "11-100", "101-1000", "101-1000", "1001-10000", "1001-10000", "10001+"],
  );
});

test("activity timestamps become relative ages and only due times can be in the future", () => {
  const createdAt = Date.parse("2026-11-24T14:38:00.000Z");
  const timestamp = (hoursAgo: number) => new Date(createdAt - hoursAgo * 3_600_000).toISOString();
  assert.deepEqual(
    [0, 1, 23, 24, 167, 168, 720, 721].map((hours) =>
      bucketSupportAge(timestamp(hours), createdAt)),
    ["<1h", "1-24h", "1-24h", "1-7d", "1-7d", "7-30d", "7-30d", ">30d"],
  );
  assert.equal(bucketSupportAge(timestamp(-1), createdAt), undefined);
  assert.equal(bucketSupportAge(timestamp(-1), createdAt, true), "future");
  assert.equal(bucketSupportAge("not a timestamp", createdAt), undefined);
});

function publicDiagnostics(diagnostics: unknown, publicSlugs?: ReadonlySet<string>) {
  const result = formatSupportIssue({ issue, diagnostics }, publicSlugs);
  assert.ok("payload" in result);
  const json = /```json\n([\s\S]+?)\n```/.exec(result.payload.body)?.[1];
  assert.ok(json);
  return JSON.parse(json);
}

test("schema 1 reports keep recognized categories and bucket counts, dropping precise times and hashes", () => {
  const timestamp = "2026-11-24T14:38:17.453Z";
  assert.deepEqual(publicDiagnostics({
    schemaVersion: 1,
    createdAt: "2026-11-25T00:38:17+02:00",
    notice: "Text from an older client",
    excluded: ["Text from an older client"],
    issueContext: {
      source: "run-failure", titleLength: 41, descriptionLength: 134,
      agentSlugHash: "7789960e40319539", runIdHash: "7789960e40319539",
      hasStepsToReproduce: false,
    },
    state: {
      activeProvider: { id: "ollama", modelCount: 13, detailCategory: "timeout", detailHash: "7789960e40319539" },
      tenants: { connectedCount: 3 },
      registry: { sourceKind: "official", lastRefresh: timestamp, refreshErrorHash: "7789960e40319539" },
      scheduler: { enabled: true, lastWakeAt: timestamp, lastSuccessAt: timestamp, nextDueAt: timestamp },
      runs: { total: 32, byStatus: { failed: 13 }, byTrigger: { manual: 32 }, latestRunAt: timestamp },
      recentFailures: [{
        trigger: "manual", queuedAt: timestamp, finishedAt: timestamp,
        errorCategory: "network", errorHash: "7789960e40319539",
      }],
      graphCache: {
        schedule: {
          intervalMinutes: 30, updatedAt: timestamp, lastRunAt: timestamp,
          lastSuccessAt: timestamp, nextRunAt: timestamp, lastErrorHash: "7789960e40319539",
        },
        resources: [
          { resource: "managedDevices", rows: 745, pages: 13, pageLimitReached: true, refreshedAt: timestamp },
          { resource: "users", rows: "105304", pages: "11-100", pageLimitReached: false },
        ],
      },
    },
  }), {
    schemaVersion: 1,
    createdAt: "2026-11-24",
    issueContext: { source: "run-failure", hasStepsToReproduce: false },
    state: {
      activeProvider: { id: "ollama", modelCount: "11-100", detailCategory: "timeout" },
      tenants: { connectedCount: "1-10" },
      registry: { sourceKind: "official" },
      scheduler: { enabled: true },
      runs: { total: "11-100", byStatus: { failed: "11-100" }, byTrigger: { manual: "11-100" } },
      recentFailures: [{ trigger: "manual", errorCategory: "network" }],
      graphCache: {
        schedule: { intervalMinutes: "11-100" },
        resources: [
          { resource: "managedDevices", rows: "101-1000", pages: "11-100", pageLimitReached: true },
          { resource: "users", rows: "10001+", pages: "11-100", pageLimitReached: false },
        ],
      },
    },
  });
});

test("schema 2 rebuilds diagnostics from allowlisted fields, enums, and types", () => {
  const publicSlugs = new Set(["compliance-overview"]);
  const diagnostics = publicDiagnostics({
    schemaVersion: "2",
    createdAt: "2026-11-24",
    issueContext: {
      source: "settings-about", hasExpectedBehavior: true, hasActualBehavior: "true",
      agentSlug: "compliance-overview", displayName: "Private Name",
    },
    app: {
      version: "0.8.0-nightly.20261124123456", packaged: true, processArch: "x64",
      osRelease: "6.8.0-private-host", node: "22.0.0", v8: "13.0.245.25-electron.0",
      electron: "private-example", tenantName: "Private Name",
    },
    privacy: { promptsIncluded: false, tenantName: "Private Name" },
    tenantName: "Private Name",
    state: {
      tenantName: "Private Name",
      activeProvider: {
        id: ["ollama"], detailCategory: "105304", modelCount: ["105304"], detailhash: "private",
      },
      providers: [{
        id: "ollama", modelCount: "105304", status: "connected", detailhash: "private",
      }, ["private"], { id: "private-provider" }],
      tenants: { connectedCount: "32", hasActiveTenant: true, displayName: "Private Name" },
      agents: { installedCount: "1-10", registryCount: " 105304 ", scheduledCount: 0 },
      registry: { lastRefresh: "1-24h" },
      scheduler: { lastWakeAt: "<1h", lastSuccessAt: "future", nextDueAt: "future", wakeAt: "105304" },
      runs: {
        total: "1-10", latestRunAt: "1-7d",
        byStatus: { completed: "3", failed: ["14"], private: 12 },
        byTrigger: { schedule: "11-100", displayName: "Private Name" },
      },
      recentFailures: [
        { agentSlug: "compliance-overview", queuedAt: "<1h", finishedAt: "<1h", runIdHash: "private" },
        { agentSlug: "local", errorCategory: "timeout", error_hash: "private" },
        { agentSlug: "private-agent", errorCategory: "auth" },
      ],
      graphCache: {
        resourceCount: "3", available: true,
        schedule: {
          intervalMinutes: "30", enabled: true, updatedAt: "7-30d",
          lastRunAt: "1-24h", lastSuccessAt: "1-7d", nextRunAt: "future", nextRefreshAt: "105304",
        },
        resources: [
          { resource: "users", rows: "105304", Rows: 742, totalRows: 742, tenantTotal: 742, refreshedAt: "<1h" },
          { resource: "managedDevices", rows: "101-1000", pages: ["13"], displayName: "Private Name" },
          { resource: "private-source", rows: 42 },
          ["105304"],
        ],
      },
    },
  }, publicSlugs);
  assert.deepEqual(diagnostics, {
    schemaVersion: 2,
    createdAt: "2026-11-24",
    issueContext: { source: "settings-about", hasExpectedBehavior: true, agentSlug: "compliance-overview" },
    app: {
      version: "0.8.0-nightly.20261124123456", packaged: true, processArch: "x64",
      osRelease: "6.8.0", node: "22.0.0", v8: "13.0.245.25-electron.0",
    },
    privacy: { promptsIncluded: false },
    state: {
      providers: [{ id: "ollama", status: "connected", modelCount: "10001+" }],
      tenants: { connectedCount: "11-100", hasActiveTenant: true },
      agents: { installedCount: "1-10", registryCount: "10001+", scheduledCount: "0" },
      registry: { lastRefresh: "1-24h" },
      scheduler: { lastWakeAt: "<1h", nextDueAt: "future" },
      runs: { total: "1-10", latestRunAt: "1-7d", byStatus: { completed: "1-10" }, byTrigger: { schedule: "11-100" } },
      recentFailures: [
        { agentSlug: "compliance-overview", queuedAt: "<1h", finishedAt: "<1h" },
        { agentSlug: "local", errorCategory: "timeout" },
        { errorCategory: "auth" },
      ],
      graphCache: {
        available: true, resourceCount: "1-10",
        schedule: {
          enabled: true, intervalMinutes: "11-100", updatedAt: "7-30d",
          lastRunAt: "1-24h", lastSuccessAt: "1-7d", nextRunAt: "future",
        },
        resources: [
          { resource: "users", rows: "10001+", refreshedAt: "<1h" },
          { resource: "managedDevices", rows: "101-1000" },
        ],
      },
    },
  });
  assert.deepEqual(publicDiagnostics(diagnostics, publicSlugs), diagnostics);
});

test("rejects oversized diagnostics before formatting unknown fields", () => {
  assert.throws(
    () => formatSupportIssue({ issue, diagnostics: { unknown: "x".repeat(40_001) } }),
    (error) => error instanceof SupportIssueSizeError && error.status === 413,
  );
});

test("issue preview formats redacted text and can verify an exact title and body", () => {
  const result = formatSupportIssue({
    issue: {
      ...issue,
      title: "Cache error for sample@example.invalid",
      description: "The Data settings page stayed blank.",
    },
  });
  assert.ok("payload" in result);
  const { title, body } = result.payload;
  assert.equal(title, "[Support] Cache error for [email]");
  assert.ok(body.includes("### What happened\nThe Data settings page stayed blank."));
  assert.ok(body.includes("### Diagnostics\n_Not included._"));
  assert.notEqual(supportIssuePreviewDigest(title, body), supportIssuePreviewDigest(title, body.trimEnd()));
});
