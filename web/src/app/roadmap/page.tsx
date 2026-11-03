import type { Metadata } from "next";
import Link from "next/link";

import { MarketingShell } from "../MarketingShell";
import {
  GITHUB_URL,
  JsonLd,
  ROADMAP_URL,
  organizationSchema,
  pageMetadata,
  websiteSchema,
} from "../seo";
import { ROADMAP_STAGES } from "./stages";

const TITLE = "Roadmap";
const HEADLINE = "From one admin's desktop to every IT team.";
const DESCRIPTION =
  "The OpenAdminOS roadmap: the trusted desktop available today, then any model and any tenant, features for IT teams, and an ecosystem for vendors.";

// Canonical lives on roadmap.openadminos.com; next.config.js rewrites that
// host's root to this route, and /roadmap on the main site redirects there.
export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: ROADMAP_URL,
});

export default function RoadmapPage() {
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      organizationSchema(),
      websiteSchema(),
      {
        "@type": "WebPage",
        "@id": `${ROADMAP_URL}#webpage`,
        url: ROADMAP_URL,
        name: `OpenAdminOS ${TITLE}`,
        description: DESCRIPTION,
      },
    ],
  };

  return (
    <MarketingShell>
      <JsonLd data={structuredData} />
      <header className="max-w-4xl">
        <p className="font-mono text-xs uppercase tracking-[0.06em] text-brand-faint">
          {TITLE}
        </p>
        <h1 className="font-display mt-4 max-w-[14ch] text-balance text-[2.5rem] leading-[1.02] tracking-[-0.025em] sm:text-[4.25rem]">
          {HEADLINE}
        </h1>
      </header>

      <ol
        aria-label="Roadmap stages"
        className="mt-16 grid gap-12 sm:mt-20 lg:grid-cols-4 lg:gap-0"
      >
        {ROADMAP_STAGES.map((stage, index) => {
          const shipped = Boolean(stage.status);
          const number = String(index + 1).padStart(2, "0");
          return (
            <li
              key={stage.title}
              className={`relative pt-7 lg:pr-7 ${
                index > 0 ? "lg:border-l lg:border-brand-line-soft lg:pl-7" : ""
              }`}
            >
              <span
                aria-hidden
                className={`absolute inset-x-0 top-0 h-0.5 ${
                  shipped ? "bg-brand-ink" : "bg-brand-line"
                } ${index > 0 ? "lg:-left-px" : ""}`}
              />
              <p
                className={`inline-flex items-center gap-2 font-mono text-xs uppercase tracking-[0.06em] ${
                  shipped ? "text-brand-ink" : "text-brand-faint"
                }`}
              >
                <span
                  aria-hidden
                  className={`h-2 w-2 rounded-full border-[1.5px] ${
                    shipped
                      ? "border-brand-ink bg-brand-ink"
                      : "border-brand-faint"
                  }`}
                />
                {number}
                {stage.status ? ` · ${stage.status}` : null}
              </p>
              <h2 className="font-display mt-3.5 text-[1.75rem] leading-[1.1] tracking-[-0.02em]">
                {stage.title}
              </h2>
              <p className="mt-2 text-sm leading-6 text-brand-muted">
                {stage.summary}
              </p>
              <ul className="mt-7 border-b border-brand-line-soft">
                {stage.items.map((item) => (
                  <li
                    key={item.title}
                    className="border-t border-brand-line-soft py-3.5"
                  >
                    <h3 className="text-[0.95rem] font-medium tracking-[-0.005em]">
                      {item.title}
                    </h3>
                    <p className="mt-0.5 text-[0.85rem] leading-6 text-brand-faint">
                      {item.text}
                    </p>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ol>

      <p className="mt-16 text-sm text-brand-muted">
        Every item is tracked as a public issue.{" "}
        <Link
          href={`${GITHUB_URL}/issues`}
          target="_blank"
          rel="noreferrer"
          className="text-brand-ink underline decoration-brand-line-strong underline-offset-4 hover:decoration-brand-ink"
        >
          Follow the work on GitHub
        </Link>
      </p>
    </MarketingShell>
  );
}
