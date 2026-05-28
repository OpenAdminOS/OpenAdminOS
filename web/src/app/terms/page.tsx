import Link from "next/link";
import { type Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of use — OpenAdminOS",
  description:
    "The terms that govern your use of the OpenAdminOS desktop app and openadminos.com.",
};

const LAST_UPDATED = "2026-05-19";

export default function TermsPage() {
  return (
    <div className="relative flex min-h-screen flex-col bg-[#0a0a0c] text-white">
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
          Terms of use
        </h1>
        <p className="mt-2 text-sm text-white/50">
          Last updated: {LAST_UPDATED}
        </p>

        <div className="mt-10 space-y-10 text-sm leading-relaxed text-white/75">
          <section>
            <h2 className="text-base font-semibold text-white">Summary</h2>
            <p className="mt-3">
              OpenAdminOS is open-source software published by OpenAdminOS under
                the MIT License. These terms govern your use of the desktop
                app and the website at openadminos.com. By installing the app
                or using the site, you agree to them.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-white">
              The software is provided as-is
            </h2>
            <p className="mt-3">
              The desktop app is distributed under the MIT License, the full
              text of which is included with the source at{" "}
              <Link
                href="https://github.com/OpenAdminOS/OpenAdminOS/blob/main/LICENSE"
                target="_blank"
                rel="noreferrer"
                className="text-white underline underline-offset-4 transition hover:text-white/70"
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
            <h2 className="text-base font-semibold text-white">
              You are responsible for what you run
            </h2>
            <ul className="mt-3 list-disc space-y-3 pl-5 marker:text-white/30">
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
            <h2 className="text-base font-semibold text-white">
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
            <h2 className="text-base font-semibold text-white">
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
            <h2 className="text-base font-semibold text-white">
              Privacy
            </h2>
            <p className="mt-3">
              Use of the desktop app and website is also governed by the{" "}
              <Link
                href="/privacy"
                className="text-white underline underline-offset-4 transition hover:text-white/70"
              >
                privacy policy
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
              of the Microsoft group of companies. OpenAdminOS is not affiliated
              with, endorsed by, or sponsored by Microsoft. References to those
              services describe compatibility and administration targets only.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-white">
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
            <h2 className="text-base font-semibold text-white">
              Contact
            </h2>
            <p className="mt-3">
              Questions about these terms:{" "}
              <Link
                href="mailto:support@openadminos.com"
                className="text-white underline underline-offset-4 transition hover:text-white/70"
              >
                support@openadminos.com
              </Link>
              .
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
        </span>
      </footer>
    </div>
  );
}
