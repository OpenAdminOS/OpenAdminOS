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

const TITLE = "Local and hosted LLM providers";
const DESCRIPTION =
  "OpenAdminOS supports local LLM providers for private Microsoft 365 tenant work and labels hosted provider egress before prompts are sent.";

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: "/llm-providers",
});

const PROVIDERS = [
  {
    title: "Ollama",
    text: "Local provider available today. Tenant data and prompts stay on the admin workstation.",
  },
  {
    title: "LM Studio",
    text: "Planned local provider path for admins who prefer a local desktop model host.",
  },
  {
    title: "OpenAI, Anthropic, Azure OpenAI",
    text: "Hosted providers are optional. The app labels provider and region before tenant context is sent.",
  },
];

export default function LlmProvidersPage() {
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      organizationSchema(),
      websiteSchema(),
      softwareApplicationSchema(),
      webPageSchema({
        path: "/llm-providers",
        name: TITLE,
        description: DESCRIPTION,
        dateModified: "2026-06-02",
      }),
      breadcrumbSchema([
        { name: "Home", path: "/" },
        { name: "LLM providers", path: "/llm-providers" },
      ]),
    ],
  };

  return (
    <MarketingShell>
      <JsonLd data={structuredData} />
      <PageIntro
        eyebrow="Provider model"
        title="Local models by default, hosted models by choice."
        description={DESCRIPTION}
      />

      <section className="mt-12 grid gap-4 md:grid-cols-3">
        {PROVIDERS.map((provider) => (
          <TextCard key={provider.title} title={provider.title}>
            <p>{provider.text}</p>
          </TextCard>
        ))}
      </section>

      <section className="mt-12 grid gap-5 border-t border-white/10 pt-12 md:grid-cols-[0.9fr_1.1fr]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/45">
            Provider trust
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight">
            The selected model changes the data boundary.
          </h2>
        </div>
        <div className="space-y-5 text-sm leading-6 text-white/62">
          <p>
            With a local provider selected, the desktop app sends agent prompts
            to the local model host and keeps tenant context on the device. With
            a hosted provider selected, prompts that include tenant data are
            sent over TLS to that provider under the admin's account.
          </p>
          <p>
            OpenAdminOS does not treat those two modes as equivalent. The app
            copy changes because the trust boundary changes.
          </p>
          <Link
            href="/trust-model"
            className="inline-flex font-medium text-white underline-offset-4 transition hover:text-white/70 hover:underline"
          >
            Read the full trust model
          </Link>
        </div>
      </section>
    </MarketingShell>
  );
}
