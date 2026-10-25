import Link from "next/link";
import { type Metadata } from "next";

import { MarketingShell } from "../MarketingShell";

import {
  JsonLd,
  LEGAL_ENTITY_ADDRESS_LINES,
  LEGAL_ENTITY_NAME,
  LEGAL_ENTITY_SHORT_NAME,
  MANAGING_DIRECTOR_NAME,
  SUPPORT_EMAIL,
  breadcrumbSchema,
  organizationSchema,
  pageMetadata,
  softwareApplicationSchema,
  webPageSchema,
  websiteSchema,
} from "../seo";

const LAST_UPDATED = "2026-10-24";
const TITLE = "Privacy policy";
const DESCRIPTION =
  "How OpenAdminOS handles Microsoft 365 tenant data, authentication tokens, LLM prompts, registry install counts, and website analytics.";

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: "/privacy",
});

export default function PrivacyPage() {
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      organizationSchema(),
      websiteSchema(),
      softwareApplicationSchema(),
      webPageSchema({
        path: "/privacy",
        name: TITLE,
        description: DESCRIPTION,
        dateModified: LAST_UPDATED,
      }),
      breadcrumbSchema([
        { name: "Home", path: "/" },
        { name: "Privacy", path: "/privacy" },
      ]),
    ],
  };

  return (
    <MarketingShell>
      <JsonLd data={structuredData} />
      <article className="mx-auto max-w-2xl">
        <h1 className="font-display text-balance text-[2.6rem] leading-[1.05] sm:text-[3.5rem]">
          Privacy policy
        </h1>
        <p className="mt-2 text-sm text-brand-muted">
          Last updated: {LAST_UPDATED}
        </p>

        <div className="mt-10 space-y-10 text-[15px] leading-7 text-brand-muted">
          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">Summary</h2>
            <p className="mt-3">
              OpenAdminOS is a desktop app for Microsoft 365 administrators. It
              runs on your computer. Your Microsoft 365 tenant data, local
              model prompts, run history, and crash logs are not sent to{" "}
              {LEGAL_ENTITY_NAME}, the company behind OpenAdminOS.
            </p>
            <p className="mt-3">
              When you choose a hosted language-model provider (Anthropic,
              OpenAI, or Azure OpenAI) instead of a local one, prompts that
              include tenant data are sent to that provider under their own
              privacy policy. The app states this explicitly in the UI before
              any prompt is sent.
            </p>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              Who is responsible
            </h2>
            <p className="mt-3">
              The controller under the GDPR for this website and for the data
              described in this policy is {LEGAL_ENTITY_NAME}{" "}
              (&ldquo;{LEGAL_ENTITY_SHORT_NAME}&rdquo;, &ldquo;we&rdquo;),
              represented by its managing director, {MANAGING_DIRECTOR_NAME}.
              OpenAdminOS is our open-source product. The source is at{" "}
              <Link
                href="https://github.com/OpenAdminOS/OpenAdminOS"
                target="_blank"
                rel="noreferrer"
                className="text-link"
              >
                github.com/OpenAdminOS/OpenAdminOS
              </Link>
              . You can reach support at{" "}
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
              The full provider disclosure is available in the{" "}
              <Link
                href="/legal-notice"
                className="text-link"
              >
                legal notice
              </Link>
              .
            </p>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              What the desktop app does on your computer
            </h2>
            <ul className="mt-3 list-disc space-y-3 pl-5 marker:text-brand-muted">
              <li>
                <span className="text-brand-ink">
                  Microsoft 365 authentication.
                </span>{" "}
                When you connect a tenant, the app signs you in to Microsoft
                using MSAL. Microsoft returns access and refresh tokens scoped
                to the Graph permissions you consented to. Those tokens are
                stored in your operating-system keychain (macOS Keychain,
                Windows Credential Manager) and used only by the local app to
                call Microsoft Graph. They are never transmitted to us.
              </li>
              <li>
                <span className="text-brand-ink">Microsoft Graph data.</span>{" "}
                Agents you run call Microsoft Graph on your behalf and process
                the returned data (devices, users, policies, etc.) in memory
                on your machine. Selected fields may be written to a local
                SQLite database for run history and audit purposes. This
                database is stored under your user profile and is never
                uploaded anywhere.
              </li>
              <li>
                <span className="text-brand-ink">
                  Language-model prompts (local provider).
                </span>{" "}
                When you select a local LLM provider such as Ollama or LM
                Studio, prompts and responses stay on your machine. We do not
                see them.
              </li>
              <li>
                <span className="text-brand-ink">
                  Language-model prompts (hosted provider).
                </span>{" "}
                When you select Anthropic, OpenAI, or Azure OpenAI, prompts
                (which may contain tenant data) are sent over TLS to that
                provider, under their privacy policy and your account with
                them. The app names the selected provider and marks it as
                hosted before any prompt is sent. We do not receive a copy of
                these prompts.
              </li>
              <li>
                <span className="text-brand-ink">No tenant telemetry.</span> The
                desktop app does not collect tenant data, prompts, run results,
                analytics events, or error-reporting data. Crash logs stay on
                your machine.
              </li>
              <li>
                <span className="text-brand-ink">Registry install counts.</span> In
                packaged production builds, the app can send a small registry
                install count event when you install a public registry agent.
                You can disable this in Settings. The event contains the agent
                slug, app version, operating-system platform, and a yearly
                per-agent SHA-256 hash derived from a random local install ID.
                It does not include tenant identifiers, user identifiers,
                prompts, run results, or Microsoft Graph data. The website
                endpoint also uses your IP address briefly for rate limiting
                and stores the deduplication hash for up to one year. These
                counts are used only to publish aggregate registry stats.
              </li>
              <li>
                <span className="text-brand-ink">Support issue reports.</span> If
                you choose Report issue, review the form, and confirm public
                submission, the app sends the report to the OpenAdminOS website
                so the server can create a public GitHub issue. Optional
                diagnostics are bounded and sanitized before submission. They do
                not include tenant identifiers, prompts, Graph responses, run
                results, raw logs, screenshots, local databases, tokens, or
                provider credentials. The endpoint uses your IP address briefly
                for rate limiting and stores a short-lived deduplication hash.
              </li>
              <li>
                <span className="text-brand-ink">Auto-update.</span> The app can
                check GitHub Releases for a new version and download the signed
                installer. These checks send a standard HTTPS request to GitHub;
                refer to{" "}
                <Link
                  href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement"
                  target="_blank"
                  rel="noreferrer"
                  className="text-link"
                >
                  GitHub&rsquo;s privacy statement
                </Link>{" "}
                for what they log.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              What this website does
            </h2>
            <ul className="mt-3 list-disc space-y-3 pl-5 marker:text-brand-muted">
              <li>
                <span className="text-brand-ink">Hosting and logs.</span> The site
                is deployed on Vercel. Vercel records standard server access
                logs (IP address, user-agent, timestamps) as a normal part of
                serving the site; see{" "}
                <Link
                  href="https://vercel.com/legal/privacy-policy"
                  target="_blank"
                  rel="noreferrer"
                  className="text-link"
                >
                  Vercel&rsquo;s privacy policy
                </Link>
                .
              </li>
              <li>
                <span className="text-brand-ink">
                  Privacy-friendly website analytics.
                </span>{" "}
                The public marketing website uses{" "}
                <Link
                  href="https://plausible.io/"
                  target="_blank"
                  rel="noreferrer"
                  className="text-link"
                >
                  Plausible Analytics
                </Link>{" "}
                to understand aggregate page usage. We do not use Google
                Analytics, advertising trackers, or third-party cookies.
                Plausible is not used in the desktop app and never receives
                tenant data, prompts, run results, tokens, provider credentials,
                or support diagnostics from the app.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              Your rights
            </h2>
            <p className="mt-3">
              If you are in the EU, UK, or another jurisdiction with similar
              data-protection laws, you have the right to request a copy of
              the personal data we hold about you, to correct it, or to have
              it deleted. Because the desktop app does not transmit tenant
              content to us, this in practice applies to support
              correspondence and the limited registry install count data described
              above. Email {SUPPORT_EMAIL} and we will respond within
              30 days.
            </p>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              Changes to this policy
            </h2>
            <p className="mt-3">
              Material changes will be noted by updating the &ldquo;Last
              updated&rdquo; date above and, where reasonable, by a notice in
              the desktop app or on this page. The full revision history is
              public in the project&rsquo;s GitHub repository.
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
