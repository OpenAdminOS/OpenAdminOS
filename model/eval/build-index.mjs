#!/usr/bin/env node
// Build a local embedding index over the Microsoft Learn Intune docs.
//
// Chunks every markdown file by heading, embeds chunks with a llama-server
// --embedding endpoint (nomic-embed-text), and writes:
//   data/index/chunks.jsonl    one metadata+text record per chunk
//   data/index/embeddings.f32  packed Float32 vectors, same order
//
// Usage: node eval/build-index.mjs [--docs <dir>] [--endpoint http://127.0.0.1:8091]

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, createWriteStream } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const args = process.argv.slice(2);
const argOf = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const CORPORA = [
  { label: "intune", dir: join(ROOT, "data/docs-memdocs/intune") },
  { label: "entra", dir: join(ROOT, "data/docs-entra/docs") },
  { label: "defender", dir: join(ROOT, "data/docs-defender") },
];
const ENDPOINT = argOf("--endpoint", "http://127.0.0.1:8091");
const OUT = join(ROOT, "data/index");
const BATCH = 32;
const MAX_CHARS = 2400;   // ~600 tokens per chunk
const MIN_CHARS = 120;    // drop crumbs

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (name.endsWith(".md")) yield p;
  }
}

function stripFrontmatter(text) {
  const m = text.match(/^---\n[\s\S]*?\n---\n/);
  return m ? text.slice(m[0].length) : text;
}

function chunkMarkdown(text) {
  // Split on headings; merge tiny sections forward; hard-split oversized ones.
  const sections = text.split(/^(?=#{1,3} )/m);
  const chunks = [];
  let buf = "";
  for (const s of sections) {
    if ((buf + s).length <= MAX_CHARS) { buf += s; continue; }
    if (buf.trim().length >= MIN_CHARS) chunks.push(buf.trim());
    if (s.length <= MAX_CHARS) { buf = s; continue; }
    for (let i = 0; i < s.length; i += MAX_CHARS) chunks.push(s.slice(i, i + MAX_CHARS).trim());
    buf = "";
  }
  if (buf.trim().length >= MIN_CHARS) chunks.push(buf.trim());
  return chunks.filter((c) => c.length >= MIN_CHARS);
}

async function embedBatch(texts) {
  const res = await fetch(`${ENDPOINT}/v1/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: texts.map((t) => "search_document: " + t) }),
  });
  if (!res.ok) throw new Error(`embed HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return body.data.map((d) => d.embedding);
}

mkdirSync(OUT, { recursive: true });
const metaOut = createWriteStream(join(OUT, "chunks.jsonl"));
const vecOut = createWriteStream(join(OUT, "embeddings.f32"));

let files = 0, total = 0, dim = 0;
let pendingTexts = [], pendingMeta = [];

async function flush() {
  if (!pendingTexts.length) return;
  const vecs = await embedBatch(pendingTexts);
  for (let i = 0; i < vecs.length; i++) {
    dim = vecs[i].length;
    metaOut.write(JSON.stringify(pendingMeta[i]) + "\n");
    vecOut.write(Buffer.from(new Float32Array(vecs[i]).buffer));
    total++;
  }
  pendingTexts = []; pendingMeta = [];
}

for (const { label, dir } of CORPORA) {
  for (const file of walk(dir)) {
    const rel = `${label}/${relative(dir, file)}`;
    let text;
    try { text = stripFrontmatter(readFileSync(file, "utf8")); } catch { continue; }
    const title = (text.match(/^# (.+)$/m) ?? [])[1] ?? rel;
    for (const chunk of chunkMarkdown(text)) {
      pendingTexts.push(chunk);
      pendingMeta.push({ file: rel, title, text: chunk });
      if (pendingTexts.length >= BATCH) await flush();
    }
    files++;
    if (files % 200 === 0) console.log(`${files} files, ${total} chunks embedded...`);
  }
  console.log(`corpus '${label}' done: ${files} files so far, ${total} chunks`);
}
await flush();
await new Promise((r) => metaOut.end(r));
await new Promise((r) => vecOut.end(r));
writeFileSync(join(OUT, "index-meta.json"), JSON.stringify({ dim, count: total, corpora: CORPORA.map((c) => c.label), when: new Date().toISOString() }));
console.log(`DONE: ${files} files, ${total} chunks, dim ${dim}`);
