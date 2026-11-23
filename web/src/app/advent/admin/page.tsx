import Link from "next/link";
import { notFound } from "next/navigation";

import { doors } from "~/content/advent/doors";
import { drawOpens, draws, RETENTION_MS } from "~/lib/advent/admin";
import { currentAdmin, doorStats } from "~/lib/advent/db";
import type { Draw } from "~/lib/advent/db";
import { campaignNow } from "~/lib/advent/time";
import { ActionForm } from "../ActionForm";
import { LocalTime } from "../LocalTime";
import { AdventTitle, field, heading, Notice, STORAGE_UNAVAILABLE, textLink } from "../shared";

export const metadata = { title: "Campaign admin | Advent of Admin", robots: { index: false, follow: false } };

export default async function AdminPage() {
  const account = await currentAdmin().catch(() => null);
  if (!account) notFound();

  const now = campaignNow(process.env.ADVENT_NOW);
  const state = await loadAdmin();
  const grand = state.records?.find((record) => record.kind === "grand");
  const purgeAt = grand ? Date.parse(grand.created_at) + RETENTION_MS : null;

  return (
    <div className="mx-auto max-w-5xl space-y-9">
      <Link href="/advent/me" className={textLink}>My Advent</Link>
      <AdventTitle title="Campaign admin" label="Advent of Admin" />
      {!state.stats || !state.records ? <Notice tone="error">{STORAGE_UNAVAILABLE}</Notice> : (
        <>
          <section id="answers" className="scroll-mt-24 space-y-4" aria-labelledby="answers-title">
            <h2 id="answers-title" className={heading}>Accepted answers</h2>
            <div className="max-w-xl">
              <ActionForm action="set-answers" label="Replace accepted answers">
                <label className="block text-sm font-medium">Door
                  <select name="day" className={`${field} mt-2 block`}>
                    {doors.filter(({ day }) => day !== 22 && day !== 24).map(({ day, title }) => (
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
                      <td className="p-2"><DrawControls day={stat.day} now={now} record={state.records.find((item) => item.day === stat.day)} /></td>
                    </tr>
                  ))}
                  <tr className="border-b border-brand-line align-top">
                    <th scope="row" colSpan={4} className="p-2 font-medium">Grand draw</th>
                    <td className="p-2"><DrawControls day={null} now={now} record={grand} /></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-4 border-t border-brand-line pt-6" aria-labelledby="purge">
            <h2 id="purge" className={heading}>Participant retention</h2>
            <p className="text-sm leading-6 text-brand-muted">
              {purgeAt === null ? "Purge becomes available 90 days after the grand draw."
                : <>Purge opens <LocalTime timestamp={purgeAt} showYear />.</>} It immediately deletes accounts that won no prize.
            </p>
            <ActionForm action="purge" label="Purge non-winner accounts" quiet disabled={purgeAt === null || now < purgeAt} refreshOnSuccess />
          </section>
        </>
      )}
    </div>
  );
}

function DrawControls({ day, now, record }: { day: number | null; now: number; record?: Draw }) {
  const opens = drawOpens(day);
  const open = now >= opens;
  const target = day === null ? "grand" : String(day);
  const csv = `/api/advent/export?draw=${target}`;

  if (!open) return <span className="text-xs text-brand-muted">Opens <LocalTime timestamp={opens} showYear={day === null} /></span>;
  return (
    <div className="space-y-3">
      {record ? (
        <details className="max-w-md space-y-2">
          <summary className="cursor-pointer font-medium">Audit record · {record.winner_participant_ids.length} drawn</summary>
          <dl className="space-y-2 break-all text-xs text-brand-muted">
            <div><dt>Record</dt><dd className="font-mono">{record.id}</dd></div>
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
      ) : (
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

async function loadAdmin() {
  try {
    const [stats, records] = await Promise.all([doorStats(), draws()]);
    return { stats, records };
  } catch {
    return {};
  }
}
