import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { RetrievalIndex, repairFrontMatter, type EmbedQuery } from "./retrieval.js";

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
  it("reads the page title from front matter an older index build left in the first chunk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-retrieval-"));
    try {
      const frontMatter = "---\ntitle: Configure Splashtop for Single sign-on with Microsoft Entra ID\nms.topic: how-to\n# Customer intent: As an IT administrator, I want to learn how to configure single sign-on.\n--- \n\n";
      const comment = "Customer intent: As an IT administrator, I want to learn how to configure single sign-on.";
      await writeIndex(dir, [[1, 0], [0.9, 0.1], [0, 1]], [
        { file: "entra/splashtop-tutorial.md", title: comment, text: `${frontMatter}# Configure Splashtop for Single sign-on with Microsoft Entra ID\n\nIn this article, you learn how.` },
        { file: "entra/splashtop-tutorial.md", title: comment, text: "## Prerequisites\n\nA Splashtop subscription." },
        { file: "intune/table.md", title: "A table", text: "---|---\n| a | b |\n---\n" },
      ]);
      const hits = await new RetrievalIndex(dir).retrieve("splashtop", async () => [1, 0], { k: 3 });
      assert.deepEqual(hits.map((hit) => hit.title), ["Configure Splashtop for Single sign-on with Microsoft Entra ID", "Configure Splashtop for Single sign-on with Microsoft Entra ID", "A table"]);
      assert.equal(hits[0]!.text, "# Configure Splashtop for Single sign-on with Microsoft Entra ID\n\nIn this article, you learn how.");
      assert.equal(hits[1]!.text, "## Prerequisites\n\nA Splashtop subscription.");
      assert.equal(hits[2]!.text, "---|---\n| a | b |\n---\n", "a table or rule that starts with dashes is not front matter");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("repairs quoted titles, a BOM and CRLF front matter, and leaves chunks without front matter alone", () => {
    const untouched = [{ file: "a.md", title: "A", text: "# A\n\nText." }];
    assert.equal(repairFrontMatter(untouched)[0], untouched[0]);
    const [quoted] = repairFrontMatter([{ file: "b.md", title: "b.md", text: "\uFEFF---\r\ntitle: \"Set up enrollment\"\r\nms.date: 01/01/2026\r\n---\r\n# Set up\r\n" }]);
    assert.equal(quoted!.title, "Set up enrollment");
    assert.equal(quoted!.text, "# Set up\r\n");
    // Front matter without a title keeps the title the index gave.
    const [untitled] = repairFrontMatter([{ file: "c.md", title: "Kept", text: "---\nms.topic: how-to\n---\nBody" }]);
    assert.deepEqual([untitled!.title, untitled!.text], ["Kept", "Body"]);
    // A title read from a YAML comment, with no front matter title: the first heading, else the file path.
    const comment = "Customer intent: As an admin, I want single sign-on.";
    const [headed, tail] = repairFrontMatter([
      { file: "d.md", title: comment, text: `---\nms.topic: how-to\n# ${comment}\n---\n# Configure single sign-on\n\nText.` },
      { file: "d.md", title: comment, text: "## Steps" },
    ]);
    assert.deepEqual([headed!.title, tail!.title], ["Configure single sign-on", "Configure single sign-on"]);
    assert.equal(repairFrontMatter([{ file: "e.md", title: comment, text: `---\nms.topic: how-to\n# ${comment}\n---\nNo heading here.` }])[0]!.title, "e.md");
    // Front matter that opens with the comment is still front matter.
    const [opened] = repairFrontMatter([{ file: "f.md", title: comment, text: `---\n# ${comment}\ntitle: Configure single sign-on\n---\nBody` }]);
    assert.deepEqual([opened!.title, opened!.text], ["Configure single sign-on", "Body"]);
  });

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
