import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createHash } from "node:crypto";

import {
  downloadIndex,
  installIndexFromDirectory,
  parseChecksums,
  validateIndexDirectory,
} from "./install.js";

async function writeIndex(dir: string, chunks: number, dim = 3): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "index-meta.json"),
    JSON.stringify({ dim, embeddingModel: "nomic-embed-text", builtAt: "2026-08-31", chunkCount: chunks }),
  );
  await writeFile(
    join(dir, "chunks.jsonl"),
    Array.from({ length: chunks }, (_, i) => JSON.stringify({ file: `d${i}.md`, text: `t${i}` })).join("\n") + "\n",
  );
  await writeFile(join(dir, "embeddings.f32"), Buffer.from(new Float32Array(chunks * dim).buffer));
}

describe("documentation index install", () => {
  it("installs a valid index from a local folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "oaos-idx-"));
    try {
      const src = join(root, "src");
      await writeIndex(src, 4);
      const result = await installIndexFromDirectory({ sourceDir: src, targetDir: join(root, "installed") });
      assert.equal(result.chunkCount, 4);
      assert.equal(result.embeddingModel, "nomic-embed-text");
      assert.ok(existsSync(join(root, "installed", "embeddings.f32")));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses an index whose vectors do not match its chunks", async () => {
    const root = await mkdtemp(join(tmpdir(), "oaos-idx-"));
    try {
      const src = join(root, "src");
      await writeIndex(src, 4);
      // Simulate a truncated download.
      await writeFile(join(src, "embeddings.f32"), Buffer.from(new Float32Array(2 * 3).buffer));
      await assert.rejects(validateIndexDirectory(src), /inconsistent|truncated/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the working index when a new install fails validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "oaos-idx-"));
    try {
      const target = join(root, "installed");
      const good = join(root, "good");
      await writeIndex(good, 3);
      await installIndexFromDirectory({ sourceDir: good, targetDir: target });

      const broken = join(root, "broken");
      await writeIndex(broken, 3);
      await writeFile(join(broken, "embeddings.f32"), Buffer.from(new Float32Array(1).buffer));
      await assert.rejects(
        installIndexFromDirectory({ sourceDir: broken, targetDir: target }),
      );

      // The previously working index must still be intact and loadable.
      const meta = JSON.parse(await readFile(join(target, "index-meta.json"), "utf8"));
      assert.equal(meta.chunkCount, 3);
      await validateIndexDirectory(target);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats a short download as truncated instead of installing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "oaos-idx-"));
    try {
      const fetchImpl = (async (url: string) => {
        const name = String(url).split("/").pop()!;
        const body =
          name === "index-meta.json"
            ? Buffer.from(JSON.stringify({ dim: 3, embeddingModel: "nomic-embed-text", builtAt: "x", chunkCount: 2 }))
            : Buffer.from("short");
        return new Response(body, { headers: { "content-length": "9999" } });
      }) as unknown as typeof fetch;

      await assert.rejects(
        downloadIndex({ baseUrl: "https://example.test/idx", targetDir: join(root, "installed"), fetchImpl }),
        /truncated/i,
      );
      assert.equal(existsSync(join(root, "installed")), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("published index integrity", () => {
  it("discards a file whose hash does not match the published manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "oaos-idx-"));
    try {
      const meta = JSON.stringify({ dim: 3, count: 1, when: "2026-08-31" });
      const chunks = JSON.stringify({ file: "a.md", text: "a" }) + "\n";
      const vectors = Buffer.from(new Float32Array(3).buffer);
      // A manifest that matches meta and chunks, but not the vectors:
      // exactly the shape of a corrupted or substituted asset.
      const sha = (b: Buffer | string) =>
        createHash("sha256").update(b).digest("hex");
      const manifest = [
        `${sha(meta)}  index-meta.json`,
        `${sha(chunks)}  chunks.jsonl`,
        `${"0".repeat(64)}  embeddings.f32`,
      ].join("\n");

      const fetchImpl = (async (url: string) => {
        const name = String(url).split("/").pop()!;
        if (name === "SHA256SUMS.txt") return new Response(manifest);
        if (name === "index-meta.json") return new Response(meta);
        if (name === "chunks.jsonl") return new Response(chunks);
        return new Response(vectors);
      }) as unknown as typeof fetch;

      await assert.rejects(
        downloadIndex({
          baseUrl: "https://example.test/idx",
          targetDir: join(root, "installed"),
          fetchImpl,
        }),
        /checksum|tampered|corrupted/i,
      );
      assert.equal(existsSync(join(root, "installed")), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads a standard sha256sum manifest", () => {
    const parsed = parseChecksums(
      `${"a".repeat(64)}  chunks.jsonl\n${"b".repeat(64)} *embeddings.f32\n# comment\n`,
    );
    assert.equal(parsed.get("chunks.jsonl"), "a".repeat(64));
    assert.equal(parsed.get("embeddings.f32"), "b".repeat(64));
    assert.equal(parsed.size, 2);
  });
});
