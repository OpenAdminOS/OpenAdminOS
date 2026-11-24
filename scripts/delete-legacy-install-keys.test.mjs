import assert from "node:assert/strict";
import test from "node:test";

import { deleteLegacyInstallKeys } from "./delete-legacy-install-keys.mjs";

const slug = "sample-agent";
const digest = "ab".repeat(32);
const uuid = "12345678-abcd-4321-89ab-0123456789ab";
const oldSet = `oa:installs7d:${slug}`;
const oldDigest = `oa:dedup:${digest}:${slug}`;
const oldUuid = `oa:dedup:${uuid}:${slug}`;
const retained = [
  `oa:pending:installs:${slug}`,
  `oa:installs:day:2026-11-24:${slug}`,
  "oa:rate:install:example:1",
  "oa:rate:support-issue:example:1",
  `oa:dedup:support-issue:${digest}`,
  `${oldSet}:extra`,
  `${oldDigest}:extra`,
  `oa:dedup:other:${slug}`,
  "oa:slugs",
];

function fakeRedis() {
  const pages = [
    ["oa:installs7d:*", "0", ["17", [oldSet, ...retained]]],
    ["oa:installs7d:*", "17", ["0", [oldSet]]],
    ["oa:dedup:*:*", "0", ["12", []]],
    ["oa:dedup:*:*", "12", ["0", [oldDigest, oldUuid, ...retained]]],
  ];
  const keys = new Set([oldSet, oldDigest, oldUuid, ...retained]);
  return {
    keys,
    pages,
    async scan(cursor, { match }) {
      const [expectedMatch, expectedCursor, page] = pages.shift();
      assert.equal(match, expectedMatch);
      assert.equal(cursor, expectedCursor);
      return page;
    },
    async del(...batch) {
      assert.equal(pages.length, 0);
      assert.deepEqual(batch, [oldSet, oldDigest, oldUuid]);
      return batch.filter((key) => keys.delete(key)).length;
    },
  };
}

test("dry run counts each legacy key once without deleting anything", async () => {
  const redis = fakeRedis();
  assert.deepEqual(await deleteLegacyInstallKeys(redis), { matched: 3, deleted: 0 });
  assert.equal(redis.pages.length, 0);
  assert.equal(redis.keys.size, retained.length + 3);
});

test("apply deletes only matching legacy install keys after scanning all pages", async () => {
  const redis = fakeRedis();
  assert.deepEqual(await deleteLegacyInstallKeys(redis, { apply: true }), { matched: 3, deleted: 3 });
  assert.deepEqual([...redis.keys], retained);
});
