import Link from "next/link";

import { SITE_URL } from "~/app/seo";
import { MARKETING_CONSENT_LABEL, REMINDERS_CONSENT_LABEL, isAdventAdmin, sessionSecret, storageConfig } from "~/lib/advent/config";
import { completions, currentParticipant, rpc } from "~/lib/advent/db";
import { BADGE_DOORS, GRAND_DOORS, REFERRAL_CAP, earnsBadge, grandEntries } from "~/lib/advent/eligibility";
import { campaignNow } from "~/lib/advent/time";
import { ActionForm } from "../ActionForm";
import { Calendar } from "../Calendar";
import { AdventTitle, BackToCalendar, field, heading, Notice, NOT_CONFIGURED, primary, STORAGE_UNAVAILABLE, textLink } from "../shared";

export const metadata = { title: "My Advent | Advent of Admin", robots: { index: false, follow: false } };

export default async function MyAdventPage() {
  const state = await loadAccount();
  const account = state.account;
  const done = state.done ?? [];
  const referrals = Math.min(REFERRAL_CAP, state.referrals ?? 0);
  const entries = grandEntries(done.length, referrals);
  const referralUrl = account ? new URL(`/advent?ref=${account.ref_code}`, SITE_URL).toString() : "";

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <BackToCalendar />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <AdventTitle title="My Advent" description={account?.handle} />
        {account && isAdventAdmin(account.email) && <Link href="/advent/admin" className={textLink}>Campaign admin</Link>}
      </div>
      {state.issue ? <Notice>{state.issue}</Notice> : !account ? (
        <div className="space-y-4">
          <Notice>Sign in to view your saved doors and referral link.</Notice>
          <Link href="/advent/sign-in" className={primary}>Sign in</Link>
        </div>
      ) : (
        <>
          <dl className="grid gap-5 border-y border-brand-line py-5 sm:grid-cols-3">
            <Progress label="Badge" value={`${Math.min(done.length, BADGE_DOORS)} of ${BADGE_DOORS} doors`} detail={earnsBadge(done.length) ? "Badge earned" : "Doors completed toward the badge"} />
            <Progress label="Grand draw" value={`${Math.min(done.length, GRAND_DOORS)} of ${GRAND_DOORS} doors`} detail={`${entries} ${entries === 1 ? "entry" : "entries"}`} />
            <Progress label="Referrals counted" value={`${referrals} of ${REFERRAL_CAP}`} detail="They count after completing door 1." />
          </dl>
          <Calendar now={campaignNow(process.env.ADVENT_NOW)} done={done} />
          <section className="max-w-xl space-y-3" aria-labelledby="referral">
            <h2 id="referral" className={heading}>Referral link</h2>
            <p className="text-sm leading-6 text-brand-muted">Share this link. Each person who signs up through it and completes door 1 adds one grand draw entry once you qualify, up to five extra entries.</p>
            <input className={`${field} font-mono text-sm`} aria-label="Your referral link" readOnly value={referralUrl} />
          </section>
          <section id="settings" className="scroll-mt-24 space-y-5 border-t border-brand-line pt-6" aria-labelledby="settings-title">
            <h2 id="settings-title" className={heading}>Settings</h2>
            <div className="max-w-xl">
              <ActionForm action="settings" label="Save settings">
                <label className="block text-sm font-medium">
                  Handle
                  <input name="handle" className={`${field} mt-2 block`} defaultValue={account.handle} maxLength={24} autoComplete="username" autoCapitalize="none" required />
                </label>
                <label className="flex items-baseline gap-2 text-sm">
                  <input type="checkbox" name="badge" defaultChecked={account.badge_public} /> Public badge page
                </label>
                <p className="text-sm leading-6 text-brand-muted">Shows your handle and completion total. Your badge appears once you reach 12 doors.</p>
                {account.badge_public && <Link href={`/advent/u/${account.handle}`} className={textLink}>View your public badge page</Link>}
                <label className="flex items-baseline gap-2 text-sm">
                  <input type="checkbox" name="marketing" defaultChecked={account.marketing_opt_in} /> {MARKETING_CONSENT_LABEL}
                </label>
                <label className="flex items-baseline gap-2 text-sm">
                  <input type="checkbox" name="reminders" defaultChecked={account.reminders_opt_in} /> {REMINDERS_CONSENT_LABEL}
                </label>
                <input type="hidden" name="reminders_initial" value={account.reminders_opt_in ? "on" : "off"} />
              </ActionForm>
            </div>
            <ActionForm action="sign-out" label="Sign out" quiet />
          </section>
          <section className="max-w-xl space-y-3 border-t border-brand-line pt-6" aria-labelledby="delete-title">
            <h2 id="delete-title" className={heading}>Delete my account</h2>
            <p className="text-sm leading-6 text-brand-muted">This immediately deletes your account, completed doors and feedback, and signs you out.</p>
            <ActionForm action="delete" label="Delete my account" quiet>
              <label className="block text-sm font-medium">
                Type your current handle, <strong>{account.handle}</strong>
                <input className={`${field} mt-2 block`} name="confirm" autoComplete="off" maxLength={24} required />
              </label>
            </ActionForm>
          </section>
        </>
      )}
    </div>
  );
}

function Progress({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="space-y-1">
      <dt className="text-sm text-brand-muted">{label}</dt>
      <dd className="font-mono text-xl">{value}</dd>
      <dd className="text-sm text-brand-muted">{detail}</dd>
    </div>
  );
}

async function loadAccount() {
  if (!storageConfig() || !sessionSecret()) return { issue: NOT_CONFIGURED };
  try {
    const account = await currentParticipant();
    if (!account) return { account: null };
    const [done, referrals] = await Promise.all([completions(account.id), rpc<number>("advent_referral_count", { p_id: account.id })]);
    return { account, done, referrals };
  } catch {
    return { issue: STORAGE_UNAVAILABLE };
  }
}
