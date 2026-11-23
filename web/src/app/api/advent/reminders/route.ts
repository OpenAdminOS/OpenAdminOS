import { createHash, timingSafeEqual } from "node:crypto";

import { SITE_URL } from "~/app/seo";
import { doors } from "~/content/advent/doors";
import { signReminderUnsubscribe } from "~/lib/advent/auth";
import { adventEnabled, sessionSecret, storageConfig } from "~/lib/advent/config";
import { rpc } from "~/lib/advent/db";
import { incompleteBatch, parseBatchResult, reminderSendingEnabled, renderReminder, runReminders } from "~/lib/advent/reminders";
import type { Recipient } from "~/lib/advent/reminders";
import { campaignNow, reminderDoorAt } from "~/lib/advent/time";

const headers = { "Cache-Control": "private, no-store" };

function authorised(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const supplied = Buffer.from(request.headers.get("Authorization") ?? "");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function POST(request: Request) {
  if (!authorised(request)) {
    return Response.json({ error: adventEnabled() ? "Unauthorized." : "Not found." }, {
      status: adventEnabled() ? 401 : 404, headers,
    });
  }

  const day = reminderDoorAt(campaignNow(process.env.ADVENT_NOW));
  const apiKey = process.env.ADVENT_RESEND_API_KEY?.trim();
  const from = process.env.ADVENT_EMAIL_FROM?.trim();
  const secret = sessionSecret();
  const switchedOn = reminderSendingEnabled(process.env.ADVENT_ENABLED, process.env.ADVENT_REMINDERS_SEND, apiKey);
  const delivery = switchedOn && apiKey && from && secret ? { apiKey, from, secret } : null;
  const canSend = delivery !== null;

  if (day !== null && !storageConfig()) {
    console.info("[advent] Reminder count unavailable", { day, dryRun: !canSend });
    return Response.json({ error: "Campaign storage is not configured.", day, dryRun: !canSend }, { status: 503, headers });
  }

  try {
    const result = await runReminders(day, canSend, {
      count: (day) => rpc<number>("advent_reminder_count", { p_day: day }),
      claim: (day, limit) => rpc<Recipient[]>("advent_reminder_claim", { p_day: day, p_limit: limit }),
      send: (recipients) => day !== null && delivery
        ? sendBatch(day, recipients, delivery)
        : Promise.resolve(incompleteBatch(recipients.map(({ id }) => id), "delivery_disabled", "failed")),
      record: (day, outcomes) => rpc<void>("advent_reminder_record", {
        p_day: day,
        p_outcomes: outcomes.map((outcome) => outcome.status === "sent"
          ? { id: outcome.id, status: outcome.status, message_id: outcome.messageId }
          : { id: outcome.id, status: outcome.status, code: outcome.code }),
      }),
    });
    console.info("[advent] Reminder run", result);
    const note = switchedOn && !canSend ? "The sender or unsubscribe signing secret is not configured." : undefined;
    return Response.json({ ...result, note }, { headers });
  } catch {
    console.error("[advent] Reminder run could not finish", { day, dryRun: !canSend });
    return Response.json({ error: "Campaign storage could not finish the reminder run.", day, dryRun: !canSend },
      { status: 503, headers });
  }
}

async function sendBatch(day: number, recipients: Recipient[], { apiKey, from, secret }: { apiKey: string; from: string; secret: string }) {
  const ids = recipients.map(({ id }) => id);
  const door = doors[day - 1]!;
  const now = Date.now();
  const emails = recipients.map(({ unsubscribeId, email }) => {
    const unsubscribe = new URL("/api/advent/unsubscribe", SITE_URL);
    unsubscribe.searchParams.set("token", signReminderUnsubscribe(unsubscribeId, now, secret));
    return {
      from, to: [email], ...renderReminder(door, SITE_URL, unsubscribe.href),
      headers: {
        "List-Unsubscribe": `<${unsubscribe.href}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    };
  });
  const hash = createHash("sha256").update(ids.join(",")).digest("hex");

  try {
    const response = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `advent-2026:${day}:${hash}`,
        "X-Batch-Validation": "permissive",
      },
      body: JSON.stringify(emails),
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      return incompleteBatch(ids, `resend_http_${response.status}`, response.status >= 500 ? "unconfirmed" : "failed");
    }
    return parseBatchResult(ids, await response.json());
  } catch {
    return incompleteBatch(ids, "resend_response_unavailable");
  }
}
