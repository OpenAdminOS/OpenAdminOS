import Link from "next/link";
import { type Metadata } from "next";

import {
  GITHUB_URL,
  JsonLd,
  LEGAL_ENTITY_ADDRESS_LINES,
  LEGAL_ENTITY_NAME,
  MANAGING_DIRECTOR_NAME,
  SUPPORT_EMAIL,
  breadcrumbSchema,
  organizationSchema,
  pageMetadata,
  softwareApplicationSchema,
  webPageSchema,
  websiteSchema,
} from "../seo";

const LAST_UPDATED = "2026-06-04";
const TITLE = "Legal notice";
const DESCRIPTION =
  "Provider identification, Impressum, and contact details for OpenAdminOS.";

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
    <div className="relative flex min-h-screen flex-col bg-[#0a0a0c] text-white">
      <JsonLd data={structuredData} />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[600px] bg-[radial-gradient(ellipse_at_top,rgba(140,140,255,0.10),transparent_70%)]"
      />

      <header className="relative z-10 flex items-center px-6 py-6 sm:px-10">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm font-semibold tracking-tight"
        >
          <img
            src="/icon.svg"
            alt=""
            aria-hidden
            className="h-5 w-5 rounded-[4px]"
          />
          OpenAdminOS
        </Link>
      </header>

      <main className="relative z-10 mx-auto w-full max-w-2xl flex-1 px-6 pb-24 pt-10 sm:px-10 sm:pt-14">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Legal notice
        </h1>
        <p className="mt-2 text-sm text-white/50">
          Last updated: {LAST_UPDATED}
        </p>

        <div className="mt-10 space-y-10 text-sm leading-relaxed text-white/75">
          <section>
            <h2 className="text-base font-semibold text-white">
              Provider identification
            </h2>
            <p className="mt-3">
              This page is the Impressum / provider identification for
              OpenAdminOS under § 5 DDG.
            </p>
            <address className="mt-3 not-italic text-white/70">
              {LEGAL_ENTITY_ADDRESS_LINES.map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </address>
          </section>

          <section>
            <h2 className="text-base font-semibold text-white">Contact</h2>
            <p className="mt-3">
              Email:{" "}
              <Link
                href={`mailto:${SUPPORT_EMAIL}`}
                className="text-white underline underline-offset-4 transition hover:text-white/70"
              >
                {SUPPORT_EMAIL}
              </Link>
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-white">
              Managing director
            </h2>
            <p className="mt-3">{MANAGING_DIRECTOR_NAME}</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-white">
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
                className="text-white underline underline-offset-4 transition hover:text-white/70"
              >
                github.com/OpenAdminOS/OpenAdminOS
              </Link>
              .
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-white">
              Microsoft trademarks
            </h2>
            <p className="mt-3">
              Microsoft 365, Intune, Entra, and Microsoft Graph are trademarks
              of the Microsoft group of companies. OpenAdminOS is not
              affiliated with, endorsed by, or sponsored by Microsoft.
            </p>
          </section>
        </div>

        <div className="mt-16 border-t border-white/10 pt-8 text-xs text-white/40">
          <Link
            href="/"
            className="underline-offset-4 transition hover:text-white/70 hover:underline"
          >
            &larr; Back to OpenAdminOS
          </Link>
        </div>
      </main>

      <footer className="relative z-10 px-6 py-8 text-center sm:px-10">
        <span className="text-xs text-white/40">
          &copy; {new Date().getFullYear()} OpenAdminOS
          {" · "}
          <Link
            href="/privacy"
            className="underline-offset-4 transition hover:text-white/70 hover:underline"
          >
            Privacy
          </Link>
          {" · "}
          <Link
            href="/terms"
            className="underline-offset-4 transition hover:text-white/70 hover:underline"
          >
            Terms
          </Link>
          {" · "}
          <Link
            href="/legal-notice"
            className="underline-offset-4 transition hover:text-white/70 hover:underline"
          >
            Legal notice
          </Link>
        </span>
      </footer>
    </div>
  );
}

// TODO(ugur): Add the register court/register number and VAT ID if issued.
// These are generally required in a complete § 5 DDG provider identification
// for a registered German UG.
