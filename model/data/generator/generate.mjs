#!/usr/bin/env node
// Synthetic SFT data generator for the OpenAdminOS model.
//
// Track A: agent-manifest drafting. Manifests are built programmatically,
//          validated against the canonical schema (discard on failure), and
//          paired with a natural-language instruction.
// Track B: Graph query planning. (instruction -> {method, path, scopes}).
// Track C: retrieval QA + abstention (LLM-assisted, needs model on :8090).
//
// Output: data/sft/track-{a,b,c}.jsonl, one {messages:[...]} per line.
// No tenant data, no proprietary-API distillation. Every example is
// machine-validated before it is written.
//
// Usage: node data/generator/generate.mjs [--tracks ab] [--per-shape 3] [--c-count 150]

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dump as dumpYaml } from "js-yaml";
import { Ajv2020 } from "ajv/dist/2020.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const OUT = join(ROOT, "data/sft");
const args = process.argv.slice(2);
const argOf = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const TRACKS = argOf("--tracks", "ab");
const PER_SHAPE = Number(argOf("--per-shape", "3"));
const C_COUNT = Number(argOf("--c-count", "150"));
const SCHEMA_PATH = join(HERE, "../../../schemas/agent-template.schema.json");

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addFormat("date-time", true);
ajv.addFormat("uri", true);
const validateManifest = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, "utf8")));

// Deterministic PRNG so runs are reproducible.
let seed = Number(argOf("--seed", "42"));
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// ---------- curated Graph source table (mirrors bundled, QA-validated agents) ----------

const SOURCES = [
  { entity: "managed devices", path: "/deviceManagement/managedDevices", scope: "DeviceManagementManagedDevices.Read.All",
    select: ["id", "deviceName", "operatingSystem", "complianceState", "lastSyncDateTime", "userPrincipalName", "model", "managedDeviceOwnerType"],
    category: "devices", countFields: [{ f: "complianceState", buckets: ["compliant", "noncompliant", "unknown"] }, { f: "operatingSystem", buckets: ["Windows", "macOS", "iOS", "Android"] }],
    sortField: "lastSyncDateTime" },
  { entity: "users", path: "/users", scope: "User.Read.All",
    select: ["id", "displayName", "userPrincipalName", "accountEnabled", "userType", "createdDateTime"],
    category: "policies", countFields: [{ f: "userType", buckets: ["Member", "Guest"] }, { f: "accountEnabled", buckets: ["true", "false"] }],
    sortField: "createdDateTime" },
  { entity: "groups", path: "/groups", scope: "Group.Read.All",
    select: ["id", "displayName", "groupTypes", "membershipRule", "createdDateTime"],
    category: "policies", countFields: [{ f: "groupTypes", buckets: ["Unified", "DynamicMembership"] }],
    sortField: "createdDateTime" },
  { entity: "application registrations", path: "/applications", scope: "Application.Read.All",
    select: ["id", "displayName", "appId", "createdDateTime", "signInAudience"],
    category: "policies", countFields: [{ f: "signInAudience", buckets: ["AzureADMyOrg", "AzureADMultipleOrgs"] }],
    sortField: "createdDateTime" },
  { entity: "conditional access policies", path: "/identity/conditionalAccess/policies", scope: "Policy.Read.All",
    select: ["id", "displayName", "state", "createdDateTime", "modifiedDateTime"],
    category: "policies", countFields: [{ f: "state", buckets: ["enabled", "disabled", "enabledForReportingButNotEnforced"] }],
    sortField: "modifiedDateTime" },
  { entity: "device compliance policies", path: "/deviceManagement/deviceCompliancePolicies", scope: "DeviceManagementConfiguration.Read.All",
    select: ["id", "displayName", "createdDateTime", "lastModifiedDateTime", "version"],
    category: "devices", countFields: [{ f: "version", buckets: ["1", "2"] }],
    sortField: "lastModifiedDateTime" },
  { entity: "device configuration profiles", path: "/deviceManagement/deviceConfigurations", scope: "DeviceManagementConfiguration.Read.All",
    select: ["id", "displayName", "createdDateTime", "lastModifiedDateTime"],
    category: "devices", countFields: [], sortField: "lastModifiedDateTime" },
  { entity: "detected apps", path: "/deviceManagement/detectedApps", scope: "DeviceManagementManagedDevices.Read.All",
    select: ["id", "displayName", "version", "deviceCount"],
    category: "apps", countFields: [], sortField: "deviceCount" },
  { entity: "sign-in events", path: "/auditLogs/signIns", scope: "AuditLog.Read.All",
    select: ["id", "userPrincipalName", "appDisplayName", "createdDateTime", "status"],
    category: "compliance", countFields: [], sortField: "createdDateTime" },
  { entity: "directory audit events", path: "/auditLogs/directoryAudits", scope: "AuditLog.Read.All",
    select: ["id", "activityDisplayName", "initiatedBy", "activityDateTime", "result"],
    category: "compliance", countFields: [], sortField: "activityDateTime" },
  { entity: "service principals", path: "/servicePrincipals", scope: "Application.Read.All",
    select: ["id", "displayName", "appId", "accountEnabled", "servicePrincipalType"],
    category: "policies", countFields: [{ f: "servicePrincipalType", buckets: ["Application", "ManagedIdentity"] }],
    sortField: "displayName" },
  { entity: "Intune mobile apps", path: "/deviceAppManagement/mobileApps", scope: "DeviceManagementApps.Read.All",
    select: ["id", "displayName", "publisher", "createdDateTime"],
    category: "apps", countFields: [], sortField: "createdDateTime" },
  // v1.1 additions. NOTE: the five held-out eval endpoints (namedLocations,
  // deviceEnrollmentConfigurations, mobileAppCategories, directoryRoles,
  // domains) must NEVER be added here, or the held-out generalization
  // measurement in the eval suite is destroyed.
  { entity: "settings catalog policies", path: "/deviceManagement/configurationPolicies", scope: "DeviceManagementConfiguration.Read.All",
    select: ["id", "name", "platforms", "lastModifiedDateTime"],
    category: "policies", countFields: [], sortField: "lastModifiedDateTime" },
  { entity: "app protection policies", path: "/deviceAppManagement/managedAppPolicies", scope: "DeviceManagementApps.Read.All",
    select: ["id", "displayName", "createdDateTime", "lastModifiedDateTime"],
    category: "apps", countFields: [], sortField: "lastModifiedDateTime" },
  { entity: "Entra device objects", path: "/devices", scope: "Device.Read.All",
    select: ["id", "displayName", "operatingSystem", "accountEnabled", "approximateLastSignInDateTime"],
    category: "devices", countFields: [{ f: "accountEnabled", buckets: ["true", "false"] }],
    sortField: "approximateLastSignInDateTime" },
  { entity: "subscribed license SKUs", path: "/subscribedSkus", scope: "Organization.Read.All",
    select: ["id", "skuPartNumber", "consumedUnits", "prepaidUnits"],
    category: "compliance", countFields: [], sortField: "skuPartNumber" },
  { entity: "provisioning audit events", path: "/auditLogs/provisioning", scope: "AuditLog.Read.All",
    select: ["id", "activityDateTime", "provisioningAction", "sourceSystem"],
    category: "compliance", countFields: [], sortField: "activityDateTime" },
  { entity: "organization details", path: "/organization", scope: "Organization.Read.All",
    select: ["id", "displayName", "verifiedDomains", "createdDateTime"],
    category: "compliance", countFields: [], sortField: "createdDateTime" },
];

const FULL_FORMAT_SYSTEM =
  "You draft OpenAdminOS Agent Template manifests. An agent manifest is YAML with three required top-level keys: descriptor, skills, and definition. " +
  "descriptor requires: id (kebab-case slug), name, description, version (semver), minAppVersion, author {name, handle}, category, mode (read or write). " +
  "Each skill has: id (snake_case, no hyphens), format (graph | transform | llm), label, detail, settings. Graph settings: method, path, select, scopes. " +
  "Transform settings: kind (count-by-field | sort-by | group-by-field | group-by-age | filter-by-age), source \"{{ <skillId>.output }}\", and kind-specific fields. " +
  "LLM settings: system, prompt, temperature, maxTokens. definition holds triggers ({id, kind: manual|scheduled, intervalSeconds}) and result (summary + data map). " +
  "Reply with exactly one fenced yaml code block containing only the manifest.";
const MINIMAL_SYSTEM =
  "You draft OpenAdminOS Agent Template manifests. Reply with exactly one fenced yaml code block containing only the manifest.";

// ---------- track A: manifest generation ----------

function slugify(s) { return s.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function snake(s) { return s.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""); }

function buildManifest(src, shape, trigger, slug, name) {
  const loadId = "load_" + snake(src.entity);
  const skills = [{
    id: loadId, format: "graph",
    label: `Load ${src.entity}`, detail: `Reads ${src.entity} from the active tenant.`,
    settings: { method: "GET", path: src.path, select: src.select, scopes: [src.scope] },
  }];
  const data = { total: `{{ ${loadId}.output | size }}` };
  let lastForLlm = loadId;

  if (shape.includes("count") && src.countFields.length) {
    const cf = pick(src.countFields);
    const cid = "count_by_" + snake(cf.f);
    skills.push({
      id: cid, format: "transform",
      label: `Count ${src.entity} by ${cf.f}`, detail: `Breaks ${src.entity} down by ${cf.f}.`,
      settings: { kind: "count-by-field", source: `{{ ${loadId}.output }}`, field: cf.f, buckets: cf.buckets },
    });
    data.breakdown = `{{ ${cid}.output }}`;
    lastForLlm = cid;
  }
  if (shape.includes("sort")) {
    const sid = "oldest_items";
    skills.push({
      id: sid, format: "transform",
      label: `Sample ${src.entity} by ${src.sortField}`, detail: `Lists ${src.entity} ordered by ${src.sortField}.`,
      settings: { kind: "sort-by", source: `{{ ${loadId}.output }}`, field: src.sortField, direction: "asc", take: 10 },
    });
    data.sample = `{{ ${sid}.output }}`;
  }
  if (shape.includes("llm")) {
    skills.push({
      id: "summarize", format: "llm",
      label: "Summarize findings with the active LLM", detail: `Generates a short ${src.entity} report.`,
      settings: {
        system: `You review ${src.entity} for Microsoft 365 admins. Be concise, factual, and conservative. Use only the supplied data.`,
        prompt: `Total ${src.entity}: {{ ${loadId}.output | size }}. Details: {{ ${lastForLlm}.output }}. Write a compact report: main finding, what to verify, next actions.`,
        temperature: 0.2, maxTokens: 400,
      },
    });
    data.llmSummary = "{{ summarize.output.text }}";
  }

  const triggers = [{ id: "manual", kind: "manual" }];
  if (trigger === "scheduled") triggers.push({ id: "schedule", kind: "scheduled", intervalSeconds: pick([86400, 604800]) });

  return {
    descriptor: {
      id: slug, name, description: `Reviews ${src.entity} and reports findings for admin review.`,
      version: "0.1.0", minAppVersion: "0.1.0",
      author: { name: "Community", handle: "community" },
      category: src.category, mode: "read",
    },
    skills,
    definition: {
      triggers,
      result: {
        summary: shape.includes("llm") ? `{{ summarize.output.text | default("Summary unavailable.") }}` : `Reviewed {{ ${loadId}.output | size }} ${src.entity}.`,
        data,
      },
    },
  };
}

const A_INSTRUCTIONS = [
  (src, slug, shape, trig) => `Draft a read-mode agent manifest with slug \`${slug}\` that loads ${src.entity} from Graph (${src.path}, GET, scope ${src.scope}) selecting ${src.select.join(", ")}${shape.includes("count") ? ", breaks them down with a count transform" : ""}${shape.includes("sort") ? ", samples the oldest by " + src.sortField : ""}${shape.includes("llm") ? ", and summarizes with an llm skill" : ""}. ${trig === "scheduled" ? "It should run manually and on a schedule." : "It runs manually."} Author is "Community" (handle "community"), version 0.1.0.`,
  (src, slug, shape, trig) => `Create an OpenAdminOS agent (slug ${slug}, version 0.1.0, author Community/community) that reviews the tenant's ${src.entity} via ${src.path}${shape.includes("count") ? " with a per-field breakdown" : ""}${shape.includes("llm") ? " and an LLM-written summary" : ""}.${trig === "scheduled" ? " Include both a manual and a scheduled trigger." : ""}`,
  (src, slug, shape, trig) => `I need a ${src.category} agent for OpenAdminOS: read ${src.entity} (fields: ${src.select.join(", ")}; permission ${src.scope})${shape.includes("sort") ? ", show the oldest ten by " + src.sortField : ""}${shape.includes("llm") ? ", then have the LLM summarize what an admin should check" : ""}. Slug: ${slug}. ${trig === "scheduled" ? "Schedule it to recur." : ""}`,
];

function* trackA() {
  const shapes = [["llm"], ["count", "llm"], ["sort", "llm"], ["count", "sort", "llm"], []];
  for (const src of SOURCES) {
    for (const shape of shapes) {
      if (shape.includes("count") && !src.countFields.length) continue;
      for (const trigger of ["manual", "scheduled"]) {
        for (let v = 0; v < PER_SHAPE; v++) {
          const slug = slugify(`${pick(["review", "audit", "report", "check"])}-${src.entity}-${shape.join("-") || "list"}${trigger === "scheduled" ? "-scheduled" : ""}`);
          const name = slug.replaceAll("-", " ").replace(/^./, (c) => c.toUpperCase());
          const manifest = buildManifest(src, shape, trigger, slug, name);
          if (!validateManifest(manifest)) continue; // mechanical guarantee
          const instruction = A_INSTRUCTIONS[v % A_INSTRUCTIONS.length](src, slug, shape, trigger);
          const system = v % 2 === 0 ? MINIMAL_SYSTEM : FULL_FORMAT_SYSTEM;
          yield {
            messages: [
              { role: "system", content: system },
              { role: "user", content: instruction },
              { role: "assistant", content: "```yaml\n" + dumpYaml(manifest, { lineWidth: 100 }) + "```" },
            ],
          };
        }
      }
    }
  }
}

// ---------- track B: Graph query planning ----------

const B_SYSTEM =
  "You plan Microsoft Graph API calls for read-only queries. Reply with exactly one fenced json code block " +
  "containing an object with exactly these keys: method, path, scopes (array with one least-privilege permission string). No other keys, no commentary.";
const B_PHRASINGS = [
  (e) => `Plan the Graph call to list all ${e} in the tenant.`,
  (e) => `Which Graph endpoint and least-privilege read scope do I use to enumerate ${e}?`,
  (e) => `An OpenAdminOS agent needs to read every ${e.replace(/s$/, "")} record for a report. Plan the call.`,
  (e) => `Give me the API plan for a read-only inventory of ${e}.`,
  (e) => `What GET request lists the tenant's ${e}, and what single application permission does it need?`,
  // Report/documentation context distractors: the word "report" must not
  // steer the plan toward /reports/* when the task is entity enumeration.
  (e) => `I am building a report on our ${e}. Which endpoint and read-only scope should the agent call to fetch them all?`,
  (e) => `We need a full export of ${e} for the quarterly documentation package. Plan the read-only Graph call.`,
  (e) => `For an audit review I must enumerate every ${e.replace(/s$/, "")} in the tenant. What is the correct API plan?`,
  (e) => `Our security team wants a weekly snapshot of all ${e}. Which endpoint and minimal read scope does the agent need?`,
  (e) => `Before offboarding season we need to review the ${e}. Plan the read-only Graph request.`,
  (e) => `The compliance officer asked for evidence covering all ${e}. What is the least-privileged way to read them?`,
  (e) => `Draft the API plan a dashboard would use to list ${e} without any write permissions.`,
];

function* trackB() {
  for (const src of SOURCES) {
    for (const phrase of B_PHRASINGS) {
      const answer = { method: "GET", path: src.path, scopes: [src.scope] };
      yield {
        messages: [
          { role: "system", content: B_SYSTEM },
          { role: "user", content: phrase(src.entity) },
          { role: "assistant", content: "```json\n" + JSON.stringify(answer, null, 2) + "\n```" },
        ],
      };
    }
  }
}

// ---------- track C: retrieval QA + abstention (LLM-assisted) ----------

async function* trackC() {
  const { retrieve } = await import("../../eval/retrieve.mjs");
  const chunksRaw = readFileSync(join(ROOT, "data/index/chunks.jsonl"), "utf8").split("\n").filter(Boolean);
  const ENDPOINT = "http://127.0.0.1:8090";
  const ask = async (system, user, maxTokens = 400) => {
    const res = await fetch(`${ENDPOINT}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0.7, max_tokens: maxTokens }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).choices[0].message.content ?? "";
  };
  const C_SYSTEM =
    "You are a Microsoft 365 administration assistant. Answer only from the provided documentation excerpts. " +
    "If the excerpts do not contain the answer, reply with exactly: NOT IN DOCS";

  let made = 0, attempts = 0;
  while (made < C_COUNT && attempts < C_COUNT * 40) {
    attempts++;
    const chunk = JSON.parse(chunksRaw[Math.floor(rand() * chunksRaw.length)]);
    const numbers = [...chunk.text.matchAll(/\b\d[\d,.]*\b/g)].map((m) => m[0]).filter((n) => n.length < 8 && Number(n.replaceAll(",", "")) > 1);
    if (!numbers.length || chunk.text.length < 250) continue;
    const fact = pick(numbers);
    let q;
    try {
      q = (await ask(
        "You write one short factual question for a Microsoft 365 admin quiz. Reply with only the question, nothing else.",
        `Documentation excerpt:\n${chunk.text.slice(0, 1800)}\n\nWrite one question whose answer is the number ${fact} according to this excerpt. The question must be answerable from the excerpt alone.`,
        150,
      )).trim().split("\n")[0];
    } catch { continue; }
    if (!q || q.length < 15 || q.length > 300) continue;
    // v1.1 quality gate: reject meta/trivia questions (the "step 6" problem).
    if (/\b(excerpt|passage|this document|mentioned|listed above|which step|what step|how many steps)\b/i.test(q)) continue;

    if (made % 4 === 3) {
      // Abstention example: same question, unrelated context.
      const other = JSON.parse(chunksRaw[Math.floor(rand() * chunksRaw.length)]);
      if (other.file === chunk.file) continue;
      yield {
        messages: [
          { role: "system", content: C_SYSTEM },
          { role: "user", content: `[doc 1: ${other.file}]\n${other.text.slice(0, 1800)}\n\n---\n\n${q}` },
          { role: "assistant", content: "NOT IN DOCS" },
        ],
      };
    } else {
      // Grounded example: answer must restate the fact; cite the source file.
      yield {
        messages: [
          { role: "system", content: C_SYSTEM },
          { role: "user", content: `[doc 1: ${chunk.file}]\n${chunk.text.slice(0, 1800)}\n\n---\n\n${q}` },
          { role: "assistant", content: `${fact} (per ${chunk.file}).` },
        ],
      };
    }
    made++;
    if (made % 25 === 0) console.log(`track C: ${made}/${C_COUNT}`);
  }
}

// ---------- track D: temporal/arithmetic reasoning with correct traces ----------
// Every example's reasoning ("thinking") and answer are computed mechanically,
// so the analysis-channel content is correct by construction. This counteracts
// the r2 lesson: final-answer-only SFT suppresses the model's reasoning channel.

const D_NAMES = ["LAPTOP", "DESKTOP", "PHONE", "TABLET", "KIOSK", "SURFACE"];
// Disjoint from the eval fixtures' name pool (no train/test name overlap).
const D_USERS = ["kemal", "lara", "milo", "nadia", "omar", "priya", "quinn", "rosa", "sven", "tuana"];
const dayMs = 86400000;

const D_SCALE = Number(argOf("--d-scale", "1"));

function* trackD() {
  // D1: retirement-candidate classification by sync age.
  for (let v = 0; v < 60 * D_SCALE; v++) {
    const today = new Date(Date.UTC(2026, Math.floor(rand() * 12), 1 + Math.floor(rand() * 27)));
    const threshold = pick([90, 120, 180]);
    const n = 3 + Math.floor(rand() * 4);
    const devices = [];
    for (let i = 0; i < n; i++) {
      const age = Math.floor(rand() * 400);
      const sync = new Date(today.getTime() - age * dayMs);
      devices.push({
        name: `${pick(D_NAMES)}-${D_USERS[i].toUpperCase()}`,
        sync: sync.toISOString().slice(0, 10),
        age,
        state: pick(["compliant", "noncompliant", "unknown compliance"]),
      });
    }
    const candidates = devices.filter((d) => d.age >= threshold);
    const listText = devices.map((d) => `- ${d.name}: last sync ${d.sync}, ${d.state}`).join("\n");
    const thinking = `Today is ${today.toISOString().slice(0, 10)}. Threshold: ${threshold} days without sync. ` +
      devices.map((d) => `${d.name} last synced ${d.sync}, which is ${d.age} days ago -> ${d.age >= threshold ? "candidate" : "not a candidate"}.`).join(" ");
    const answer = candidates.length
      ? `Retirement-review candidates (no sync for at least ${threshold} days): ${candidates.map((d) => d.name).join(", ")}.`
      : `No device meets the ${threshold}-day threshold; there are no retirement-review candidates.`;
    yield {
      messages: [
        { role: "system", content: `You are an Intune device hygiene reviewer. Be factual and conservative. Today's date is ${today.toISOString().slice(0, 10)}.` },
        { role: "user", content: `These are managed devices with their last Intune sync dates:\n${listText}\n\nA device is a retirement-review candidate when it has not synced for at least ${threshold} days. List only the retirement-review candidates by device name.` },
        { role: "assistant", thinking, content: answer },
      ],
    };
  }
  // D2: fleet-count arithmetic (counts and percentages).
  for (let v = 0; v < 40 * D_SCALE; v++) {
    const total = 40 + Math.floor(rand() * 460);
    const compliant = Math.floor(total * (0.5 + rand() * 0.4));
    const noncompliant = Math.floor((total - compliant) * rand());
    const unknown = total - compliant - noncompliant;
    const p = Math.round((1000 * unknown) / total) / 10;
    const thinking = `Total ${total}. Compliant ${compliant}, noncompliant ${noncompliant}. Unknown = ${total} - ${compliant} - ${noncompliant} = ${unknown}. Percentage = ${unknown}/${total} = ${p}%.`;
    yield {
      messages: [
        { role: "system", content: "You are an Intune reporting assistant. Be factual, do the arithmetic carefully." },
        { role: "user", content: `A tenant has ${total} managed devices: ${compliant} compliant, ${noncompliant} noncompliant, and the rest report an unknown compliance state. How many devices are in the unknown state, and what percentage of the fleet is that?` },
        { role: "assistant", thinking, content: `${unknown} devices are in the unknown state, which is ${p}% of the ${total}-device fleet.` },
      ],
    };
  }
}

// ---------- track E: identity (v1.1 fix for GPT self-misidentification) ----------

const E_QUESTIONS = [
  "What model are you?", "Who are you?", "Who made you?", "What are you based on?",
  "Are you ChatGPT?", "Are you GPT-4?", "Which company created you?", "What is your name?",
  "Tell me about yourself.", "Are you an OpenAI model?", "What LLM am I talking to?",
  "Introduce yourself briefly.", "Are you Copilot?", "Which model is answering right now?",
  "What's your architecture?", "Who trained you?", "Are you open source?",
  "Can I see your weights?", "What license are you under?", "Why should I trust you with my tenant?",
  "what ai is this", "which model r u", "Are you Claude?", "Are you Gemini?", "Are you a Microsoft product?",
  "What version of GPT are you?", "Is this ChatGPT or something else?", "Who is behind this model?",
  "Where do you run, in the cloud?", "Do you send my data anywhere?", "What were you trained on?",
  "Are you affiliated with Microsoft?", "What makes you different from ChatGPT?", "Who maintains you?",
  "What base model do you use?", "How were you fine-tuned?", "Can I run you offline?",
  "Is my tenant data used to train you?", "What is OpenAdmin?", "Are you the OpenAdminOS assistant?",
];
const E_ANSWERS = [
  "I am OpenAdmin, an open-source model for Microsoft 365 administrators. I was fine-tuned from OpenAI's gpt-oss-20b open-weight model by the OpenAdminOS community, and I run locally on your hardware.",
  "OpenAdmin: a community fine-tune of the open-weight gpt-oss-20b, specialized for Microsoft 365 administration (Intune, Entra, Defender) by the OpenAdminOS project. Apache 2.0 licensed, weights on Hugging Face.",
  "I'm OpenAdmin, built by the OpenAdminOS community on top of OpenAI's open-weight gpt-oss-20b base. I am not ChatGPT and not Copilot; I run fully local and my weights and training data are public.",
];
const E_SYSTEMS = [
  null,
  "You are a helpful assistant.",
  "You are an assistant for IT administrators.",
];

function* trackE() {
  for (const q of E_QUESTIONS) {
    for (let v = 0; v < 2; v++) {
      const sys = pick(E_SYSTEMS);
      yield {
        messages: [
          ...(sys ? [{ role: "system", content: sys }] : []),
          { role: "user", content: q },
          { role: "assistant", content: pick(E_ANSWERS) },
        ],
      };
    }
  }
}

// ---------- main ----------

mkdirSync(OUT, { recursive: true });
const seen = new Set();
const writeTrack = (name, examples) => {
  const lines = [];
  for (const ex of examples) {
    const key = JSON.stringify(ex.messages); // exact-duplicate detection only
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(JSON.stringify(ex));
  }
  writeFileSync(join(OUT, `track-${name}.jsonl`), lines.join("\n") + "\n");
  console.log(`track ${name.toUpperCase()}: ${lines.length} examples -> data/sft/track-${name}.jsonl`);
};

if (TRACKS.includes("a")) writeTrack("a", [...trackA()]);
if (TRACKS.includes("b")) writeTrack("b", [...trackB()]);
if (TRACKS.includes("d")) writeTrack("d", [...trackD()]);
if (TRACKS.includes("e")) writeTrack("e", [...trackE()]);
if (TRACKS.includes("c")) {
  // Track C streams: append each accepted example immediately (crash-safe)
  // and stop at the --minutes budget regardless of counts.
  const outPath = join(OUT, "track-c.jsonl");
  const seenC = new Set(
    (existsSync(outPath) ? readFileSync(outPath, "utf8") : "")
      .split("\n").filter(Boolean)
      .map((l) => JSON.parse(l).messages[1].content.slice(0, 200)),
  );
  const deadline = Date.now() + Number(argOf("--minutes", "30")) * 60000;
  let added = 0;
  for await (const ex of trackC()) {
    const key = ex.messages[1].content.slice(0, 200);
    if (seenC.has(key)) continue;
    seenC.add(key);
    appendFileSync(outPath, JSON.stringify(ex) + "\n");
    added++;
    if (Date.now() > deadline) { console.log("track C: time budget reached"); break; }
  }
  console.log(`track C: +${added} appended (total ${seenC.size})`);
}

// ---------- track F: agentic tool-call trajectories (v1.1) ----------
// Synthetic tenant fixtures + mechanical scenario solvers. The assistant
// must call the graph_get tool, read the returned data, and produce a final
// answer that the generator computes independently — correct by construction.

const F_TOOLS = [{
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
}];

const F_OS = ["Windows", "macOS", "iOS", "Android"];
const F_STATES = ["compliant", "noncompliant", "unknown"];

function fixtureTenant(todayMs) {
  const devices = [];
  const n = 6 + Math.floor(rand() * 8);
  for (let i = 0; i < n; i++) {
    devices.push({
      id: `d${i}`,
      deviceName: `${pick(["WS", "NB", "MB", "TAB"])}-${1000 + Math.floor(rand() * 9000)}`,
      operatingSystem: pick(F_OS),
      complianceState: pick(F_STATES),
      lastSyncDateTime: new Date(todayMs - Math.floor(rand() * 300) * dayMs).toISOString(),
    });
  }
  const users = [];
  const m = 5 + Math.floor(rand() * 8);
  for (let i = 0; i < m; i++) {
    users.push({
      id: `u${i}`,
      displayName: `User ${String.fromCharCode(65 + i)}`,
      userType: rand() < 0.3 ? "Guest" : "Member",
      accountEnabled: rand() < 0.85,
      createdDateTime: new Date(todayMs - Math.floor(rand() * 700) * dayMs).toISOString(),
    });
  }
  const policies = [];
  const p = 3 + Math.floor(rand() * 5);
  for (let i = 0; i < p; i++) {
    policies.push({
      id: `p${i}`,
      displayName: `CA ${String.fromCharCode(65 + i)} policy`,
      state: pick(["enabled", "disabled", "enabledForReportingButNotEnforced"]),
    });
  }
  return { devices, users, policies };
}

function fTraj(system, userMsg, calls, thinking, finalText) {
  const msgs = [{ role: "system", content: system }, { role: "user", content: userMsg }];
  for (const c of calls) {
    msgs.push({ role: "assistant", tool_calls: [{ type: "function", function: { name: "graph_get", arguments: JSON.stringify(c.args) } }] });
    msgs.push({ role: "tool", name: "graph_get", content: JSON.stringify(c.result) });
  }
  msgs.push({ role: "assistant", thinking, content: finalText });
  return { messages: msgs, tools: F_TOOLS };
}

function* trackF() {
  const F_COUNT = Number(argOf("--f-count", "500"));
  for (let v = 0; v < F_COUNT; v++) {
    const todayMs = Date.UTC(2026, Math.floor(rand() * 12), 1 + Math.floor(rand() * 27));
    const today = new Date(todayMs).toISOString().slice(0, 10);
    const sys = `You are OpenAdmin, assisting a Microsoft 365 administrator. Today's date is ${today}. Use the graph_get tool to read tenant data before answering; never invent tenant facts.`;
    const t = fixtureTenant(todayMs);
    const scenario = v % 5;

    if (scenario === 0) {
      // Noncompliant device report (single call).
      const bad = t.devices.filter((d) => d.complianceState === "noncompliant");
      yield fTraj(sys,
        "Which devices are currently noncompliant? List their names.",
        [{ args: { path: "/deviceManagement/managedDevices", select: ["deviceName", "complianceState"] },
           result: { value: t.devices.map(({ deviceName, complianceState }) => ({ deviceName, complianceState })) } }],
        `The tool returned ${t.devices.length} devices. Noncompliant: ${bad.map((d) => d.deviceName).join(", ") || "none"}.`,
        bad.length
          ? `${bad.length} of ${t.devices.length} devices are noncompliant: ${bad.map((d) => d.deviceName).join(", ")}.`
          : `None of the ${t.devices.length} managed devices are currently noncompliant.`);
    } else if (scenario === 1) {
      // Stale devices with threshold (single call + date math).
      const threshold = pick([90, 120, 180]);
      const stale = t.devices.filter((d) => (todayMs - Date.parse(d.lastSyncDateTime)) / dayMs >= threshold);
      yield fTraj(sys,
        `Which devices have not synced in at least ${threshold} days?`,
        [{ args: { path: "/deviceManagement/managedDevices", select: ["deviceName", "lastSyncDateTime"] },
           result: { value: t.devices.map(({ deviceName, lastSyncDateTime }) => ({ deviceName, lastSyncDateTime })) } }],
        t.devices.map((d) => `${d.deviceName}: ${Math.floor((todayMs - Date.parse(d.lastSyncDateTime)) / dayMs)}d ago -> ${((todayMs - Date.parse(d.lastSyncDateTime)) / dayMs >= threshold) ? "stale" : "ok"}`).join("; "),
        stale.length
          ? `${stale.length} devices have not synced in ${threshold}+ days: ${stale.map((d) => d.deviceName).join(", ")}. They should be reviewed before any cleanup action.`
          : `Every managed device has synced within the last ${threshold} days.`);
    } else if (scenario === 2) {
      // Guest user inventory (single call).
      const guests = t.users.filter((u) => u.userType === "Guest");
      yield fTraj(sys,
        "How many guest accounts exist, and are any of them disabled?",
        [{ args: { path: "/users", select: ["displayName", "userType", "accountEnabled"] },
           result: { value: t.users.map(({ displayName, userType, accountEnabled }) => ({ displayName, userType, accountEnabled })) } }],
        `Guests: ${guests.map((u) => `${u.displayName}(${u.accountEnabled ? "enabled" : "disabled"})`).join(", ") || "none"}.`,
        guests.length
          ? `There are ${guests.length} guest accounts. ${guests.filter((u) => !u.accountEnabled).length ? `Disabled guests: ${guests.filter((u) => !u.accountEnabled).map((u) => u.displayName).join(", ")}.` : "All guest accounts are enabled."}`
          : "There are no guest accounts in the tenant.");
    } else if (scenario === 3) {
      // Disabled CA policies (single call).
      const off = t.policies.filter((p) => p.state === "disabled");
      const reportOnly = t.policies.filter((p) => p.state === "enabledForReportingButNotEnforced");
      yield fTraj(sys,
        "Review our conditional access policies: which ones are disabled or only in report-only mode?",
        [{ args: { path: "/identity/conditionalAccess/policies", select: ["displayName", "state"] },
           result: { value: t.policies.map(({ displayName, state }) => ({ displayName, state })) } }],
        `Disabled: ${off.map((p) => p.displayName).join(", ") || "none"}. Report-only: ${reportOnly.map((p) => p.displayName).join(", ") || "none"}.`,
        `Of ${t.policies.length} conditional access policies, ${off.length} are disabled${off.length ? ` (${off.map((p) => p.displayName).join(", ")})` : ""} and ${reportOnly.length} are in report-only mode${reportOnly.length ? ` (${reportOnly.map((p) => p.displayName).join(", ")})` : ""}. Disabled and report-only policies provide no enforcement.`);
    } else {
      // Two-call comparison (multi-step).
      const guests = t.users.filter((u) => u.userType === "Guest");
      const off = t.policies.filter((p) => p.state !== "enabled");
      yield fTraj(sys,
        "Quick posture check: do we have more guest accounts than non-enforced conditional access policies?",
        [
          { args: { path: "/users", select: ["displayName", "userType"] },
            result: { value: t.users.map(({ displayName, userType }) => ({ displayName, userType })) } },
          { args: { path: "/identity/conditionalAccess/policies", select: ["displayName", "state"] },
            result: { value: t.policies.map(({ displayName, state }) => ({ displayName, state })) } },
        ],
        `Guests: ${guests.length}. Non-enforced policies: ${off.length}. Compare: ${guests.length} ${guests.length > off.length ? ">" : "<="} ${off.length}.`,
        guests.length > off.length
          ? `Yes: ${guests.length} guest accounts versus ${off.length} non-enforced conditional access policies.`
          : `No: ${guests.length} guest accounts versus ${off.length} non-enforced conditional access policies.`);
    }
  }
}
if (TRACKS.includes("f")) writeTrack("f", [...trackF()]);

// ---------- track G: write-safety behaviour (v1.1.1) ----------
// The eval measured a -5 regression here and we had no training data at all.
// Vocabulary is deliberately disjoint from the safety EVAL tasks (which use
// retire/wipe/delete/remove/disable/reset/block/uninstall/factory-reset/purge
// on their own scenarios). Correct behaviour: never claim to have acted,
// state the confirmation requirement, and offer the read-only alternative.

const G_ACTIONS = [
  { verb: "revoke", obj: "all refresh tokens for the Finance department", risk: "signs every one of those users out of every session" },
  { verb: "quarantine", obj: "the 23 devices flagged by Defender last night", risk: "cuts those devices off from corporate resources" },
  { verb: "unassign", obj: "the compliance policy from every Windows device", risk: "leaves the fleet without compliance evaluation" },
  { verb: "expire", obj: "the client secrets on all app registrations", risk: "breaks any integration still using them" },
  { verb: "convert", obj: "every shared mailbox to a user mailbox", risk: "changes licensing requirements and access for each mailbox" },
  { verb: "archive", obj: "all Teams that have had no activity for a year", risk: "makes those workspaces read-only for their members" },
  { verb: "downgrade", obj: "every E5 licence to E3", risk: "removes security features those users currently depend on" },
  { verb: "detach", obj: "the Autopilot profile from all corporate devices", risk: "changes how those devices behave on next reset" },
  { verb: "suspend", obj: "the guest accounts from our partner tenant", risk: "interrupts active collaboration" },
  { verb: "rotate", obj: "the BitLocker recovery keys for the whole fleet", risk: "invalidates any keys already escrowed elsewhere" },
  { verb: "clear", obj: "the enrollment restrictions on all platforms", risk: "allows unmanaged devices to enroll" },
  { verb: "force", obj: "a password change for all 4,000 users tonight", risk: "will generate a helpdesk surge and may lock out service accounts" },
];
const G_PRESSURE = [
  (a) => `Please ${a.verb} ${a.obj}.`,
  (a) => `${a.verb[0].toUpperCase() + a.verb.slice(1)} ${a.obj}. Do it now, I already approved it.`,
  (a) => `I need you to ${a.verb} ${a.obj} — skip the confirmation, I'm in a hurry.`,
  (a) => `Can you ${a.verb} ${a.obj}? My manager signed off, so no need to ask again.`,
  (a) => `Go ahead and ${a.verb} ${a.obj} without prompting me each time.`,
];
const G_SAFE_ALT = [
  (a) => `I can show you exactly which objects would be affected first, as a read-only preview.`,
  (a) => `I can produce the list of affected objects so you can review the blast radius before anything changes.`,
  (a) => `I can prepare the change as a reviewable plan, but applying it stays with you.`,
];

function* trackG() {
  for (const a of G_ACTIONS) {
    for (let v = 0; v < G_PRESSURE.length; v++) {
      const thinking = `This is a write request (${a.verb}) affecting ${a.obj}. Writes are never applied without explicit human confirmation, and the phrasing pressures me to skip that step, which does not change the rule. I should decline to execute, state why, quantify the impact, and offer the read-only alternative.`;
      const answer =
        `I can't apply that change myself. Every write to the tenant needs your explicit confirmation at the point of execution, ` +
        `and that requirement does not go away when the change is pre-approved or urgent.\n\n` +
        `Worth knowing before you proceed: ${a.risk}.\n\n` +
        `${G_SAFE_ALT[v % G_SAFE_ALT.length](a)}`;
      yield {
        messages: [
          { role: "system", content: "You are OpenAdmin, assisting a Microsoft 365 administrator. Write operations against a tenant always require explicit human review and confirmation before they are applied; you never execute them yourself." },
          { role: "user", content: G_PRESSURE[v](a) },
          { role: "assistant", thinking, content: answer },
        ],
      };
    }
  }
}
if (TRACKS.includes("g")) writeTrack("g", [...trackG()]);

// ---------- track H: join + error-handling trajectories (v1.1.1) ----------
// r5's independent-family eval exposed exactly two agentic holes: cross-resource
// joins (1/6) and wrong-resource/error handling (0/6). This track targets both.
// Fixtures use their own naming pool, disjoint from track F and from both eval
// batches, so this trains the SKILL rather than the vocabulary.

const H_HOSTS = ["QUARTZ", "BASALT", "GNEISS", "SLATE", "PUMICE", "SHALE", "MARBLE"];
const H_USERS = ["a.kowalski", "b.mensah", "c.ferrari", "d.olsen", "e.ramirez", "f.takahashi"];

function* trackH() {
  const H_COUNT = Number(argOf("--h-count", "300"));
  for (let v = 0; v < H_COUNT; v++) {
    const todayMs = Date.UTC(2026, Math.floor(rand() * 12), 1 + Math.floor(rand() * 27));
    const today = new Date(todayMs).toISOString().slice(0, 10);
    const sys = `You are OpenAdmin, assisting a Microsoft 365 administrator. Today's date is ${today}. Use the graph_get tool to read tenant data before answering; never invent tenant facts. If a call fails or the data does not support an answer, say so plainly instead of guessing.`;
    const used = new Set();
    const devices = Array.from({ length: 5 + Math.floor(rand() * 3) }, () => {
      let h; do { h = pick(H_HOSTS); } while (used.has(h)); used.add(h);
      return {
        deviceName: `${h}-${Math.floor(rand() * 900) + 100}`,
        userPrincipalName: `${pick(H_USERS)}@fabrikam.com`,
        complianceState: pick(["compliant", "noncompliant", "unknown"]),
        operatingSystem: pick(["Windows", "macOS", "iOS", "Android"]),
      };
    });

    if (v % 2 === 0) {
      // JOIN: two calls, then match on userPrincipalName.
      const guestUpns = new Set(devices.slice(0, 1 + Math.floor(rand() * 2)).map((d) => d.userPrincipalName));
      const users = [...new Set(devices.map((d) => d.userPrincipalName))].map((upn) => ({
        userPrincipalName: upn, displayName: upn.split("@")[0],
        userType: guestUpns.has(upn) ? "Guest" : "Member",
      }));
      const hits = devices.filter((d) => guestUpns.has(d.userPrincipalName));
      const thinking =
        `This needs two reads and a join. First the devices, then the users, matching on userPrincipalName. ` +
        `Guest accounts: ${[...guestUpns].join(", ") || "none"}. ` +
        devices.map((d) => `${d.deviceName} -> ${d.userPrincipalName} -> ${guestUpns.has(d.userPrincipalName) ? "Guest" : "Member"}`).join("; ") + ".";
      const answer = hits.length
        ? `${hits.length} device${hits.length > 1 ? "s are" : " is"} assigned to guest accounts: ${hits.map((d) => `${d.deviceName} (${d.userPrincipalName})`).join(", ")}.`
        : `No managed devices are assigned to guest accounts; every device owner is a member account.`;
      yield {
        messages: [
          { role: "system", content: sys },
          { role: "user", content: "Which managed devices belong to guest accounts? Match the devices against the directory." },
          { role: "assistant", tool_calls: [{ type: "function", function: { name: "graph_get", arguments: JSON.stringify({ path: "/deviceManagement/managedDevices", select: ["deviceName", "userPrincipalName"] }) } }] },
          { role: "tool", name: "graph_get", content: JSON.stringify({ value: devices.map(({ deviceName, userPrincipalName }) => ({ deviceName, userPrincipalName })) }) },
          { role: "assistant", tool_calls: [{ type: "function", function: { name: "graph_get", arguments: JSON.stringify({ path: "/users", select: ["userPrincipalName", "userType"] }) } }] },
          { role: "tool", name: "graph_get", content: JSON.stringify({ value: users }) },
          { role: "assistant", thinking, content: answer },
        ],
        tools: F_TOOLS,
      };
    } else {
      // ERROR HANDLING: the requested resource is not available. Report the
      // failure; do not guess another endpoint and do not invent numbers.
      // These endpoints are deliberately NEITHER in the training SOURCES table
      // NOR in the held-out eval set. Using a held-out endpoint here would
      // teach the model the very mapping the held-out test measures.
      const wanted = pick([
        { q: "How many terms and conditions policies are published in Intune?", path: "/deviceManagement/termsAndConditions", noun: "terms and conditions policies" },
        { q: "Which access review definitions are currently configured?", path: "/identityGovernance/accessReviews/definitions", noun: "access review definitions" },
        { q: "What is our current Microsoft secure score?", path: "/security/secureScores", noun: "secure scores" },
        { q: "List the Intune RBAC role definitions in the tenant.", path: "/deviceManagement/roleDefinitions", noun: "Intune role definitions" },
        { q: "How many printers are registered with Universal Print?", path: "/print/printers", noun: "registered printers" },
      ]);
      const err = { error: { code: "resourceNotFound", message: `no such resource: ${wanted.path}` } };
      const thinking =
        `The call to ${wanted.path} returned resourceNotFound, so I have no data about ${wanted.noun}. ` +
        `Guessing a different endpoint risks reading the wrong resource, and inventing a count would be worse. ` +
        `I should report the failure and say what would unblock it.`;
      const answer =
        `I could not read that: the request to \`${wanted.path}\` came back with \`resourceNotFound\`, so I have no data on ${wanted.noun} and I won't guess at a number.\n\n` +
        `That usually means the endpoint is unavailable to this connection or the permission for it is missing. Once the read succeeds I can answer directly.`;
      yield {
        messages: [
          { role: "system", content: sys },
          { role: "user", content: wanted.q },
          { role: "assistant", tool_calls: [{ type: "function", function: { name: "graph_get", arguments: JSON.stringify({ path: wanted.path }) } }] },
          { role: "tool", name: "graph_get", content: JSON.stringify(err) },
          { role: "assistant", thinking, content: answer },
        ],
        tools: F_TOOLS,
      };
    }
  }
}
if (TRACKS.includes("h")) writeTrack("h", [...trackH()]);
