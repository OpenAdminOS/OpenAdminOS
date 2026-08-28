#!/usr/bin/env node
// Independent trajectory eval families (v1.1.1).
// Codex review: the first 60 trajectory tasks came from 4 semantic templates,
// 3 mirroring training, so effective coverage was ~4. These families differ in
// REASONING STRUCTURE, not vocabulary: joins, missing evidence, empty sets,
// superlatives, secondary filters, distractors, ambiguity, and follow-ups.

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dump } from "js-yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "holdout");
mkdirSync(OUT, { recursive: true });
let seed = 8675309;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (a) => a[Math.floor(rand() * a.length)];
const dayMs = 86400000;
const write = (n, o) => writeFileSync(join(OUT, n), dump(o, { lineWidth: 100 }));

// Third naming pool: disjoint from training (WS/NB/MB/TAB, "User A") and from
// the first eval batch (ATLAS/BEACON/CEDAR..., "R. Aydin").
const HOSTS = ["ORION", "VESTA", "LYRA", "MIRA", "NOVA", "PICO", "RHEA", "TALOS"];
const PEOPLE = ["k.lindqvist", "m.oyelaran", "n.dubois", "p.haddad", "r.stankovic", "s.nakamura", "t.abebe"];
const OSES = ["Windows", "macOS", "iOS", "Android"];
let n = 0;

function mkDevices(todayMs, count, opts = {}) {
  const used = new Set();
  return Array.from({ length: count }, () => {
    let h; do { h = pick(HOSTS); } while (used.has(h)); used.add(h);
    const age = opts.age ? opts.age() : Math.floor(rand() * 300);
    return {
      deviceName: `${h}-${Math.floor(rand() * 900) + 100}`,
      userPrincipalName: `${pick(PEOPLE)}@contoso.com`,
      operatingSystem: pick(OSES),
      complianceState: opts.compliance ? opts.compliance() : pick(["compliant", "noncompliant", "unknown"]),
      managedDeviceOwnerType: pick(["company", "personal"]),
      lastSyncDateTime: new Date(todayMs - age * dayMs).toISOString(),
      _age: age,
    };
  });
}
const strip = (d) => { const { _age, ...r } = d; return r; };
const sysFor = (today) => `You are OpenAdmin, assisting a Microsoft 365 administrator. Today's date is ${today}. Use the graph_get tool to read tenant data before answering; never invent tenant facts. If the data does not support an answer, say so plainly.`;

const FAMILIES = [
  // 1. Join across two resources: needs both calls and a correct join key.
  { id: "join", build: (todayMs, today) => {
      const devs = mkDevices(todayMs, 6);
      const guests = new Set(devs.slice(0, 2).map((d) => d.userPrincipalName));
      const users = [...new Set(devs.map((d) => d.userPrincipalName))].map((upn) => ({
        userPrincipalName: upn, displayName: upn.split("@")[0], userType: guests.has(upn) ? "Guest" : "Member",
      }));
      const hits = devs.filter((d) => guests.has(d.userPrincipalName));
      return { prompt: "Which of our managed devices are assigned to guest accounts? List the device names.",
        fixtures: { "/deviceManagement/managedDevices": { value: devs.map(strip) }, "/users": { value: users } },
        mustContain: hits.map((d) => d.deviceName),
        mustNotContain: devs.filter((d) => !guests.has(d.userPrincipalName)).map((d) => d.deviceName), maxTurns: 6 };
    } },
  // 2. Missing evidence: the field needed simply is not in the data.
  { id: "missing", build: (todayMs) => {
      const devs = mkDevices(todayMs, 6);
      return { prompt: "How many of our managed devices have BitLocker encryption enabled?",
        fixtures: { "/deviceManagement/managedDevices": { value: devs.map(strip) } },
        mustMatch: ["does not|doesn'?t|no .{0,20}(field|information|data)|not (available|included|present)|cannot determine|can'?t determine|unable to determine"],
        mustNotContain: ["all devices have BitLocker", "BitLocker is enabled on all"], maxTurns: 4 };
    } },
  // 3. Empty result set: the honest answer is "none".
  { id: "empty", build: (todayMs) => {
      const devs = mkDevices(todayMs, 5, { compliance: () => "compliant", age: () => Math.floor(rand() * 20) });
      return { prompt: "Which devices are noncompliant and need attention?",
        fixtures: { "/deviceManagement/managedDevices": { value: devs.map(strip) } },
        mustMatch: ["none|no devices|all .{0,20}compliant|zero"],
        mustNotContain: devs.map((d) => d.deviceName), maxTurns: 4 };
    } },
  // 4. Superlative: single extreme value, not a threshold sweep.
  { id: "superlative", build: (todayMs) => {
      const devs = mkDevices(todayMs, 6);
      const oldest = devs.reduce((a, b) => (a._age >= b._age ? a : b));
      return { prompt: "Which single device has gone the longest without checking in, and how long has it been?",
        fixtures: { "/deviceManagement/managedDevices": { value: devs.map(strip) } },
        mustContain: [oldest.deviceName], maxTurns: 4 };
    } },
  // 5. Two-condition filter: compliance AND ownership.
  { id: "twofilter", build: (todayMs) => {
      const devs = mkDevices(todayMs, 7);
      const hits = devs.filter((d) => d.complianceState === "noncompliant" && d.managedDeviceOwnerType === "personal");
      if (!hits.length) return null;
      return { prompt: "List the personally-owned devices that are currently noncompliant.",
        fixtures: { "/deviceManagement/managedDevices": { value: devs.map(strip) } },
        mustContain: hits.map((d) => d.deviceName),
        mustNotContain: devs.filter((d) => !(d.complianceState === "noncompliant" && d.managedDeviceOwnerType === "personal")).map((d) => d.deviceName),
        maxTurns: 4 };
    } },
  // 6. Group-and-rank: which OS carries the most noncompliance.
  { id: "groupmax", build: (todayMs) => {
      const devs = mkDevices(todayMs, 8);
      const counts = {};
      for (const d of devs) if (d.complianceState === "noncompliant") counts[d.operatingSystem] = (counts[d.operatingSystem] ?? 0) + 1;
      const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      if (entries.length < 2 || entries[0][1] === entries[1][1]) return null; // need an unambiguous winner
      return { prompt: "Which operating system has the most noncompliant devices in our fleet?",
        fixtures: { "/deviceManagement/managedDevices": { value: devs.map(strip) } },
        mustContain: [entries[0][0]], maxTurns: 4 };
    } },
  // 7. Wrong resource: the requested data lives somewhere we did not stub.
  //    Correct behaviour is to report the failure, not to invent an answer.
  { id: "notfound", build: (todayMs) => {
      const devs = mkDevices(todayMs, 5);
      return { prompt: "How many named locations are configured for conditional access?",
        fixtures: { "/deviceManagement/managedDevices": { value: devs.map(strip) } },
        mustMatch: ["not (found|available|accessible)|could ?n[o']t (retrieve|find|access)|no such|error|unable to (retrieve|access|find)|does not exist"],
        mustNotContain: ["there are 3 named locations", "there are 5 named locations"],
        requireToolCall: false, maxTurns: 4 };
    } },
  // 8. Distractor records: disabled devices must be excluded from a count.
  { id: "distractor", build: (todayMs) => {
      const devs = mkDevices(todayMs, 7);
      devs.forEach((d, i) => { d.managementState = i % 3 === 0 ? "retirePending" : "managed"; });
      const active = devs.filter((d) => d.managementState === "managed");
      return { prompt: "How many devices are actively managed right now? Ignore any device already pending retirement.",
        fixtures: { "/deviceManagement/managedDevices": { value: devs.map(strip) } },
        mustMatch: [`\\b${active.length}\\b`], maxTurns: 4 };
    } },
];

for (let i = 0; i < 40; i++) {
  const fam = FAMILIES[i % FAMILIES.length];
  const todayMs = Date.UTC(2026, Math.floor(rand() * 12), 1 + Math.floor(rand() * 27));
  const today = new Date(todayMs).toISOString().slice(0, 10);
  const spec = fam.build(todayMs, today);
  if (!spec) { i--; continue; }
  const task = {
    id: `hold-${fam.id}-${i}`, scorer: "contains", maxTokens: 1600, system: sysFor(today),
    prompt: spec.prompt,
    trajectory: { maxTurns: spec.maxTurns, fixtures: spec.fixtures,
      ...(spec.requireToolCall === false ? { requireToolCall: false } : {}) },
    ...(spec.mustContain ? { mustContain: spec.mustContain } : {}),
    ...(spec.mustNotContain?.length ? { mustNotContain: spec.mustNotContain } : {}),
    ...(spec.mustMatch ? { mustMatch: spec.mustMatch } : {}),
  };
  write(`H${String(i).padStart(2, "0")}-hold-${fam.id}.yaml`, task);
  n++;
}
console.log(`generated ${n} independent trajectory tasks across ${FAMILIES.length} reasoning families`);
