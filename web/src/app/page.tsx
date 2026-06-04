import Image from "next/image";
import { type Metadata } from "next";
import Link from "next/link";

import { DiffConfirmationDemo } from "./DiffConfirmationDemo";
import { MobileNav, type MobileNavItem } from "./MobileNav";
import { getLatestReleaseDownloads } from "./release-downloads";
import {
  DOCS_URL,
  GITHUB_URL,
  HOME_DESCRIPTION,
  HOME_TITLE,
  JsonLd,
  breadcrumbSchema,
  organizationSchema,
  pageMetadata,
  softwareApplicationSchema,
  webPageSchema,
  websiteSchema,
} from "./seo";

export const revalidate = 900;

export const metadata: Metadata = pageMetadata({
  title: HOME_TITLE,
  description: HOME_DESCRIPTION,
  path: "/",
  absoluteTitle: true,
});

const HOME_NAV_ITEMS: readonly MobileNavItem[] = [
  { href: "/registry", label: "Registry" },
  { href: "/trust-model", label: "Trust model" },
  { href: "/use-cases/intune", label: "Intune" },
  { href: DOCS_URL, label: "Documentation", external: true },
  { href: GITHUB_URL, label: "GitHub", external: true },
  { href: "/download", label: "Download", primary: true },
];

const TRUST_ITEMS = [
  {
    label: "Local models",
    detail: "Use Ollama today for private runs without per-token vendor costs.",
    command: "ollama serve",
  },
  {
    label: "Model choice",
    detail: "LM Studio is planned; hosted providers stay optional.",
    command: "localhost:1234",
  },
  {
    label: "Hosted providers",
    detail: "OpenAI, Anthropic, or Azure OpenAI are labeled before every run.",
    command: "explicit egress",
  },
  {
    label: "Tenant boundary",
    detail: "Local runs keep tenant data, prompts, and results on this device.",
    command: "no tenant telemetry",
  },
];

const USE_CASES = [
  {
    label: "Investigate",
    detail:
      "Correlate tenant signals across users, devices, sign-ins, policies, and audit logs.",
  },
  {
    label: "Explain",
    detail:
      "Turn Conditional Access, Secure Score, and posture data into admin-readable reasoning.",
  },
  {
    label: "Prioritize",
    detail:
      "Rank stale devices, risky accounts, policy gaps, and cleanup candidates by tenant context.",
  },
  {
    label: "Prepare changes",
    detail:
      "Generate reviewed write plans with evidence before anything touches the tenant.",
  },
];

const AGENTS = [
  {
    name: "Sign-in failure explainer",
    mode: "Read-only",
    scopes: "Declared permissions",
    description:
      "Clusters failed sign-ins by user, app, policy status, device context, and location.",
  },
  {
    name: "Secure Score prioritizer",
    mode: "Read-only",
    scopes: "Declared permissions",
    description:
      "Ranks security controls by effort, user impact, category, and max-score upside.",
  },
  {
    name: "Stale guest cleanup",
    mode: "Write",
    scopes: "Approval required",
    description:
      "Builds a capped disable plan for inactive guests with per-account rationale.",
  },
];

const PROOF_ITEMS = [
  ["MIT", "Commercial-friendly license"],
  ["Open runtime", "Agents, desktop app, registry, and SDK"],
  ["Forkable registry", "Point enterprises at their own curated agents"],
  ["No tenant telemetry", "Tenant content does not leave by default"],
];

const COMPARISON_ROWS = [
  {
    axis: "Local models",
    local: "Prompts and tenant context stay on the workstation.",
    hosted: "Optional hosted providers are labeled before tenant context is sent.",
  },
  {
    axis: "Read-only agents",
    local: "Run investigations and reports without changing tenant state.",
    hosted: "Use the same read-only contract, with hosted model egress disclosed.",
  },
  {
    axis: "Write agents",
    local: "Prepare a Graph change diff and wait for approval.",
    hosted: "Still require the same diff and typed confirmation gates.",
  },
  {
    axis: "Agent registry",
    local: "Install from the public open registry or point to a private registry.",
    hosted: "Registry choice does not change the write-confirmation contract.",
  },
];

const COMMON_QUESTIONS = [
  {
    question: "What is OpenAdminOS?",
    answer:
      "OpenAdminOS is a local-first agent runtime and open-source desktop app for Microsoft 365, Intune, and Entra administrators. It connects to a tenant through MSAL, reads tenant data through Microsoft Graph, and runs declared agent workflows from the admin's machine. Local LLM providers keep prompts and tenant context on-device; hosted providers remain optional and are labeled before data leaves the workstation.",
  },
  {
    question: "Does OpenAdminOS send Microsoft 365 tenant data to the cloud?",
    answer:
      "Not when a local provider is selected. With Ollama or another local provider, tenant data, prompts, and run results stay on the device. If an admin chooses a hosted provider such as OpenAI, Anthropic, or Azure OpenAI, the app labels that tenant context will be sent to that provider.",
  },
  {
    question: "Which Microsoft 365 services does it work with?",
    answer:
      "The product is built around Microsoft Graph and initially focuses on Intune and Entra administration: devices, users, groups, sign-ins, Conditional Access, compliance posture, app assignments, audit logs, and related tenant signals.",
  },
  {
    question: "What Microsoft Graph permissions do agents need?",
    answer:
      "Each agent declares its required Graph scopes in its manifest. OpenAdminOS shows those scopes before install and before consent, so admins can see what an agent can read or propose changing before it runs.",
  },
  {
    question: "What happens before a write agent changes my tenant?",
    answer:
      "Write agents always pause at a diff confirmation screen. Destructive operations require typed confirmation. There is no trust-this-agent bypass and no skip toggle for write operations.",
  },
  {
    question: "Can I use a private agent registry?",
    answer:
      "Yes. Enterprises can point OpenAdminOS at their own curated registry instead of using only the public community registry. Agents still use the same manifest, scope declaration, and write-confirmation rules.",
  },
  {
    question: "Which LLM providers are supported?",
    answer:
      "Ollama is the local provider path available today. LM Studio is planned. Hosted providers such as OpenAI, Anthropic, and Azure OpenAI are optional and are treated as a different trust boundary in the UI.",
  },
  {
    question: "Is OpenAdminOS affiliated with Microsoft?",
    answer:
      "No. OpenAdminOS is an independent open-source project. Microsoft 365, Intune, Entra, and Microsoft Graph are Microsoft trademarks and are referenced only to describe compatibility and administration targets.",
  },
];

export default async function HomePage() {
  const latestRelease = await getLatestReleaseDownloads();
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      organizationSchema(),
      websiteSchema(),
      softwareApplicationSchema({
        version: latestRelease.version,
        downloadUrl: latestRelease.releaseNotesUrl,
        operatingSystem: "macOS, Linux",
      }),
      webPageSchema({
        path: "/",
        name: HOME_TITLE,
        description: HOME_DESCRIPTION,
        dateModified: "2026-06-04",
      }),
      breadcrumbSchema([{ name: "Home", path: "/" }]),
    ],
  };

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-[#070709] text-white">
      <JsonLd data={structuredData} />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-[size:72px_72px] [mask-image:linear-gradient(to_bottom,black,transparent_78%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/30 to-transparent"
      />
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-[#070709]"
      >
        Skip to content
      </a>

      <header className="relative z-30 mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-6 sm:px-10">
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
        <nav className="hidden items-center gap-6 text-sm text-white/55 md:flex">
          {HOME_NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              target={item.external ? "_blank" : undefined}
              rel={item.external ? "noreferrer" : undefined}
              className={
                item.primary
                  ? "rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-[#070709] transition hover:bg-white/90"
                  : "transition hover:text-white"
              }
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <MobileNav items={HOME_NAV_ITEMS} />
      </header>

      <main
        id="main-content"
        tabIndex={-1}
        className="relative z-10 flex flex-1 flex-col items-center px-6 sm:px-10"
      >
        <section className="flex flex-col items-center pt-10 text-center sm:pt-14">
          <Link
            href={latestRelease.releaseNotesUrl}
            target="_blank"
            rel="noreferrer"
            className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium uppercase tracking-wider text-white/70 transition hover:border-white/20 hover:text-white"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {latestRelease.version} — release notes
          </Link>

          <h1 className="max-w-4xl text-balance text-5xl font-semibold tracking-tight sm:text-7xl">
            AI agents for Microsoft 365 admins that run from your own machine.
          </h1>

          <p className="mt-5 max-w-2xl text-balance text-base leading-7 text-white/60 sm:text-lg">
            Keep sensitive work local, avoid per-token costs with local models,
            and approve every change before it happens. Use agents to
            investigate tenant issues, explain policy behavior, and prepare
            changes.
          </p>

          <div className="mt-8 grid w-full max-w-3xl gap-3 md:grid-cols-3">
            <div className="flex min-w-0 flex-col items-stretch gap-1.5">
              <a
                href={latestRelease.macosDmgUrl}
                className="inline-flex h-11 w-full items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-white px-4 text-sm font-semibold text-[#0a0a0c] shadow-[0_8px_30px_-4px_rgba(255,255,255,0.25)] transition hover:bg-white/90"
              >
                <svg
                  aria-hidden
                  viewBox="0 0 384 512"
                  className="h-4 w-4 fill-current"
                >
                  <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zM256.6 105.8c30.3-36 27.6-68.8 26.7-80.6-26.8 1.6-57.8 18.3-75.5 38.8-19.5 22-31 49.2-28.5 80 29 2.2 55.5-12.7 77.3-38.2z" />
                </svg>
                Download for macOS
              </a>
              <p className="min-h-4 text-center text-[11px] leading-4 text-white/38">
                DMG direct download. PKG on the download page.
              </p>
            </div>
            <div className="flex min-w-0 flex-col items-stretch gap-1.5">
              <a
                href={latestRelease.linuxAppImageUrl}
                className="inline-flex h-11 w-full items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-white px-4 text-sm font-semibold text-[#0a0a0c] shadow-[0_8px_30px_-4px_rgba(255,255,255,0.25)] transition hover:bg-white/90"
              >
                <img
                  src="/linux.svg"
                  alt=""
                  aria-hidden
                  width={16}
                  height={16}
                  className="h-4 w-4"
                />
                Download for Linux
              </a>
              <Link
                href="/download#linux-packages"
                className="min-h-4 text-center text-[11px] leading-4 text-white/38 underline-offset-4 transition hover:text-white/70 hover:underline"
              >
                AppImage direct. DEB/RPM available.
              </Link>
            </div>
            <div className="flex min-w-0 flex-col items-stretch gap-1.5">
              <div
                aria-describedby="windows-download-status"
                className="inline-flex h-11 w-full cursor-default items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-white/10 bg-white/[0.03] px-4 text-sm font-medium text-white/40"
              >
                <svg
                  aria-hidden
                  viewBox="0 0 448 512"
                  className="h-4 w-4 fill-current"
                >
                  <path d="M0 93.7l183.6-25.3v177.4H0V93.7zm0 324.6l183.6 25.3V268.4H0v149.9zm203.8 28L448 480V268.4H203.8v177.9zm0-380.6v180.1H448V32L203.8 65.7z" />
                </svg>
                Download for Windows
                <span className="ml-1 text-[10px] font-normal uppercase tracking-wider text-white/30">
                  Soon
                </span>
              </div>
              <p
                id="windows-download-status"
                className="min-h-4 text-center text-[11px] leading-4 text-white/35"
              >
                Pending signing.
              </p>
            </div>
          </div>

          <p className="mt-3 text-[11.5px] text-white/40">
            Free and open-source. MIT licensed.{" "}
            <Link
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="underline-offset-4 hover:text-white/70 hover:underline"
            >
              github.com/OpenAdminOS/OpenAdminOS
            </Link>
          </p>
        </section>

        <section className="mt-12 w-full max-w-[88rem] sm:mt-16">
          <Image
            src="/openadminos-app.png"
            alt="OpenAdminOS app showing Microsoft 365 agent runs"
            width={2400}
            height={1500}
            priority
            sizes="(min-width: 1408px) 1408px, 100vw"
            className="h-auto w-full drop-shadow-[0_40px_120px_rgba(140,140,255,0.18)]"
          />
        </section>

        <section className="w-full max-w-7xl py-20">
          <div className="grid gap-8 lg:grid-cols-[0.85fr_1.15fr] lg:items-start">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/45">
                Admin work
              </p>
              <h2 className="mt-3 max-w-xl text-3xl font-semibold tracking-tight sm:text-4xl">
                Agents for the work scripts do not explain.
              </h2>
              <p className="mt-4 max-w-xl text-sm leading-6 text-white/60 sm:text-base">
                OpenAdminOS agents read Microsoft 365 tenant data, shape the
                evidence, use the selected model for reasoning, and return work
                an admin can inspect before acting.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {USE_CASES.map((item) => (
                <div
                  key={item.label}
                  className="rounded-lg border border-white/10 bg-white/[0.03] p-4"
                >
                  <h3 className="text-sm font-semibold">{item.label}</h3>
                  <p className="mt-2 text-sm leading-6 text-white/55">
                    {item.detail}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="grid w-full max-w-7xl gap-5 border-t border-white/10 py-20 md:grid-cols-[0.95fr_1.05fr] md:items-start">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300/80">
              Local-first by default
            </p>
            <h2 className="mt-3 max-w-xl text-3xl font-semibold tracking-tight sm:text-4xl">
              Run repeatable tenant work locally.
            </h2>
            <p className="mt-4 max-w-xl text-sm leading-6 text-white/60 sm:text-base">
              Use local models for drafts, investigations, scheduled checks,
              and agent runs without a per-token meter. If you choose a hosted
              model, the app says so before tenant data is sent.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {TRUST_ITEMS.map((item) => (
              <div
                key={item.label}
                className="rounded-lg border border-white/10 bg-white/[0.035] p-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold">{item.label}</h3>
                  <code className="rounded border border-white/10 bg-black/35 px-2 py-1 font-mono text-[11px] text-white/50">
                    {item.command}
                  </code>
                </div>
                <p className="mt-3 text-sm leading-6 text-white/55">
                  {item.detail}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="w-full max-w-7xl border-t border-white/10 py-20">
          <div className="grid gap-8 lg:grid-cols-[0.85fr_1.15fr] lg:items-start">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/45">
                Operating modes
              </p>
              <h2 className="mt-3 max-w-xl text-3xl font-semibold tracking-tight sm:text-4xl">
                The data boundary changes by mode.
              </h2>
              <p className="mt-4 max-w-xl text-sm leading-6 text-white/60 sm:text-base">
                Local and hosted model choices are not treated as cosmetic
                settings. Read-only and write agents also have different
                confirmation paths.
              </p>
            </div>
            <div className="overflow-hidden rounded-xl border border-white/10 bg-[#0d0e12]">
              <div className="hidden grid-cols-[0.75fr_1fr_1fr] gap-3 border-b border-white/10 px-4 py-3 font-mono text-[11px] uppercase tracking-wider text-white/40 md:grid">
                <span>Mode</span>
                <span>Local-first path</span>
                <span>Hosted or write path</span>
              </div>
              {COMPARISON_ROWS.map((row) => (
                <div
                  key={row.axis}
                  className="grid gap-3 border-b border-white/10 px-4 py-4 text-sm last:border-b-0 md:grid-cols-[0.75fr_1fr_1fr]"
                >
                  <h3 className="font-semibold text-white/90">{row.axis}</h3>
                  <p className="leading-6 text-white/55">
                    <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-white/35 md:hidden">
                      Local-first path
                    </span>
                    {row.local}
                  </p>
                  <p className="leading-6 text-white/55">
                    <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-white/35 md:hidden">
                      Hosted or write path
                    </span>
                    {row.hosted}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section
          id="agents"
          className="w-full max-w-7xl border-y border-white/10 py-20"
        >
          <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-300/80">
                Agent registry
              </p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                Agents that investigate, explain, and prepare work.
              </h2>
              <p className="mt-4 text-sm leading-6 text-white/60 sm:text-base">
                Agents install from an open registry and can be inspected before
                use. Each one declares what it can access, whether it can
                propose changes, and which model requirements it has.
              </p>
              <Link
                href="/registry"
                className="mt-5 inline-flex text-sm font-medium text-sky-200 underline-offset-4 transition hover:text-white hover:underline"
              >
                Read how the registry works
              </Link>
            </div>

            <div className="overflow-hidden rounded-xl border border-white/10 bg-[#0d0e12]">
              <div className="hidden grid-cols-[minmax(0,1fr)_96px_minmax(260px,320px)] gap-3 border-b border-white/10 px-4 py-3 font-mono text-[11px] uppercase tracking-wider text-white/40 md:grid">
                <span>Agent</span>
                <span>Mode</span>
                <span>Trust</span>
              </div>
              {AGENTS.map((agent) => (
                <div
                  key={agent.name}
                  className="grid gap-3 border-b border-white/10 px-4 py-4 last:border-b-0 md:grid-cols-[minmax(0,1fr)_96px_minmax(260px,320px)]"
                >
                  <div>
                    <h3 className="text-sm font-semibold text-white/90">
                      {agent.name}
                    </h3>
                    <p className="mt-1 text-sm leading-6 text-white/50">
                      {agent.description}
                    </p>
                  </div>
                  <div>
                    <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-white/35 md:hidden">
                      Mode
                    </span>
                    <span
                      className={`inline-flex h-fit rounded-md border px-2 py-1 text-xs font-medium ${
                        agent.mode === "Write"
                          ? "border-amber-300/25 bg-amber-300/10 text-amber-200"
                          : "border-emerald-300/20 bg-emerald-300/10 text-emerald-200"
                      }`}
                    >
                      {agent.mode}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-white/35 md:hidden">
                      Trust
                    </span>
                    <code className="break-all font-mono text-xs leading-5 text-white/50">
                      {agent.scopes}
                    </code>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="grid w-full max-w-7xl gap-6 border-t border-white/10 py-20 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-300/80">
              Graph permissions
            </p>
            <h2 className="mt-3 max-w-xl text-3xl font-semibold tracking-tight sm:text-4xl">
              Agents declare the Microsoft Graph scopes they need.
            </h2>
            <p className="mt-4 max-w-xl text-sm leading-6 text-white/60 sm:text-base">
              OpenAdminOS uses{" "}
              <Link
                href="https://learn.microsoft.com/en-us/entra/identity-platform/msal-overview"
                target="_blank"
                rel="noreferrer"
                className="text-white underline underline-offset-4 transition hover:text-white/70"
              >
                MSAL
              </Link>{" "}
              for Microsoft identity sign-in and Microsoft Graph for tenant
              data. Consent is tied to the scopes declared by the agents an admin
              chooses to run.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
              <h3 className="text-sm font-semibold">Before install</h3>
              <p className="mt-3 text-sm leading-6 text-white/55">
                The agent manifest lists required Graph scopes, read/write mode,
                model requirements, settings, and connector egress before the
                agent is installed.
              </p>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
              <h3 className="text-sm font-semibold">Before run</h3>
              <p className="mt-3 text-sm leading-6 text-white/55">
                If the active tenant is missing, expired, or ambiguous, the run
                cannot start. If a write plan is produced, the diff gate appears
                before any tenant change.
              </p>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
              <h3 className="text-sm font-semibold">For private registries</h3>
              <p className="mt-3 text-sm leading-6 text-white/55">
                Internal registries use the same scope declaration and
                confirmation rules as public registry agents. The source changes;
                the trust contract does not.
              </p>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
              <h3 className="text-sm font-semibold">For hosted models</h3>
              <p className="mt-3 text-sm leading-6 text-white/55">
                Graph data selected for the prompt is labeled as egress before it
                is sent to a hosted provider. Local providers keep that prompt on
                the workstation.
              </p>
            </div>
          </div>
        </section>

        <section
          id="safety"
          className="grid w-full max-w-7xl gap-8 py-20 lg:grid-cols-[1fr_1fr] lg:items-center"
        >
          <DiffConfirmationDemo />

          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-300/80">
              Human in the loop
            </p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
              Changes wait for your approval.
            </h2>
            <p className="mt-4 text-sm leading-6 text-white/60 sm:text-base">
              Read-only agents can run autonomously. Any change shows a diff
              first, and destructive actions require typed confirmation. There
              is no trust-this-agent bypass.
            </p>
            <Link
              href="/trust-model"
              className="mt-5 inline-flex text-sm font-medium text-amber-200 underline-offset-4 transition hover:text-white hover:underline"
            >
              Review the trust model
            </Link>
          </div>
        </section>

        <section className="w-full max-w-7xl border-t border-white/10 py-20">
          <div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/45">
                Open source
              </p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                No vendor-owned agent runtime.
              </h2>
              <p className="mt-4 text-sm leading-6 text-white/60 sm:text-base">
                The app, runtime, agents, and registry contract are open from
                day one. Audit them, change them, or point OpenAdminOS at your
                own curated registry.
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/35 p-4 font-mono text-sm text-white/60">
              <p className="text-white/35">~/code</p>
              <p className="mt-3">$ gh repo fork OpenAdminOS/OpenAdminOS --clone</p>
              <p className="text-emerald-300/80">✓ Cloned OpenAdminOS</p>
              <p className="mt-3">$ pnpm install</p>
              <p className="text-emerald-300/80">✓ workspace ready</p>
              <p className="mt-3">$ pnpm dev</p>
              <p className="text-sky-300/80">OpenAdminOS desktop app started</p>
            </div>
          </div>
          <div className="mt-8 grid gap-3 sm:grid-cols-4">
            {PROOF_ITEMS.map(([label, detail]) => (
              <div
                key={label}
                className="rounded-lg border border-white/10 bg-white/[0.03] p-4"
              >
                <p className="text-sm font-semibold">{label}</p>
                <p className="mt-2 text-sm leading-5 text-white/50">{detail}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="w-full max-w-7xl border-t border-white/10 py-20">
          <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/45">
                Common questions
              </p>
              <h2 className="mt-3 max-w-xl text-3xl font-semibold tracking-tight sm:text-4xl">
                Questions admins usually ask first.
              </h2>
              <p className="mt-4 max-w-xl text-sm leading-6 text-white/60 sm:text-base">
                These answers summarize the product boundary: desktop app,
                Microsoft Graph, local-first model choice, declared agent
                permissions, and write confirmation.
              </p>
            </div>
            <div className="grid gap-3">
              {COMMON_QUESTIONS.map((item, index) => (
                <details
                  key={item.question}
                  open={index === 0}
                  className="group rounded-lg border border-white/10 bg-white/[0.035] transition hover:border-white/18"
                >
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-4 text-left [&::-webkit-details-marker]:hidden">
                    <span className="text-base font-semibold tracking-tight text-white/92">
                      {item.question}
                    </span>
                    <span
                      aria-hidden="true"
                      className="grid size-7 shrink-0 place-items-center rounded-md border border-white/10 text-lg leading-none text-white/48 transition group-open:rotate-45 group-open:border-white/20 group-open:text-white/72"
                    >
                      +
                    </span>
                  </summary>
                  <p className="px-4 pb-4 text-sm leading-6 text-white/58">
                    {item.answer}
                  </p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="w-full max-w-4xl pb-20 pt-4 text-center">
          <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
            Run tenant agents on your terms.
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-sm leading-6 text-white/60 sm:text-base">
            Use local models when privacy, repeatability, or cost matters. Use
            hosted models when you choose to. Either way, OpenAdminOS keeps
            tenant work inspectable and changes gated.
          </p>
          <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/download"
              className="rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-[#070709] transition hover:bg-white/90"
            >
              View downloads
            </Link>
            <Link
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-white/10 bg-white/[0.03] px-5 py-2.5 text-sm font-medium text-white/72 transition hover:border-white/20 hover:text-white"
            >
              Star on GitHub
            </Link>
          </div>
        </section>
      </main>

      <footer className="relative z-10 flex flex-col items-center gap-2 px-6 py-8 text-center sm:px-10">
        <span className="text-xs text-white/40">
          © {new Date().getFullYear()} OpenAdminOS
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
          {" · "}
          <Link
            href="/registry"
            className="underline-offset-4 transition hover:text-white/70 hover:underline"
          >
            Registry
          </Link>
          {" · "}
          <Link
            href="/trust-model"
            className="underline-offset-4 transition hover:text-white/70 hover:underline"
          >
            Trust model
          </Link>
          {" · "}
          <Link
            href="/download"
            className="underline-offset-4 transition hover:text-white/70 hover:underline"
          >
            Download
          </Link>
          {" · "}
          <Link
            href="https://www.linkedin.com/company/openadminos/"
            target="_blank"
            rel="noreferrer"
            aria-label="OpenAdminOS on LinkedIn"
            className="inline-flex align-[-2px] text-white/45 transition hover:text-white/75"
          >
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              className="h-3.5 w-3.5 fill-current"
            >
              <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.95v5.66H9.34V9h3.42v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.32 7.43a2.07 2.07 0 1 1 0-4.14 2.07 2.07 0 0 1 0 4.14Zm1.78 13.02H3.53V9H7.1v11.45ZM22.23 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.46c.98 0 1.77-.77 1.77-1.72V1.72C24 .77 23.21 0 22.23 0Z" />
            </svg>
          </Link>
        </span>
        <p className="max-w-2xl text-balance text-[11px] leading-5 text-white/30">
          Microsoft 365, Intune, Entra, and Microsoft Graph are trademarks of
          the Microsoft group of companies. OpenAdminOS is not affiliated with,
          endorsed by, or sponsored by Microsoft.
        </p>
      </footer>
    </div>
  );
}
