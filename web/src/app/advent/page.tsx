import type { Metadata } from "next";
import Link from "next/link";

import { pageMetadata } from "~/app/seo";
import { CAMPAIGN_CLOSE, campaignNow } from "~/lib/advent/time";
import { storageConfig } from "~/lib/advent/config";
import { completions, currentParticipant, doorStats } from "~/lib/advent/db";
import { parseReferral } from "~/lib/advent/identity";
import { Calendar } from "./Calendar";
import { AdventTitle, heading, Notice, primary, secondary, textLink, NOT_CONFIGURED, STORAGE_UNAVAILABLE } from "./shared";

export const metadata: Metadata = pageMetadata({
  title: "Advent of Admin",
  description: "Try one feature a day in OpenAdminOS from 1 to 24 December 2026.",
  path: "/advent",
});

export default async function AdventPage({ searchParams }: { searchParams: Promise<{ ref?: string | string[] }> }) {
  const query = await searchParams;
  const ref = typeof query.ref === "string" ? parseReferral(query.ref) : "";
  const now = campaignNow(process.env.ADVENT_NOW);
  const state = await loadCalendar();
  const signUp = ref ? `/advent/sign-up?ref=${ref}` : "/advent/sign-up";

  return (
    <div className="mx-auto max-w-5xl">
      <div className="grid gap-6 border-b border-brand-line pb-9 lg:grid-cols-[1fr_auto] lg:items-end">
        <AdventTitle
          label="1 to 24 December 2026"
          title="Advent of Admin"
          description="Try one feature a day in OpenAdminOS. Each door takes about five minutes and ends with a short check you can answer from the app."
        />
        <div className="flex flex-wrap gap-2.5">
          <Link href="/download" className={primary}>Download OpenAdminOS</Link>
          {state.account ? <Link href="/advent/me" className={secondary}>My Advent</Link> : (
            <>
              {now < CAMPAIGN_CLOSE && <Link href={signUp} className={secondary}>Sign up</Link>}
              <Link href="/advent/sign-in" className={secondary}>Sign in</Link>
            </>
          )}
        </div>
      </div>

      <section aria-labelledby="calendar" className="mt-9 space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h2 id="calendar" className={heading}>December calendar</h2>
          <p className="text-sm text-brand-muted">14 of 24 doors work without connecting a Microsoft 365 tenant.</p>
        </div>
        {state.issue && <Notice>{state.issue} You can still view the doors and download the app.</Notice>}
        <Calendar now={now} done={state.done} counts={state.counts} />
      </section>

      <section aria-labelledby="prizes" className="mt-12 grid gap-5 border-t border-brand-line pt-8 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <h2 id="prizes" className={heading}>Prizes and badge</h2>
        <dl className="divide-y divide-brand-line border-y border-brand-line">
          <Prize title="Daily draw">One €25 voucher for each door. Complete the door before the next one opens to enter that day’s draw.</Prize>
          <Prize title="Grand draw">Complete at least 18 doors for a chance to win a mini PC that runs local models or one of two Microsoft certification exam vouchers.</Prize>
          <Prize title="Badge">Complete at least 12 doors to earn a badge. You can make it public in My Advent.</Prize>
        </dl>
      </section>
      <nav aria-label="Campaign information" className="mt-7 flex flex-wrap gap-5 text-sm">
        <Link href="/advent/rules" className={textLink}>Campaign rules</Link>
        <Link href="/privacy#advent" className={textLink}>Privacy</Link>
      </nav>
    </div>
  );
}

function Prize({ title, children }: { title: string; children: string }) {
  return <div className="grid gap-1 py-3 sm:grid-cols-[7rem_1fr]"><dt className="text-sm font-medium">{title}</dt><dd className="text-sm leading-6 text-brand-muted">{children}</dd></div>;
}

async function loadCalendar() {
  if (!storageConfig()) return { issue: NOT_CONFIGURED };
  try {
    const [stats, account] = await Promise.all([doorStats(), currentParticipant()]);
    const done = account ? await completions(account.id) : [];
    return { counts: new Map(stats.map(({ day, completed }) => [day, completed])), account, done };
  } catch {
    return { issue: STORAGE_UNAVAILABLE };
  }
}
