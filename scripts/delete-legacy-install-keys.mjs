#!/usr/bin/env node
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const legacyId = /^(?:[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const batchSize = 100;
const patterns = [
  {
    match: "oa:installs7d:*",
    accepts: (key) => {
      const [, , agent, extra] = key.split(":");
      return key.startsWith("oa:installs7d:") && extra === undefined &&
        typeof agent === "string" && agent.length <= 64 && slug.test(agent);
    },
  },
  {
    match: "oa:dedup:*:*",
    accepts: (key) => {
      const [, , id, agent, extra] = key.split(":");
      return key.startsWith("oa:dedup:") && extra === undefined &&
        typeof id === "string" && legacyId.test(id) &&
        typeof agent === "string" && agent.length <= 64 && slug.test(agent);
    },
  },
];

export async function deleteLegacyInstallKeys(redis, { apply = false } = {}) {
  const found = new Set();
  for (const { match, accepts } of patterns) {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, { match, count: batchSize });
      cursor = String(next);
      for (const key of keys) {
        if (accepts(key)) found.add(key);
      }
    } while (cursor !== "0");
  }

  let deleted = 0;
  if (apply) {
    // Finish both scans before changing the keyspace.
    const keys = [...found];
    for (let offset = 0; offset < keys.length; offset += batchSize) {
      deleted += await redis.del(...keys.slice(offset, offset + batchSize));
    }
  }
  return { matched: found.size, deleted };
}

async function main(args) {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--apply")) {
    console.error("Usage: node scripts/delete-legacy-install-keys.mjs [--apply]");
    process.exitCode = 1;
    return;
  }
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.error("Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.");
    process.exitCode = 1;
    return;
  }

  const require = createRequire(new URL("../web/package.json", import.meta.url));
  const { Redis } = require("@upstash/redis");
  const apply = args[0] === "--apply";
  const { matched, deleted } = await deleteLegacyInstallKeys(
    new Redis({ url, token, automaticDeserialization: false }),
    { apply },
  );
  console.log(`Matched ${matched} legacy keys. Deleted ${deleted}.`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch(() => {
    // Redis errors can include keys, so keep operational output free of identifiers.
    console.error("Legacy install key cleanup failed. Check the web dependencies, Redis connection and permissions.");
    process.exitCode = 1;
  });
}
