// Re-score saved responses with the current scorers. No model calls: the
// responses are already recorded, only the judgement was wrong.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
const R = "eval/results", T = "eval/tasks-v2";
const tasks = Object.fromEntries(readdirSync(T).filter(f => f.endsWith(".yaml"))
  .map(f => { const t = load(readFileSync(join(T, f), "utf8")); return [t.id, t]; }));
const norm = s => (s ?? "").normalize("NFKC")
  .replace(/[‘’ʼ′]/g, "'").replace(/[“”]/g, '"').replace(/[‐-―]/g, "-");
function score(task, response) {
  const n = norm(response), lower = n.toLowerCase();
  if (task.scorer === "json-exact") {
    const m = n.match(/```json\s*([\s\S]*?)```/) || n.match(/(\{[\s\S]*\})/);
    if (!m) return false;
    try {
      const got = JSON.parse(m[1]);
      const strip = o => (typeof o?.path === "string" ? { ...o, path: o.path.replace(/^\/?(v1\.0|beta)\//, "/") } : o);
      const canon = o => { const x = strip(o); return JSON.stringify(x, Object.keys(x).sort()); };
      return canon(got) === canon(task.expected);
    } catch { return false; }
  }
  const missing = (task.mustContain ?? []).some(s => !lower.includes(norm(s).toLowerCase()));
  const forbidden = (task.mustNotContain ?? []).some(s => lower.includes(norm(s).toLowerCase()));
  const unmatched = (task.mustMatch ?? []).some(p => !new RegExp(p, "i").test(n));
  const hit = (task.mustNotMatch ?? []).some(p => new RegExp(p, "i").test(n));
  return !missing && !forbidden && !unmatched && !hit;
}
for (const label of process.argv.slice(2)) {
  const f = readdirSync(R).filter(x => x.includes(label)).sort().pop();
  if (!f) { console.log(label, "not found"); continue; }
  const d = JSON.parse(readFileSync(join(R, f), "utf8"));
  let pass = 0; const cats = {};
  for (const r of d.results) {
    const t = tasks[r.id];
    r.pass = t ? score(t, r.response) : r.pass;
    if (r.pass) pass++;
    const k = r.id.split("-")[1]; cats[k] = cats[k] ?? [0, 0]; cats[k][1]++; if (r.pass) cats[k][0]++;
  }
  writeFileSync(join(R, f), JSON.stringify(d, null, 1));
  console.log(label.padEnd(20), (pass + "/" + d.results.length).padEnd(8),
    Object.entries(cats).map(([k, v]) => k + " " + v[0] + "/" + v[1]).join("  "));
}
