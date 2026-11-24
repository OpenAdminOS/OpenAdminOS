import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { bucketSupportCount, formatSupportIssue, supportIssuePreviewDigest } from "./issue-format";

const issue = {
  title: "Cache shows a blank page",
  description: "Opening Data settings gives a blank page.",
  source: "settings-about",
  appVersion: "0.8.0",
};

test("the desktop and web formatters and their redaction rules match", () => {
  const desktop = "../../../../apps/desktop/electron/";
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.equal(
    read(`${desktop}support-issue-format.ts`).replace("./support-secret-redaction.js", "./secret-redaction"),
    read("./issue-format.ts"),
  );
  assert.equal(read(`${desktop}support-secret-redaction.ts`), read("./secret-redaction.ts"));
});

test("support count ranges are contiguous and become coarser", () => {
  assert.deepEqual(
    [0, 1, 10, 11, 100, 101, 1_000, 1_001, 10_000, 10_001].map(bucketSupportCount),
    ["0", "1-10", "1-10", "11-100", "11-100", "101-1000", "101-1000", "1001-10000", "1001-10000", "10001+"],
  );
});

test("public issues from older apps bucket nested counts and drop error hashes", () => {
  const result = formatSupportIssue({
    issue,
    diagnostics: {
      state: {
        activeProvider: { detailCategory: "timeout", detailHash: "1234567890abcdef" },
        graphCache: {
          schedule: { intervalMinutes: 30, lastErrorHash: "1234567890abcdef" },
          resources: [
            { resource: "managedDevices", rows: 745, pages: 13, tenantTotal: 831, pageLimitReached: true },
            { resource: "users", rows: 105_304, pages: "11-100", pageLimitReached: false },
          ],
        },
        tenants: { connectedCount: 3 },
        runs: { total: 32, byStatus: { failed: 13 }, byTrigger: { manual: 32 } },
        recentFailures: [{ errorCategory: "network", errorHash: "1234567890abcdef" }],
      },
    },
  });
  assert.ok("payload" in result);
  const json = /```json\n([\s\S]+?)\n```/.exec(result.payload.body)?.[1];
  assert.ok(json);
  assert.deepEqual(JSON.parse(json), {
    state: {
      activeProvider: { detailCategory: "timeout" },
      graphCache: {
        schedule: { intervalMinutes: 30 },
        resources: [
          { resource: "managedDevices", rows: "101-1000", pages: "11-100", tenantTotal: "101-1000", pageLimitReached: true },
          { resource: "users", rows: "10001+", pages: "11-100", pageLimitReached: false },
        ],
      },
      tenants: { connectedCount: "1-10" },
      runs: { total: "11-100", byStatus: { failed: "11-100" }, byTrigger: { manual: "11-100" } },
      recentFailures: [{ errorCategory: "network" }],
    },
  });
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
