import type { Metadata } from "next";
import Link from "next/link";

import { MarketingShell, PageIntro, TextCard } from "../../MarketingShell";
import {
  JsonLd,
  breadcrumbSchema,
  organizationSchema,
  pageMetadata,
  softwareApplicationSchema,
  webPageSchema,
  websiteSchema,
} from "../../seo";

const TITLE = "Intune admin agents for Microsoft 365 tenants";
const DESCRIPTION =
  "Use OpenAdminOS agents to investigate Intune devices, compliance policies, app assignments, sign-ins, and stale assets with local Graph workflows.";

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: "/use-cases/intune",
});

const USE_CASES = [
  {
    title: "Device and compliance investigations",
    text: "Correlate managed devices, Entra devices, compliance policies, update posture, encryption state, and troubleshooting events.",
  },
  {
    title: "App and assignment questions",
    text: "Inspect mobile apps, detected apps, app configuration policies, managed app protection, groups, and assignment filters.",
  },
  {
    title: "Sign-in and policy explanations",
    text: "Summarize failed sign-ins, Conditional Access results, directory audit entries, and policy context for an admin-readable report.",
  },
  {
    title: "Reviewed cleanup plans",
    text: "Prepare stale device or stale guest cleanup plans with evidence. Any write still waits for diff confirmation.",
  },
];

export default function IntuneUseCasePage() {
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      organizationSchema(),
      websiteSchema(),
      softwareApplicationSchema(),
      webPageSchema({
        path: "/use-cases/intune",
        name: TITLE,
        description: DESCRIPTION,
        dateModified: "2026-06-02",
      }),
      breadcrumbSchema([
        { name: "Home", path: "/" },
        { name: "Use cases", path: "/use-cases/intune" },
        { name: "Intune", path: "/use-cases/intune" },
      ]),
    ],
  };

  return (
    <MarketingShell>
      <JsonLd data={structuredData} />
      <PageIntro
        eyebrow="Intune use cases"
        title="Tenant investigations that need more than a script."
        description={DESCRIPTION}
      />

      <section className="mt-12 grid gap-4 md:grid-cols-2">
        {USE_CASES.map((item) => (
          <TextCard key={item.title} title={item.title}>
            <p>{item.text}</p>
          </TextCard>
        ))}
      </section>

      <section className="mt-12 grid gap-5 border-t border-white/10 pt-12 md:grid-cols-[0.9fr_1.1fr]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300/80">
            Microsoft Graph
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight">
            Agents declare every Graph scope they need.
          </h2>
        </div>
        <div className="space-y-5 text-sm leading-6 text-white/62">
          <p>
            OpenAdminOS does not ask for broad tenant access on behalf of an
            invisible automation layer. Each agent declares the Graph resources
            it reads or writes. The app shows those scopes before consent and
            keeps the active tenant visible while work runs.
          </p>
          <p>
            Local LLM providers such as Ollama keep Intune evidence and prompts
            on the admin machine. Hosted providers remain available, but the UI
            labels that tenant context will leave the device.
          </p>
          <Link
            href="/llm-providers"
            className="inline-flex font-medium text-emerald-200 underline-offset-4 transition hover:text-white hover:underline"
          >
            Compare local and hosted providers
          </Link>
        </div>
      </section>
    </MarketingShell>
  );
}
