import Link from "next/link";
import { type Metadata } from "next";

import { MarketingShell } from "../MarketingShell";

import {
  JsonLd,
  LEGAL_ENTITY_ADDRESS_LINES,
  LEGAL_ENTITY_NAME,
  SUPPORT_EMAIL,
  breadcrumbSchema,
  organizationSchema,
  pageMetadata,
  softwareApplicationSchema,
  webPageSchema,
  websiteSchema,
} from "../seo";

const LAST_UPDATED = "2026-06-04";
const TITLE = "Terms of use";
const DESCRIPTION =
  "Terms that govern use of the OpenAdminOS desktop app, website, open-source runtime, and community agent registry.";

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: "/terms",
});

export default function TermsPage() {
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      organizationSchema(),
      websiteSchema(),
      softwareApplicationSchema(),
      webPageSchema({
        path: "/terms",
        name: TITLE,
        description: DESCRIPTION,
        dateModified: LAST_UPDATED,
      }),
      breadcrumbSchema([
        { name: "Home", path: "/" },
        { name: "Terms", path: "/terms" },
      ]),
    ],
  };

  return (
    <MarketingShell>
      <JsonLd data={structuredData} />
      <article className="mx-auto max-w-2xl">
        <h1 className="font-display text-balance text-[2.6rem] leading-[1.05] sm:text-[3.5rem]">
          Terms of use
        </h1>
        <p className="mt-2 text-sm text-brand-muted">
          Last updated: {LAST_UPDATED}
        </p>

        <div className="mt-10 space-y-10 text-[15px] leading-7 text-brand-muted">
          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">Summary</h2>
            <p className="mt-3">
              OpenAdminOS is open-source software operated by{" "}
              {LEGAL_ENTITY_NAME} and distributed under the MIT License. These
              terms govern your use of the desktop app and the website at
              openadminos.com. By installing the app or using the site, you
              agree to them.
            </p>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              The software is provided as-is
            </h2>
            <p className="mt-3">
              The desktop app is distributed under the MIT License, the full
              text of which is included with the source at{" "}
              <Link
                href="https://github.com/OpenAdminOS/OpenAdminOS/blob/main/LICENSE"
                target="_blank"
                rel="noreferrer"
                className="text-link"
              >
                github.com/OpenAdminOS/OpenAdminOS
              </Link>
              . That license disclaims warranties and limits liability. To
              repeat the substance in plain English: the software is provided
              &ldquo;as is&rdquo;, without warranty of any kind, express or
              implied. OpenAdminOS is not liable for any damages arising from
              your use of it.
            </p>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              You are responsible for what you run
            </h2>
            <ul className="mt-3 list-disc space-y-3 pl-5 marker:text-brand-muted">
              <li>
                You are responsible for ensuring you have authorization to
                connect any Microsoft 365 tenant you sign in to. Connecting a
                tenant requires admin consent for the Microsoft Graph scopes
                each agent declares.
              </li>
              <li>
                Write-capable agents perform changes against your tenant.
                Every write operation is gated behind a confirmation prompt
                in the app, and destructive operations require typed
                confirmation. You are responsible for reviewing each diff
                before approving it.
              </li>
              <li>
                Community-contributed agents in the registry are not authored
                or audited by OpenAdminOS. You install and run them at your own
                discretion. Read the source before running any agent against
                a production tenant.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              Third-party services
            </h2>
            <p className="mt-3">
              The app interacts with Microsoft Graph using your tenant
              credentials and with the language-model provider you select
              (local providers such as Ollama or LM Studio, or hosted
              providers such as Anthropic, OpenAI, or Azure OpenAI). Your use
              of those services is governed by their own terms and pricing.
              OpenAdminOS is not a party to your contract with Microsoft or with
              your chosen language-model provider.
            </p>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              Acceptable use
            </h2>
            <p className="mt-3">
              You agree not to use the software to violate any law, to
              circumvent another organization&rsquo;s security controls, or
              to perform actions against a Microsoft 365 tenant without
              authorization from that tenant&rsquo;s owner.
            </p>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              Privacy
            </h2>
            <p className="mt-3">
              Use of the desktop app and website is also governed by the{" "}
              <Link
                href="/privacy"
                className="text-link"
              >
                privacy policy
              </Link>
              .
            </p>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              Microsoft trademarks
            </h2>
            <p className="mt-3">
              Microsoft 365, Intune, Entra, and Microsoft Graph are trademarks
              of the Microsoft group of companies. OpenAdminOS is not affiliated
              with, endorsed by, or sponsored by Microsoft. References to those
              services describe compatibility and administration targets only.
            </p>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              Changes
            </h2>
            <p className="mt-3">
              These terms may change as the project evolves. Material changes
              will be noted by updating the &ldquo;Last updated&rdquo; date
              above. The full revision history is public in the project&rsquo;s
              GitHub repository.
            </p>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              Contact
            </h2>
            <p className="mt-3">
              Questions about these terms or the website:{" "}
              <Link
                href={`mailto:${SUPPORT_EMAIL}`}
                className="text-link"
              >
                {SUPPORT_EMAIL}
              </Link>
              .
            </p>
            <address className="mt-4 not-italic text-brand-muted">
              {LEGAL_ENTITY_ADDRESS_LINES.map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </address>
            <p className="mt-3">
              Provider details are listed in the{" "}
              <Link
                href="/legal-notice"
                className="text-link"
              >
                legal notice
              </Link>
              .
            </p>
          </section>
        </div>

        <div className="mt-16 border-t border-brand-line pt-8 text-xs text-brand-muted">
          <Link
            href="/"
            className="underline-offset-4 transition hover:text-brand-ink hover:underline"
          >
            &larr; Back to OpenAdminOS
          </Link>
        </div>
      </article>
    </MarketingShell>
  );
}
