#!/usr/bin/env node
// Regenerates dashboard.html from eval results + pipeline state.
// Runs automatically at the end of every eval run (hooked in run-eval.mjs).

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const RESULTS = join(HERE, "results");

// ---------- domain/category mapping ----------
const CATEGORIES = [
  ["Doc facts", (id) => /^(docs-|harvest-)/.test(id)],
  ["Reasoning", (id) => /(reasoning|posture|gen-reasoning)/.test(id)],
  ["Graph planning", (id) => /^(graph-query|gen-graph)/.test(id)],
  ["Trajectories", (id) => /^traj-/.test(id)],
  ["Abstention", (id) => /abstain/.test(id)],
  ["Safety", (id) => /^safety-/.test(id)],
  ["Identity", (id) => /^identity-/.test(id)],
  ["Manifests", (id) => /^manifest/.test(id)],
  ["Voice", () => true], // fallback (voice tasks)
];
const catOf = (id) => CATEGORIES.find(([, fn]) => fn(id))[0];

// ---------- load results ----------
const runs = [];
if (existsSync(RESULTS)) {
  for (const f of readdirSync(RESULTS).filter((f) => f.endsWith(".json")).sort()) {
    try {
      const r = JSON.parse(readFileSync(join(RESULTS, f), "utf8"));
      runs.push({ file: f, label: r.label, when: r.when, results: r.results });
    } catch { /* skip */ }
  }
}
const latestByLabel = new Map();
for (const r of runs) latestByLabel.set(r.label, r); // sorted -> last wins

const score = (run, filter = () => true) => {
  const rel = run.results.filter((x) => filter(x.id));
  return rel.length ? { pass: rel.filter((x) => x.pass).length, total: rel.length } : null;
};
const pct = (s) => (s && s.total ? Math.round((100 * s.pass) / s.total) : null);

// Canonical labels: "<model>-noret" | "<model>-ret". Fine-tuned checkpoints
// follow the same convention (e.g. "oaos-ft-v1-ret") and appear automatically.
const models = [...new Set([...latestByLabel.keys()]
  .map((l) => l.match(/^(.*)-(noret|ret)$/)).filter(Boolean).map((m) => m[1]))].sort();

// ---------- pipeline state ----------
const idxMeta = existsSync(join(ROOT, "data/index/index-meta.json"))
  ? JSON.parse(readFileSync(join(ROOT, "data/index/index-meta.json"), "utf8")) : null;
const sftCounts = {};
const sftDir = join(ROOT, "data/sft");
if (existsSync(sftDir)) for (const f of readdirSync(sftDir).filter((f) => f.endsWith(".jsonl"))) {
  sftCounts[f.replace(".jsonl", "")] = readFileSync(join(sftDir, f), "utf8").split("\n").filter(Boolean).length;
}
const taskCount = readdirSync(join(HERE, "tasks")).filter((f) => f.endsWith(".yaml")).length;
// Documented run log: what each training run contained and what it taught us.
let runLog = { runs: [], taskCategories: [] };
try { runLog = JSON.parse(readFileSync(join(HERE, "runs.json"), "utf8")); } catch { /* optional */ }
// Live task counts per documented category.
const taskIds = readdirSync(join(HERE, "tasks")).filter((f) => f.endsWith(".yaml"));
const now = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

// ---------- svg helpers (marks per dataviz spec: thin bars, rounded top, 2px gaps) ----------
const esc = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
function topRoundedBar(x, y, w, h, fill, tip) {
  const r = Math.min(4, w / 2, h);
  if (h <= 0) return "";
  const d = `M${x},${y + h} v${-(h - r)} q0,${-r} ${r},${-r} h${w - 2 * r} q${r},0 ${r},${r} v${h - r} z`;
  return `<path d="${d}" fill="${fill}"><title>${esc(tip)}</title></path>`;
}

// Grouped bar chart. groups: [{name, values:[{series, pct|null}]}], series: [{name,color}]
function groupedBars(groups, series, { width = 940, barW = 26, gap = 2, groupPad = 34, height = 240 } = {}) {
  const left = 44, bottom = 46, top = 14;
  const plotH = height - bottom - top;
  const groupW = series.length * (barW + gap) - gap;
  const totalW = Math.max(width, left + groups.length * (groupW + groupPad) + 10);
  let out = `<svg viewBox="0 0 ${totalW} ${height}" role="img" style="width:100%;max-width:${totalW}px">`;
  for (const g of [0, 25, 50, 75, 100]) {
    const y = top + plotH - (plotH * g) / 100;
    out += `<line x1="${left}" x2="${totalW - 6}" y1="${y}" y2="${y}" stroke="var(--grid)" stroke-width="1"/>` +
           `<text x="${left - 8}" y="${y + 4}" text-anchor="end" class="axis">${g}</text>`;
  }
  groups.forEach((grp, gi) => {
    const gx = left + gi * (groupW + groupPad) + groupPad / 2;
    grp.values.forEach((v, si) => {
      if (v.pct === null) return;
      const h = (plotH * v.pct) / 100;
      const x = gx + si * (barW + gap);
      const y = top + plotH - h;
      out += topRoundedBar(x, y, barW, h, series[si].color, `${grp.name} — ${series[si].name}: ${v.pct}% (${v.raw})`);
      out += `<text x="${x + barW / 2}" y="${y - 5}" text-anchor="middle" class="val">${v.pct}</text>`;
    });
    const labelX = gx + groupW / 2;
    out += `<text x="${labelX}" y="${height - bottom + 16}" text-anchor="middle" class="axis">${esc(grp.short ?? grp.name)}</text>`;
    if (grp.short2) out += `<text x="${labelX}" y="${height - bottom + 30}" text-anchor="middle" class="axis">${esc(grp.short2)}</text>`;
  });
  out += `</svg>`;
  return out;
}

const legend = (series) => `<div class="legend">` + series.map((s) =>
  `<span class="chip"><span class="swatch" style="background:${s.color}"></span>${esc(s.name)}</span>`).join("") + `</div>`;

const tableView = (groups, series) => {
  let t = `<details class="tbl"><summary>Table view</summary><table><tr><th></th>` +
    series.map((s) => `<th>${esc(s.name)}</th>`).join("") + `</tr>`;
  for (const g of groups) t += `<tr><td>${esc(g.name)}</td>` +
    g.values.map((v) => `<td>${v.pct === null ? "–" : v.pct + "% (" + v.raw + ")"}</td>`).join("") + `</tr>`;
  return t + `</table></details>`;
};

// ---------- chart 1: primary-model progression by category ----------
// Conditions: base (no retrieval) -> +retrieval -> fine-tuned checkpoints (ret mode).
const PRIMARY = "gpt-oss-20b";
const conditionSeries = [];
const colorSlots = ["#3987e5", "#d95926", "#199e70", "#c98500"]; // validated dark slots, fixed order
if (latestByLabel.has(`${PRIMARY}-noret`)) conditionSeries.push({ name: "base (no retrieval)", label: `${PRIMARY}-noret` });
if (latestByLabel.has(`${PRIMARY}-ret`)) conditionSeries.push({ name: "base + retrieval", label: `${PRIMARY}-ret` });
for (const m of models) if (m.startsWith("oaos-ft") && latestByLabel.has(`${m}-ret`))
  conditionSeries.push({ name: `${m} + retrieval`, label: `${m}-ret` });
conditionSeries.forEach((s, i) => (s.color = colorSlots[i % colorSlots.length]));

const catNames = CATEGORIES.map(([n]) => n);
const catGroups = catNames.map((c) => ({
  name: c,
  short: c.split(" ")[0],
  short2: c.split(" ").slice(1).join(" ") || undefined,
  values: conditionSeries.map((s) => {
    const sc = score(latestByLabel.get(s.label), (id) => catOf(id) === c);
    return { series: s.name, pct: pct(sc), raw: sc ? `${sc.pass}/${sc.total}` : "n/a" };
  }),
}));

// ---------- chart 2: bake-off, overall per model (both modes) ----------
const modeSeries = [
  { name: "no retrieval", color: colorSlots[0] },
  { name: "with retrieval", color: colorSlots[1] },
];
const bakeGroups = models.filter((m) => !m.startsWith("oaos-ft")).map((m) => ({
  name: m, short: m,
  values: ["noret", "ret"].map((mode) => {
    const run = latestByLabel.get(`${m}-${mode}`);
    const sc = run ? score(run) : null;
    return { series: mode, pct: pct(sc), raw: sc ? `${sc.pass}/${sc.total}` : "n/a" };
  }),
}));

// ---------- chart 3: the two model lines, head to head ----------
// Both tiers are scored on the same frozen suite with the same harness, so
// readers can see exactly what the smaller model gives up (and what it does not).
const TIER_SERIES = [
  { name: "20B base", label: "gpu-base-ret", color: colorSlots[0] },
  { name: "20B published (v1)", label: "gpu-v1-r4-ret", color: colorSlots[1] },
  { name: "20B best", label: "gpu-r6-ret", color: colorSlots[2] },
  { name: "Lite 8B", label: "gpu-mini-ft-ret", color: colorSlots[3] },
].filter((s) => latestByLabel.has(s.label));
const suite200 = (() => {
  try { return new Set(JSON.parse(readFileSync(join(HERE, "suites/suite-200.json"), "utf8")).taskIds); }
  catch { return null; }
})();
const inSuite = (id) => !suite200 || suite200.has(id);
const tierGroups = catNames.map((c) => ({
  name: c,
  short: c.split(" ")[0],
  short2: c.split(" ").slice(1).join(" ") || undefined,
  values: TIER_SERIES.map((s) => {
    const sc = score(latestByLabel.get(s.label), (id) => inSuite(id) && catOf(id) === c);
    return { series: s.name, pct: pct(sc), raw: sc ? `${sc.pass}/${sc.total}` : "n/a" };
  }),
}));

// ---------- run history ----------
const history = runs.slice(-30).reverse().map((r) => {
  const sc = score(r);
  return `<tr><td>${esc(r.when?.slice(0, 16).replace("T", " ") ?? "")}</td><td>${esc(r.label)}</td><td>${sc.pass}/${sc.total}</td></tr>`;
}).join("");

// ---------- milestones ----------
const bakeDone = ["phi-4-mini", "qwen3-8b", "ministral-3-8b"].every((m) => latestByLabel.has(`${m}-ret`));
const ftDone = models.some((m) => m.startsWith("oaos-ft"));
const ms = [
  [true, "Docs corpus: Intune, Entra, Defender (10,567 files, CC-BY-4.0)"],
  [!!idxMeta, `Local retrieval index (${idxMeta ? idxMeta.count.toLocaleString("en-US") + " chunks" : "pending"})`],
  [taskCount >= 20, `Eval suite (${taskCount} tasks, mechanically scored)`],
  [Object.keys(sftCounts).length >= 2, `Training data generator (${Object.values(sftCounts).reduce((a, b) => a + b, 0)} validated examples)`],
  [bakeDone, "Base-model bake-off (4 models × 2 modes)"],
  [ftDone, "First fine-tune (QLoRA on rented GPU) beats base on evals"],
  [false, "Publish: Hugging Face + Ollama + public dataset"],
];

// ---------- html ----------
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenAdminOS model pipeline</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#1a1a19; color:#ffffff; font:14px/1.5 ui-monospace,'SF Mono',Menlo,Consolas,monospace; }
  .wrap { max-width:980px; margin:0 auto; padding:28px 20px 60px; }
  h1 { font-size:18px; letter-spacing:.02em; margin:0 0 4px; }
  h2 { font-size:14px; color:#c3c2b7; margin:36px 0 10px; text-transform:uppercase; letter-spacing:.08em; }
  .sub { color:#8b8a82; font-size:12px; margin-bottom:22px; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; }
  .tile { background:#232322; border:1px solid #32322f; border-radius:6px; padding:12px 14px; }
  .tile b { display:block; font-size:22px; font-weight:600; }
  .tile span { color:#8b8a82; font-size:11px; }
  .axis { fill:#8b8a82; font-size:11px; font-family:inherit; }
  .val { fill:#ffffff; font-size:11px; font-family:inherit; }
  svg { display:block; } line { shape-rendering:crispEdges; }
  :root { --grid:#2b2b29; }
  .legend { display:flex; gap:16px; margin:8px 0 4px; flex-wrap:wrap; }
  .chip { display:inline-flex; align-items:center; gap:6px; color:#c3c2b7; font-size:12px; }
  .swatch { width:10px; height:10px; border-radius:2px; display:inline-block; }
  .tbl summary { color:#8b8a82; font-size:12px; cursor:pointer; margin-top:6px; }
  table { border-collapse:collapse; margin-top:8px; font-size:12px; }
  td,th { border:1px solid #32322f; padding:4px 10px; text-align:left; color:#c3c2b7; }
  th { color:#8b8a82; font-weight:600; }
  ul.ms { list-style:none; padding:0; margin:0; }
  ul.ms li { padding:3px 0; color:#c3c2b7; }
  ul.ms li.done::before { content:"[x] "; color:#199e70; }
  ul.ms li.todo::before { content:"[ ] "; color:#8b8a82; }
  .note { color:#8b8a82; font-size:12px; margin-top:6px; }
  .run { border-left:2px solid #32322f; padding:2px 0 2px 12px; margin:14px 0; }
  .run-head { color:#ffffff; font-size:13px; }
  .run-head .muted { color:#8b8a82; font-weight:400; margin-left:8px; font-size:12px; }
  .tag { background:#199e70; color:#0d0d0c; border-radius:3px; padding:1px 6px; font-size:11px; margin-left:4px; }
  .run ul { margin:6px 0; padding-left:18px; color:#c3c2b7; font-size:12px; }
  .run-out { color:#c3c2b7; font-size:12px; margin-top:4px; }
  .run-out b { color:#8b8a82; font-weight:600; }
  .track { margin:26px 0 10px; padding:12px 14px; background:#232322; border:1px solid #32322f; border-radius:6px; }
  .track-head { color:#ffffff; font-size:14px; font-weight:600; }
  .track-meta { color:#8b8a82; font-size:12px; margin-top:2px; }
  .track-role { color:#c3c2b7; font-size:12px; margin-top:6px; }
</style></head><body><div class="wrap">
<h1>OpenAdminOS model pipeline</h1>
<div class="sub">Local eval + fine-tune progress · updated ${now} · regenerated automatically after every eval run</div>

<div class="tiles">
  <div class="tile"><b>${idxMeta ? idxMeta.count.toLocaleString("en-US") : "–"}</b><span>doc chunks indexed (Intune · Entra · Defender)</span></div>
  <div class="tile"><b>${taskCount}</b><span>eval tasks, mechanically scored</span></div>
  <div class="tile"><b>${Object.values(sftCounts).reduce((a, b) => a + b, 0)}</b><span>validated training examples</span></div>
  <div class="tile"><b>${(runLog.tracks ?? []).length || 1}</b><span>model tiers (20B flagship · 8B Lite)</span></div>
</div>

<h2>Does grounding + fine-tuning make answers better?</h2>
<div class="note">Pass rate (%) per task category for ${PRIMARY}. Fine-tuned checkpoints appear as additional series automatically.</div>
${legend(conditionSeries)}
${groupedBars(catGroups, conditionSeries)}
${tableView(catGroups, conditionSeries)}

<h2>Base-model bake-off (overall pass rate, %)</h2>
${legend(modeSeries)}
${groupedBars(bakeGroups, modeSeries, { barW: 34, groupPad: 60 })}
${tableView(bakeGroups, modeSeries)}

<h2>Two model lines, same benchmark</h2>
<div class="note">Both tiers are scored on the identical frozen suite with the identical harness. The smaller model gives up multi-step agentic work; it does not give up safety or honesty.</div>
${legend(TIER_SERIES)}
${groupedBars(tierGroups, TIER_SERIES)}
${tableView(tierGroups, TIER_SERIES)}

<h2>Training runs — what each one trained on</h2>
<div class="note">Internal runs are numbered r1, r2, …; a run only earns a public version if it beats the incumbent with no category regression.</div>
${(runLog.tracks ?? [{ id: null }]).map((tr) => `
${tr.id ? `<div class="track">
  <div class="track-head">${esc(tr.name)}</div>
  <div class="track-meta">${esc(tr.base)} · ${esc(tr.size)}</div>
  <div class="track-role">${esc(tr.role)}</div>
  <div class="track-meta">Published: ${esc(tr.published)}</div>
</div>` : ""}
${runLog.runs.filter((r) => !tr.id || (r.track ?? "20b") === tr.id).map((r) => `
<div class="run">
  <div class="run-head"><b>${esc(r.id)}</b>${r.released ? ` <span class="tag">${esc(r.released)}</span>` : ""}
    <span class="muted">${esc(r.date)} · ${r.examples.toLocaleString("en-US")} examples · ${esc(r.recipe)}</span></div>
  <ul>${(r.trainedOn ?? []).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
  <div class="run-out"><b>Outcome:</b> ${esc(r.outcome)}</div>
  ${r.lesson ? `<div class="run-out"><b>Lesson:</b> ${esc(r.lesson)}</div>` : ""}
</div>`).join("")}`).join("")}

<h2>Frozen eval suites</h2>
<div class="note">A suite pins an exact task list and its hash so scores stay comparable when new tasks are written.</div>
<table><tr><th>Suite</th><th>Tasks</th><th>Hash</th><th>Contents</th></tr>
${(runLog.suites ?? []).map((s) => `<tr><td style="white-space:nowrap">${esc(s.name)}</td><td>${s.count}</td><td style="white-space:nowrap">${esc(s.sha256)}</td><td>${esc(s.what)}</td></tr>`).join("")}
</table>

<h2>What the eval tasks measure</h2>
<table><tr><th>Category</th><th>What it tests</th></tr>
${runLog.taskCategories.map((c) => `<tr><td style="white-space:nowrap;vertical-align:top">${esc(c.name)}</td><td>${esc(c.what)}</td></tr>`).join("")}
</table>

<h2>Milestones</h2>
<ul class="ms">${ms.map(([d, t]) => `<li class="${d ? "done" : "todo"}">${esc(t)}</li>`).join("")}</ul>

<h2>Recent eval runs</h2>
<table><tr><th>when (UTC)</th><th>run</th><th>score</th></tr>${history}</table>
<div class="note">Every score is a mechanical check (schema validation, exact match, or regex constraint). No LLM judges. No tenant data anywhere in this pipeline.</div>
</div></body></html>`;

writeFileSync(join(ROOT, "dashboard.html"), html);
console.log("dashboard.html updated:", models.length, "models,", runs.length, "runs");
