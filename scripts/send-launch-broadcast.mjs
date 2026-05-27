#!/usr/bin/env node
// Send the v0.1.8 launch email to the OpenAgents/OpenAdminOS waitlist
// via Resend's Broadcasts API. Each contact in the audience receives
// their own individual SMTP delivery — no one sees any other
// recipient's address.
//
// Usage:
//   RESEND_API_KEY=re_xxxxx node scripts/send-launch-broadcast.mjs --dry-run
//   RESEND_API_KEY=re_xxxxx node scripts/send-launch-broadcast.mjs --send
//
// Optional env:
//   FROM_EMAIL       defaults to "Ugur <ugur@openadminos.com>"
//   AUDIENCE_NAME    defaults to "OpenAdminOS waitlist"
//   BROADCAST_NAME   defaults to "OpenAdminOS v0.1.8 launch"
//   RECIPIENTS_FILE  defaults to scripts/waitlist-recipients.txt
//   CONTACT_RATE_PER_SEC  defaults to 5 (Resend free tier is 2/sec;
//                         5/sec is safe on paid tiers)
//
// --dry-run mode never calls the Resend API. It just parses the
// recipient file and prints what would happen.
//
// State is written to scripts/.broadcast-state.json so re-runs can
// resume without re-creating the audience or re-adding contacts that
// already landed.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const stateFile = resolve(scriptDir, ".broadcast-state.json");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const reallySend = args.has("--send");

if (!dryRun && !reallySend) {
  console.error(
    "Pass --dry-run (no API calls, just preview) or --send (actually send).",
  );
  process.exit(1);
}

const apiKey = process.env.RESEND_API_KEY;
if (!dryRun && !apiKey) {
  console.error("Missing RESEND_API_KEY. Re-run with it in the env.");
  process.exit(1);
}

const fromEmail = process.env.FROM_EMAIL ?? "Ugur <ugur@openadminos.com>";
const audienceName = process.env.AUDIENCE_NAME ?? "OpenAdminOS waitlist";
const broadcastName =
  process.env.BROADCAST_NAME ?? "OpenAdminOS v0.1.8 launch";
const recipientsPath = resolve(
  repoRoot,
  process.env.RECIPIENTS_FILE ?? "scripts/waitlist-recipients.txt",
);
const contactRatePerSec = Number(process.env.CONTACT_RATE_PER_SEC ?? 5);

// ---------------------------------------------------------------------
// Email content (same as send-launch-test.mjs — keep in sync if edited)
// ---------------------------------------------------------------------

const subject = "OpenAdminOS v0.1 is ready to download (formerly OpenAgents)";

const dmgUrl =
  "https://github.com/OpenAdminOS/OpenAdminOS/releases/download/v0.1.8/OpenAdminOS-0.1.8-arm64.dmg";
const releaseUrl =
  "https://github.com/OpenAdminOS/OpenAdminOS/releases/tag/v0.1.8";
const repoUrl = "https://github.com/OpenAdminOS/OpenAdminOS";
const issuesUrl = "https://github.com/OpenAdminOS/OpenAdminOS/issues";

const text = `Hey,

You signed up for the private preview a while back, when this was still called OpenAgents. I renamed it to OpenAdminOS in the meantime. Same product, clearer name for what it does. Flagging it up front so you don't read this as someone else's email.

v0.1 is out today.

OpenAdminOS is an open-source desktop app for Microsoft 365 admins. You connect a tenant, pick a local LLM (Ollama, today), and run agents against Intune and Entra. Tenant data and prompts never leave your machine unless you explicitly switch to a hosted provider.

Download for macOS:
${dmgUrl}

Windows is coming as soon as Microsoft approves the Store submission. The MSIX is built and submitted, I'm waiting on review. No promised date; Microsoft sets the pace. I'll send a short follow-up the moment it lands.

WHAT'S IN v0.1

A starter set of agents covering device compliance, identity hygiene, security posture, and cleanup tasks. Both read-only investigators and a few write agents (which always pause for typed confirmation before changing anything). The agent browser inside the app shows the full list with descriptions, required scopes, and which ones need Entra ID P1/P2.

The agent registry lives in the same GitHub repo, so it grows by PR. Contributing a new agent is a YAML manifest plus a README.

WORTH KNOWING

- Local by default. Ollama is the default LLM and runs on your Mac. If you don't have it installed the first-run flow walks you through it.
- Open-source (MIT). Runtime, registry, and agents all live at ${repoUrl}.
- Write agents always require typed confirmation ("RETIRE 47 DEVICES") before doing anything. No "trust this agent" override.
- Auto-updates from GitHub Releases on next launch. You won't re-download for v0.1.x patches.

FEEDBACK

Hit something weird, want a feature, have an agent idea? Open an issue at ${issuesUrl}, or just reply to this email.

Full release notes: ${releaseUrl}

Ugur

---

You're getting this because you signed up for the OpenAgents / OpenAdminOS preview at openadminos.com (formerly openagents.sh). {{{RESEND_UNSUBSCRIBE_URL}}} to unsubscribe.
`;

const html = `<!doctype html>
<html lang="en">
<body style="margin:0; padding:0; background:#0a0a0c; color:#e6e2d9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif; line-height:1.55; -webkit-font-smoothing:antialiased;">
  <div style="max-width:560px; margin:0 auto; padding:32px 24px;">
    <p style="margin:0 0 16px;">Hey,</p>

    <p style="margin:0 0 16px;">You signed up for the private preview a while back, when this was still called <strong>OpenAgents</strong>. I renamed it to <strong>OpenAdminOS</strong> in the meantime. Same product, clearer name for what it does. Flagging it up front so you don't read this as someone else's email.</p>

    <p style="margin:0 0 16px;">v0.1 is out today.</p>

    <p style="margin:0 0 24px;">OpenAdminOS is an open-source desktop app for Microsoft 365 admins. You connect a tenant, pick a local LLM (Ollama, today), and run agents against Intune and Entra. Tenant data and prompts never leave your machine unless you explicitly switch to a hosted provider.</p>

    <p style="margin:0 0 28px;">
      <a href="${dmgUrl}" style="display:inline-block; background:#e8a87c; color:#1c1917; text-decoration:none; padding:12px 22px; border-radius:8px; font-weight:600; font-size:15px;">Download for macOS</a>
    </p>

    <p style="margin:0 0 24px;">Windows is coming as soon as Microsoft approves the Store submission. The MSIX is built and submitted, I'm waiting on review. No promised date; Microsoft sets the pace. I'll send a short follow-up the moment it lands.</p>

    <h3 style="margin:32px 0 12px; font-size:16px; font-weight:600; color:#f5f5f5;">What's in v0.1</h3>

    <p style="margin:0 0 16px;">A starter set of agents covering device compliance, identity hygiene, security posture, and cleanup tasks. Both read-only investigators and a few write agents (which always pause for typed confirmation before changing anything). The agent browser inside the app shows the full list with descriptions, required scopes, and which ones need Entra ID P1/P2.</p>

    <p style="margin:0 0 16px;">The agent registry lives in the same GitHub repo, so it grows by PR. Contributing a new agent is a YAML manifest plus a README.</p>

    <h3 style="margin:32px 0 12px; font-size:16px; font-weight:600; color:#f5f5f5;">Worth knowing</h3>

    <ul style="margin:0 0 16px; padding-left:20px;">
      <li style="margin:0 0 8px;"><strong>Local by default.</strong> Ollama is the default LLM and runs on your Mac. If you don't have it installed the first-run flow walks you through it.</li>
      <li style="margin:0 0 8px;"><strong>Open-source (MIT).</strong> Runtime, registry, and agents all live at <a href="${repoUrl}" style="color:#e8a87c;">github.com/OpenAdminOS/OpenAdminOS</a>.</li>
      <li style="margin:0 0 8px;"><strong>Write agents always require typed confirmation</strong> ("RETIRE 47 DEVICES") before doing anything. No "trust this agent" override.</li>
      <li style="margin:0 0 8px;"><strong>Auto-updates</strong> from GitHub Releases on next launch. You won't re-download for v0.1.x patches.</li>
    </ul>

    <h3 style="margin:32px 0 12px; font-size:16px; font-weight:600; color:#f5f5f5;">Feedback</h3>

    <p style="margin:0 0 16px;">Hit something weird, want a feature, have an agent idea? <a href="${issuesUrl}" style="color:#e8a87c;">Open an issue</a>, or just reply to this email.</p>

    <p style="margin:0 0 32px; font-size:13.5px; color:#9b958a;">Full release notes: <a href="${releaseUrl}" style="color:#e8a87c;">${releaseUrl}</a></p>

    <p style="margin:0 0 8px;">Ugur</p>

    <hr style="border:none; border-top:1px solid #2a2622; margin:32px 0;" />

    <p style="margin:0; font-size:12px; color:#6b665f; line-height:1.5;">You're getting this because you signed up for the OpenAgents / OpenAdminOS preview at openadminos.com (formerly openagents.sh). <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#6b665f;">Unsubscribe</a>.</p>
  </div>
</body>
</html>`;

// ---------------------------------------------------------------------
// Recipient loading + dedup
// ---------------------------------------------------------------------

if (!existsSync(recipientsPath)) {
  console.error(`Recipients file not found: ${recipientsPath}`);
  process.exit(1);
}

const raw = readFileSync(recipientsPath, "utf8");
const recipients = Array.from(
  new Set(
    raw
      .split("\n")
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.length > 0 && line.includes("@") && !line.startsWith("#")),
  ),
);

console.log(`Loaded ${recipients.length} unique recipients from ${recipientsPath}`);
console.log(`From: ${fromEmail}`);
console.log(`Subject: ${subject}`);
console.log(`Audience: ${audienceName}`);
console.log(`Broadcast: ${broadcastName}`);
console.log();

// ---------------------------------------------------------------------
// State (resume support)
// ---------------------------------------------------------------------

const state = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, "utf8"))
  : { audienceId: null, addedContacts: [], broadcastId: null, sentAt: null };

function saveState() {
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------

if (dryRun) {
  const redacted = (email) => {
    const [local, domain] = email.split("@");
    return `${local.slice(0, 3)}***@${domain}`;
  };
  console.log("=== DRY RUN — no API calls will be made ===");
  console.log();
  console.log("First 5 recipients (redacted):");
  recipients.slice(0, 5).forEach((e) => console.log(`  ${redacted(e)}`));
  console.log("Last 5 recipients (redacted):");
  recipients.slice(-5).forEach((e) => console.log(`  ${redacted(e)}`));
  console.log();
  console.log(`Would create audience "${audienceName}" if it doesn't exist.`);
  console.log(`Would add ${recipients.length} contacts at ${contactRatePerSec}/sec`);
  console.log(
    `Estimated audience-build time: ~${Math.ceil(recipients.length / contactRatePerSec)}s`,
  );
  console.log(`Would create broadcast "${broadcastName}" and send to the audience.`);
  console.log();
  console.log("To send for real: re-run with --send (and a valid RESEND_API_KEY).");
  process.exit(0);
}

// ---------------------------------------------------------------------
// Real send
// ---------------------------------------------------------------------

async function resendApi(path, options = {}) {
  const res = await fetch(`https://api.resend.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Resend ${options.method ?? "GET"} ${path} returned ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 1) Get or create audience
if (!state.audienceId) {
  console.log(`Looking up audience "${audienceName}"...`);
  const list = await resendApi("/audiences");
  const existing = (list.data ?? []).find((a) => a.name === audienceName);
  if (existing) {
    console.log(`  Reusing existing audience ${existing.id}`);
    state.audienceId = existing.id;
  } else {
    console.log(`  Creating new audience...`);
    const created = await resendApi("/audiences", {
      method: "POST",
      body: JSON.stringify({ name: audienceName }),
    });
    state.audienceId = created.id;
    console.log(`  Created audience ${state.audienceId}`);
  }
  saveState();
}

// 2) Add contacts (idempotent — Resend dedupes by email within an audience)
const alreadyAdded = new Set(state.addedContacts);
const toAdd = recipients.filter((e) => !alreadyAdded.has(e));
console.log(
  `Adding ${toAdd.length} contact${toAdd.length === 1 ? "" : "s"} to audience (${alreadyAdded.size} already added in a previous run)...`,
);
const intervalMs = Math.max(1, Math.floor(1000 / contactRatePerSec));
let added = 0;
let skipped = 0;
let failed = 0;
for (const email of toAdd) {
  try {
    await resendApi(`/audiences/${state.audienceId}/contacts`, {
      method: "POST",
      body: JSON.stringify({ email, unsubscribed: false }),
    });
    state.addedContacts.push(email);
    added++;
  } catch (err) {
    // 409 = already exists in this audience; treat as success
    if (err.status === 409) {
      state.addedContacts.push(email);
      skipped++;
    } else {
      failed++;
      console.warn(`  Failed to add ${email}: ${err.status} ${JSON.stringify(err.body)}`);
    }
  }
  if (added % 25 === 0) saveState();
  await sleep(intervalMs);
}
saveState();
console.log(`  Added: ${added}, already-present: ${skipped}, failed: ${failed}`);

// 3) Create broadcast
if (!state.broadcastId) {
  console.log(`Creating broadcast "${broadcastName}"...`);
  const broadcast = await resendApi("/broadcasts", {
    method: "POST",
    body: JSON.stringify({
      audience_id: state.audienceId,
      from: fromEmail,
      subject,
      html,
      text,
      name: broadcastName,
      reply_to: ["ugur@openadminos.com"],
    }),
  });
  state.broadcastId = broadcast.id;
  saveState();
  console.log(`  Created broadcast ${state.broadcastId}`);
} else {
  console.log(`Reusing existing broadcast ${state.broadcastId}`);
}

// 4) Send
if (!state.sentAt) {
  console.log(`Sending broadcast ${state.broadcastId}...`);
  await resendApi(`/broadcasts/${state.broadcastId}/send`, {
    method: "POST",
  });
  state.sentAt = new Date().toISOString();
  saveState();
  console.log(`  Sent at ${state.sentAt}`);
} else {
  console.log(`Broadcast already sent at ${state.sentAt}`);
}

console.log();
console.log("Done.");
console.log(`Dashboard: https://resend.com/broadcasts/${state.broadcastId}`);
console.log(
  `State written to ${stateFile} — safe to delete after Supabase notified_at is updated.`,
);
