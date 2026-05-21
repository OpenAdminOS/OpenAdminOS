import Link from "next/link";
import { type Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy policy — OpenAdminOS",
  description:
    "How OpenAdminOS handles your Microsoft 365 tenant data, authentication tokens, and LLM prompts. Local-first by default.",
};

const LAST_UPDATED = "2026-05-19";

export default function PrivacyPage() {
  return (
    <div className="relative flex min-h-screen flex-col bg-[#0a0a0c] text-white">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[600px] bg-[radial-gradient(ellipse_at_top,rgba(140,140,255,0.10),transparent_70%)]"
      />

      <header className="relative z-10 flex items-center px-6 py-6 sm:px-10">
        <Link href="/" className="text-sm font-semibold tracking-tight">
          OpenAdminOS
        </Link>
      </header>

      <main className="relative z-10 mx-auto w-full max-w-2xl flex-1 px-6 pb-24 pt-10 sm:px-10 sm:pt-14">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Privacy policy
        </h1>
        <p className="mt-2 text-sm text-white/50">
          Last updated: {LAST_UPDATED}
        </p>

        <div className="mt-10 space-y-10 text-sm leading-relaxed text-white/75">
          <section>
            <h2 className="text-base font-semibold text-white">Summary</h2>
            <p className="mt-3">
              OpenAdminOS is a desktop app for Microsoft 365 administrators. It
              runs on your computer. Your Microsoft 365 tenant data and the
              prompts sent to your local language model never leave your
              machine. The only data we knowingly receive is what you type
              into the waitlist form on this website.
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
            <h2 className="text-base font-semibold text-white">
              Who is responsible
            </h2>
            <p className="mt-3">
              OpenAdminOS is an open-source project published by OpenAdminOS.
              The source is at{" "}
              <Link
                href="https://github.com/OpenAdminOS/OpenAdminOS"
                target="_blank"
                rel="noreferrer"
                className="text-white underline underline-offset-4 transition hover:text-white/70"
              >
                github.com/OpenAdminOS/OpenAdminOS
              </Link>
              . You can reach the maintainer at{" "}
              <Link
                href="mailto:support@openadminos.com"
                className="text-white underline underline-offset-4 transition hover:text-white/70"
              >
                support@openadminos.com
              </Link>
              .
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-white">
              What the desktop app does on your computer
            </h2>
            <ul className="mt-3 list-disc space-y-3 pl-5 marker:text-white/30">
              <li>
                <span className="text-white">
                  Microsoft 365 authentication.
                </span>{" "}
                When you connect a tenant, the app signs you in to Microsoft
                using MSAL. Microsoft returns access and refresh tokens scoped
                to the Graph permissions you consented to. Those tokens are
                stored in your operating-system keychain (macOS Keychain,
                Windows Credential Manager) and used only by the local app to
                call Microsoft Graph. They are never transmitted to OpenAdminOS
                or OpenAdminOS.
              </li>
              <li>
                <span className="text-white">Microsoft Graph data.</span>{" "}
                Agents you run call Microsoft Graph on your behalf and process
                the returned data (devices, users, policies, etc.) in memory
                on your machine. Selected fields may be written to a local
                SQLite database for run history and audit purposes. This
                database is stored under your user profile and is never
                uploaded anywhere.
              </li>
              <li>
                <span className="text-white">
                  Language-model prompts (local provider).
                </span>{" "}
                When you select a local LLM provider such as Ollama or LM
                Studio, prompts and responses stay on your machine. OpenAdminOS
                does not see them.
              </li>
              <li>
                <span className="text-white">
                  Language-model prompts (hosted provider).
                </span>{" "}
                When you select Anthropic, OpenAI, or Azure OpenAI, prompts
                (which may contain tenant data) are sent over TLS to that
                provider, under their privacy policy and your account with
                them. The OpenAdminOS UI labels the selected provider and the
                region the API is hosted in. OpenAdminOS and OpenAdminOS do not
                receive a copy of these prompts.
              </li>
              <li>
                <span className="text-white">No telemetry.</span> The desktop
                app does not collect analytics, usage metrics, or
                error-reporting data. Crash logs stay on your machine.
              </li>
              <li>
                <span className="text-white">Auto-update.</span> The Microsoft
                Store handles updates on Windows. On macOS, the app checks
                GitHub Releases for a new version and downloads the signed
                installer. These checks send a standard HTTPS request to
                GitHub; refer to{" "}
                <Link
                  href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement"
                  target="_blank"
                  rel="noreferrer"
                  className="text-white underline underline-offset-4 transition hover:text-white/70"
                >
                  GitHub&rsquo;s privacy statement
                </Link>{" "}
                for what they log.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold text-white">
              What this website does
            </h2>
            <ul className="mt-3 list-disc space-y-3 pl-5 marker:text-white/30">
              <li>
                <span className="text-white">Waitlist signups.</span> If you
                enter your email on the homepage, that address is stored in
                our database (Supabase, hosted in the EU) and used only to
                contact you about the OpenAdminOS private preview. You can ask
                us to delete it at any time by emailing
                support@openadminos.com.
              </li>
              <li>
                <span className="text-white">Hosting and logs.</span> The site
                is deployed on Vercel. Vercel records standard server access
                logs (IP address, user-agent, timestamps) as a normal part of
                serving the site; see{" "}
                <Link
                  href="https://vercel.com/legal/privacy-policy"
                  target="_blank"
                  rel="noreferrer"
                  className="text-white underline underline-offset-4 transition hover:text-white/70"
                >
                  Vercel&rsquo;s privacy policy
                </Link>
                .
              </li>
              <li>
                <span className="text-white">No third-party analytics.</span>{" "}
                We do not use Google Analytics, advertising trackers, or
                third-party cookies.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold text-white">
              Your rights
            </h2>
            <p className="mt-3">
              If you are in the EU, UK, or another jurisdiction with similar
              data-protection laws, you have the right to request a copy of
              the personal data we hold about you, to correct it, or to have
              it deleted. Because the desktop app does not transmit anything
              to us, this in practice applies to your waitlist email and any
              support correspondence. Email support@openadminos.com and we will
              respond within 30 days.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-white">
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
          &copy; {new Date().getFullYear()}{" "}
          <Link
            href="https://openadminos.com"
            target="_blank"
            rel="noreferrer"
            className="underline-offset-4 transition hover:text-white/70 hover:underline"
          >
            OpenAdminOS
          </Link>
        </span>
      </footer>
    </div>
  );
}
