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
    title: "Local: Ollama, LM Studio, Apple Foundation",
    text: "Run open-source models locally. Tenant data and prompts stay on this machine.",
  },
  {
    title: "Hosted through a vendor CLI",
    text: "Anthropic through Claude Code, OpenAI Codex, GitHub Copilot, and Google Gemini use the CLI you already signed in to. Tenant prompts are sent to that vendor's service while the provider is active.",
  },
  {
    title: "Azure OpenAI",
    text: "Uses your own Azure OpenAI deployment. Tenant prompts are sent to your Azure resource's endpoint.",
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

      <section className="mt-12 grid gap-5 border-t border-brand-line pt-12 md:grid-cols-[0.9fr_1.1fr]">
        <div>
          <p className="text-sm font-medium text-brand-faint">
            Provider trust
          </p>
          <h2 className="font-display mt-4 text-balance text-[2rem] leading-[1.1] sm:text-[2.5rem]">
            The selected model changes the data boundary.
          </h2>
        </div>
        <div className="space-y-5 text-sm leading-6 text-brand-muted">
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
            className="inline-flex font-medium text-link"
          >
            Read the full trust model
          </Link>
        </div>
      </section>
    </MarketingShell>
  );
}
