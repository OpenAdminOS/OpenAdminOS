import { verifyReminderUnsubscribe } from "~/lib/advent/auth";
import { adventEnabled, sessionSecret, storageConfig } from "~/lib/advent/config";
import { db } from "~/lib/advent/db";
import { escapeHtml } from "~/lib/advent/reminders";

const headers = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
};

function page(title: string, body: string, status = 200) {
  return new Response(`<!doctype html><html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} | Advent of Admin</title></head>
<body style="padding:32px 20px;background:#faf9f6;color:#1f1d1a;font:16px/1.55 system-ui,sans-serif">
<main style="max-width:560px;margin:auto"><p style="color:#5c5852;font-size:14px">OpenAdminOS · Advent of Admin</p>
<h1 style="font:normal 36px/1.1 Georgia,serif">${escapeHtml(title)}</h1>
${body}
<p><a href="/advent/me" style="color:#1f1d1a">My Advent settings</a></p>
</main></body></html>`, {
    status, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
  });
}

function tokenFrom(request: Request) {
  return new URL(request.url).searchParams.get("token") ?? "";
}

function reminderParticipant(token: string) {
  const secret = sessionSecret();
  return secret ? verifyReminderUnsubscribe(token, Date.now(), secret) : null;
}

function unavailable() {
  return page("Reminder settings are unavailable", "<p>Try again later or turn off reminders from My Advent.</p>", 503);
}

function expired() {
  return page("This unsubscribe link is invalid or expired", "<p>Sign in to My Advent to turn off door reminders.</p>", 400);
}

export function GET(request: Request) {
  if (!adventEnabled()) return new Response(null, { status: 404, headers });
  if (!sessionSecret() || !storageConfig()) return unavailable();
  const token = tokenFrom(request);
  if (!reminderParticipant(token)) return expired();
  const action = `/api/advent/unsubscribe?token=${encodeURIComponent(token)}`;
  return page("Unsubscribe from door reminders", `<p>Turn off daily Advent of Admin reminders for this account.</p>
<form method="post" action="${escapeHtml(action)}">
<button style="min-height:44px;padding:8px 14px;background:#1f1d1a;color:#faf9f6;border:0;border-radius:10px;font:inherit;cursor:pointer">Unsubscribe from door reminders</button>
</form>`);
}

export async function POST(request: Request) {
  if (!adventEnabled()) return new Response(null, { status: 404, headers });
  const human = request.headers.get("Accept")?.includes("text/html");
  if (!sessionSecret() || !storageConfig()) {
    return human ? unavailable() : new Response("Reminder settings are unavailable.", { status: 503, headers });
  }
  const id = reminderParticipant(tokenFrom(request));
  if (!id) return human ? expired() : new Response("Invalid or expired link.", { status: 400, headers });

  try {
    await db("advent_participants", { id: `eq.${id}` }, {
      method: "PATCH",
      body: {
        reminders_opt_in: false,
        reminders_consent_text_version: null,
        reminders_consent_at: null,
      },
    });
    return human ? page("Door reminders are off", "<p>You can change this any time in My Advent.</p>")
      : new Response("Door reminders are off.", { headers });
  } catch {
    return human ? unavailable() : new Response("Reminder settings could not be saved.", { status: 503, headers });
  }
}
