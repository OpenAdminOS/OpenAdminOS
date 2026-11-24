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

const LAST_UPDATED = "2026-11-25";
const TITLE = "Privacy policy";
const DESCRIPTION =
  "What OpenAdminOS and its service providers process when you use the desktop app, website, downloads, support, or booking.";

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
              OpenAdminOS runs on your computer. A local model processes tenant data,
              prompts, and responses on that device. A hosted model receives prompts
              and any context included in them. The app names the destination.
            </p>
            <p className="mt-3">
              The app also makes limited requests for updates, the agent catalog,
              documentation, and install counts. Settings &gt; Privacy controls
              these requests. This policy explains what we and the services we use receive.
            </p>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              Who is responsible
            </h2>
            <p className="mt-3">
              The controller for the processing we do is {LEGAL_ENTITY_NAME}{" "}
              (&ldquo;{LEGAL_ENTITY_SHORT_NAME}&rdquo;, &ldquo;we&rdquo;),
              represented by its managing director, {MANAGING_DIRECTOR_NAME}.
              For privacy questions and requests, email{" "}
              <Link href={`mailto:${SUPPORT_EMAIL}`} className="text-link">{SUPPORT_EMAIL}</Link>.
            </p>
            <address className="mt-4 not-italic">
              {LEGAL_ENTITY_ADDRESS_LINES.map((line) => (
                <span key={line} className="block">{line}</span>
              ))}
            </address>
            <p className="mt-3">
              Ugurlabs has no data protection officer. Fewer than 20 people regularly
              carry out automated processing of personal data at Ugurlabs (§ 38 BDSG).
              The full provider disclosure is in the{" "}
              <Link href="/legal-notice" className="text-link">legal notice</Link>.
            </p>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              People and devices in your Microsoft 365 tenant
            </h2>
            <p className="mt-3">
              The administrator&rsquo;s organization is the controller for personal
              data about other people in its Microsoft 365 tenant, including user
              records and device records associated with people. The desktop app
              connects to the tenant and processes the records on the
              administrator&rsquo;s device.
              For questions about these records, contact the administrator&rsquo;s
              organization.
            </p>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              What the desktop app does
            </h2>
            <p className="mt-3">
              When you connect a service such as Microsoft 365, the app signs you in and
              uses that connection to read the data you authorize. It keeps credentials
              in operating-system protected storage and stores chat, cached records,
              and run history on your computer. We do not receive tenant records,
              credentials, prompts, run results, or crash reports as telemetry.
            </p>
            <p className="mt-3">
              Your setup determines where other data goes. Hosted providers receive
              the prompts and context sent to them under their own terms. Enabled
              public references can receive filtered words from a question, and
              configured delivery rules or agent steps can send reports to connectors.
            </p>
            <p className="mt-3">
              The app checks local model servers and installed CLI versions. It
              reads the Codex model cache and configuration and asks Codex and
              Claude Code for sign-in status. Claude Code may contact its configured
              service. The full Copilot check contacts GitHub through the Copilot CLI
              for the model catalog. For Copilot and Gemini, the first-run scan checks
              only the installed versions. OpenAdminOS sends none of these discovery
              results to us.
            </p>
            <p className="mt-3">
              The app checks GitHub Releases for updates on supported Windows and
              macOS builds. An available update downloads in the background from
              GitHub. It installs when you restart or quit the app. The app refreshes
              the agent registry from GitHub or your configured registry. With local
              Ollama available, it can download the
              docs index from GitHub Releases and have local Ollama pull its embedding
              model from the Ollama registry. Installing a public agent can send
              a count to our website. Pause these automatic requests in
              Settings &gt; Privacy. You can still check for updates on supported
              builds, refresh the registry, or install the docs index manually.
              See the{" "}
              <Link href="/docs/trust-model/network-calls" className="text-link">network calls reference</Link>{" "}
              for timing, payloads, and individual controls.
            </p>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              Website, app requests, and downloads
            </h2>
            <div className="mt-4 space-y-5">
              <div>
                <h3 className="font-medium text-brand-ink">Hosting and access logs</h3>
                <p>
                  Vercel hosts the website and its APIs for us on its Pro plan.
                  It processes access logs with IP addresses, browser or app user-agent strings, and
                  timestamps to serve requests, troubleshoot, and protect the site.
                  We rely on our legitimate interest in operating and securing the
                  site (Art. 6(1)(f) GDPR). Vercel keeps these logs for up to 30 days.
                  We do not export copies of these logs. Build logs contain no visitor
                  data. The website&rsquo;s server functions run in the United States.
                  Logging is part of using the site or API.
                  See <Link href="https://vercel.com/legal/privacy-policy" className="text-link">Vercel&rsquo;s privacy policy</Link>.
                </p>
              </div>
              <div>
                <h3 className="font-medium text-brand-ink">Rate limits and duplicate reports</h3>
                <p>
                  Our website derives a keyed hash (HMAC) from the IP address for
                  each endpoint. Our processor, Supabase (Supabase Pte. Ltd.),
                  stores these rate-limit keys in Frankfurt, Germany
                  (<code>eu-central-1</code>). The raw IP address stays out of that
                  database. The keys expire after 60 seconds for install requests
                  and after 1 hour for support reports and agent submissions.
                  A hash used to detect duplicate support reports expires after
                  24 hours. Cleanup deletes the expired records. We rely on our
                  legitimate interest in preventing abuse and duplicate issues
                  (Art. 6(1)(f) GDPR). Rate limiting applies when you use these endpoints.
                </p>
              </div>
              <div>
                <h3 className="font-medium text-brand-ink">Public agent install counts</h3>
                <p>
                  Packaged builds (stable and nightly) send the public agent slug, app version,
                  and platform when you install a public registry agent. The app
                  records one attempt per agent and UTC calendar year on your
                  device, even if the request fails. Supabase stores daily
                  aggregate counts by agent slug. The count records contain no
                  installation identifier, app version, or platform. The website
                  publishes the totals hourly to GitHub in <code>stats/agents.json</code>.
                  The Git commits also record daily aggregates by agent. The
                  database keeps each day&rsquo;s totals for about 8 days after
                  the UTC day ends, then deletes them once published. We keep
                  the published aggregates indefinitely. They contain no personal data.
                  Our legitimate interest is improving the registry by measuring
                  which agents are installed (Art. 6(1)(f) GDPR). Counts are on
                  by default. Turn them off in Settings &gt; Privacy.
                </p>
              </div>
              <div>
                <h3 className="font-medium text-brand-ink">Website theme</h3>
                <p>
                  If you choose a light or dark theme, the site can save that choice in
                  your browser&rsquo;s local storage (<code>localStorage</code>). The choice stays in your browser
                  and is never sent to us. The theme setting uses no cookie. You can
                  clear it in your browser&rsquo;s site settings.
                </p>
              </div>
              <div>
                <h3 className="font-medium text-brand-ink">Marketing website analytics</h3>
                <p>
                  Plausible Analytics measures aggregate use of our marketing
                  pages. It receives page, referral, and engagement information
                  and uses request IP addresses and user agents transiently for
                  daily visitor estimates. Plausible uses no cookies, stores no
                  personal data, and keeps only aggregate statistics. We rely on
                  our legitimate interest in improving the marketing site by
                  understanding which pages people use (Art. 6(1)(f) GDPR).
                  Plausible deletes its daily salt after 24 hours. The docs and
                  desktop app do not load Plausible. You can block its script in
                  your browser. See <Link href="https://plausible.io/data-policy" className="text-link">Plausible&rsquo;s data policy</Link>.
                </p>
              </div>
              <div>
                <h3 className="font-medium text-brand-ink">GitHub downloads and registry requests</h3>
                <p>
                  GitHub receives your IP address and request details when you use
                  GitHub Releases, the apt repository on GitHub Pages, or the
                  default agent registry. The desktop updater also sends GitHub a
                  random UUID saved on your device in its <code>x-user-staging-id</code>{" "}
                  header. Our legitimate interest is making releases and the catalog
                  available and helping users find updates (Art. 6(1)(f) GDPR).
                  GitHub acts as an independent controller for
                  these requests. Its own statement covers its logging, retention,
                  and rights requests. To pause background update checks and automatic
                  registry refreshes, turn off Automatic network requests in Settings &gt;
                  Privacy. A manual update check can still download an available update.
                  See <Link href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" className="text-link">GitHub&rsquo;s privacy statement</Link>.
                </p>
              </div>
            </div>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              Support, public submissions, and bookings
            </h2>
            <div className="mt-4 space-y-5">
              <div>
                <h3 className="font-medium text-brand-ink">Support email</h3>
                <p>
                  When you email us, we use your address, message, and any attachments
                  to handle your request. Microsoft 365 Exchange Online hosts the
                  mailbox in our EU tenant. For customers, we handle support
                  as part of the contract (Art. 6(1)(b) GDPR). For other senders, we rely on our
                  legitimate interest in responding to support requests and resolving
                  reported problems (Art. 6(1)(f) GDPR).
                </p>
                <p className="mt-2">
                  We delete support email 12 months after the request is closed.
                  We keep business correspondence for six years, or for ten years
                  if it falls into a record category with that retention period under
                  German commercial or tax law (§ 257 HGB and § 147 AO).
                  Email is optional. We need a return address and enough information
                  about the problem to respond.
                </p>
              </div>
              <div>
                <h3 className="font-medium text-brand-ink">Public GitHub issues</h3>
                <p>
                  If you submit a support report or share a community agent, our
                  website forwards the submitted content to GitHub to open a public
                  issue. For support reports, you can preview the exact public title
                  and issue body on your device. The app requires that preview
                  when you include diagnostics. If you change the report, review
                  it again before sending with diagnostics. Diagnostics group
                  counts and activity ages into ranges and summarize errors by
                  category. They use the UTC calendar date for the report.
                  Verified public registry agents can appear by slug. Other
                  agents are labeled local, and run identifiers are omitted.
                  Agent submissions include the manifest, supporting details, and
                  contact information you provide. Our legitimate interest in
                  processing public support reports is diagnosing and resolving
                  reported problems (Art. 6(1)(f) GDPR). Our legitimate interest
                  in processing agent submissions is reviewing community contributions
                  in public and maintaining the registry (Art. 6(1)(f) GDPR).
                </p>
                <p className="mt-2">
                  Anyone can read the issue, and issues can remain public indefinitely.
                  Copies may persist after an edit or removal. Submitting is optional.
                  The required form fields are needed to create the issue. Leave out
                  private details and use email if you need to contact us privately.
                </p>
              </div>
              <div>
                <h3 className="font-medium text-brand-ink">Booking a call</h3>
                <p>
                  Our site links to Cal.com, which processes booking details in the
                  United States on our behalf. Both booking forms require your name
                  and email address. You can add notes and additional guests&rsquo; email addresses.
                  The &ldquo;We build an OpenAdminOS agent for you&rdquo; booking also
                  requires an answer to &ldquo;What should the agent do?&rdquo;
                  We use booking details to arrange and hold the call. Calls run on
                  Microsoft Teams in our Microsoft 365 tenant, which is hosted in the EU.
                  We do not record calls.
                </p>
                <p className="mt-2">
                  We process booking details to perform a contract or take steps you
                  request before entering into one (Art. 6(1)(b) GDPR). We keep booking
                  details for 12 months after the call. Booking is optional.
                  See <Link href="https://cal.com/privacy" className="text-link">Cal.com&rsquo;s privacy policy</Link>.
                </p>
              </div>
            </div>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              International transfers
            </h2>
            <p className="mt-3">
              Vercel, GitHub, Microsoft, and Cal.com may process data in the United
              States. For eligible transfers to Vercel, GitHub, and Cal.com, we
              rely on the frameworks listed below. The standard contractual
              clauses (SCCs) are those approved by the European Commission.
            </p>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>
                <strong className="text-brand-ink">Vercel Inc.</strong> participates in
                the EU-U.S. Data Privacy Framework (DPF), its UK Extension, and the
                Swiss-U.S. DPF. Its data processing addendum includes SCCs where applicable.
              </li>
              <li>
                <strong className="text-brand-ink">GitHub</strong> participates in the
                EU-U.S. DPF, its UK Extension, and the Swiss-U.S. DPF. Its privacy
                statement also describes its use of SCCs for international transfers.
              </li>
              <li>
                <strong className="text-brand-ink">Microsoft Corporation</strong> participates in
                the EU-U.S. DPF, its UK Extension, and the Swiss-U.S. DPF. Microsoft
                uses the SCCs in its data protection addendum for international
                transfers through its enterprise services.
              </li>
              <li>
                <strong className="text-brand-ink">Cal.com, Inc.</strong> participates in
                the EU-U.S. DPF and its UK Extension. Its data processing agreement
                uses SCCs where the framework does not cover a transfer, including
                transfers from Switzerland.
              </li>
              <li>
                <strong className="text-brand-ink">Supabase (Supabase Pte. Ltd.)</strong> is
                based in Singapore and hosts our database in Frankfurt, Germany
                (<code>eu-central-1</code>). For international transfers we rely on
                the SCCs in its data processing agreement.
              </li>
            </ul>
            <p className="mt-3">
              Plausible hosts our analytics in the EU, with no transfer outside the
              EU. For a copy of the relevant safeguards, email{" "}
              <Link href={`mailto:${SUPPORT_EMAIL}`} className="text-link">{SUPPORT_EMAIL}</Link>.
            </p>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              Your rights
            </h2>
            <p className="mt-3">
              You can ask whether we process your personal data and request a copy
              and details about the processing, including its purposes, categories
              of data, recipients, retention, sources where relevant, and transfer
              safeguards. You can ask us to correct or erase your data, restrict its
              use, or provide your data in a portable format where that right
              applies. You can object to processing based on legitimate interests.
              We do not use the data described here to make solely automated
              decisions that have legal or similarly significant effects on you.
            </p>
            <p className="mt-3">
              Email {SUPPORT_EMAIL}. We generally cannot link app traffic to
              you. Install counts carry no installation identifier. Older app versions
              may still send a legacy hash, which the server discards without storing.
              We switched the website to aggregate-only counts and deleted the
              former provider&rsquo;s stored install hashes, hash sets, and
              pending counters on 24 November 2026.
              The updater UUID goes to GitHub. An email address you used
              to contact us, an issue URL, a booking reference, or an approximate
              date and time can help us locate a record. We may ask for enough
              information to verify that the record is yours. We normally respond
              within one month.
            </p>
            <p className="mt-3">
              You can lodge a complaint with any data protection supervisory
              authority in the EU, in particular where you live or work. Our
              supervisory authority is the{" "}
              <Link href="https://www.ldi.nrw.de" className="text-link">
                Landesbeauftragte für Datenschutz und Informationsfreiheit Nordrhein-Westfalen
              </Link>{" "}
              (LDI NRW) in Düsseldorf, Germany.
            </p>
          </section>

          <section>
            <h2 className="font-display text-[1.5rem] leading-tight text-brand-ink">
              Changes to this policy
            </h2>
            <p className="mt-3">
              The date at the top shows when we last updated this policy. If we
              plan to use personal data for a new purpose, we will tell you
              about the new purpose before we start. Earlier
              versions are available in the{" "}
              <Link href="https://github.com/OpenAdminOS/OpenAdminOS/commits/main/web/src/app/privacy/page.tsx" className="text-link">
                public Git history
              </Link>.
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
