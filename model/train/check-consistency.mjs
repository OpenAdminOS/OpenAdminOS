#!/usr/bin/env node
// Format-consistency gate for a training set.
//
// Two runs were lost to the same class of bug: different tracks teaching
// different shapes for the same construct. The model produced substantively
// correct answers and failed anyway.
//   - r10/r11: track B taught {method, path, scopes:[]} while track L taught
//     "scope" or omitted it. Graph planning fell 10/16 -> 5/16.
//   - 8b-r4:   older tracks emitted tool_calls without an id, newer ones with
//     one. 51 of 60 trajectory tasks died on a tool-call parse error.
//
// Run this before every training run. It is cheaper than a GPU hour.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2];
if (!file) { console.error("usage: check-consistency.mjs <train-file.jsonl>"); process.exit(2); }
const rows = readFileSync(join(HERE, "../data/sft", file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const problems = [];
const seen = (label, set) => {
  if (set.size > 1) problems.push(`${label}: ${set.size} different shapes -> ${[...set].join("  |  ")}`);
};

// 1. tool-call structure
const tcShapes = new Set();
for (const r of rows) for (const m of r.messages ?? []) for (const tc of m.tool_calls ?? [])
  tcShapes.add(Object.keys(tc).sort().join("+") + "/args:" + typeof tc.function?.arguments);
seen("tool_call shape", tcShapes);

// 2. fenced JSON plan key sets
const planKeys = new Set();
for (const r of rows) for (const m of r.messages ?? []) {
  if (m.role !== "assistant" || typeof m.content !== "string") continue;
  const fence = m.content.match(/```json\s*([\s\S]*?)```/);
  if (!fence) continue;
  try { planKeys.add(Object.keys(JSON.parse(fence[1])).sort().join(",")); } catch { planKeys.add("UNPARSEABLE"); }
}
seen("json plan key set", planKeys);

// 3. benchmark contamination. The five held-out endpoints exist so the eval
// can measure generalisation to Graph surface the model was never taught.
// Training on any of them silently inflates every future score.
const HELD_OUT = ["namedLocations", "deviceEnrollmentConfigurations", "mobileAppCategories", "directoryRoles", "/domains"];
const raw = rows.map((r) => JSON.stringify(r)).join("\n");
for (const h of HELD_OUT) {
  const n = raw.split(h).length - 1;
  if (n) problems.push(`CONTAMINATION: held-out eval endpoint "${h}" appears ${n}x in training data`);
}

// 4. identity. A model that claims to be a different model is a support
// problem and an honesty problem; r5 shipped 2,267 examples asserting the
// wrong identity because a chat template injected it silently.
// "gpt-oss" is CORRECT for the 20B line and WRONG for the 8B line, so only
// flag it on Mistral-rendered files. A check that raises false alarms is a
// check people learn to ignore.
const isSmallTier = /train-mini/.test(file);
const identityBad = isSmallTier ? ["gpt-oss", "You are ChatGPT"] : ["You are ChatGPT"];
for (const bad of identityBad) {
  const n = raw.split(bad).length - 1;
  if (n) problems.push(`identity leak: "${bad}" appears ${n}x (wrong base model for this tier)`);
}

// 5. safety floor. Write-refusal behaviour is a hard product constraint, so a
// dataset that has lost it should never reach a GPU.
const safety = rows.filter((r) => /can't apply that change|cannot apply that change/i.test(JSON.stringify(r))).length;
if (safety < 20) problems.push(`only ${safety} write-safety examples (expected >= 20)`);

// 6. role vocabulary
const roles = new Set();
for (const r of rows) for (const m of r.messages ?? []) roles.add(m.role);
const allowed = new Set(["system", "user", "assistant", "tool"]);
for (const r of roles) if (!allowed.has(r)) problems.push(`unexpected role: ${r}`);

console.log(`checked ${rows.length} examples`);
console.log(`  tool_call shapes: ${tcShapes.size}`);
console.log(`  json plan key sets: ${planKeys.size} (${[...planKeys].join(" | ") || "none"})`);
console.log(`  write-safety examples: ${safety}`);
console.log(`  held-out endpoints leaked: ${HELD_OUT.filter((h) => raw.includes(h)).length}`);
if (problems.length) {
  console.error("\nINCONSISTENT SUPERVISION — fix before training:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("consistent: every track teaches the same shape for the same construct");
