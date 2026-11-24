import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { absoluteUrl, pageMetadata } from "~/app/seo";
import { adventEnabled, storageConfig } from "~/lib/advent/config";
import { publicProfile } from "~/lib/advent/db";
import { earnsBadge } from "~/lib/advent/eligibility";
import { validHandle } from "~/lib/advent/identity";
import { AdventTitle, BackToCalendar, Notice, STORAGE_UNAVAILABLE } from "../../shared";

type Props = { params: Promise<{ handle: string }> };

const loadProfile = cache(async (handle: string) => {
  if (!validHandle(handle)) return { profile: null };
  if (!storageConfig()) return { profile: null };
  try {
    return { profile: await publicProfile(handle) };
  } catch {
    return { issue: STORAGE_UNAVAILABLE };
  }
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params;
  if (!adventEnabled()) return {};
  const { profile } = await loadProfile(handle);
  if (!profile) return { title: "Advent of Admin", robots: { index: false, follow: false } };

  const path = `/advent/u/${profile.handle}`;
  const description = `${profile.handle} completed ${profile.count} of 24 Advent of Admin doors.`;
  const metadata = pageMetadata({ title: `${profile.handle} | Advent of Admin`, description, path });
  const image = { url: absoluteUrl(`${path}/og`), width: 1200, height: 630, alt: description };
  return {
    ...metadata,
    robots: { index: false, follow: true },
    openGraph: { ...metadata.openGraph, images: [image] },
    twitter: { ...metadata.twitter, images: [image] },
  };
}

export default async function BadgePage({ params }: Props) {
  const { handle } = await params;
  const { profile, issue } = await loadProfile(handle);
  if (!profile && !issue) notFound();

  return (
    <article className="mx-auto max-w-2xl space-y-6">
      <BackToCalendar />
      <AdventTitle label="Advent of Admin · December 2026" title={profile?.handle ?? "Public badge"} />
      {issue ? <Notice>{issue}</Notice> : profile && (
        <div className="border-y border-brand-line py-6">
          <p className="font-mono text-3xl">{profile.count} <span className="text-base text-brand-muted">of 24 doors completed</span></p>
          {earnsBadge(profile.count) && <p className="mt-4 inline-flex rounded-[10px] border border-brand-line bg-brand-ok-surface px-3 py-2 text-sm font-medium text-brand-ok">Advent of Admin badge earned</p>}
        </div>
      )}
    </article>
  );
}
