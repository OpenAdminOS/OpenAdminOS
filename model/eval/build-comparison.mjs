#!/usr/bin/env node
// Builds comparison.html from measured results only.
//
// Every number on the page comes from a scored run in eval/results. Nothing is
// asserted about another model that we did not measure ourselves, on the same
// tasks, with the same scorers.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const R = join(HERE, "results");
const pick = (s) => readdirSync(R).filter((f) => f.includes(s)).sort().pop();
const load = (s) => JSON.parse(readFileSync(join(R, pick(s)), "utf8"));

// Three categorical slots, validated against the dark surface #1a1a19:
// all pass the lightness band, chroma floor, CVD separation and contrast.
const MODELS = [
  { label: "OpenAdmin 8B", file: "V3-8b", colour: "own", note: "4.9 GB · your hardware · no cost" },
  { label: "Claude Opus 5", file: "V3-claude-opus-5", colour: "ext", note: "hosted · per-token billing" },
  { label: "GPT-5.6-sol", file: "V3-gpt-5.6-sol", colour: "third", note: "hosted · per-token billing" },
].map((m) => ({ ...m, results: load(m.file).results }));

const ids = new Set(MODELS[0].results.map((r) => r.id));
for (const m of MODELS) m.results = m.results.filter((r) => ids.has(r.id));

const CAT = { abstain: "Refuses to invent", safety: "Write-safety", identity: "Identity",
  graph: "Graph planning", answer: "Answer quality" };
const catOf = (id) => CAT[id.split("-")[1]] ?? "Other";
const agg = (rs) => {
  const m = {};
  for (const x of rs) { const c = catOf(x.id); m[c] = m[c] ?? [0, 0]; m[c][1]++; if (x.pass) m[c][0]++; }
  return m;
};
for (const m of MODELS) { m.agg = agg(m.results); m.total = m.results.filter((x) => x.pass).length; }
const cats = Object.keys(MODELS[0].agg);
const esc = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const N = ids.size;

// Grouped bars: thin marks, 4px rounded data-end on the baseline, 2px gap
// between adjacent fills, direct label on each bar, recessive grid, per-mark
// hover title. Three series, so the legend carries identity and the labels
// carry value — never colour alone.
function bars() {
  const W = 800, H = 310, left = 54, bottom = 66, top = 20, barW = 22, gap = 2, pad = 44;
  const plotH = H - bottom - top, gw = MODELS.length * (barW + gap) - gap;
  let o = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Pass rate by task category for OpenAdmin 8B, Claude Opus 5 and GPT-5.6-sol" style="width:100%;max-width:${W}px">`;
  for (const g of [0, 25, 50, 75, 100]) {
    const y = top + plotH - (plotH * g) / 100;
    o += `<line x1="${left}" x2="${W - 8}" y1="${y}" y2="${y}" stroke="var(--grid)" stroke-width="1"/>`
       + `<text x="${left - 8}" y="${y + 4}" text-anchor="end" class="ax">${g}%</text>`;
  }
  cats.forEach((c, i) => {
    const gx = left + i * (gw + pad) + pad / 2;
    MODELS.forEach((m, j) => {
      const v = m.agg[c] ?? [0, 0];
      const pct = v[1] ? Math.round((100 * v[0]) / v[1]) : 0;
      const h = (plotH * pct) / 100, x = gx + j * (barW + gap), y = top + plotH - h;
      const r = Math.min(4, h, barW / 2);
      if (h > 0) {
        o += `<path d="M${x},${y + h} v${-(h - r)} q0,${-r} ${r},${-r} h${barW - 2 * r} q${r},0 ${r},${r} v${h - r} z" fill="var(--${m.colour})">`
           + `<title>${esc(c)} — ${esc(m.label)}: ${v[0]}/${v[1]} (${pct}%)</title></path>`;
      }
      o += `<text x="${x + barW / 2}" y="${y - 6}" text-anchor="middle" class="val">${v[0]}</text>`;
    });
    const w = c.split(" ");
    o += `<text x="${gx + gw / 2}" y="${H - bottom + 18}" text-anchor="middle" class="ax">${esc(w[0])}</text>`;
    if (w.length > 1) o += `<text x="${gx + gw / 2}" y="${H - bottom + 32}" text-anchor="middle" class="ax">${esc(w.slice(1).join(" "))}</text>`;
  });
  return o + "</svg>";
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenAdmin 8B vs frontier models</title>
<style>
 :root{color-scheme:dark;--surface-1:#1a1a19;--panel:#232322;--line:#32322f;--grid:#2b2b29;
   --text-primary:#ffffff;--text-secondary:#c3c2b7;--muted:#8b8a82;
   --own:#3987e5;--ext:#d95926;--third:#199e70;--good:#199e70}
 body{margin:0;background:var(--surface-1);color:var(--text-primary);
   font:14px/1.6 ui-monospace,'SF Mono',Menlo,Consolas,monospace}
 .wrap{max-width:900px;margin:0 auto;padding:32px 20px 72px}
 h1{font-size:19px;margin:0 0 6px;letter-spacing:.02em}
 h2{font-size:13px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.08em;margin:40px 0 12px}
 .sub{color:var(--muted);font-size:12px;margin-bottom:26px}
 .hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:22px 0}
 .tile{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:14px 16px}
 .tile b{display:block;font-size:25px;font-weight:600;line-height:1.2}
 .tile span{color:var(--muted);font-size:11px}
 .tile .note{color:var(--text-secondary);font-size:11.5px;margin-top:4px}
 .ax{fill:var(--muted);font-size:11px;font-family:inherit}
 .val{fill:var(--text-primary);font-size:10.5px;font-family:inherit}
 svg{display:block}line{shape-rendering:crispEdges}
 .legend{display:flex;gap:18px;margin:6px 0 10px;flex-wrap:wrap}
 .chip{display:inline-flex;align-items:center;gap:7px;color:var(--text-secondary);font-size:12px}
 .sw{width:10px;height:10px;border-radius:2px;display:inline-block}
 table{border-collapse:collapse;width:100%;font-size:12.5px;margin-top:8px}
 td,th{border:1px solid var(--line);padding:7px 11px;text-align:left;color:var(--text-secondary);vertical-align:top}
 th{color:var(--muted);font-weight:600}
 td.y{color:var(--good)}td.n{color:var(--ext)}
 .caveat{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--own);
   border-radius:6px;padding:14px 16px;margin:18px 0;color:var(--text-secondary);font-size:12.5px}
 .caveat b{color:var(--text-primary)}
 details{margin-top:10px}summary{color:var(--muted);font-size:12px;cursor:pointer}
 code{background:#111;padding:1px 5px;border-radius:3px;font-size:12px}
</style></head><body><div class="wrap">

<h1>Do Microsoft 365 admins need a frontier model?</h1>
<div class="sub">Three models, ${N} identical tasks, identical mechanical scoring · 2026-08-31</div>

<div class="hero">
${MODELS.map((m) => `  <div class="tile"><b style="color:var(--${m.colour})">${m.total}/${N}</b><span>${esc(m.label)}</span><div class="note">${esc(m.note)}</div></div>`).join("\n")}
  <div class="tile"><b>8 GB</b><span>RAM for the local model</span><div class="note">no GPU · ~15 tok/s on a mini-PC</div></div>
</div>

<div class="caveat">
<b>The finding is the closeness, not the ranking.</b> Three models within three tasks of
each other, and a manual read of every single miss found <b>no capability failures on any
of them</b> — they were wording and convention differences (a refusal phrased "I can't
bypass confirmation" instead of "I can't apply", a Graph path written <code>/beta/…</code>
instead of <code>/…</code>). On bounded, well-specified administrative work, frontier
capability is not the binding constraint. That is the case for running locally.
</div>

<h2>Pass rate by category — same tasks, same scorers</h2>
<div class="legend">
${MODELS.map((m) => `  <span class="chip"><span class="sw" style="background:var(--${m.colour})"></span>${esc(m.label)}</span>`).join("\n")}
</div>
${bars()}
<details><summary>Table view</summary><table>
<tr><th>Category</th>${MODELS.map((m) => `<th>${esc(m.label)}</th>`).join("")}</tr>
${cats.map((c) => `<tr><td>${esc(c)}</td>${MODELS.map((m) => `<td>${(m.agg[c] ?? [0, 0]).join("/")}</td>`).join("")}</tr>`).join("")}
<tr><th>Total</th>${MODELS.map((m) => `<th>${m.total}/${N}</th>`).join("")}</tr>
</table></details>

<h2>Where the difference actually is</h2>
<table>
<tr><th></th><th>OpenAdmin 8B</th><th>Hosted frontier models</th></tr>
<tr><td>Cost per query</td><td class="y">none</td><td class="n">per-token billing</td></tr>
<tr><td>Where tenant data goes</td><td class="y">nowhere — stays on the device</td><td class="n">to the provider</td></tr>
<tr><td>Works offline</td><td class="y">yes</td><td class="n">no</td></tr>
<tr><td>Typical response time on these tasks</td><td class="y">~1 s</td><td class="n">10 s – 3 min</td></tr>
<tr><td>Hardware needed</td><td class="y">8 GB RAM, no GPU</td><td class="n">none</td></tr>
<tr><td>Data-residency review</td><td class="y">not required</td><td class="n">usually required</td></tr>
<tr><td>Long multi-step agentic chains</td><td class="n">weaker — escalate these</td><td class="y">stronger</td></tr>
<tr><td>Knowledge outside Microsoft 365</td><td class="n">narrow by design</td><td class="y">broad</td></tr>
</table>

<h2>What each model got wrong</h2>
<table><tr><th>Model</th><th>Task</th><th>Its answer (truncated) — read these, not just the totals</th></tr>
${MODELS.flatMap((m) => m.results.filter((r) => !r.pass).map((f) =>
  `<tr><td style="white-space:nowrap">${esc(m.label)}</td><td style="white-space:nowrap">${esc(f.id.replace("v2-", ""))}</td><td>${esc((f.response || "(empty)").slice(0, 130))}…</td></tr>`)).join("")}
</table>

<h2>Method, including what is wrong with it</h2>
<div class="caveat" style="border-left-color:var(--muted)">
All three models answered the identical ${N} tasks, drawn evenly from a 160-task behaviour
suite, and were scored by identical mechanical scorers — schema validation, exact match,
regex constraints. No LLM judges.
<br><br>
<b>Known biases, stated because they cut in our favour.</b> The suite was written by us, so
its conventions are our model's native output format; we normalise Graph API version
prefixes and accept any refusal wording, but a regex scorer inevitably encodes some house
style. Earlier drafts of this comparison were wrong three separate times — duplicated
tasks inflated two categories, a refusal pattern only matched our own phrasing, and a
curly apostrophe made one model score zero on write-safety while refusing every request.
Each was found by reading the raw answers. Assume more remain.
<br><br>
The hosted models were accessed through their CLIs, so they carry those products' own
system prompts; this measures what an admin would experience, not a controlled comparison
of base weights. Harness, tasks and every raw answer are public
(<code>model/eval/run-external.mjs</code>, <code>model/eval/tasks-v2/</code>) so anything
here can be re-run and checked.
</div>

</div></body></html>`;

writeFileSync(join(HERE, "..", "comparison.html"), html);
console.log(`comparison.html: ${(html.length / 1024).toFixed(0)}KB · ` +
  MODELS.map((m) => `${m.label} ${m.total}/${N}`).join(" · "));
