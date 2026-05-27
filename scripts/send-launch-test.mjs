#!/usr/bin/env node
// One-off: send the v0.1.8 launch email to a single test address via
// Resend. Useful for previewing rendering, links, and the unsubscribe
// footer before sending to the whole waitlist.
//
// Usage:
//   RESEND_API_KEY=re_xxxxx \
//   FROM_EMAIL="OpenAdminOS <hello@openadminos.com>" \
//   TO_EMAIL="ulimuli92@googlemail.com" \
//     node scripts/send-launch-test.mjs
//
// FROM_EMAIL defaults to "Ugur <ugur@openadminos.com>".
// TO_EMAIL defaults to ulimuli92@googlemail.com.

const apiKey = process.env.RESEND_API_KEY;
if (!apiKey) {
  console.error(
    "Missing RESEND_API_KEY. Grab it from https://resend.com/api-keys and re-run with it in the env.",
  );
  process.exit(1);
}

const from = process.env.FROM_EMAIL ?? "Ugur <ugur@openadminos.com>";
const to = process.env.TO_EMAIL ?? "ulimuli92@googlemail.com";
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
  </div>
</body>
</html>`;

const payload = {
  from,
  to: [to],
  subject,
  text,
  html,
};

console.log(`Sending test to ${to} from ${from} ...`);

const res = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(payload),
});

const body = await res.json();
if (!res.ok) {
  console.error(`Resend returned HTTP ${res.status}:`);
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}

console.log("Sent.");
console.log(JSON.stringify(body, null, 2));
