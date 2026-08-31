#!/usr/bin/env node
// Score an external model on the v2 behaviour suite via its CLI.
//
// Written because we wanted to compare OpenAdmin 8B against frontier models
// and had no measurements. Inventing competitor numbers was not an option,
// so this runs the same tasks through the same scorers.
//
// Methodology caveat, stated because it matters: these CLIs are assistant
// products, not raw model endpoints. They may carry their own system prompt
// and post-processing. That makes this a fair comparison of what an admin
// would actually experience, not a controlled comparison of base weights.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { load } from "js-yaml";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const TASKS = join(HERE, "tasks-v2");
const argOf = (f, d) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : d; };
const LABEL = argOf("--label", "external");
const CMD = argOf("--cmd", "claude");
// Codex needs its user config bypassed: that config loads several remote MCP
// servers, and each `exec` pays the full connection cost at startup — two
// minutes per task instead of nine seconds. --ignore-user-config skips them;
// auth still resolves from CODEX_HOME.
const ARGS = CMD === "codex"
  ? () => ["exec", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config",
           "-m", argOf("--model", "gpt-5.6-sol"), "-"]
  : (p) => ["--model", argOf("--model", "opus"), "-p", p];
const LIMIT = Number(argOf("--limit", "0"));

// Curly quotes are not folded by NFKC, so a model writing "can’t" failed
// every regex expecting "can't" — GPT-5.6 scored 0/9 on write-safety
// while refusing every request. Fold quotes and dashes before matching.
const norm = (s) => (s ?? "").normalize("NFKC")
  .replace(/[\u2018\u2019\u02BC\u2032]/g, "'")
  .replace(/[\u201C\u201D]/g, '"')
  .replace(/[\u2010-\u2015]/g, "-");
function score(task, response) {
  const n = norm(response), lower = n.toLowerCase();
  if (task.scorer === "json-exact") {
    const m = n.match(/```json\s*([\s\S]*?)```/) || n.match(/(\{[\s\S]*\})/);
    if (!m) return { pass: false, detail: "no json block" };
    try {
      const got = JSON.parse(m[1]);
      const stripVer = (o) => (typeof o?.path === "string"
        ? { ...o, path: o.path.replace(/^\/?(v1\.0|beta)\//, "/") } : o);
      const canon = (o) => { const x = stripVer(o); return JSON.stringify(x, Object.keys(x).sort()); };
      return { pass: canon(got) === canon(task.expected), detail: canon(got) };
    } catch (e) { return { pass: false, detail: "unparseable json" }; }
  }
  const missing = (task.mustContain ?? []).filter((s) => !lower.includes(norm(s).toLowerCase()));
  const forbidden = (task.mustNotContain ?? []).filter((s) => lower.includes(norm(s).toLowerCase()));
  const unmatched = (task.mustMatch ?? []).filter((p) => !new RegExp(p, "i").test(n));
  const hitForbidden = (task.mustNotMatch ?? []).filter((p) => new RegExp(p, "i").test(n));
  const pass = !missing.length && !forbidden.length && !unmatched.length && !hitForbidden.length;
  return { pass, detail: pass ? "ok" : `missing:${missing.length} unmatched:${unmatched.length} forbidden:${hitForbidden.length}` };
}

const files = readdirSync(TASKS).filter((f) => f.endsWith(".yaml")).sort();
const tasks = files.map((f) => load(readFileSync(join(TASKS, f), "utf8")));
const chosen = LIMIT ? tasks.filter((_, i) => i % Math.ceil(tasks.length / LIMIT) === 0).slice(0, LIMIT) : tasks;

const results = [];
let pass = 0;
for (const [i, t] of chosen.entries()) {
  const prompt = `${t.system}\n\n${t.prompt}`;
  void prompt;
  let response = "";
  try {
    if (CMD === "local") {
      const r = await fetch("http://127.0.0.1:8090/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "system", content: t.system }, { role: "user", content: t.prompt }],
                               max_tokens: 400, temperature: 0 }),
      }).then((x) => x.json()).catch(() => null);
      response = r?.choices?.[0]?.message?.content?.trim() ?? "";
    } else if (CMD === "codex") {
      // codex reads instructions from stdin when the prompt is not an argv
      // value, and blocks on an unclosed stdin when launched non-interactively.
      // Write the prompt, then close: passing it as argv left it waiting for
      // EOF and returning nothing.
      response = await new Promise((resolve) => {
        const child = spawn(CMD, ARGS(null), { stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(""); }, 240000);
        child.stdout.on("data", (d) => { out += d; });
        child.on("close", () => { clearTimeout(timer); resolve(out); });
        child.on("error", () => { clearTimeout(timer); resolve(""); });
        child.stdin.end(prompt);
      });
      response = response.replace(/\n?tokens used[\s\S]*$/, "").trim();
    } else {
      const { stdout } = await exec(CMD, ARGS(prompt), { timeout: 180000, maxBuffer: 4e6 });
      response = stdout.trim();
    }
  } catch (e) { response = ""; }
  const s = score(t, response);
  if (s.pass) pass++;
  results.push({ id: t.id, pass: s.pass, detail: s.detail, response: response.slice(0, 600) });
  process.stdout.write(`\r  ${i + 1}/${chosen.length}  pass ${pass}   `);
}
console.log();
const out = join(HERE, "results", `${new Date().toISOString().replace(/[:.]/g, "-")}-${LABEL}.json`);
writeFileSync(out, JSON.stringify({ label: LABEL, when: new Date().toISOString(), cmd: CMD, results }, null, 1));
console.log(`${LABEL}: ${pass}/${chosen.length} tasks passed`);
