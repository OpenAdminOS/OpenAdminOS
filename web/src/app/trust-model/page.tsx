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

const TITLE = "Local-first trust model for tenant agents";
const DESCRIPTION =
  "How OpenAdminOS keeps Microsoft 365 tenant work local by default, labels hosted model egress, and gates every write agent behind human approval.";

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: "/trust-model",
});

const TRUST_RULES = [
  {
    title: "Local provider selected",
    text: "Tenant data, prompts, answer packs, run history, and local model responses stay on the admin workstation.",
  },
  {
    title: "Hosted provider selected",
    text: "The app labels the provider before a prompt containing tenant context is sent to OpenAI, Anthropic, or Azure OpenAI.",
  },
  {
    title: "Write agent selected",
    text: "The agent prepares a diff first. Destructive changes require typed confirmation every time.",
  },
  {
    title: "Tenant context missing",
    text: "No agent run starts until an active tenant is connected and visible in the app status strip.",
  },
];

export default function TrustModelPage() {
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      organizationSchema(),
      websiteSchema(),
      softwareApplicationSchema(),
      webPageSchema({
        path: "/trust-model",
        name: TITLE,
        description: DESCRIPTION,
        dateModified: "2026-06-02",
      }),
      breadcrumbSchema([
        { name: "Home", path: "/" },
        { name: "Trust model", path: "/trust-model" },
      ]),
    ],
  };

  return (
    <MarketingShell>
      <JsonLd data={structuredData} />
      <PageIntro
        eyebrow="Trust model"
        title="Tenant data stays local unless you choose otherwise."
        description={DESCRIPTION}
      />

      <section className="mt-12 grid gap-4 md:grid-cols-2">
        {TRUST_RULES.map((rule) => (
          <TextCard key={rule.title} title={rule.title}>
            <p>{rule.text}</p>
          </TextCard>
        ))}
      </section>

      <section className="mt-12 grid gap-5 border-t border-white/10 pt-12 md:grid-cols-[0.9fr_1.1fr]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-300/80">
            Write safety
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight">
            There is no trust-this-agent bypass.
          </h2>
        </div>
        <div className="space-y-5 text-sm leading-6 text-white/62">
          <p>
            Read-only agents can run autonomously against the active tenant.
            Write agents cannot. They produce a proposed change set, show the
            before/after diff, and wait for approval. Destructive operations
            require the exact typed phrase shown in the confirmation panel.
          </p>
          <p>
            This rule applies to community agents and private registry agents.
            It also applies when chat suggests an installed write agent for a
            repeated task.
          </p>
          <Link
            href="/registry"
            className="inline-flex font-medium text-amber-200 underline-offset-4 transition hover:text-white hover:underline"
          >
            Review the agent registry contract
          </Link>
        </div>
      </section>
    </MarketingShell>
  );
}
