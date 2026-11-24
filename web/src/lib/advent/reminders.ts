export const REMINDER_BATCH_SIZE = 100;

export function reminderSendingEnabled(enabled: string | undefined, send: string | undefined, apiKey: string | undefined) {
  return enabled === "true" && send === "true" && Boolean(apiKey?.trim());
}

type ReminderDoor = { day: number; title: string; goal: string; needsTenant: boolean };

export function escapeHtml(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function renderReminder(door: ReminderDoor, site: string, unsubscribe: string) {
  const link = new URL(`/advent/day/${door.day}`, site).toString();
  const subject = `Door ${door.day} is open: ${door.title}`;
  const tenant = door.needsTenant ? "Microsoft 365 tenant needed." : "No Microsoft 365 tenant needed.";
  const reason = "You chose to receive door reminders for Advent of Admin.";
  const text = [
    subject, door.goal, tenant, `Open door ${door.day}: ${link}`,
    `${reason}\nUnsubscribe from door reminders: ${unsubscribe}`,
  ].join("\n\n");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px;background:#faf9f6;color:#1f1d1a;font:16px/1.55 system-ui,sans-serif">
<main style="max-width:560px;margin:auto">
<p style="font-size:14px;color:#5c5852">OpenAdminOS · Advent of Admin</p>
<h1 style="font:normal 32px/1.15 Georgia,serif">${escapeHtml(subject)}</h1>
<p>${escapeHtml(door.goal)}</p>
<p>${tenant}</p>
<p><a style="color:#1f1d1a" href="${escapeHtml(link)}">Open door ${door.day}</a></p>
<footer style="margin-top:24px;padding-top:16px;border-top:1px solid #d8d4cd;color:#5c5852;font-size:14px">
<p>${reason} <a style="color:#1f1d1a" href="${escapeHtml(unsubscribe)}">Unsubscribe from door reminders</a>.</p>
</footer>
</main></body></html>`;
  return { subject, text, html };
}

export type Recipient = { id: string; email: string; unsubscribeId: string };
export type SendOutcome =
  | { id: string; status: "sent"; messageId: string }
  | { id: string; status: "failed" | "unconfirmed"; code: string };

export function incompleteBatch(ids: string[], code: string, status: "failed" | "unconfirmed" = "unconfirmed"): SendOutcome[] {
  return ids.map((id) => ({ id, status, code }));
}

export function parseBatchResult(ids: string[], value: unknown): SendOutcome[] {
  const result = value as { data?: { id?: unknown }[]; errors?: { index?: unknown }[] } | null;
  const unknown = () => incompleteBatch(ids, "unexpected_batch_response");
  if (!result || !Array.isArray(result.data) || (result.errors !== undefined && !Array.isArray(result.errors))) {
    return unknown();
  }
  const failures = new Set<number>();
  for (const issue of result.errors ?? []) {
    const index = issue?.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= ids.length || failures.has(index)) {
      return unknown();
    }
    failures.add(index);
  }
  const accepted = result.data.map((message) => message?.id);
  if (accepted.length + failures.size !== ids.length
    || accepted.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(id))) return unknown();

  let cursor = 0;
  return ids.map((id, index) => failures.has(index)
    ? { id, status: "failed", code: "recipient_rejected" }
    : { id, status: "sent", messageId: accepted[cursor++] as string });
}

type ReminderIO = {
  count: (day: number) => Promise<number>;
  claim: (day: number, limit: number) => Promise<Recipient[]>;
  send: (recipients: Recipient[]) => Promise<SendOutcome[]>;
  record: (day: number, outcomes: SendOutcome[]) => Promise<void>;
};

export async function runReminders(day: number | null, send: boolean, io: ReminderIO) {
  const summary = { day, dryRun: !send, wouldSend: 0, sent: 0, failed: 0, unconfirmed: 0 };
  if (day === null) return summary;
  if (!send) {
    summary.wouldSend = await io.count(day);
    return summary;
  }

  // The store reserves each recipient before Resend sees the batch. An unknown
  // result remains reserved so a later invocation cannot send it a second time.
  for (;;) {
    const recipients = await io.claim(day, REMINDER_BATCH_SIZE);
    if (!recipients.length) return summary;
    const outcomes = await io.send(recipients);
    await io.record(day, outcomes);
    summary.wouldSend += recipients.length;
    for (const result of outcomes) summary[result.status]++;
  }
}
