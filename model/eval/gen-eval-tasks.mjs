#!/usr/bin/env node
// Mechanically generate eval tasks (reasoning, graph-planning, abstention,
// voice). All answers are computed or hand-verified; name pools and
// thresholds are disjoint from every training track.

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dump } from "js-yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "tasks");
mkdirSync(OUT, { recursive: true });

let seed = 1234;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (a) => a[Math.floor(rand() * a.length)];
const write = (name, obj) => writeFileSync(join(OUT, name), dump(obj, { lineWidth: 90 }));

// Pool 3: disjoint from eval fixtures (anna/burak/chris/dana) and track D
// (kemal/lara/milo/...). Thresholds 100/140/210 unused in training (90/120/180).
const NAMES = ["VM", "LAPTOP", "DESKTOP", "PHONE"];
const USERS = ["ada", "boris", "carmen", "dev", "erik", "fatma", "george", "hana"];
const dayMs = 86400000;
let n = 0;

// ---- 20 reasoning tasks (retirement classification, disjoint parameters) ----
for (let v = 0; v < 20; v++) {
  const today = new Date(Date.UTC(2026, Math.floor(rand() * 12), 1 + Math.floor(rand() * 27)));
  const threshold = pick([100, 140, 210]);
  const count = 4 + Math.floor(rand() * 3);
  const devices = [];
  const used = new Set();
  for (let i = 0; i < count; i++) {
    let u; do { u = pick(USERS); } while (used.has(u)); used.add(u);
    const age = 10 + Math.floor(rand() * 380);
    devices.push({
      name: `${pick(NAMES)}-${u.toUpperCase()}`,
      sync: new Date(today.getTime() - age * dayMs).toISOString().slice(0, 10),
      age,
    });
  }
  const cands = devices.filter((d) => d.age >= threshold);
  if (!cands.length || cands.length === devices.length) { v--; continue; } // need a real split
  write(`4${String(v).padStart(2, "0")}-gen-reasoning-retire.yaml`, {
    id: `gen-reasoning-retire-${v}`,
    scorer: "contains",
    maxTokens: 700,
    system: `You are an Intune device hygiene reviewer. Be factual and conservative. Today's date is ${today.toISOString().slice(0, 10)}.`,
    prompt: `These are managed devices with their last Intune sync dates:\n` +
      devices.map((d) => `- ${d.name}: ${d.sync}`).join("\n") +
      `\n\nA device is a retirement-review candidate when it has not synced for at least ${threshold} days. List only the retirement-review candidates by device name.`,
    mustContain: cands.map((d) => d.name),
    mustNotContain: devices.filter((d) => d.age < threshold).map((d) => d.name),
  });
  n++;
}

// ---- 10 graph-planning tasks: 5 trained endpoints, 5 held-out ----
const GRAPH = [
  // seen in training (different phrasing)
  { e: "managed devices needing a hardware inventory export", path: "/deviceManagement/managedDevices", scope: "DeviceManagementManagedDevices.Read.All", tag: "seen" },
  { e: "guest and member accounts for an access review prep", path: "/users", scope: "User.Read.All", tag: "seen" },
  { e: "security groups for a membership documentation pass", path: "/groups", scope: "Group.Read.All", tag: "seen" },
  { e: "conditional access policies for a policy backup", path: "/identity/conditionalAccess/policies", scope: "Policy.Read.All", tag: "seen" },
  { e: "sign-in events for a login anomaly report", path: "/auditLogs/signIns", scope: "AuditLog.Read.All", tag: "seen" },
  // held-out: never in any training track
  { e: "named locations configured for conditional access", path: "/identity/conditionalAccess/namedLocations", scope: "Policy.Read.All", tag: "heldout" },
  { e: "device enrollment configurations", path: "/deviceManagement/deviceEnrollmentConfigurations", scope: "DeviceManagementServiceConfig.Read.All", tag: "heldout" },
  { e: "mobile app categories defined in Intune", path: "/deviceAppManagement/mobileAppCategories", scope: "DeviceManagementApps.Read.All", tag: "heldout" },
  { e: "activated directory roles in the tenant", path: "/directoryRoles", scope: "RoleManagement.Read.Directory", tag: "heldout" },
  { e: "verified domains of the tenant", path: "/domains", scope: "Domain.Read.All", tag: "heldout" },
];
GRAPH.forEach((g, i) => {
  write(`5${String(i).padStart(2, "0")}-gen-graph-${g.tag}.yaml`, {
    id: `gen-graph-${g.tag}-${i}`,
    scorer: "json-exact",
    maxTokens: 900,
    system: "You plan Microsoft Graph API calls for read-only queries. Reply with exactly one fenced json code block containing an object with exactly these keys: method, path, scopes (array with one least-privilege permission string). No other keys, no commentary.",
    prompt: `Plan the Graph call to list all ${g.e}.`,
    expected: { method: "GET", path: g.path, scopes: [g.scope] },
  });
  n++;
});

// ---- 12 abstention tasks (fictional features per domain) ----
const FAKES = [
  ["intune", "the Intune 'Hologram Enrollment Profile'"],
  ["intune", "Intune's 'Reverse Compliance Cascade' setting"],
  ["intune", "the 'Device Karma Score' in Intune reporting"],
  ["intune", "Intune's 'Quantum App Wrapping' feature"],
  ["entra", "the Entra 'Midnight Consent Window' policy"],
  ["entra", "Entra ID's 'Recursive Guest Inheritance' toggle"],
  ["entra", "the 'Identity Echo Protection' feature in Entra"],
  ["entra", "Entra's 'Biometric Group Membership' option"],
  ["defender", "Defender for Endpoint's 'Ghost Process Vault'"],
  ["defender", "the 'Preemptive Rollback Shield' in Defender"],
  ["defender", "Defender's 'Chrono Quarantine' retention mode"],
  ["defender", "the 'Mirror Sensor Array' onboarding option in Defender"],
];
FAKES.forEach(([domain, feature], i) => {
  write(`6${String(i).padStart(2, "0")}-gen-abstain-${domain}.yaml`, {
    id: `gen-abstain-${domain}-${i}`,
    scorer: "contains",
    retrieval: { k: 12 },
    maxTokens: 300,
    system: "You are a Microsoft 365 administration assistant. Answer only from the provided documentation excerpts. If the excerpts do not contain the answer, reply with exactly: NOT IN DOCS",
    prompt: `How do I configure ${feature}, and what license does it require?`,
    mustContain: ["NOT IN DOCS"],
  });
  n++;
});

// ---- 4 voice tasks ----
const VOICE = [
  ["scanned 128 mailboxes, 9 have forwarding rules to external addresses, 2 rules were created this week",
    ["\\b128\\b", "\\b9\\b"]],
  ["reviewed 54 conditional access policies, 6 are in report-only mode, 1 blocks legacy authentication",
    ["\\b54\\b", "\\b6\\b"]],
  ["checked 300 app registrations, 41 have secrets expiring within 30 days",
    ["\\b300\\b", "\\b41\\b"]],
  ["audited 76 groups, 12 have no owner assigned",
    ["\\b76\\b", "\\b12\\b"]],
];
VOICE.forEach(([facts, must], i) => {
  write(`7${String(i).padStart(2, "0")}-gen-voice.yaml`, {
    id: `gen-voice-${i}`,
    scorer: "contains",
    maxTokens: 400,
    system: "You write run report summaries for OpenAdminOS, a professional Microsoft 365 admin tool. The voice is honest, plain, slightly dry. No exclamation marks, no hype adjectives, no emoji.",
    prompt: `Write a two-sentence run summary: the agent ${facts}.`,
    mustMatch: must,
    mustNotContain: ["!", "amazing", "supercharge", "revolution", "🚀"],
  });
  n++;
});

console.log(`generated ${n} eval tasks`);
