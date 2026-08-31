#!/usr/bin/env node
// Publish a documentation retrieval index as a GitHub release asset.
//
// GitHub release assets allow files just under 2 GiB and are downloaded
// without bandwidth limits or charges, which suits a ~264 MB index far
// better than the marketing site's host (Vercel caps static uploads at
// 100 MB on Hobby, and Blob egress is billed per GB).
//
// The index ships on its own tag so it can be rebuilt on the
// documentation's cadence without cutting an app release. The tag must
// match DEFAULT_INDEX_BASE_URL in apps/desktop/electron/retrieval/install.ts.
//
// Usage:
//   node scripts/publish-docs-index.mjs <index-dir> [tag]

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, join, resolve } from "node:path";

const FILES = ["index-meta.json", "chunks.jsonl", "embeddings.f32"];

const indexDir = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("Usage: node scripts/publish-docs-index.mjs <index-dir> [tag]");
  process.exit(2);
}

const meta = JSON.parse(await readFile(join(indexDir, "index-meta.json"), "utf8"));
const built = typeof meta.when === "string" ? meta.when : meta.builtAt;
const tag = process.argv[3] ?? `docs-index-${String(built).slice(0, 10)}`;

async function sha256(path) {
  return await new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolveHash(hash.digest("hex")));
  });
}

const lines = [];
let total = 0;
for (const file of FILES) {
  const path = join(indexDir, file);
  const info = await stat(path);
  total += info.size;
  if (info.size >= 2 * 1024 ** 3) {
    console.error(`${file} is ${info.size} bytes, over the 2 GiB release asset limit.`);
    process.exit(1);
  }
  lines.push(`${await sha256(path)}  ${basename(path)}`);
  console.log(`hashed ${file} (${(info.size / 1024 ** 2).toFixed(1)} MB)`);
}

const sumsPath = join(indexDir, "SHA256SUMS.txt");
await writeFile(sumsPath, lines.join("\n") + "\n");
console.log(`\nindex: ${meta.count ?? meta.chunkCount} chunks, dim ${meta.dim}, ${(total / 1024 ** 2).toFixed(0)} MB`);
console.log(`tag:   ${tag}`);

if (process.env.DRY_RUN === "1") {
  console.log("\nDRY_RUN=1, not publishing. Wrote SHA256SUMS.txt only.");
  process.exit(0);
}

const notes = `Documentation retrieval index.\n\n- ${meta.count ?? meta.chunkCount} chunks, ${meta.dim}-dimension vectors\n- Corpora: ${(meta.corpora ?? []).join(", ") || "unspecified"}\n- Built ${built}\n\nInstalled from Settings, or downloaded and installed from a folder on machines without network access. Verified against SHA256SUMS.txt.`;

const args = [
  "release", "create", tag,
  ...FILES.map((f) => join(indexDir, f)),
  sumsPath,
  "--title", `Documentation index ${String(built).slice(0, 10)}`,
  "--notes", notes,
];
console.log(`\ngh ${args.slice(0, 3).join(" ")} ...`);
const result = spawnSync("gh", args, { stdio: "inherit" });
process.exit(result.status ?? 1);
