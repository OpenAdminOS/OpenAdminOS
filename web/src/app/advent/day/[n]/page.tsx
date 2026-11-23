import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { pageMetadata } from "~/app/seo";
import { doors } from "~/content/advent/doors";
import { storageConfig } from "~/lib/advent/config";
import { completions, currentParticipant } from "~/lib/advent/db";
import { campaignNow, doorState, doorUnlock, doorWindowEnd, parseDay } from "~/lib/advent/time";
import { ActionForm } from "../../ActionForm";
import { LocalTime } from "../../LocalTime";
import { AdventTitle, BackToCalendar, field, heading, Notice, NOT_CONFIGURED, secondary, STORAGE_UNAVAILABLE, textLink } from "../../shared";

type Props = { params: Promise<{ n: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const day = parseDay((await params).n);
  if (!day) return {};
  return pageMetadata({
    title: `Door ${day} | Advent of Admin`,
    description: `Door ${day} of the OpenAdminOS December calendar.`,
    path: `/advent/day/${day}`,
  });
}

export default async function DoorPage({ params }: Props) {
  const day = parseDay((await params).n);
  const door = day ? doors[day - 1] : undefined;
  if (!day || !door) notFound();
  const state = doorState(day, campaignNow(process.env.ADVENT_NOW));

  if (state === "locked") {
    return (
      <article className="mx-auto max-w-2xl space-y-6">
        <BackToCalendar />
        <AdventTitle title={`Door ${day} is locked`} label="Advent of Admin" />
        <Notice>Opens <LocalTime timestamp={doorUnlock(day)} unlock />.</Notice>
      </article>
    );
  }

  const { participant, completion, issue } = await loadCheck(day);
  return (
    <article className="mx-auto max-w-2xl space-y-7">
      <BackToCalendar />
      <AdventTitle title={door.title} label={`Door ${day} · Advent of Admin`} description={door.goal} />
      {door.needsTenant && <p className="border-l-2 border-brand-line-strong pl-3 text-sm text-brand-muted">
        {day === 8 ? "Have a Microsoft 365 tenant you are authorised to connect with read-only permissions."
          : "Needs a connected Microsoft 365 tenant. Use a tenant you are authorised to work with."}
      </p>}
      {door.draft && <Notice>Steps are being checked against the current release.</Notice>}
      {door.steps && (
        <section aria-labelledby="steps" className="space-y-3">
          <h2 id="steps" className={heading}>Steps</h2>
          {day === 1 && <Link href="/download" className={textLink}>Download OpenAdminOS</Link>}
          {day === 24 && <Link href="/advent/me#settings" className={textLink}>My Advent settings</Link>}
          <ol className="list-decimal space-y-2 pl-6 text-[15px] leading-7 text-brand-muted">
            {door.steps.map((step) => <li className="pl-1" key={step}>{step}</li>)}
          </ol>
        </section>
      )}

      <section id="check" aria-labelledby="check-title" className="scroll-mt-24 space-y-4 border-t border-brand-line pt-6">
        <h2 id="check-title" className={heading}>Check</h2>
        {completion && (
          <Notice tone="ok">
            <strong className="text-brand-ok">Done</strong> · Completed <LocalTime timestamp={Date.parse(completion.completed_at)} />.
            <br />{completion.on_time ? `This completion counts for the door ${day} daily draw.` : "This completion was after the daily draw deadline."}
          </Notice>
        )}
        {state === "closed" && <Notice>Completions closed on 31 December. You can still read the steps.</Notice>}
        {door.question && <p className="text-base leading-7 text-brand-muted">{door.question}</p>}
        {state === "open" && !completion && (
          <>
            {issue ? <Notice>{issue}</Notice> : !door.question ? <Notice>The check for this door is being prepared.</Notice>
              : !participant ? <Link href="/advent/sign-in" className={secondary}>Sign in to complete this door</Link>
                : (
                  <ActionForm action="complete" label={day === 22 ? "Submit feedback" : day === 24 ? "Complete door" : "Check answer"}>
                    <input type="hidden" name="day" value={day} />
                    {day === 22 ? (
                      <label className="block space-y-2 text-sm font-medium">Feedback
                        <textarea className={`${field} mt-2 block`} name="feedback" rows={5} maxLength={2000} required />
                      </label>
                    ) : day === 24 ? null : (
                      <label className="block space-y-2 text-sm font-medium">Check answer
                        <input className={`${field} mt-2 block`} name="answer" autoComplete="off" maxLength={256} required />
                      </label>
                    )}
                  </ActionForm>
                )}
            <p className="text-sm text-brand-muted">Daily draw deadline · <LocalTime timestamp={doorWindowEnd(day)} />.</p>
          </>
        )}
      </section>
    </article>
  );
}

async function loadCheck(day: number) {
  if (!storageConfig()) return { issue: NOT_CONFIGURED };
  try {
    const participant = await currentParticipant();
    const completion = participant ? (await completions(participant.id)).find((item) => item.day === day) : undefined;
    return { participant, completion };
  } catch {
    return { issue: STORAGE_UNAVAILABLE };
  }
}
