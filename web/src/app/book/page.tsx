import type { Metadata } from "next";
import Link from "next/link";

import { MarketingShell, PageIntro } from "../MarketingShell";
import {
  AGENT_BUILD_BOOKING_URL,
  DEMO_BOOKING_URL,
  JsonLd,
  breadcrumbSchema,
  organizationSchema,
  pageMetadata,
  webPageSchema,
  websiteSchema,
} from "../seo";
import { buttonPrimary, card, eyebrow } from "../ui";

const TITLE = "Book a demo or an agent build call";
const DESCRIPTION =
  "Book a free 30-minute demo of OpenAdminOS, or a free 60-minute call where we build an agent for one of your admin tasks with you.";

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: "/book",
});

const CALLS = [
  {
    id: "demo",
    meta: "30 minutes · Free · Microsoft Teams",
    title: "Book a demo",
    text: "A walkthrough of OpenAdminOS with us. Bring your questions and your use case.",
    points: [
      "Agents answering questions about a Microsoft 365 tenant",
      "How write agents pause for approval before any change",
      "Local and hosted models, and where data goes with each",
    ],
    href: DEMO_BOOKING_URL,
    action: "Pick a demo time",
  },
  {
    id: "build",
    meta: "60 minutes · Free · Microsoft Teams",
    title: "We build an agent for you",
    text: "Bring one task you do by hand today, such as a weekly report or a cleanup. You leave the call with a working agent for it.",
    points: [
      "Tell us the task when you book, so we can prepare",
      "We build the agent with you in Build your own Agent and test it",
      "It is saved on your machine, and its changes still wait for your approval",
    ],
    href: AGENT_BUILD_BOOKING_URL,
    action: "Book a build call",
  },
] as const;

export default function BookPage() {
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      organizationSchema(),
      websiteSchema(),
      webPageSchema({
        path: "/book",
        name: TITLE,
        description: DESCRIPTION,
        dateModified: "2026-11-17",
      }),
      breadcrumbSchema([
        { name: "Home", path: "/" },
        { name: "Book a call", path: "/book" },
      ]),
    ],
  };

  return (
    <MarketingShell>
      <JsonLd data={structuredData} />
      <PageIntro
        tone="clay"
        eyebrow="Book a call"
        title="See it run, or leave with your own agent."
        description="Two free calls with us. A short demo of the app, or a longer session where we build an agent for one of your tasks together."
      />

      <div className="mt-12 grid gap-6 md:grid-cols-2">
        {CALLS.map((call) => (
          <section
            key={call.id}
            id={call.id}
            aria-labelledby={`${call.id}-title`}
            className={`${card} flex scroll-mt-24 flex-col p-8`}
            data-reveal
          >
            <p className={eyebrow}>{call.meta}</p>
            <h2
              id={`${call.id}-title`}
              className="font-display mt-4 text-[2rem] leading-tight"
            >
              {call.title}
            </h2>
            <p className="mt-3 text-base leading-7 text-brand-muted">{call.text}</p>
            <ul className="mt-6 flex-1 space-y-3 border-t border-brand-line pt-6 text-[15px] leading-6">
              {call.points.map((point) => (
                <li key={point} className="flex gap-3">
                  <span
                    aria-hidden
                    className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-muted"
                  />
                  {point}
                </li>
              ))}
            </ul>
            <a
              href={call.href}
              target="_blank"
              rel="noreferrer"
              className={`${buttonPrimary} mt-8 h-12 self-start px-5 text-[15px]`}
            >
              {call.action}
              <span aria-hidden>↗</span>
            </a>
          </section>
        ))}
      </div>

      <section className="mt-12 border-t border-brand-line pt-8" data-reveal>
        <h2 className="font-display text-[1.45rem] leading-tight">
          How both calls work
        </h2>
        <p className="mt-3 max-w-3xl text-[15px] leading-7 text-brand-muted">
          You share your screen and do every click. We never sign in to your
          tenant or ask for a password. For a build call, have OpenAdminOS
          installed and use an account that can grant admin consent in your
          tenant. Booking runs on Cal.com. For details, see the{" "}
          <Link href="/privacy" className="text-link">
            privacy policy
          </Link>
          .
        </p>
      </section>
    </MarketingShell>
  );
}
