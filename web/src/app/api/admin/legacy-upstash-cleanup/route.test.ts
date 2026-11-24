import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";

import { POST } from "./route";

const origin = "https://example.test";
const legacyUrl = "https://legacy-stats.example";

function configure(t: TestContext, url: string | undefined = legacyUrl, token = "legacy-test") {
  for (const [name, value] of Object.entries({
    CRON_SECRET: "cron-test",
    UPSTASH_REDIS_REST_URL: url,
    UPSTASH_REDIS_REST_TOKEN: token,
  })) {
    const previous = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
}

function request(query = "", authorization = "Bearer cron-test") {
  return new Request(`${origin}/api/admin/legacy-upstash-cleanup${query}`, {
    method: "POST", headers: { authorization },
  });
}

const pages: Record<string, [string, string[]]> = {
  "0": ["24", [
    "oa:pending:installs:sample-agent",
    "oa:dedup:support-issue:report-hash",
    "oa:dedup:legacy-install-id:sample-agent",
    "oa:rate:install:192.0.2.1:12",
    "another-project:preserve-me",
  ]],
  "24": ["0", [
    "oa:installs7d:sample-agent",
    "oa:installs:day:2026-11-24:sample-agent",
    "oa:pending:installs:sample-agent",
    "oa:slugs",
    "oa:private-website-key",
    "private-unprefixed-key",
  ]],
};

const counts = {
  "oa:pending:installs:*": 1,
  "oa:dedup:support-issue:*": 1,
  "oa:dedup:*": 1,
  "oa:rate:*": 1,
  other: 2,
  "oa:installs7d:*": 1,
  "oa:installs:day:*": 1,
  "oa:cache": 1,
  "oa:other": 1,
};

for (const apply of [false, true]) {
  test(apply ? "apply deletes website keys only" : "dry run scans all pages without deleting keys", async (t) => {
    configure(t);
    const scanCursors: string[] = [];
    const deletedKeys: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: string, options: RequestInit) => {
      assert.equal(input, legacyUrl);
      assert.equal(options.method, "POST");
      assert.equal(new Headers(options.headers).get("authorization"), "Bearer legacy-test");
      const [name, ...args] = JSON.parse(String(options.body)) as string[];
      if (name === "SCAN") {
        const [cursor] = args;
        assert.ok(cursor);
        scanCursors.push(cursor);
        assert.deepEqual(args.slice(1), ["MATCH", "*", "COUNT", "500"]);
        return Response.json({ result: pages[cursor] });
      }
      assert.equal(name, "DEL");
      assert.ok(apply);
      assert.ok(args.every((key) => key.startsWith("oa:")));
      deletedKeys.push(...args);
      return Response.json({ result: args.length });
    });

    const response = await POST(request(apply ? "?apply=1" : ""));
    assert.equal(response.status, 200);
    const result = await response.text();
    const websiteCounts = Object.fromEntries(Object.entries(counts).filter(([group]) => group.startsWith("oa:")));
    assert.deepEqual(JSON.parse(result), {
      ok: true, dryRun: !apply, complete: true, nextCursor: null, scanned: counts,
      deleted: apply ? websiteCounts : {},
    });
    assert.deepEqual(scanCursors, ["0", "24"]);
    assert.equal(deletedKeys.length, apply ? 8 : 0);
    assert.equal(new Set(deletedKeys).size, deletedKeys.length);
    for (const sensitive of ["sample-agent", "report-hash", "legacy-install-id", "192.0.2.1",
      "another-project", "preserve-me", "private-unprefixed-key", "oa:slugs", "private-website-key"]) {
      assert.equal(result.includes(sensitive), false);
    }
  });
}

test("cron auth is required and missing legacy settings return 503", async (t) => {
  configure(t, legacyUrl, "");
  t.mock.method(globalThis, "fetch", () => assert.fail("Request should not fetch"));
  assert.equal((await POST(request("?apply=1", ""))).status, 401);
  assert.equal((await POST(request("?apply=1", "Bearer cron-wrong"))).status, 401);
  assert.equal((await POST(request())).status, 503);
});

test("a timed-out scan can resume at the returned cursor", async (t) => {
  configure(t);
  const controller = new AbortController();
  const timeout = t.mock.method(AbortSignal, "timeout", () => controller.signal);
  t.mock.method(globalThis, "fetch", async (_: string, options: RequestInit) => {
    const [, cursor] = JSON.parse(String(options.body)) as string[];
    if (cursor === "0") return Response.json({ result: pages["0"] });
    if (options.signal === controller.signal) {
      controller.abort();
      throw controller.signal.reason;
    }
    return Response.json({ result: pages["24"] });
  });

  const first = await (await POST(request())).json();
  assert.equal(first.complete, false);
  assert.equal(first.nextCursor, "24");
  assert.equal(first.scanned["oa:pending:installs:*"], 1);
  timeout.mock.restore();

  const resumed = await (await POST(request(`?cursor=${first.nextCursor}`))).json();
  assert.equal(resumed.complete, true);
  assert.equal(resumed.nextCursor, null);
  assert.equal(resumed.scanned["oa:installs:day:*"], 1);
});
