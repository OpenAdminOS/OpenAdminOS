#!/usr/bin/env node
// Eval harness: runs every task in eval/tasks/ against a llama-server
// OpenAI-compatible endpoint and scores the responses mechanically.
//
// Usage: node eval/run-eval.mjs [--endpoint http://127.0.0.1:8090] [--label gpt-oss-20b]

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import { Ajv2020 } from "ajv/dist/2020.js";
import { retrieve } from "./retrieve.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const ENDPOINT = argOf("--endpoint", "http://127.0.0.1:8090");
const LABEL = argOf("--label", "unlabeled");
const SCHEMA_PATH = argOf(
  "--schema",
  join(HERE, "../../schemas/agent-template.schema.json"),
);

// ---------- scorers ----------

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addFormat("date-time", true);
ajv.addFormat("uri", true);
const validateManifest = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, "utf8")));

// gpt-oss emits typographic punctuation (U+2011 non-breaking hyphen, en/em
// dashes, non-breaking spaces). Normalize to ASCII before matching so a
// correct answer is not failed on cosmetics.
function normalizeText(text) {
  return String(text)
    .normalize("NFKC")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u00a0\u202f\u2007\u2009\u200a]/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[ \t]+/g, " ");
}

function extractFencedBlock(text, lang) {
  const re = new RegExp("```[ \\t]*(?:" + lang + ")?[ \\t]*\\r?\\n([\\s\\S]*?)```", "i");
  const m = text.match(re);
  return m ? m[1] : text; // fall back to the whole response
}

const scorers = {
  // Response must contain YAML that parses and validates against the
  // canonical agent-template schema from the OpenAdminOS repo.
  // Response must contain YAML that (a) validates against the canonical
  // agent-template schema and (b) actually answers the request: right slug,
  // right Graph path and scope, right skill formats. Schema-validity alone
  // would accept any constant manifest, which makes the metric meaningless.
  "manifest-schema": (task, response) => {
    const yamlText = extractFencedBlock(response, "yaml");
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

  // Response must contain a JSON object deep-equal to task.expected.
  "json-exact": (task, response) => {
    const jsonText = extractFencedBlock(response, "json");
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      return { pass: false, detail: `JSON parse error: ${e.message}` };
    }
    const canon = (v) =>
      Array.isArray(v) ? v.map(canon)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
        : v;
    const pass = JSON.stringify(canon(parsed)) === JSON.stringify(canon(task.expected));
    return { pass, detail: pass ? "exact match" : `got ${JSON.stringify(parsed)}` };
  },

  // Every string in task.mustContain must appear in the response
  // (case-insensitive); none of task.mustNotContain may appear; every
  // pattern in task.mustMatch (regex, case-insensitive) must match.
  contains: (task, response) => {
    const norm = normalizeText(response);
    const lower = norm.toLowerCase();
    const missing = (task.mustContain ?? []).filter((s) => !lower.includes(normalizeText(s).toLowerCase()));
    const forbidden = (task.mustNotContain ?? []).filter((s) => lower.includes(normalizeText(s).toLowerCase()));
    const unmatched = (task.mustMatch ?? []).filter((p) => !new RegExp(p, "i").test(norm));
    const pass = missing.length === 0 && forbidden.length === 0 && unmatched.length === 0;
    return {
      pass,
      detail: pass
        ? "all constraints met"
        : `missing: [${missing.join(", ")}] forbidden-hit: [${forbidden.join(", ")}] unmatched: [${unmatched.join(", ")}]`,
    };
  },
};

// ---------- runner ----------

const GRAPH_TOOL = {
  type: "function",
  function: {
    name: "graph_get",
    description: "Perform a read-only Microsoft Graph GET request against the active tenant.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Graph API path, e.g. /deviceManagement/managedDevices" },
        select: { type: "array", items: { type: "string" }, description: "Properties to select" },
      },
      required: ["path"],
    },
  },
};

async function chat(messages, task, tools) {
  const res = await fetch(`${ENDPOINT}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages,
      ...(tools ? { tools } : {}),
      temperature: task.temperature ?? 0,
      max_tokens: task.maxTokens ?? 2048,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).choices[0].message;
}

// Serve a fixture for a graph_get call. Matches on exact path, then on the
// path's last segment, so a model that adds $select/query noise still resolves.
// Resolve a graph_get call against the task fixtures. Matching is exact on
// the path (after stripping the query string, trailing slashes, and an
// optional /v1.0|/beta prefix). Anything else returns a Graph-style error, so
// calling the wrong resource cannot silently yield the right data.
function fixtureFor(task, rawPath) {
  const fixtures = task.trajectory?.fixtures ?? {};
  if (!rawPath || typeof rawPath !== "string") {
    return { ok: false, body: { error: { code: "badRequest", message: "missing 'path' argument" } } };
  }
  const clean = rawPath
    .split("?")[0]
    .trim()
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/^\/(v1\.0|beta)(?=\/)/i, "")
    .replace(/\/+$/, "");
  const key = Object.keys(fixtures).find((k) => k.replace(/\/+$/, "") === clean);
  if (key) return { ok: true, body: fixtures[key] };
  return {
    ok: false,
    body: { error: { code: "resourceNotFound", message: `no such resource: ${clean}` } },
  };
}

async function complete(task) {
  let userContent = task.prompt;
  // Optional retrieval augmentation: tasks with `retrieval: {k}` get top-k
  // chunks from the local docs index prepended as cited context.
  if (task.retrieval && !args.includes("--no-retrieval")) {
    const hits = await retrieve(task.retrieval.query ?? task.prompt, {
      k: task.retrieval.k ?? 4,
    });
    const context = hits
      .map((h, i) => `[doc ${i + 1}: ${h.file}]\n${h.text}`)
      .join("\n\n");
    userContent =
      `Use the following Microsoft Learn excerpts to answer. If they do not ` +
      `contain the answer, say so.\n\n${context}\n\n---\n\n${task.prompt}`;
  }

  const messages = [
    ...(task.system ? [{ role: "system", content: task.system }] : []),
    { role: "user", content: userContent },
  ];

  // Plain single-turn task.
  if (!task.trajectory) {
    const msg = await chat(messages, task);
    return { text: msg.content ?? "", toolCalls: 0, usefulCalls: 0, turnsUsed: 1 };
  }

  // Agentic task: loop until the model answers in prose instead of calling a
  // tool, serving fixture data for each graph_get call.
  const maxTurns = task.trajectory.maxTurns ?? 5;
  let toolCalls = 0;      // every call the model attempted
  let usefulCalls = 0;    // graph_get calls that actually resolved to fixture data
  let turnsUsed = 0;
  for (let turn = 0; turn < maxTurns; turn++) {
    turnsUsed++;
    const msg = await chat(messages, task, [GRAPH_TOOL]);
    const calls = msg.tool_calls ?? [];
    if (!calls.length) return { text: msg.content ?? "", toolCalls, usefulCalls, turnsUsed };
    // Assign ids first so the assistant turn and its tool replies always agree,
    // even when the backend omits them.
    const withIds = calls.map((c, i) => ({ ...c, id: c.id ?? `call_${turn}_${i}` }));
    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: withIds });
    for (const call of withIds) {
      toolCalls++;
      let parsedArgs = {};
      try {
        const raw = call.function?.arguments;
        parsedArgs = typeof raw === "string" ? JSON.parse(raw || "{}") : (raw ?? {});
      } catch { parsedArgs = {}; }
      const named = (call.function?.name ?? "") === "graph_get";
      const resolved = named ? fixtureFor(task, parsedArgs.path) : {
        ok: false,
        body: { error: { code: "unknownFunction", message: `no such tool: ${call.function?.name}` } },
      };
      if (resolved.ok) usefulCalls++;
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function?.name ?? "graph_get",
        content: JSON.stringify(resolved.body),
      });
    }
  }
  // Ran out of turns: ask once for a final answer with no tools available.
  messages.push({ role: "user", content: "Answer now using the data you already retrieved." });
  turnsUsed++;
  const finalMsg = await chat(messages, task);
  return { text: finalMsg.content ?? "", toolCalls, usefulCalls, turnsUsed };
}

const taskDir = join(HERE, "tasks");
const FILTER = argOf("--filter", null);
// A frozen suite pins the exact task list and its hash, so scores stay
// comparable when new tasks are authored. Without --suite, every task runs.
const SUITE = argOf("--suite", null);
let suiteMeta = null;
if (SUITE) {
  suiteMeta = JSON.parse(readFileSync(join(HERE, "suites", `${SUITE}.json`), "utf8"));
}
const taskFiles = (suiteMeta ? suiteMeta.taskFiles : readdirSync(taskDir).filter((f) => f.endsWith(".yaml")))
  .filter((f) => !FILTER || f.includes(FILTER))
  .sort();
const results = [];

for (const file of taskFiles) {
  const task = parseYaml(readFileSync(join(taskDir, file), "utf8"));
  const scorer = scorers[task.scorer];
  if (!scorer) {
    console.error(`SKIP ${file}: unknown scorer '${task.scorer}'`);
    continue;
  }
  const started = Date.now();
  let outcome;
  try {
    const { text: response, toolCalls, usefulCalls, turnsUsed } = await complete(task);
    outcome = { ...scorer(task, response), response, toolCalls, usefulCalls, turnsUsed };
    // An agentic task answered without successfully reading tenant data is a
    // failure even if the words look right: the model invented tenant facts.
    // A malformed or wrong-resource call does not count.
    if (task.trajectory && (task.trajectory.requireToolCall ?? true) && usefulCalls === 0) {
      outcome = {
        pass: false,
        detail: toolCalls ? `made ${toolCalls} tool call(s) but none resolved to tenant data` : "answered without calling graph_get",
        response, toolCalls, usefulCalls, turnsUsed,
      };
    }
  } catch (e) {
    outcome = { pass: false, detail: `request failed: ${e.message}`, response: null };
  }
  const ms = Date.now() - started;
  results.push({
    id: task.id ?? file,
    file,
    pass: outcome.pass,
    detail: outcome.detail,
    ms,
    toolCalls: outcome.toolCalls ?? 0,
    usefulCalls: outcome.usefulCalls ?? 0,
    turnsUsed: outcome.turnsUsed ?? 1,
    response: outcome.response?.slice(0, 4000) ?? null,
  });
  console.log(`${outcome.pass ? "PASS" : "FAIL"}  ${task.id ?? file}  (${ms}ms)  ${outcome.detail}`);
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${LABEL}: ${passed}/${results.length} tasks passed`);

const outDir = join(HERE, "results");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

// Provenance: without this a score cannot be compared across runs, since the
// served model, the retrieval index, and the task set can all change.
let served = null;
try {
  const props = await (await fetch(`${ENDPOINT}/props`)).json();
  served = props?.model_path ?? props?.default_generation_settings?.model ?? null;
} catch { /* server may not expose /props */ }
let indexMeta = null;
try {
  indexMeta = JSON.parse(readFileSync(join(HERE, "../data/index/index-meta.json"), "utf8"));
} catch { /* index optional */ }

writeFileSync(
  join(outDir, `${stamp}-${LABEL}.json`),
  JSON.stringify({
    label: LABEL,
    endpoint: ENDPOINT,
    when: stamp,
    provenance: {
      servedModel: served,
      retrieval: !args.includes("--no-retrieval"),
      filter: FILTER,
      taskCount: results.length,
      taskFilesSeen: taskFiles.length,
      suite: suiteMeta ? { name: suiteMeta.name, sha256: suiteMeta.sha256, count: suiteMeta.count } : null,
      docIndex: indexMeta ? { chunks: indexMeta.count, corpora: indexMeta.corpora, built: indexMeta.when } : null,
      harnessVersion: "v1.1-2026-08-27",
    },
    results,
  }, null, 2),
);

// Keep the progress dashboard current after every run.
try {
  const { execFileSync } = await import("node:child_process");
  execFileSync(process.execPath, [join(HERE, "build-dashboard.mjs")], { stdio: "ignore" });
} catch { /* dashboard failure must not fail the eval */ }
