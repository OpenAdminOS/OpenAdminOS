#!/usr/bin/env node
// Re-score saved eval responses against the current task definitions and
// scorers, without re-running any model. Used after a scorer fix so past runs
// stay comparable. Usage: node eval/rescore.mjs <result-file-substring>...
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import { Ajv2020 } from "ajv/dist/2020.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addFormat("date-time", true); ajv.addFormat("uri", true);
const validateManifest = ajv.compile(JSON.parse(readFileSync(
  join(HERE, "../../schemas/agent-template.schema.json"), "utf8")));

function normalizeText(t) {
  return String(t).normalize("NFKC")
    .replace(/[‐-―−]/g, "-")
    .replace(/[     ]/g, " ")
    .replace(/[​-‍⁠﻿­]/g, "")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[ \t]+/g, " ");
}
const fence = (text, lang) => {
  const m = text.match(new RegExp("```[ \\t]*(?:" + lang + ")?[ \\t]*\\r?\\n([\\s\\S]*?)```", "i"));
  return m ? m[1] : text;
};
const canon = (v) => Array.isArray(v) ? v.map(canon)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;

const scorers = {
  // Response must contain YAML that (a) validates against the canonical
  // agent-template schema and (b) actually answers the request: right slug,
  // right Graph path and scope, right skill formats. Schema-validity alone
  // would accept any constant manifest, which makes the metric meaningless.
  "manifest-schema": (task, response) => {
    const yamlText = fence(response, "yaml");
    let parsed;
    try {
      parsed = parseYaml(yamlText);
    } catch (e) {
      return { pass: false, detail: `YAML parse error: ${e.message}` };
    }
    if (!validateManifest(parsed)) {
      return {
        pass: false,
        detail: (validateManifest.errors ?? []).slice(0, 5)
          .map((e) => `${e.instancePath || "/"} ${e.message}`).join("; "),
      };
    }
    const problems = [];
    const skills = Array.isArray(parsed?.skills) ? parsed.skills : [];
    const graphSkills = skills.filter((s) => s?.format === "graph");
    const paths = graphSkills.map((s) => String(s?.settings?.path ?? ""));
    const scopes = graphSkills.flatMap((s) => s?.settings?.scopes ?? []).map(String);
    if (task.mustSlug && parsed?.descriptor?.id !== task.mustSlug) {
      problems.push(`slug is '${parsed?.descriptor?.id}', expected '${task.mustSlug}'`);
    }
    if (task.mustMode && parsed?.descriptor?.mode !== task.mustMode) {
      problems.push(`mode is '${parsed?.descriptor?.mode}', expected '${task.mustMode}'`);
    }
    for (const p of task.mustPath ?? []) {
      if (!paths.some((x) => x === p)) problems.push(`no graph skill with path '${p}' (got ${paths.join(", ") || "none"})`);
    }
    for (const s of task.mustScope ?? []) {
      if (!scopes.includes(s)) problems.push(`missing scope '${s}' (got ${scopes.join(", ") || "none"})`);
    }
    for (const f of task.mustFormats ?? []) {
      if (!skills.some((s) => s?.format === f)) problems.push(`no skill with format '${f}'`);
    }
    return problems.length
      ? { pass: false, detail: `schema ok but does not match request: ${problems.join("; ")}` }
      : { pass: true, detail: "valid manifest matching the request" };
  },
  "json-exact": (task, r) => {
    let p; try { p = JSON.parse(fence(r, "json")); } catch (e) { return { pass: false, detail: `JSON parse error` }; }
    const pass = JSON.stringify(canon(p)) === JSON.stringify(canon(task.expected));
    return { pass, detail: pass ? "exact match" : `got ${JSON.stringify(p)}` };
  },
  contains: (task, r) => {
    const norm = normalizeText(r), lower = norm.toLowerCase();
    const missing = (task.mustContain ?? []).filter((s) => !lower.includes(normalizeText(s).toLowerCase()));
    const forbidden = (task.mustNotContain ?? []).filter((s) => lower.includes(normalizeText(s).toLowerCase()));
    const unmatched = (task.mustMatch ?? []).filter((p) => !new RegExp(p, "i").test(norm));
    const pass = !missing.length && !forbidden.length && !unmatched.length;
    return { pass, detail: pass ? "all constraints met" : `missing: [${missing}] forbidden-hit: [${forbidden}] unmatched: [${unmatched}]` };
  },
};

const tasks = new Map();
for (const f of readdirSync(join(HERE, "tasks")).filter((f) => f.endsWith(".yaml"))) {
  const t = parseYaml(readFileSync(join(HERE, "tasks", f), "utf8"));
  tasks.set(t.id, t);
}

for (const needle of process.argv.slice(2)) {
  const file = readdirSync(join(HERE, "results")).filter((f) => f.includes(needle)).sort().pop();
  if (!file) { console.log(`no result file matching ${needle}`); continue; }
  const data = JSON.parse(readFileSync(join(HERE, "results", file), "utf8"));
  let changed = 0, before = 0, after = 0;
  for (const r of data.results) {
    if (r.pass) before++;
    const task = tasks.get(r.id);
    if (!task || r.response == null) { if (r.pass) after++; continue; }
    const scorer = scorers[task.scorer];
    if (!scorer) { if (r.pass) after++; continue; }
    let out = scorer(task, r.response);
    // Preserve the trajectory rule: no successful tool call means failure.
    if (task.trajectory && (task.trajectory.requireToolCall ?? true) && (r.usefulCalls ?? 0) === 0) {
      out = { pass: false, detail: "no resolved tool call" };
    }
    if (out.pass !== r.pass) changed++;
    r.pass = out.pass; r.detail = out.detail;
    if (out.pass) after++;
  }
  data.rescored = { when: new Date().toISOString(), changed };
  writeFileSync(join(HERE, "results", file), JSON.stringify(data, null, 2));
  console.log(`${data.label}: ${before} -> ${after} (${changed} verdicts changed)`);
}
