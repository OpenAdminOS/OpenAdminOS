import Link from "next/link";
import { type Metadata } from "next";

import { MarketingShell } from "../MarketingShell";

import {
  GITHUB_URL,
  JsonLd,
  LEGAL_ENTITY_ADDRESS_LINES,
  LEGAL_ENTITY_NAME,
  LEGAL_ENTITY_REGISTER,
  LEGAL_ENTITY_VAT_ID,
  MANAGING_DIRECTOR_NAME,
  MICROSOFT_NOTICE,
  SUPPORT_EMAIL,
  breadcrumbSchema,
  organizationSchema,
  pageMetadata,
  softwareApplicationSchema,
  webPageSchema,
  websiteSchema,
} from "../seo";

const LAST_UPDATED = "2026-10-25";
const TITLE = "Legal notice";
const DESCRIPTION =
  "Provider identification, Impressum, and contact details for OpenAdminOS, a product of Ugurlabs UG (haftungsbeschränkt).";

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: "/legal-notice",
});

export default function LegalNoticePage() {
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      organizationSchema(),
      websiteSchema(),
      softwareApplicationSchema(),
      webPageSchema({
        path: "/legal-notice",
        name: TITLE,
        description: DESCRIPTION,
        dateModified: LAST_UPDATED,
      }),
      breadcrumbSchema([
        { name: "Home", path: "/" },
        { name: "Legal notice", path: "/legal-notice" },
      ]),
    ],
  };

  return (
    <MarketingShell>
      <JsonLd data={structuredData} />
      <article className="mx-auto max-w-2xl">
        <h1 className="font-display text-balance text-[2.6rem] leading-[1.05] sm:text-[3.5rem]">
          Legal notice
        </h1>
        <p className="mt-2 text-sm text-brand-muted">
          Last updated: {LAST_UPDATED}
        </p>

        <div className="mt-10 space-y-10 text-[15px] leading-7 text-brand-muted">
          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              Provider identification
            </h2>
            <p className="mt-3">
              This page is the Impressum / provider identification under § 5
              DDG for openadminos.com and the OpenAdminOS desktop app.
              OpenAdminOS is a product of {LEGAL_ENTITY_NAME}.
            </p>
            <address className="mt-3 not-italic text-brand-muted">
              {LEGAL_ENTITY_ADDRESS_LINES.map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </address>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">Contact</h2>
            <p className="mt-3">
              Email:{" "}
              <Link
                href={`mailto:${SUPPORT_EMAIL}`}
                className="text-link"
              >
                {SUPPORT_EMAIL}
              </Link>
            </p>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              Managing director
            </h2>
            <p className="mt-3">{MANAGING_DIRECTOR_NAME}</p>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              Commercial register
            </h2>
            <p className="mt-3">
              Registered in the commercial register (Handelsregister) of the{" "}
              {LEGAL_ENTITY_REGISTER.court} under {LEGAL_ENTITY_REGISTER.number}.
            </p>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              VAT ID
            </h2>
            <p className="mt-3">
              VAT identification number under § 27a of the German VAT Act
              (UStG): {LEGAL_ENTITY_VAT_ID}
            </p>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              Open-source project
            </h2>
            <p className="mt-3">
              OpenAdminOS is published under the MIT License. The source code,
              issue tracker, license text, and contribution history are public
              at{" "}
              <Link
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className="text-link"
              >
                github.com/OpenAdminOS/OpenAdminOS
              </Link>
              .
            </p>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              Microsoft trademarks
            </h2>
            <p className="mt-3">{MICROSOFT_NOTICE}</p>
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
