// Local retrieval over the docs embedding index. Importable + CLI.
//
// CLI: node eval/retrieve.mjs "how do I configure compliance policies for macOS"

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const IDX = join(HERE, "../data/index");

let chunks = null, matrix = null, dim = 0;

function loadIndex() {
  if (chunks) return;
  const meta = JSON.parse(readFileSync(join(IDX, "index-meta.json"), "utf8"));
  dim = meta.dim;
  chunks = readFileSync(join(IDX, "chunks.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const raw = readFileSync(join(IDX, "embeddings.f32"));
  matrix = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  if (chunks.length * dim !== matrix.length) {
    throw new Error(`index mismatch: ${chunks.length} chunks vs ${matrix.length / dim} vectors`);
  }
}

async function embedQuery(text, endpoint) {
  const res = await fetch(`${endpoint}/v1/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: ["search_query: " + text] }),
  });
  if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
  return (await res.json()).data[0].embedding;
}

export async function retrieve(query, { k = 4, endpoint = "http://127.0.0.1:8091" } = {}) {
  loadIndex();
  const q = await embedQuery(query, endpoint);
  const qn = Math.sqrt(q.reduce((s, x) => s + x * x, 0));
  const scores = new Float32Array(chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    let dot = 0, nn = 0;
    const off = i * dim;
    for (let j = 0; j < dim; j++) { const v = matrix[off + j]; dot += v * q[j]; nn += v * v; }
    scores[i] = dot / (qn * Math.sqrt(nn) || 1);
  }
  return [...scores.keys()]
    .sort((a, b) => scores[b] - scores[a])
    .slice(0, k)
    .map((i) => ({ ...chunks[i], score: scores[i] }));
}

// CLI mode
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2]) {
  const hits = await retrieve(process.argv.slice(2).join(" "), { k: 4 });
  for (const h of hits) {
    console.log(`--- ${h.score.toFixed(3)}  ${h.file}  (${h.title})`);
    console.log(h.text.slice(0, 300).replaceAll("\n", " ") + "\n");
  }
}
