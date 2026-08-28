#!/usr/bin/env node
// Harvest doc-fact eval tasks from the corpus. Base model phrases the
// question; acceptance is mechanical:
//   1. the fact value must appear in the source chunk (by construction),
//   2. the question must not leak the value,
//   3. retrieval(top-12) for the question must surface the source file.
// Usage: node eval/harvest-doc-tasks.mjs [--count 36]

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dump } from "js-yaml";
import { retrieve } from "./retrieve.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const COUNT = Number(args[args.indexOf("--count") + 1] || 36);
const ENDPOINT = "http://127.0.0.1:8090";

let seed = 777;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

const chunks = readFileSync(join(HERE, "../data/index/chunks.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

const FACT_RE = /\b(?:up to|maximum of|a maximum|at most|limited to|within|every|after|expires? (?:in|after)|retained for|at least)\s+([0-9][0-9,]*)\s*(days?|hours?|minutes?|devices?|users?|policies?|apps?|groups?|locations?|characters?|MB|GB)\b/i;

async function ask(system, user) {
  const res = await fetch(`${ENDPOINT}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0.6, max_tokens: 700 }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).choices[0].message.content ?? "";
}

const perCorpus = { intune: 0, entra: 0, defender: 0 };
const capPer = Math.ceil(COUNT / 3);
let made = 0, attempts = 0;

// Precompute fact-bearing candidates (random sampling over 55k chunks wastes
// ~99% of attempts; only ~1% match the fact pattern). Shuffle deterministically.
const candidates = chunks.filter((c) => c.text.length >= 400 && c.text.length <= 2200 && FACT_RE.test(c.text));
for (let i = candidates.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
}
console.log(`${candidates.length} fact-bearing candidate chunks`);

for (const chunk of candidates) {
  if (made >= COUNT) break;
  attempts++;
  const corpus = chunk.file.split("/")[0];
  if ((perCorpus[corpus] ?? 99) >= capPer) continue;
  const m = chunk.text.match(FACT_RE);
  const value = m[1], unit = m[2];

  let q;
  try {
    q = (await ask(
      "You write one short factual exam question for Microsoft 365 administrators. Reply with only the question, nothing else.",
      `Documentation excerpt:\n${chunk.text.slice(0, 1800)}\n\nWrite one question whose answer is "${value} ${unit}" according to this excerpt. The question must be answerable from the excerpt alone, must be specific about the feature it refers to, and must NOT contain the number ${value}.`,
    )).trim().split("\n")[0].replace(/^["']|["']$/g, "");
  } catch { continue; }

  if (!q || q.length < 25 || q.length > 280) continue;
  if (q.includes(value)) continue; // leaked answer

  // Fairness gate: retrieval must be able to find the source document.
  let hits;
  try { hits = await retrieve(q, { k: 12 }); } catch { continue; }
  if (!hits.some((h) => h.file === chunk.file)) continue;

  const numRe = value.includes(",")
    ? value.replace(",", "[,.]?")
    : `\\b${value}\\b`;
  write(made, corpus, {
    id: `harvest-${corpus}-${made}`,
    scorer: "contains",
    retrieval: { k: 12 },
    maxTokens: 300,
    system: "You are a Microsoft 365 administration assistant. Answer factually and concisely from the provided documentation excerpts.",
    prompt: q,
    mustMatch: [numRe],
    _source: { file: chunk.file, sentence: m[0], value: `${value} ${unit}` },
  });
  perCorpus[corpus] = (perCorpus[corpus] ?? 0) + 1;
  made++;
  if (made % 6 === 0) console.log(`${made}/${COUNT} harvested (${attempts} attempts)`);
}

function write(i, corpus, task) {
  writeFileSync(
    join(HERE, "tasks", `8${String(i).padStart(2, "0")}-harvest-${corpus}.yaml`),
    dump(task, { lineWidth: 90 }),
  );
}
console.log(`DONE: ${made} tasks, ${attempts} attempts, per corpus: ${JSON.stringify(perCorpus)}`);
