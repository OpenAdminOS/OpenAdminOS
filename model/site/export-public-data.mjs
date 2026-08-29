#!/usr/bin/env node
// Emits site/public-data.json: the ONLY contract between the training
// pipeline and training.openadminos.com. The website reads this file and
// renders it; it never reads the pipeline's internals. Regenerate with:
//   node site/export-public-data.mjs
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const RES = join(ROOT, "eval/results");

const CATEGORIES = [
  ["Doc facts", (id) => /^(docs-|harvest-)/.test(id), "Factual questions whose answer is a specific value in Microsoft Learn, answered against the local docs index."],
  ["Reasoning", (id) => /(reasoning|posture|gen-reasoning)/.test(id), "Fleet arithmetic and date math over supplied device data."],
  ["Graph planning", (id) => /^(graph-query|gen-graph)/.test(id), "Produce the correct Microsoft Graph endpoint and least-privilege scope. Includes held-out endpoints never seen in training."],
  ["Trajectories", (id) => /^traj/.test(id), "Agentic tasks: call the tool, read returned tenant data, answer from it. Answering without a successful tool call fails."],
  ["Abstention", (id) => /abstain/.test(id), "Questions about features that do not exist. The correct answer is to say so."],
  ["Safety", (id) => /^safety-/.test(id), "Destructive requests must defer to human confirmation and never claim the action was performed."],
  ["Identity", (id) => /^identity-/.test(id), "Must identify as OpenAdmin fine-tuned from gpt-oss-20b."],
  ["Manifests", (id) => /^manifest/.test(id), "Draft an agent manifest that both validates against the schema and matches the request."],
  ["Voice", () => true, "Run summaries in the product's plain, factual voice."],
];
const catOf = (id) => CATEGORIES.find(([, f]) => f(id))[0];

const runs = existsSync(RES) ? readdirSync(RES).filter((f) => f.endsWith(".json")).sort() : [];
const byLabel = new Map();
for (const f of runs) {
  try {
    const d = JSON.parse(readFileSync(join(RES, f), "utf8"));
    byLabel.set(d.label, d);
  } catch { /* skip */ }
}

const suite200 = existsSync(join(ROOT, "eval/suites/suite-200.json"))
  ? new Set(JSON.parse(readFileSync(join(ROOT, "eval/suites/suite-200.json"), "utf8")).taskIds) : null;

function summarize(label) {
  const d = byLabel.get(label);
  if (!d) return null;
  const rows = suite200 ? d.results.filter((r) => suite200.has(r.id)) : d.results;
  if (!rows.length) return null;
  const cats = {};
  for (const r of rows) {
    const c = catOf(r.id);
    cats[c] ??= { passed: 0, total: 0 };
    cats[c].total++;
    if (r.pass) cats[c].passed++;
  }
  return {
    label,
    passed: rows.filter((r) => r.pass).length,
    total: rows.length,
    when: d.when,
    retrieval: d.provenance?.retrieval ?? null,
    suite: d.provenance?.suite ?? null,
    categories: cats,
  };
}

const runLog = existsSync(join(ROOT, "eval/runs.json"))
  ? JSON.parse(readFileSync(join(ROOT, "eval/runs.json"), "utf8")) : { runs: [], taskCategories: [], suites: [] };
const trainingRuns = runLog.runs ?? [];
const releasedRuns = trainingRuns.filter((run) => typeof run.released === "string" && /^v\d+(?:\.\d+){0,2}$/.test(run.released));
const releasedRun = releasedRuns[releasedRuns.length - 1];
if (!releasedRun) throw new Error("eval/runs.json has no released version marker");
const idx = existsSync(join(ROOT, "data/index/index-meta.json"))
  ? JSON.parse(readFileSync(join(ROOT, "data/index/index-meta.json"), "utf8")) : null;
const sft = {};
if (existsSync(join(ROOT, "data/sft"))) {
  for (const f of readdirSync(join(ROOT, "data/sft")).filter((f) => f.endsWith(".jsonl"))) {
    sft[f.replace(/^track-|\.jsonl$/g, "")] = readFileSync(join(ROOT, "data/sft", f), "utf8").split("\n").filter(Boolean).length;
  }
}

const scores = [...byLabel.keys()].map(summarize).filter(Boolean).sort((a, b) => b.passed - a.passed);

function checkpointOf(score) {
  const servedModel = byLabel.get(score.label)?.provenance?.servedModel;
  if (typeof servedModel !== "string") return null;
  const file = servedModel.split(/[\\/]/).pop().toLowerCase();
  if (file === "base.gguf" || /^gpt-oss-20b(?:-|\.gguf)/.test(file)) return "base";
  const run = file.match(/(?:^|[-_])(r\d+)(?=[-_.]|$)/);
  if (run) return run[1];
  if (file === "mini.gguf" && /^gpu-mini-ft-/.test(score.label)) return "lite-r1";
  return null;
}

function sameSuite(a, b) {
  return a?.name === b?.name && a?.sha256 === b?.sha256;
}

function newestScore(checkpoint, retrieval, suite = null) {
  return scores
    .filter((score) => checkpointOf(score) === checkpoint
      && score.retrieval === retrieval
      && score.suite !== null
      && (!suite || sameSuite(score.suite, suite)))
    .sort((a, b) => b.when.localeCompare(a.when))[0] ?? null;
}

function featuredSeries(key, name, score, note = null) {
  if (!score) return null;
  const noRetrieval = newestScore(checkpointOf(score), false, score.suite);
  return { key, name, scoreLabel: score.label, noRetrievalLabel: noRetrieval?.label ?? null, note };
}

// Featured is, in order: the base model's newest suite-scored retrieval run,
// the released version's newest one, and the best non-released checkpoint's
// newest one. Missing suite provenance omits a candidate; labels and task counts
// never stand in for an explicit suite.
// TODO(ugur): curate featured labels by hand if this rule picks wrong.
const baseScore = newestScore("base", true);
const releasedScore = newestScore(releasedRun.id, true);
const releasedIds = new Set(releasedRuns.map((run) => run.id));
const bestCheckpoint = trainingRuns
  .filter((run) => !releasedIds.has(run.id))
  .map((run) => ({ run, score: newestScore(run.id, true) }))
  .filter(({ score }) => score)
  .sort((a, b) => (b.score.passed / b.score.total) - (a.score.passed / a.score.total)
    || b.score.when.localeCompare(a.score.when))[0] ?? null;
const featured = [
  featuredSeries("base", "20B base", baseScore),
  featuredSeries("released", `20B published (${releasedRun.released})`, releasedScore, `Checkpoint ${releasedRun.id}.`),
  bestCheckpoint
    ? featuredSeries("best", `${bestCheckpoint.run.track === "8b" ? "8B" : "20B"} best`, bestCheckpoint.score, `Checkpoint ${bestCheckpoint.run.id}, not released.`)
    : null,
].filter(Boolean);

const out = {
  generatedAt: new Date().toISOString(),
  schemaVersion: 2,
  // Everything the public site is allowed to state as fact.
  model: {
    name: "OpenAdmin",
    baseModel: "openai/gpt-oss-20b",
    license: "Apache-2.0",
    published: { huggingface: "OpenAdminOS/openadmin-20b", gguf: "OpenAdminOS/openadmin-20b-GGUF", ollama: "openadminos/openadmin" },
    releasedVersion: releasedRun.released,
    quantized: "MXFP4",
    fileSizeGB: 12.1,
  },
  hardware: {
    measuredOn: "GMKtec NucBox K8 Plus (Ryzen 7 8845HS, 32GB RAM, Radeon 780M, no discrete GPU)",
    generationTokensPerSecond: 28,
    minimumRamGB: 16,
    recommendedRamGB: 32,
  },
  retrieval: idx ? { chunks: idx.count, corpora: idx.corpora, builtAt: idx.when, sources: "MicrosoftDocs memdocs (Intune), entra-docs, defender-docs — CC-BY-4.0" } : null,
  trainingData: { tracks: sft, total: Object.values(sft).reduce((a, b) => a + b, 0), policy: "100% synthetic and machine-validated. No tenant data. No distillation from proprietary APIs." },
  evalSuites: runLog.suites ?? [],
  taskCategories: CATEGORIES.map(([name, , what]) => ({ name, what })),
  trainingRuns,
  // Scores are only comparable within the same suite; each entry says which.
  scores,
  featured,
};

writeFileSync(join(HERE, "public-data.json"), JSON.stringify(out, null, 2));
console.log(`public-data.json: ${out.scores.length} scored runs, ${out.trainingRuns.length} documented training runs, ${out.trainingData.total} training examples`);
