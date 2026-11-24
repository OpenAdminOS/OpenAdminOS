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

const LAST_UPDATED = "2026-11-24";
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
              The controller for the processing described here is {LEGAL_ENTITY_NAME}{" "}
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
            {/* TODO(ugur): Confirm whether a data protection officer is required and publish their contact details if applicable. */}
            <p className="mt-3">
              Data protection officer contact, if applicable: [to be confirmed].
              The full provider disclosure is in the{" "}
              <Link href="/legal-notice" className="text-link">legal notice</Link>.
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
              The app checks local model servers on your computer. It reads local CLI
              version and sign-in status for tools such as Claude Code and Codex and
              reads the Codex model cache and configuration for model names.
              The CLI tools may check sign-in with their providers. OpenAdminOS
              sends none of these discovery results to us.
            </p>
            <p className="mt-3">
              The app checks GitHub Releases for updates on supported Windows and
              macOS builds and refreshes the agent registry from GitHub or your
              configured registry. With local Ollama available, it can download the
              docs index from GitHub Releases and have local Ollama pull its embedding
              model from the Ollama registry. Installing a public agent can send
              a count to our website. Turn off these requests in Settings &gt; Privacy.
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
                {/* TODO(ugur): Confirm the Art. 6(1)(f) basis, Vercel log retention, and processor terms. */}
                <p>
                  Vercel hosts the website and its APIs for us. It processes access
                  logs with IP addresses, browser or app user-agent strings, and
                  timestamps to serve requests, troubleshoot, and protect the site.
                  We rely on our legitimate interest in operating and securing the
                  site (Art. 6(1)(f) GDPR, [to be confirmed]). Log retention is
                  [to be confirmed]. Logging is part of using the site or API.
                  See <Link href="https://vercel.com/legal/privacy-policy" className="text-link">Vercel&rsquo;s privacy policy</Link>.
                </p>
              </div>
              <div>
                <h3 className="font-medium text-brand-ink">Rate limits and duplicate reports</h3>
                {/* TODO(ugur): Confirm the Art. 6(1)(f) basis, Upstash region, and processor terms. */}
                <p>
                  Upstash Redis processes short-lived keys containing the requester&rsquo;s
                  IP address. Install count keys expire after 60 seconds. Support and
                  agent submission rate-limit keys expire after 1 hour. A hash used to
                  detect repeated support reports expires after 24 hours. The storage region
                  is [to be confirmed]. We rely on our legitimate interest in preventing
                  abuse and duplicate issues (Art. 6(1)(f) GDPR, [to be confirmed]).
                  Rate limiting applies when you use these endpoints.
                </p>
              </div>
              <div>
                <h3 className="font-medium text-brand-ink">Public agent install counts</h3>
                {/* TODO(ugur): Confirm the Art. 6(1)(f) basis and retention for the aggregate daily counters. */}
                <p>
                  Packaged production builds send the public agent slug, app version,
                  and platform when you install a public registry agent. The app
                  checks for duplicates on your device. Upstash Redis stores aggregate
                  daily counters without a per-install identifier. We briefly use your
                  IP address for rate limiting as described above. Our legitimate
                  interest is measuring which agents are installed (Art. 6(1)(f)
                  GDPR, [to be confirmed]). Aggregate retention is [to be confirmed].
                  Counts are on by default. Turn them off in Settings &gt; Privacy.
                </p>
              </div>
              <div>
                <h3 className="font-medium text-brand-ink">Marketing website analytics</h3>
                {/* TODO(ugur): Confirm the Art. 6(1)(f) basis and analytics retention for this site. */}
                <p>
                  Plausible Analytics measures aggregate use of our marketing
                  pages. It receives page, referral, and engagement information
                  and uses request IP addresses and user agents transiently for
                  daily visitor estimates. It uses no cookies and does not store
                  raw IP addresses or user agents. We rely on our legitimate interest
                  in understanding which pages are used (Art. 6(1)(f) GDPR,
                  [to be confirmed]). Plausible deletes its daily salt after 24
                  hours. Aggregate retention is [to be confirmed]. The docs and
                  desktop app do not load Plausible. You can block its script in
                  your browser. See <Link href="https://plausible.io/data-policy" className="text-link">Plausible&rsquo;s data policy</Link>.
                </p>
              </div>
              <div>
                <h3 className="font-medium text-brand-ink">GitHub downloads and registry requests</h3>
                {/* TODO(ugur): Confirm the Art. 6(1)(f) basis for OpenAdminOS distributing releases and registry data through GitHub. */}
                <p>
                  GitHub receives your IP address and request details when you use
                  GitHub Releases, the apt repository on GitHub Pages, or the
                  default agent registry. The desktop updater also sends GitHub a
                  random UUID saved on your device in its <code>x-user-staging-id</code>{" "}
                  header. Our legitimate interest is making releases and the catalog
                  available and helping users find updates (Art. 6(1)(f) GDPR,
                  [to be confirmed]). GitHub acts as an independent controller for
                  these requests. Its own statement covers its logging, retention,
                  and rights requests. To stop background update and registry checks,
                  turn off automatic network requests in Settings &gt; Privacy. Downloads
                  are optional. See <Link href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" className="text-link">GitHub&rsquo;s privacy statement</Link>.
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
                {/* TODO(ugur): Confirm the Art. 6(1)(b) basis and support mailbox retention. */}
                <p>
                  When you email us, we use your address, message, and any attachments
                  to handle your request. Microsoft 365 Exchange Online hosts the
                  mailbox for us. The legal basis is handling the support you
                  request (Art. 6(1)(b) GDPR, [to be confirmed]). Mail retention
                  is [to be confirmed]. Email is optional. We need a return address
                  and enough information about the problem to respond.
                </p>
              </div>
              <div>
                <h3 className="font-medium text-brand-ink">Public GitHub issues</h3>
                {/* TODO(ugur): Confirm Art. 6(1)(b) for support reports and Art. 6(1)(f) for agent submissions. */}
                <p>
                  If you submit a support report or share a community agent, our
                  website forwards the submitted content to GitHub to open a public
                  issue. You review the support report before submitting it.
                  Optional diagnostics are shown in the preview and group counts into ranges.
                  Agent submissions include the manifest, supporting details, and
                  contact information you provide. We use reports to respond
                  to support requests (Art. 6(1)(b) GDPR, [to be confirmed]) and
                  rely on our legitimate interest in reviewing community contributions
                  in public (Art. 6(1)(f) GDPR, [to be confirmed]).
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
                {/* TODO(ugur): Confirm the Art. 6(1)(b) basis, Cal.com and Teams processor roles, and booking retention. */}
                <p>
                  Our site links to Cal.com. When you book, Cal.com receives the
                  name, email address, selected time, and any notes you enter.
                  We use these details to arrange and hold the call on Microsoft
                  Teams. We do not record the calls. The legal basis is arranging
                  the call you requested (Art. 6(1)(b) GDPR, [to be confirmed]).
                  Booking retention is [to be confirmed]. Booking is optional.
                  We need your email address and a time to confirm the appointment.
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
              Some service providers may process data outside the European Economic
              Area, including in the United States. The safeguards can include an
              adequacy decision under the EU-US Data Privacy Framework for an
              eligible, certified recipient, or the European Commission&rsquo;s
              standard contractual clauses (SCCs).
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-5">
              {/* TODO(ugur): Confirm the transfer countries and applicable safeguard for each provider, including DPF certification or SCCs, and how to obtain copies. */}
              <li>Vercel (hosting and access logs): [to be confirmed].</li>
              <li>Upstash (rate limiting, deduplication, and counters): [to be confirmed].</li>
              <li>Plausible (marketing website analytics): [to be confirmed].</li>
              <li>Microsoft (Exchange Online and Teams): [to be confirmed].</li>
              <li>Cal.com (bookings): [to be confirmed].</li>
              <li>GitHub (public issues and downloads): [to be confirmed].</li>
            </ul>
            <p className="mt-3">
              Email {SUPPORT_EMAIL} to ask for details or a copy of the relevant safeguards.
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
              you. Install counts carry no personal or installation identifier,
              and the updater UUID goes to GitHub. An email address you used
              to contact us, an issue URL, a booking reference, or an approximate
              date and time can help us locate a record. We may ask for enough
              information to verify that the record is yours. We normally respond
              within one month.
            </p>
            {/* TODO(ugur): Confirm the competent supervisory authority for the controller. */}
            <p className="mt-3">
              You can lodge a complaint with a data protection supervisory authority,
              including in the EU country where you live, work, or believe a
              violation occurred. In North Rhine-Westphalia, Germany, the authority
              is the{" "}
              <Link href="https://www.ldi.nrw.de/kontakt/ihre-beschwerde" className="text-link">
                Landesbeauftragte für Datenschutz und Informationsfreiheit Nordrhein-Westfalen
              </Link>{" "}
              ([to be confirmed] as the authority for our company).
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
