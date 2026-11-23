import Link from "next/link";
import { notFound } from "next/navigation";

import { SITE_URL } from "~/app/seo";
import { doors } from "~/content/advent/doors";
import { DELETED_WINNER, drawOpens, draws, retention, RETENTION_MS, winnerAccounts, winnerSlots } from "~/lib/advent/admin";
import type { DrawAccount, Retention } from "~/lib/advent/admin";
import { currentAdmin, doorStats, rpc } from "~/lib/advent/db";
import type { Draw } from "~/lib/advent/db";
import { launchReadiness, requiresAnswer } from "~/lib/advent/readiness";
import { renderReminder } from "~/lib/advent/reminders";
import { berlinDateKey, campaignDoorForDate, campaignNow } from "~/lib/advent/time";
import { ActionForm } from "../ActionForm";
import { LocalTime } from "../LocalTime";
import { AdventTitle, field, heading, Notice, STORAGE_UNAVAILABLE, textLink } from "../shared";

type ReminderStats = {
  optedIn: number;
  days: { day: number; sent: number; failed: number; unconfirmed: number }[];
};

export const metadata = { title: "Campaign admin | Advent of Admin", robots: { index: false, follow: false } };

export default async function AdminPage() {
  const account = await currentAdmin().catch(() => null);
  if (!account) notFound();

  const now = campaignNow(process.env.ADVENT_NOW);
  const state = await loadAdmin();
  const grand = state.records?.find((record) => record.kind === "grand");
  const purgeAt = grand ? Date.parse(grand.created_at) + RETENTION_MS : null;
  const prizesFinalized = Boolean(state.retention?.prizes_fulfilled_at && state.retention.prizes_fulfilled_at <= berlinDateKey(now));
  const reminders = new Map(state.reminders?.days.map((day) => [day.day, day]));

  return (
    <div className="mx-auto max-w-5xl space-y-9">
      <Link href="/advent/me" className={textLink}>My Advent</Link>
      <AdventTitle title="Campaign admin" label="Advent of Admin" />
      {!state.stats || !state.records || !state.reminders || !state.retention || !state.winners ? <Notice tone="error">{STORAGE_UNAVAILABLE}</Notice> : (
        <>
          <LaunchReadiness status={launchReadiness(doors, state.stats, process.env)} />
          <section id="answers" className="scroll-mt-24 space-y-4" aria-labelledby="answers-title">
            <h2 id="answers-title" className={heading}>Accepted answers</h2>
            <div className="max-w-xl">
              <ActionForm action="set-answers" label="Replace accepted answers">
                <label className="block text-sm font-medium">Door
                  <select name="day" className={`${field} mt-2 block`}>
                    {doors.filter(({ day }) => requiresAnswer(day)).map(({ day, title }) => (
                      <option value={day} key={day}>{day} · {title}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm font-medium">Accepted answers, one per line
                  <textarea className={`${field} mt-2 block`} name="answers" rows={4} maxLength={12850} autoComplete="off" spellCheck={false} />
                </label>
                <p className="text-sm leading-6 text-brand-muted">Saving replaces the list for this door. An empty list clears it. Only hashes are stored.</p>
              </ActionForm>
            </div>
          </section>

          <section id="draws" className="scroll-mt-24 space-y-4 border-t border-brand-line pt-6" aria-labelledby="draws-title">
            <h2 id="draws-title" className={heading}>Completions and draws</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-brand-muted">
                  <tr className="border-b border-brand-line">
                    <th scope="col" className="p-2">Door</th>
                    <th scope="col" className="p-2">Done</th>
                    <th scope="col" className="p-2">On time</th>
                    <th scope="col" className="p-2">Answers</th>
                    <th scope="col" className="p-2">Reminders sent</th>
                    <th scope="col" className="p-2">Draw</th>
                  </tr>
                </thead>
                <tbody>
                  {state.stats.map((stat) => (
                    <tr key={stat.day} className="border-b border-brand-line align-top">
                      <th scope="row" className="p-2 font-mono">{stat.day}</th>
                      <td className="p-2 font-mono">{stat.completed}</td>
                      <td className="p-2 font-mono">{stat.on_time}</td>
                      <td className="p-2 font-mono">{stat.day === 22 || stat.day === 24 ? <span aria-label="No written check">·</span> : stat.answer_count}</td>
                      <td className="p-2 font-mono">{reminders.get(stat.day)?.sent ?? 0}</td>
                      <td className="p-2"><DrawControls day={stat.day} now={now} record={state.records.find((item) => item.day === stat.day)} records={state.records} winners={state.winners} prizesFinalized={prizesFinalized} /></td>
                    </tr>
                  ))}
                  <tr className="border-b border-brand-line align-top">
                    <th scope="row" colSpan={5} className="p-2 font-medium">Grand draw</th>
                    <td className="p-2"><DrawControls day={null} now={now} record={grand} records={state.records} winners={state.winners} prizesFinalized={prizesFinalized} /></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <ReminderPreview now={now} reminders={state.reminders} />

          <ParticipantRetention state={state.retention} now={now} purgeAt={purgeAt} hasGrandDraw={Boolean(grand)} />
        </>
      )}
    </div>
  );
}

function LaunchReadiness({ status }: { status: ReturnType<typeof launchReadiness> }) {
  return (
    <section aria-labelledby="launch-readiness" className="space-y-3 border-y border-brand-line py-5">
      <h2 id="launch-readiness" className={heading}>Launch readiness</h2>
      <Notice tone={status.ready ? "ok" : "error"}>
        <p className="font-medium">{status.ready ? "Ready to launch" : "Launch blockers remain"}</p>
        <p>{status.completable} of 24 doors can be completed with the current questions and accepted answers.</p>
        {!status.ready && (
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {status.missingQuestions.length > 0 && <li>Missing check questions on doors {status.missingQuestions.join(", ")}.</li>}
            {status.missingAnswers.length > 0 && <li>Missing accepted answers on doors {status.missingAnswers.join(", ")}.</li>}
            {status.draftDoors.length > 0 && <li>Draft doors {status.draftDoors.join(", ")}.</li>}
            {status.rulesUnapproved && <li>Campaign rules are awaiting approval.</li>}
            {status.missingEnv.length > 0 && <li>Configure <span className="break-all font-mono">{status.missingEnv.join(", ")}</span>.</li>}
          </ul>
        )}
      </Notice>
    </section>
  );
}

function ParticipantRetention({ state, now, purgeAt, hasGrandDraw }: {
  state: Retention; now: number; purgeAt: number | null; hasGrandDraw: boolean;
}) {
  const date = state.prizes_fulfilled_at;
  const canDeleteWinners = date !== null && date <= berlinDateKey(now) && !state.winners_deleted_at;

  return (
    <section id="purge" className="scroll-mt-24 space-y-5 border-t border-brand-line pt-6" aria-labelledby="purge-title">
      <h2 id="purge-title" className={heading}>Participant retention</h2>
      <div className="space-y-3">
        <p className="text-sm leading-6 text-brand-muted">
          {purgeAt === null ? "Purge becomes available 90 days after the grand draw."
            : <>Purge opens <LocalTime timestamp={purgeAt} showYear />.</>} It immediately deletes accounts that won no prize.
        </p>
        <ActionForm action="purge" label="Purge non-winner accounts" quiet disabled={purgeAt === null || now < purgeAt} refreshOnSuccess />
      </div>
      <div className="max-w-xl space-y-3 border-t border-brand-line pt-5">
        <p className="text-sm leading-6 text-brand-muted">
          Winner records can be deleted from the prize fulfilment date, using Berlin time.
          {state.winners_deleted_at && <> Deleted <LocalTime timestamp={Date.parse(state.winners_deleted_at)} showYear />.</>}
        </p>
        <ActionForm action="fulfil-prizes" label="Save fulfilment date" quiet disabled={!hasGrandDraw || Boolean(state.winners_deleted_at)}>
          <label className="block text-sm font-medium">
            Prizes fulfilled on
            <input type="date" name="prizes_fulfilled_at" defaultValue={date ?? ""} className={`${field} mt-2 block max-w-xs`} required />
          </label>
        </ActionForm>
        <ActionForm action="delete-winners" label="Delete winner records" quiet disabled={!canDeleteWinners} refreshOnSuccess />
      </div>
    </section>
  );
}

function DrawControls({ day, now, record, records, winners, prizesFinalized }: {
  day: number | null; now: number; record?: Draw; records: Draw[]; winners: Map<string, DrawAccount>; prizesFinalized: boolean;
}) {
  const opens = drawOpens(day);
  const target = day === null ? "grand" : String(day);
  const csv = `/api/advent/export?draw=${target}`;

  if (now < opens) return <span className="text-xs text-brand-muted">Opens <LocalTime timestamp={opens} showYear={day === null} /></span>;
  return (
    <div className="space-y-3">
      {record ? (
        <>
          <DrawAudit record={record} label={`Audit record · ${record.winner_participant_ids.length} drawn`} />
          {winnerSlots(record, records).map(({ slot, id, history }) => {
            const winner = winners.get(id);
            return (
              <section key={slot} className="max-w-md space-y-2 border-l border-brand-line pl-2 text-xs">
                <p className="font-medium">Prize {slot}{winner ? ` · ${winner.handle}` : ""}</p>
                {!winner && (
                  <p className="text-brand-muted">{prizesFinalized ? "Account deleted after the draw." : DELETED_WINNER}</p>
                )}
                {!winner && !prizesFinalized && (
                  <ActionForm action="replace-winner" label={`Replace winner for prize ${slot}`} quiet>
                    <input type="hidden" name="original" value={record.id} />
                    <input type="hidden" name="slot" value={slot} />
                  </ActionForm>
                )}
                {history.map((replacement) => <DrawAudit key={replacement.id} record={replacement} label="Replacement draw audit" />)}
              </section>
            );
          })}
        </>
      ) : prizesFinalized ? <span className="text-xs text-brand-muted">Prizes fulfilled</span> : (
        <ActionForm action="draw" label={day === null ? "Run grand draw" : `Draw door ${day}`} quiet>
          <input type="hidden" name="draw" value={target} />
        </ActionForm>
      )}
      <div className="flex flex-wrap gap-3 text-xs">
        <a href={`${csv}&list=eligible`} className={textLink}>Eligible CSV</a>
        {record && <a href={`${csv}&list=winners`} className={textLink}>Winners CSV</a>}
      </div>
    </div>
  );
}

function DrawAudit({ record, label }: { record: Draw; label: string }) {
  return (
    <details className="max-w-md space-y-2">
      <summary className="cursor-pointer font-medium">{label}</summary>
      <dl className="space-y-2 break-all text-xs text-brand-muted">
        <div><dt>Record</dt><dd className="font-mono">{record.id}</dd></div>
        {record.original_draw_id && <div><dt>Original draw</dt><dd className="font-mono">{record.original_draw_id}</dd></div>}
        {record.replaces_draw_id && <div><dt>Replaces winner from</dt><dd className="font-mono">{record.replaces_draw_id}</dd></div>}
        <div><dt>Run by</dt><dd>{record.created_by_email} · <LocalTime timestamp={Date.parse(record.created_at)} showYear /></dd></div>
        <div><dt>Eligible participants</dt><dd>{record.eligible_count}</dd></div>
        <div><dt>Eligible list SHA-256</dt><dd className="font-mono">{record.eligible_list_sha256}</dd></div>
        <div><dt>Random bytes</dt><dd className="font-mono">{record.random_bytes_hex}</dd></div>
        <div><dt>Winner IDs in prize order</dt><dd className="font-mono">{record.winner_participant_ids.join(", ") || "No eligible participants"}</dd></div>
      </dl>
      <details className="text-xs text-brand-muted">
        <summary className="cursor-pointer">Eligibility snapshot (participant ID, entries)</summary>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all pt-1 font-mono">{record.eligible_list.map(({ id, entries }) => `${id},${entries}\n`)}</pre>
      </details>
    </details>
  );
}

function ReminderPreview({ now, reminders }: { now: number; reminders: ReminderStats }) {
  const day = campaignDoorForDate(now);
  const door = day === null ? undefined : doors[day - 1];
  const message = door ? renderReminder(door, SITE_URL, `${SITE_URL}/advent/me#settings`) : null;
  const issues = reminders.days.filter((stat) => stat.failed > 0 || stat.unconfirmed > 0);
  return (
    <section className="space-y-4 border-t border-brand-line pt-6" aria-labelledby="reminders">
      <h2 id="reminders" className={heading}>Door reminders</h2>
      <p className="text-sm text-brand-muted">{reminders.optedIn} participants opted in.</p>
      {issues.length > 0 && (
        <details className="text-sm text-brand-muted">
          <summary className="cursor-pointer font-medium">Delivery issues</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {issues.map(({ day, failed, unconfirmed }) => <li key={day}>Door {day} · {failed} failed · {unconfirmed} unconfirmed</li>)}
          </ul>
        </details>
      )}
      {message ? (
        <details className="max-w-2xl space-y-3">
          <summary className="cursor-pointer text-sm font-medium">Preview today’s reminder</summary>
          <p className="text-sm text-brand-muted">{message.subject}</p>
          <iframe title="Reminder email preview" sandbox="" referrerPolicy="no-referrer" srcDoc={message.html} className="h-96 w-full rounded-[10px] border border-brand-line bg-brand-card" />
          <details>
            <summary className="cursor-pointer text-sm font-medium">Plain-text version</summary>
            <pre className="whitespace-pre-wrap break-all rounded-[10px] bg-brand-surface p-3 text-sm text-brand-muted">{message.text}</pre>
          </details>
        </details>
      ) : <p className="text-sm text-brand-muted">There is no reminder to preview today.</p>}
    </section>
  );
}

async function loadAdmin() {
  try {
    const [stats, records, reminders, retentionState] = await Promise.all([
      doorStats(), draws(), rpc<ReminderStats>("advent_reminder_stats"), retention(),
    ]);
    const winners = await winnerAccounts(records);
    return { stats, records, reminders, retention: retentionState, winners };
  } catch {
    return {};
  }
}
