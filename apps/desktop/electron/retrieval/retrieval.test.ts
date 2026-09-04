import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { RetrievalIndex, type EmbedQuery } from "./retrieval.js";

async function writeIndex(
  dir: string,
  vectors: number[][],
  chunks: Array<{ file: string; title?: string; text: string }>,
): Promise<void> {
  const dim = vectors[0]!.length;
  await writeFile(
    join(dir, "index-meta.json"),
    JSON.stringify({
      dim,
      embeddingModel: "nomic-embed-text-v1.5",
      builtAt: "2026-08-29T00:00:00.000Z",
      chunkCount: chunks.length,
    }),
  );
  await writeFile(
    join(dir, "chunks.jsonl"),
    chunks.map((chunk) => JSON.stringify(chunk)).join("\n") + "\n",
  );
  const flat = new Float32Array(vectors.flat());
  await writeFile(join(dir, "embeddings.f32"), Buffer.from(flat.buffer));
}

describe("local documentation retrieval", () => {
  it("ranks chunks by cosine similarity and carries provenance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-retrieval-"));
    try {
      await writeIndex(
        dir,
        [
          [1, 0, 0],
          [0, 1, 0],
          [0.9, 0.1, 0],
        ],
        [
          { file: "compliance.md", title: "Compliance", text: "compliance policies" },
          { file: "apps.md", title: "Apps", text: "app deployment" },
          { file: "compliance2.md", title: "Compliance 2", text: "more compliance" },
        ],
      );
      const index = new RetrievalIndex(dir);
      const embed: EmbedQuery = async () => [1, 0, 0];
      const hits = await index.retrieve("compliance question", embed, { k: 2 });
      assert.equal(hits.length, 2);
      assert.equal(hits[0]?.file, "compliance.md");
      assert.equal(hits[0]?.title, "Compliance");
      assert.equal(hits[1]?.file, "compliance2.md");
      assert.ok((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports an unavailable status and returns [] when the index is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-retrieval-"));
    try {
      const index = new RetrievalIndex(dir);
      const status = index.status();
      assert.equal(status.available, false);
      assert.match(status.reason ?? "", /not documentation-grounded/i);
      const hits = await index.retrieve("anything", async () => [1, 0, 0]);
      assert.deepEqual(hits, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a query embedding whose dimension does not match the index", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-retrieval-"));
    try {
      await writeIndex(dir, [[1, 0, 0]], [{ file: "a.md", text: "a" }]);
      const index = new RetrievalIndex(dir);
      await assert.rejects(
        index.retrieve("q", async () => [1, 0]),
        /does not match the index/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports available status with the build date and chunk count", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-retrieval-"));
    try {
      await writeIndex(
        dir,
        [
          [1, 0, 0],
          [0, 1, 0],
        ],
        [
          { file: "a.md", text: "a" },
          { file: "b.md", text: "b" },
        ],
      );
      const status = new RetrievalIndex(dir).status();
      assert.equal(status.available, true);
      assert.equal(status.chunkCount, 2);
      assert.equal(status.dim, 3);
      assert.equal(status.embeddingModel, "nomic-embed-text-v1.5");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
