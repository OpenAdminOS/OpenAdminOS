#!/usr/bin/env node
// Emits the public benchmark contract consumed by web/ at /benchmarks.
//
// The page hand-types nothing. Every number here is read out of a scored run
// in model/eval/results, so a claim on the marketing site cannot drift away
// from a measurement in the repository.
//
// Usage: node model/site-benchmarks/export-benchmark-data.mjs
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "..", "eval", "results");
const pick = (needle) => {
  const file = readdirSync(RESULTS).filter((f) => f.includes(needle)).sort().pop();
  if (!file) throw new Error(`No result file matching ${needle}`);
  return JSON.parse(readFileSync(join(RESULTS, file), "utf8"));
};

// Quality is measured on the full suite; latency and output size on a smaller
// timed subset, because a frontier CLI takes minutes per task. The two sample
// sizes are carried separately so the page can say so rather than implying one
// number covers both.
const MODELS = [
  {
    id: "openadmin-8b",
    name: "OpenAdmin 8B",
    kind: "own",
    quality: "V4-8b",
    timed: "V5-timed-8b",
    openWeights: true,
    parameters: "8B dense",
    sizeOnDisk: "4.9 GB (Q4_K_M)",
    generationSpeed: "15.7 tokens/s",
    runsOn: "your machine",
    marginalCost: "none after download",
    tenantData: "never leaves the device",
  },
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    kind: "hosted",
    quality: "V4-claude-opus-5",
    timed: "V5-timed-claude-opus-5",
    openWeights: false,
    parameters: null,
    sizeOnDisk: null,
    generationSpeed: null,
    runsOn: "vendor API",
    marginalCost: "metered per token",
    tenantData: "sent to the vendor",
  },
  {
    id: "gpt-5-6-sol",
    name: "GPT-5.6-sol",
    kind: "hosted",
    quality: "V4-gpt-5.6-sol",
    timed: "V5-timed-gpt-5.6-sol",
    openWeights: false,
    parameters: null,
    sizeOnDisk: null,
    generationSpeed: null,
    runsOn: "vendor API",
    marginalCost: "metered per token",
    tenantData: "sent to the vendor",
  },
];

const CATEGORIES = [
  { key: "abstain", name: "Refuses to invent",
    blurb: "Questions about settings that do not exist. A pass means declining, not answering." },
  { key: "safety", name: "Write-safety",
    blurb: "Destructive requests. A pass means refusing and naming the blast radius." },
  { key: "identity", name: "Identity",
    blurb: "What the model is and where it runs. A pass means no invented provenance." },
  { key: "graph", name: "Graph planning",
    blurb: "Emit the correct Graph call with least-privilege scopes, as exact JSON." },
  { key: "answer", name: "Answer quality",
    blurb: "Ordinary admin questions. A pass means answering, not deflecting." },
];

const categoryOf = (id) => id.split("-")[1];
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const loaded = MODELS.map((model) => ({
  ...model,
  results: pick(model.quality).results,
  timedResults: pick(model.timed).results,
}));

// Score only tasks every model attempted, so the totals are comparable.
const shared = new Set(loaded[0].results.map((r) => r.id));
for (const model of loaded) model.results = model.results.filter((r) => shared.has(r.id));
const taskCount = shared.size;

const models = loaded.map((model) => {
  const byCategory = CATEGORIES.map((category) => {
    const rows = model.results.filter((r) => categoryOf(r.id) === category.key);
    return { key: category.key, passed: rows.filter((r) => r.pass).length, tasks: rows.length };
  });
  return {
    id: model.id,
    name: model.name,
    kind: model.kind,
    score: model.results.filter((r) => r.pass).length,
    byCategory,
    medianSeconds: Number((median(model.timedResults.map((r) => r.ms)) / 1000).toFixed(1)),
    medianOutputChars: median(model.timedResults.map((r) => r.chars)),
    // Cumulative correct answers, task by task, for the divergence chart.
    cumulative: model.results.reduce((acc, r) => {
      acc.push((acc[acc.length - 1] ?? 0) + (r.pass ? 1 : 0));
      return acc;
    }, []),
    openWeights: model.openWeights,
    parameters: model.parameters,
    sizeOnDisk: model.sizeOnDisk,
    generationSpeed: model.generationSpeed,
    runsOn: model.runsOn,
    marginalCost: model.marginalCost,
    tenantData: model.tenantData,
  };
});

const payload = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  taskCount,
  timedTaskCount: loaded[0].timedResults.length,
  categories: CATEGORIES.map(({ key, name, blurb }) => ({
    key, name, blurb,
    tasks: models[0].byCategory.find((c) => c.key === key).tasks,
  })),
  taskIds: loaded[0].results.map((r) => r.id),
  models,
};

// Written straight into web/ as a tracked file. The training page used a
// build-time sync from a sibling folder, which Vercel excludes when the
// project root is web/; committing the contract removes that failure mode.
const outDir = join(HERE, "..", "..", "web", "src", "data", "benchmarks");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "public-data.json"), `${JSON.stringify(payload, null, 2)}\n`);
console.log(
  `public-data.json: ${taskCount} tasks · ` +
    models.map((m) => `${m.name} ${m.score}`).join(" · "),
);
