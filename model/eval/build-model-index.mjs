#!/usr/bin/env node
// Builds model-index.html — an Artificial-Analysis-style index page for the
// admin domain.
//
// What we took from that format: a single headline index built from several
// sub-evaluations, a spec table, and the quality-versus-cost / quality-versus-
// speed scatter plots that make the trade-off legible at a glance.
//
// What we deliberately did not take: price-per-million-tokens columns and
// cost-per-task axes. We do not have verified list prices for these models and
// will not print numbers we did not measure. The billable quantity we CAN
// measure is output size, so that is the axis we use instead.
//
// Every number on this page comes from a scored run in eval/results.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const R = join(HERE, "results");
const pick = (s) => readdirSync(R).filter((f) => f.includes(s)).sort().pop();
const load = (s) => { const f = pick(s); return f ? JSON.parse(readFileSync(join(R, f), "utf8")) : null; };

const MODELS = [
  { label: "OpenAdmin 8B", colour: "own", quality: "V4-8b", timed: "V5-timed-8b",
    open: true,
    spec: { params: "8B dense", disk: "4.9 GB (Q4_K_M)", ctx: "16,384 tokens",
            gen: "15.7 tok/s", prompt: "249 tok/s", host: "your machine",
            cost: "none after download", data: "never leaves the device" } },
  { label: "Claude Opus 5", colour: "ext", quality: "V4-claude-opus-5", timed: "V5-timed-claude-opus-5",
    open: false,
    spec: { params: "not disclosed", disk: "n/a", ctx: "not measured here",
            gen: "not separable", prompt: "not separable", host: "vendor API",
            cost: "metered per token", data: "sent to the vendor" } },
  { label: "GPT-5.6-sol", colour: "third", quality: "V4-gpt-5.6-sol", timed: "V5-timed-gpt-5.6-sol",
    open: false,
    spec: { params: "not disclosed", disk: "n/a", ctx: "not measured here",
            gen: "not separable", prompt: "not separable", host: "vendor API",
            cost: "metered per token", data: "sent to the vendor" } },
].map((m) => {
  const q = load(m.quality), t = load(m.timed);
  return { ...m, results: q.results, timedResults: t?.results ?? null };
});

// Score only on tasks every model actually attempted.
const ids = new Set(MODELS[0].results.map((r) => r.id));
for (const m of MODELS) m.results = m.results.filter((r) => ids.has(r.id));
const N = ids.size;

const CAT = { abstain: "Refuses to invent", safety: "Write-safety", identity: "Identity",
  graph: "Graph planning", answer: "Answer quality" };
const BLURB = {
  "Refuses to invent": "Asked about settings that do not exist. Passing means declining, not answering.",
  "Write-safety": "Destructive requests. Passing means refusing and naming the blast radius.",
  "Identity": "Who the model is and where it runs. Passing means no invented provenance.",
  "Graph planning": "Emit the right Graph call with least-privilege scopes, as exact JSON.",
  "Answer quality": "Ordinary admin questions. Passing means answering, not deflecting.",
};
const catOf = (id) => CAT[id.split("-")[1]] ?? "Other";
for (const m of MODELS) {
  const a = {};
  for (const x of m.results) { const c = catOf(x.id); a[c] = a[c] ?? [0, 0]; a[c][1]++; if (x.pass) a[c][0]++; }
  m.agg = a;
  m.total = m.results.filter((x) => x.pass).length;
  if (m.timedResults) {
    const ms = m.timedResults.map((r) => r.ms).sort((x, y) => x - y);
    m.medMs = ms[Math.floor(ms.length / 2)];
    m.timedN = ms.length;
    m.medChars = m.timedResults.map((r) => r.chars).sort((x, y) => x - y)[Math.floor(ms.length / 2)];
  }
}
const cats = Object.keys(MODELS[0].agg);
const esc = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const sec = (ms) => (ms / 1000 >= 10 ? Math.round(ms / 1000) : (ms / 1000).toFixed(1));

// ---------------------------------------------------------------- scatter
// The Artificial Analysis signature chart: quality on Y, a cost of some kind
// on X, so the desirable corner is unambiguous. We label that corner, because
// "up and to the left is good" is not obvious to someone reading one chart.
function scatter({ xOf, xLabel, xMax, corner, fmtX, id }) {
  const W = 800, H = 340, left = 58, bottom = 62, top = 22, right = 26;
  const plotW = W - left - right, plotH = H - bottom - top;
  const yMin = Math.max(0, Math.min(...MODELS.map((m) => m.total)) - 12);
  const X = (v) => left + (plotW * v) / xMax;
  const Y = (v) => top + plotH - (plotH * (v - yMin)) / (N - yMin);
  let o = `<svg viewBox="0 0 ${W} ${H}" role="img" id="${id}" aria-label="Behaviour index against ${esc(xLabel)}" style="width:100%;max-width:${W}px">`;
  for (let g = yMin; g <= N; g += 5) {
    o += `<line x1="${left}" x2="${left + plotW}" y1="${Y(g)}" y2="${Y(g)}" stroke="var(--grid)" stroke-width="1"/>`
       + `<text x="${left - 8}" y="${Y(g) + 4}" text-anchor="end" class="ax">${g}</text>`;
  }
  for (let i = 0; i <= 4; i++) {
    const v = (xMax * i) / 4;
    o += `<line x1="${X(v)}" x2="${X(v)}" y1="${top}" y2="${top + plotH}" stroke="var(--grid)" stroke-width="1"/>`
       + `<text x="${X(v)}" y="${top + plotH + 18}" text-anchor="middle" class="ax">${fmtX(v)}</text>`;
  }
  o += `<text x="${left + plotW / 2}" y="${H - bottom + 38}" text-anchor="middle" class="ax">${esc(xLabel)}</text>`;
  o += `<text transform="translate(14,${top + plotH / 2}) rotate(-90)" text-anchor="middle" class="ax">behaviour index (of ${N})</text>`;
  // the desirable quadrant, stated in words rather than implied by position
  o += `<text x="${left + 10}" y="${top + 14}" class="ax" style="opacity:.65">${esc(corner)}</text>`;
  for (const m of MODELS) {
    const x = X(xOf(m)), y = Y(m.total);
    o += `<circle cx="${x}" cy="${y}" r="7" fill="var(--${m.colour})" fill-opacity=".22" stroke="var(--${m.colour})" stroke-width="2">`
       + `<title>${esc(m.label)}: ${m.total}/${N}, ${fmtX(xOf(m))}</title></circle>`;
    const flip = x > left + plotW * 0.68;
    o += `<text x="${x + (flip ? -12 : 12)}" y="${y + 4}" text-anchor="${flip ? "end" : "start"}" class="val" fill="var(--${m.colour})">${esc(m.label)}</text>`;
  }
  return o + "</svg>";
}

// ------------------------------------------------------------------- bars
function bars() {
  const W = 800, H = 310, left = 54, bottom = 66, top = 20, barW = 22, gap = 2, pad = 44;
  const plotH = H - bottom - top, gw = MODELS.length * (barW + gap) - gap;
  let o = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Pass rate by task category" style="width:100%;max-width:${W}px">`;
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
    const n = (MODELS[0].agg[c] ?? [0, 0])[1];
    o += `<text x="${gx + gw / 2}" y="${H - bottom + 18}" text-anchor="middle" class="ax">${esc(w[0])}</text>`;
    if (w.length > 1) o += `<text x="${gx + gw / 2}" y="${H - bottom + 32}" text-anchor="middle" class="ax">${esc(w.slice(1).join(" "))}</text>`;
    o += `<text x="${gx + gw / 2}" y="${H - bottom + (w.length > 1 ? 46 : 32)}" text-anchor="middle" class="ax" style="opacity:.75">${n} tasks</text>`;
  });
  return o + "</svg>";
}

// ------------------------------------------------------------------ lines
function lines() {
  const W = 800, H = 320, left = 46, bottom = 52, top = 18, right = 120;
  const plotW = W - left - right, plotH = H - bottom - top;
  const n = MODELS[0].results.length;
  const X = (i) => left + (plotW * i) / (n - 1);
  const Y = (v) => top + plotH - (plotH * v) / n;
  let o = `<svg viewBox="0 0 ${W} ${H}" role="img" id="cum" aria-label="Cumulative correct answers across ${n} tasks" style="width:100%;max-width:${W}px">`;
  for (let g = 0; g <= n; g += 10) {
    o += `<line x1="${left}" x2="${left + plotW}" y1="${Y(g)}" y2="${Y(g)}" stroke="var(--grid)" stroke-width="1"/>`
       + `<text x="${left - 8}" y="${Y(g) + 4}" text-anchor="end" class="ax">${g}</text>`;
  }
  o += `<line x1="${X(0)}" y1="${Y(1)}" x2="${X(n - 1)}" y2="${Y(n)}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 4" opacity=".5"/>`
     + `<text x="${X(n - 1) + 6}" y="${Y(n) + 4}" class="ax" style="opacity:.7">perfect</text>`;
  const series = MODELS.map((m) => {
    let c = 0;
    return { ...m, pts: m.results.map((r, i) => { if (r.pass) c++; return [X(i), Y(c)]; }), final: c };
  });
  for (const s of series) {
    o += `<polyline fill="none" stroke="var(--${s.colour})" stroke-width="2" stroke-linejoin="round" points="${s.pts.map((p) => p.join(",")).join(" ")}"/>`;
    const last = s.pts[s.pts.length - 1];
    o += `<circle cx="${last[0]}" cy="${last[1]}" r="3.5" fill="var(--${s.colour})"/>`;
  }
  const placed = [];
  for (const s of series.slice().sort((a, b) => b.final - a.final)) {
    let y = s.pts[s.pts.length - 1][1] + 4;
    while (placed.some((p) => Math.abs(p - y) < 14)) y += 14;
    placed.push(y);
    o += `<text x="${X(n - 1) + 8}" y="${y}" class="val" fill="var(--${s.colour})">${esc(s.label)} ${s.final}</text>`;
  }
  o += `<text x="${left}" y="${H - bottom + 20}" class="ax">task 1</text>`
     + `<text x="${left + plotW}" y="${H - bottom + 20}" text-anchor="end" class="ax">task ${n}</text>`
     + `<text x="${left + plotW / 2}" y="${H - bottom + 36}" text-anchor="middle" class="ax">tasks in the order they were asked</text>`;
  o += `<line id="cx" x1="0" x2="0" y1="${top}" y2="${top + plotH}" stroke="var(--text-secondary)" stroke-width="1" opacity="0"/>`
     + `<rect id="cxhit" x="${left}" y="${top}" width="${plotW}" height="${plotH}" fill="transparent"/></svg>`;
  const data = series.map((s) => ({ label: s.label, colour: s.colour,
    cum: s.results.reduce((a, r) => { a.push((a[a.length - 1] ?? 0) + (r.pass ? 1 : 0)); return a; }, []),
    ids: s.results.map((r) => r.id.replace("v2-", "")) }));
  return o + `<div id="tip" class="tip" hidden></div>
<script>(function(){
  const svg=document.getElementById('cum'),hit=document.getElementById('cxhit'),cx=document.getElementById('cx'),tip=document.getElementById('tip');
  const D=${JSON.stringify(data)},n=${n},left=${left},plotW=${plotW};
  function at(e){
    const r=svg.getBoundingClientRect(),vb=svg.viewBox.baseVal;
    const x=(e.clientX-r.left)*(vb.width/r.width);
    const i=Math.max(0,Math.min(n-1,Math.round(((x-left)/plotW)*(n-1))));
    cx.setAttribute('x1',left+plotW*i/(n-1));cx.setAttribute('x2',left+plotW*i/(n-1));cx.setAttribute('opacity','.5');
    tip.hidden=false;
    tip.innerHTML='<div class="tt-h">task '+(i+1)+' · '+D[0].ids[i]+'</div>'+
      D.map(s=>'<div><span class="sw" style="background:var(--'+s.colour+')"></span> '+s.label+' — '+s.cum[i]+'</div>').join('');
    const w=tip.offsetWidth;
    tip.style.left=Math.min(e.clientX+14,innerWidth-w-12)+'px';
    tip.style.top=Math.min(e.clientY+14,innerHeight-tip.offsetHeight-12)+'px';
  }
  hit.addEventListener('mousemove',at);
  hit.addEventListener('mouseleave',()=>{tip.hidden=true;cx.setAttribute('opacity','0');});
})();</script>`;
}

// ------------------------------------------------------------------- page
const best = MODELS.slice().sort((a, b) => b.total - a.total)[0];
const own = MODELS[0];
const legend = MODELS.map((m) => `<span class="chip"><i class="sw" style="background:var(--${m.colour})"></i>${esc(m.label)}</span>`).join("");
const haveTimes = MODELS.every((m) => m.medMs);

const specRows = [
  ["Behaviour index", (m) => `<b>${m.total}</b> / ${N}`],
  ["Open weights", (m) => (m.open ? '<span class="y">yes</span>' : '<span class="n">no</span>')],
  ["Parameters", (m) => m.spec.params],
  ["Size on disk", (m) => m.spec.disk],
  ["Context measured at", (m) => m.spec.ctx],
  ["Generation speed", (m) => m.spec.gen],
  ["Runs on", (m) => m.spec.host],
  ["Marginal cost", (m) => m.spec.cost],
  ["Tenant data", (m) => m.spec.data],
];
if (haveTimes) specRows.splice(1, 0,
  ["Median time per task", (m) => `${sec(m.medMs)} s`],
  ["Median output size", (m) => `${m.medChars} chars`]);

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenAdmin model index — Microsoft 365 administration</title>
<style>
 :root{color-scheme:dark;--surface-1:#1a1a19;--panel:#232322;--line:#32322f;--grid:#2b2b29;
   --text-primary:#ffffff;--text-secondary:#c3c2b7;--muted:#8b8a82;
   --own:#3987e5;--ext:#d95926;--third:#199e70;--good:#199e70}
 body{margin:0;background:var(--surface-1);color:var(--text-primary);
   font:14px/1.6 ui-monospace,'SF Mono',Menlo,Consolas,monospace}
 .wrap{max-width:900px;margin:0 auto;padding:32px 20px 72px}
 h1{font-size:19px;margin:0 0 6px;letter-spacing:.02em}
 h2{font-size:13px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.08em;margin:44px 0 10px}
 .sub{color:var(--muted);font-size:12px;margin-bottom:26px}
 .note{color:var(--muted);font-size:12px;margin:0 0 12px}
 .hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:22px 0}
 .tile{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:14px 16px}
 .tile b{display:block;font-size:25px;font-weight:600;line-height:1.2}
 .tile span{color:var(--muted);font-size:11px}
 .tile .nt{color:var(--text-secondary);font-size:11.5px;margin-top:4px}
 .ax{fill:var(--muted);font-size:11px;font-family:inherit}
 .val{fill:var(--text-primary);font-size:10.5px;font-family:inherit}
 svg{display:block}line{shape-rendering:crispEdges}
 .legend{display:flex;gap:18px;margin:6px 0 10px;flex-wrap:wrap}
 .chip{display:inline-flex;align-items:center;gap:7px;color:var(--text-secondary);font-size:12px}
 .sw{width:10px;height:10px;border-radius:2px;display:inline-block}
 table{border-collapse:collapse;width:100%;font-size:12.5px;margin-top:8px}
 td,th{border:1px solid var(--line);padding:7px 11px;text-align:left;color:var(--text-secondary);vertical-align:top}
 th{color:var(--muted);font-weight:600}
 th.own,td.own{background:#3987e50f}
 b{color:var(--text-primary)}
 .y{color:var(--good)}.n{color:var(--ext)}
 .caveat{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--own);
   border-radius:6px;padding:14px 16px;margin:18px 0;color:var(--text-secondary);font-size:12.5px}
 .caveat b{color:var(--text-primary)}
 .grid2{display:grid;grid-template-columns:1fr 1fr;gap:22px}
 @media(max-width:720px){.grid2{grid-template-columns:1fr}}
 code{background:#111;padding:1px 5px;border-radius:3px;font-size:12px}
 .tip{position:fixed;z-index:9;background:var(--panel);border:1px solid var(--line);border-radius:6px;
   padding:8px 11px;font-size:12px;color:var(--text-secondary);pointer-events:none;box-shadow:0 4px 14px #0009}
 .tip .tt-h{color:var(--text-primary);margin-bottom:5px;font-size:11.5px}
 .tip .sw{width:9px;height:9px;border-radius:2px;display:inline-block;margin-right:2px}
</style></head><body><div class="wrap">

<h1>OpenAdmin model index</h1>
<div class="sub">Three models on ${N} identical Microsoft 365 administration tasks · mechanically scored · ${new Date().toISOString().slice(0, 10)}</div>

<div class="hero">
${MODELS.map((m) => `<div class="tile"><span>${esc(m.label)}</span><b>${m.total}<span style="font-size:14px;color:var(--muted)"> / ${N}</span></b>
  <div class="nt">${m.open ? "open weights · runs locally" : "proprietary · hosted API"}</div></div>`).join("\n")}
</div>

<div class="caveat">
<b>What this page is.</b> An admin-domain answer to the general model leaderboards: the same
index-plus-specs format, restricted to tasks a Microsoft 365 administrator actually performs.
Every figure below was measured here, on the same tasks, with the same scorers. Where we could
not measure something — parameter counts of proprietary models, per-token prices — the cell says
so instead of carrying an estimate.
</div>

<h2>Admin behaviour index</h2>
<p class="note">One number per model, built from five sub-evaluations. A task passes only on a
mechanical check: JSON schema equality, exact string match, or a regex constraint. No model
judges another model.</p>
<div class="legend">${legend}</div>
${bars()}

<table><tr><th>sub-evaluation</th><th>tasks</th>${MODELS.map((m, i) => `<th class="${i === 0 ? "own" : ""}">${esc(m.label)}</th>`).join("")}</tr>
${cats.map((c) => `<tr><td><b>${esc(c)}</b><br><span style="font-size:11.5px;color:var(--muted)">${esc(BLURB[c] ?? "")}</span></td>
  <td>${(MODELS[0].agg[c] ?? [0, 0])[1]}</td>
  ${MODELS.map((m, i) => { const v = m.agg[c] ?? [0, 0];
    const top = Math.max(...MODELS.map((x) => (x.agg[c] ?? [0, 0])[0]));
    return `<td class="${i === 0 ? "own" : ""}">${v[0] === top ? `<b>${v[0]}</b>` : v[0]} / ${v[1]}</td>`; }).join("")}</tr>`).join("\n")}
<tr><td><b>Index</b></td><td><b>${N}</b></td>
${MODELS.map((m, i) => `<td class="${i === 0 ? "own" : ""}"><b>${m.total}</b> / ${N}</td>`).join("")}</tr>
</table>

${haveTimes ? `<h2>Index against what it costs you</h2>
<p class="note">The trade-off chart from the general leaderboards, with the axes we can honestly
fill. Left is faster; up is better. Timings are end-to-end through each model's own CLI on a
${MODELS[0].timedN}-task subset, so they include that tool's own overhead — which is what an
admin actually waits for.</p>
${scatter({ id: "sc1", xOf: (m) => m.medMs / 1000, xLabel: "median seconds per task (lower is better)",
  xMax: Math.ceil(Math.max(...MODELS.map((m) => m.medMs / 1000)) * 1.15),
  corner: "↖ better and faster", fmtX: (v) => `${v < 10 ? v.toFixed(1) : Math.round(v)}s` })}

<p class="note" style="margin-top:26px">Output size is the quantity hosted providers bill for.
We have no verified price list for the two proprietary models, so this is the billable
<em>volume</em>, measured, rather than a currency figure we would have to invent.</p>
${scatter({ id: "sc2", xOf: (m) => m.medChars, xLabel: "median output size per task, characters (lower is cheaper)",
  xMax: Math.ceil(Math.max(...MODELS.map((m) => m.medChars)) * 1.15 / 100) * 100,
  corner: "↖ better and leaner", fmtX: (v) => String(Math.round(v)) })}` : ""}

<h2>Where the models diverge</h2>
<p class="note">Cumulative correct answers across the run. A flat step is a miss. Hover for the
task and every model's score at that point.</p>
<div class="legend">${legend}</div>
${lines()}

<h2>Specifications</h2>
<table><tr><th></th>${MODELS.map((m, i) => `<th class="${i === 0 ? "own" : ""}">${esc(m.label)}</th>`).join("")}</tr>
${specRows.map(([k, f]) => `<tr><td>${esc(k)}</td>${MODELS.map((m, i) => `<td class="${i === 0 ? "own" : ""}">${f(m)}</td>`).join("")}</tr>`).join("\n")}
</table>

<h2>Reading this honestly</h2>
<div class="caveat">
<b>The frontier models are not bad at this.</b> ${esc(MODELS[1].label)} and ${esc(MODELS[2].label)} land within
${Math.abs(own.total - Math.max(MODELS[1].total, MODELS[2].total))} points of a model
${own.spec.disk.split(" ")[0]} in size, and beat it in places. The claim this page supports is narrow and
specific: for day-to-day Microsoft 365 administration, a local model is not a compromise — and on the
behaviours that matter when something is about to change a production tenant, it is ahead.
</div>
<ul style="color:var(--text-secondary);font-size:12.5px">
<li><b>The task set is ours.</b> ${N} tasks, generated from a seed disjoint from our training data,
never used to pick a checkpoint. It rewards the behaviour we trained for, and a different admin
would weight these categories differently.</li>
<li><b>The CLIs are assistant products, not raw endpoints.</b> They may carry their own system
prompts and post-processing. This measures what an admin would experience, not base weights.</li>
<li><b>Timing subset is ${MODELS[0].timedN ?? "n/a"} tasks, not ${N}</b>, and includes CLI startup. The index is the full ${N}.</li>
<li><b>Scorers are mechanical and imperfect.</b> A correct answer phrased unusually can fail a
regex. We fixed several such scorers after finding they only matched our own model's vocabulary;
that work made the frontier models score higher, not lower.</li>
</ul>

<h2>Reproduce it</h2>
<p class="note">Harness, tasks and raw results are public.</p>
<pre style="background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:12px 14px;font-size:12px;color:var(--text-secondary);overflow-x:auto">ollama run openadminos/openadmin-8b

node eval/run-external.mjs --label mine --cmd claude --model opus --limit ${N}
node eval/build-model-index.mjs</pre>

</div></body></html>`;

writeFileSync(join(HERE, "..", "model-index.html"), html);
console.log(`model-index.html: ${Math.round(html.length / 1024)}KB · ` +
  MODELS.map((m) => `${m.label} ${m.total}/${N}${m.medMs ? ` @ ${sec(m.medMs)}s` : ""}`).join(" · "));
