import type { Metadata } from "next";
import Link from "next/link";

import { MarketingShell, PageIntro, TextCard } from "../MarketingShell";
import {
  JsonLd,
  breadcrumbSchema,
  organizationSchema,
  pageMetadata,
  softwareApplicationSchema,
  webPageSchema,
  websiteSchema,
} from "../seo";

const TITLE = "Microsoft 365 agent registry";
const DESCRIPTION =
  "Browse the OpenAdminOS registry model for Microsoft 365 admin agents, including declared Graph scopes, read/write mode, model requirements, and review gates.";

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: "/registry",
});

const AGENT_GROUPS = [
  {
    name: "Investigation agents",
    examples: "Sign-in failure explainer, risky sign-in triage, tenant health report",
    detail:
      "Read-only agents collect evidence from Microsoft Graph and produce an admin-readable report. They can run without a write confirmation because they do not change the tenant.",
  },
  {
    name: "Posture agents",
    examples: "Secure Score prioritizer, compliance overview, OS update posture",
    detail:
      "Posture agents rank configuration gaps and stale assets by tenant context. They are built for repeatable checks rather than one-off chat prompts.",
  },
  {
    name: "Write-plan agents",
    examples: "Stale guest cleanup, offboarding agent",
    detail:
      "Write agents prepare a bounded change plan first. The desktop app always shows the diff before any Graph write runs, and destructive changes require typed confirmation.",
  },
];

export default function RegistryPage() {
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      organizationSchema(),
      websiteSchema(),
      softwareApplicationSchema(),
      webPageSchema({
        path: "/registry",
        name: TITLE,
        description: DESCRIPTION,
        dateModified: "2026-06-02",
      }),
      breadcrumbSchema([
        { name: "Home", path: "/" },
        { name: "Registry", path: "/registry" },
      ]),
      {
        "@type": "ItemList",
        "@id": "https://www.openadminos.com/registry#agent-groups",
        name: "OpenAdminOS agent registry categories",
        itemListElement: AGENT_GROUPS.map((group, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name: group.name,
          description: group.detail,
        })),
      },
    ],
  };

  return (
    <MarketingShell>
      <JsonLd data={structuredData} />
      <PageIntro
        eyebrow="Agent registry"
        title="Community agents with declared tenant access."
        description={DESCRIPTION}
      />

      <section className="mt-12 grid gap-4 lg:grid-cols-3">
        {AGENT_GROUPS.map((group) => (
          <TextCard key={group.name} title={group.name}>
            <p>{group.detail}</p>
            <p className="mt-4 font-mono text-xs text-white/45">
              {group.examples}
            </p>
          </TextCard>
        ))}
      </section>

      <section className="mt-12 grid gap-5 border-t border-white/10 pt-12 md:grid-cols-[0.8fr_1.2fr]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-300/80">
            Manifest contract
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight">
            The registry is inspectable before install.
          </h2>
        </div>
        <div className="space-y-5 text-sm leading-6 text-white/62">
          <p>
            Every public agent ships with a manifest that declares its Microsoft
            Graph scopes, read/write classification, model requirements,
            settings, and connector egress. The desktop app shows that contract
            before installation and again before a run needs new consent.
          </p>
          <p>
            Enterprises can point OpenAdminOS at their own curated registry
            instead of using the public catalog. The runtime stays the same; the
            trusted source of agent packages changes.
          </p>
          <Link
            href="/trust-model"
            className="inline-flex font-medium text-sky-200 underline-offset-4 transition hover:text-white hover:underline"
          >
            See how registry trust is enforced
          </Link>
        </div>
      </section>
    </MarketingShell>
  );
}
