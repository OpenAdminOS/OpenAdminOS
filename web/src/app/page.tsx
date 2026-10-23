import { type Metadata } from "next";
import Link from "next/link";

import {
  benchmarkData as benchmarks,
  leadOverHosted,
  ownModel,
  rankedModels,
} from "~/lib/benchmarks/data";
import { getAgentStatsSummary } from "~/lib/stats/summary";

import { getGitHubDownloadCount } from "./github-downloads";
import { getRecentReleases } from "./github-releases";
import { getGitHubRepoStats } from "./github-repo";
import { REGISTRY_AGENTS } from "./home/agents";
import { BRAND_MARKS } from "./home/brandMarks";
import { AppWindow } from "./home/AppWindow";
import { DownloadCta } from "./home/DownloadCta";
import { FigureApproval, FigureEvidence, FigureLocal } from "./home/Figures";
import { LockIcon } from "./home/icons";
import { ProductTour, type TourItem } from "./home/ProductTour";
import { Stage } from "./home/Stage";
import { MarketingShell } from "./MarketingShell";
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
import { buttonSecondary, eyebrow, sectionTitle } from "./ui";

export const revalidate = 900;

export const metadata: Metadata = pageMetadata({
  title: HOME_TITLE,
  description: HOME_DESCRIPTION,
  path: "/",
  absoluteTitle: true,
});

const benchmarkTiles = rankedModels();
const benchmarkLead = leadOverHosted();

// Hover tints use each company's brand color. Black-and-white brands use the
// page ink so they tint neutrally in light and dark.
const WORKS_WITH: readonly { name: string; color: string }[] = [
  { name: "Microsoft Graph", color: "#0078D4" },
  { name: "Intune", color: "#28A8EA" },
  { name: "Entra ID", color: "#4F6BED" },
  { name: "Ollama", color: "var(--color-brand-ink)" },
  { name: "LM Studio", color: "var(--color-brand-ink)" },
  { name: "Apple Foundation", color: "#8E8E93" },
  { name: "Claude Code", color: "#D97757" },
  { name: "OpenAI Codex", color: "#10A37F" },
  { name: "GitHub Copilot", color: "#8534F3" },
  { name: "Azure OpenAI", color: "#0089D6" },
];

const FIGURES = [
  {
    fig: "FIG 0.1",
    title: "Local by default",
    text: "Pick a local model and tenant data, prompts, and answers stay on this machine. Choose a hosted one and the app says so first.",
    Figure: FigureLocal,
  },
  {
    fig: "FIG 0.2",
    title: "Evidence with every answer",
    text: "Answers open with the tenant, the Graph sources they read, and how old the data is. Claims carry numbered citations.",
    Figure: FigureEvidence,
  },
  {
    fig: "FIG 0.3",
    title: "Nothing changes unsigned",
    text: "Write agents stop at a diff. Destructive changes stay disabled until you type the exact phrase.",
    Figure: FigureApproval,
  },
] as const;

const TOUR: readonly TourItem[] = [
  {
    id: "chat",
    title: "Chat",
    text: "Ask about the tenant in plain language. Each answer states its scope and data age, cites the Graph sources it used, and suggests an installed agent when one fits.",
    screen: "chat-transcript",
    alt: "Chat answer about stale devices with tenant scope, data age, and two numbered Microsoft Graph sources",
    tone: "sage",
  },
  {
    id: "agents",
    title: "Agents",
    text: "Browse the registry inside the app. Every agent shows whether it reads or makes changes, the Graph permissions it needs, and when it last ran.",
    screen: "hub-grid",
    alt: "Agents page listing registry agents marked read-only or makes changes",
    tone: "sand",
    link: { href: "/registry", label: "How the registry works" },
  },
  {
    id: "team",
    title: "Agent Team",
    text: "Give a teammate a role, a tenant, a provider, and up to eight installed agents. Run it once or on a schedule; every result links back to the run that produced it.",
    screen: "agent-team",
    alt: "Agent Team page with the office view and assignment history",
    tone: "slate",
  },
  {
    id: "changes",
    title: "Write confirmation",
    text: "A write agent prepares a plan and stops. You see each Microsoft Graph call and what it touches, then type the phrase to apply it.",
    screen: "write-confirmation",
    alt: "Write confirmation for the Offboarding agent listing two device retirements and a typed phrase field",
    tone: "clay",
    link: { href: "/trust-model", label: "Read the trust model" },
  },
  {
    id: "models",
    title: "Models",
    text: "Run Ollama, LM Studio, or Apple Foundation locally, or use a hosted provider through its own CLI or Azure OpenAI. Each is marked Local or Hosted.",
    screen: "settings",
    alt: "Provider settings with local and hosted model providers",
    tone: "sage",
    link: { href: "/llm-providers", label: "Compare model providers" },
  },
];

const DATA_ROWS = [
  {
    label: "Prompts and tenant context",
    local: "Stay on this device",
    hosted: "Sent to the provider you selected",
  },
  {
    label: "Graph cache and run history",
    local: "Stored on this device",
    hosted: "Stored on this device",
  },
  {
    label: "Tenant tokens",
    local: "Encrypted in the OS keychain",
    hosted: "Encrypted in the OS keychain",
  },
  {
    label: "Tenant changes",
    local: "Only after diff review",
    hosted: "Only after diff review",
  },
  {
    label: "Collected by OpenAdminOS",
    local: "No tenant data, prompts, or results",
    hosted: "No tenant data, prompts, or results",
  },
] as const;

const GUARANTEES = [
  ["01", "No tenant telemetry", "Tenant data, prompts, run results, and error reports are never collected."],
  ["02", "No agent without a tenant", "Nothing runs until an active tenant is connected and shown in the title bar."],
  ["03", "No write without review", "No skip toggle and no trust-this-agent exception, for any agent."],
  ["04", "Open source, MIT", "Read the code that touches your tenant before you connect it."],
] as const;

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
      "Each agent declares its required Graph scopes in its manifest. OpenAdminOS shows those scopes before install and before consent, so admins can see what an agent can read or propose changing before it runs. Enterprises can point the app at a private registry; the same scope declaration and write-confirmation rules still apply.",
  },
  {
    question: "What happens before a write agent changes my tenant?",
    answer:
      "Write agents always pause at a diff confirmation screen. Destructive operations require typed confirmation. There is no trust-this-agent bypass and no skip toggle for write operations.",
  },
  {
    question: "Is OpenAdminOS affiliated with Microsoft?",
    answer:
      "No. OpenAdminOS is an independent open-source project. Microsoft 365, Intune, Entra, and Microsoft Graph are Microsoft trademarks and are referenced only to describe compatibility and administration targets.",
  },
];

const TESTIMONIAL = {
  name: "Merill Fernando",
  role: "Founder at Jozra",
  href: "https://www.linkedin.com/in/merill/",
  image: "/testimonials/merill-fernando.jpg",
  quote:
    "I'm a huge fan of OpenAdminOS. It's the first tool that let me use local AI with 100% privacy to manage my tenants.",
} as const;

const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function formatStat(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

export default async function HomePage() {
  const [latestRelease, githubRepoStats, agentStatsSummary, downloadCount, releases] =
    await Promise.all([
      getLatestReleaseDownloads(),
      getGitHubRepoStats(),
      getAgentStatsSummary(),
      getGitHubDownloadCount(),
      getRecentReleases(4),
    ]);
  // Live numbers only. A source that is unavailable is left out, never faked.
  const stats = [
    ...(githubRepoStats
      ? [{ value: formatStat(githubRepoStats.stars), label: "GitHub stars" }]
      : []),
    ...(downloadCount !== null
      ? [{ value: formatStat(downloadCount), label: "Downloads" }]
      : []),
    ...(agentStatsSummary
      ? [{ value: formatStat(agentStatsSummary.agentCount), label: "Registry agents" }]
      : []),
    { value: "MIT", label: "License" },
  ];
  const downloadUrls = {
    macos: latestRelease.macosDmgUrl,
    windows: latestRelease.windowsExeUrl,
    linux: latestRelease.linuxAppImageUrl,
  };
  const latestNote = releases.find((release) => release.version === latestRelease.version);
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      organizationSchema(),
      websiteSchema(),
      softwareApplicationSchema({
        version: latestRelease.version,
        downloadUrl: latestRelease.releaseNotesUrl,
        operatingSystem: "Windows, macOS, Linux",
      }),
      webPageSchema({
        path: "/",
        name: HOME_TITLE,
        description: HOME_DESCRIPTION,
      }),
      breadcrumbSchema([{ name: "Home", path: "/" }]),
    ],
  };

  return (
    <MarketingShell
      bare
      announcement={{
        href: latestRelease.releaseNotesUrl,
        label: latestNote?.summary
          ? `${latestRelease.version}: ${latestNote.summary}`
          : `${latestRelease.version} is out`,
      }}
    >
      <JsonLd data={structuredData} />

      {/* Hero */}
      <section className="mx-auto w-full max-w-7xl px-6 pt-14 sm:px-10 sm:pt-20">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:items-end lg:gap-16">
          <h1 className="font-display text-balance text-[2.9rem] leading-[1.02] sm:text-[4.4rem] lg:text-[4.9rem]">
            Agents for your Microsoft 365 tenant, on your own machine.
          </h1>
          <div className="lg:pb-3">
            <p className="text-pretty text-lg leading-8 text-brand-muted">
              OpenAdminOS is an open-source desktop app for Intune and Entra
              admins. Ask your tenant questions, run agents from an open
              registry, and approve every change before it reaches Microsoft
              Graph.
            </p>
            <DownloadCta urls={downloadUrls} className="mt-7" />
          </div>
        </div>
      </section>

      <section className="mx-auto mt-12 w-full max-w-[96rem] px-3 sm:mt-16 sm:px-6">
        <Stage
          tone="sand"
          className="overflow-hidden rounded-[18px] px-4 pb-0 pt-8 sm:rounded-[24px] sm:px-12 sm:pt-16 lg:px-24 lg:pt-20"
        >
          <div className="relative mx-auto max-w-6xl">
            <AppWindow
              screen="chat-transcript"
              alt="OpenAdminOS Chat answer with tenant scope, data age, and two numbered Microsoft Graph sources"
              crop={{ x: 700, y: 60, width: 790, aspect: "4 / 3.6" }}
              className="rounded-b-none sm:hidden"
            />
            <AppWindow
              screen="chat-transcript"
              alt="OpenAdminOS Chat answering which managed devices have not synced in the last 7 days, with tenant scope, data age, two Microsoft Graph sources, and a local Ollama model"
              priority
              className="hidden rounded-b-none sm:block"
            />
            <div className="pointer-events-none absolute -left-10 top-[28%] hidden w-72 rounded-[14px] bg-brand-raised p-4 shadow-(--shadow-pop) lg:block">
              <p className="flex items-center gap-1.5 text-xs text-brand-ok">
                <LockIcon />
                Local · Ollama
              </p>
              <p className="mt-2 text-sm leading-6">
                Local model. Tenant data stays on this device.
              </p>
            </div>
            <div className="pointer-events-none absolute -right-10 top-[58%] hidden w-80 rounded-[14px] bg-brand-raised p-4 shadow-(--shadow-pop) lg:block">
              <p className="flex items-center gap-1.5 text-xs text-brand-warn">
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                Awaiting confirmation
              </p>
              <p className="mt-2 text-sm font-medium">Offboarding agent</p>
              <p className="text-sm leading-6 text-brand-muted">
                Retire two stale Windows devices. Type{" "}
                <code className="rounded bg-brand-code px-1 text-[12px] text-brand-ink">
                  RETIRE 2 DEVICES
                </code>{" "}
                to apply.
              </p>
            </div>
          </div>
        </Stage>
      </section>

      {/* Works with */}
      <section className="mx-auto w-full max-w-7xl px-6 pt-16 sm:px-10">
        <p className="text-center text-sm text-brand-faint">
          Works with the tenant and the models you already use
        </p>
        <ul className="mt-6 grid grid-cols-2 border-l border-t border-brand-line sm:grid-cols-5">
          {WORKS_WITH.map(({ name, color }) => {
            const mark = BRAND_MARKS[name];
            return (
              <li
                key={name}
                style={{ ["--brand" as string]: color }}
                className="brand-cell flex h-16 items-center justify-center gap-2.5 border-b border-r border-brand-line px-3 text-center text-[15px] text-brand-muted"
              >
                {mark ? (
                  <svg
                    aria-hidden
                    viewBox="0 0 24 24"
                    className="h-5 w-5 shrink-0 fill-current text-brand-ink"
                  >
                    <path d={mark} />
                  </svg>
                ) : null}
                {name}
              </li>
            );
          })}
        </ul>
      </section>

      {/* Lead + figures */}
      <section className="mx-auto w-full max-w-7xl px-6 py-24 sm:px-10 sm:py-32">
        <p
          data-reveal
          className="font-display lead-two-tone max-w-5xl text-balance text-[1.9rem] leading-[1.2] sm:text-[2.6rem]"
        >
          <strong>Local-first agents for Microsoft 365.</strong> Questions,
          scheduled checks, and reviewed changes, run from the admin&apos;s own
          machine against the tenant they picked.
        </p>
        <div className="mt-16 grid gap-px overflow-hidden rounded-[18px] border border-brand-line bg-brand-line md:grid-cols-3">
          {FIGURES.map(({ fig, title, text, Figure }) => (
            <article key={fig} data-reveal className="flex flex-col bg-brand-bg p-8">
              <p className="font-mono text-xs text-brand-faint">{fig}</p>
              <div className="my-8 text-brand-ink">
                <Figure />
              </div>
              <h2 className="font-display text-[1.6rem] leading-tight">{title}</h2>
              <p className="mt-2 text-[15px] leading-7 text-brand-muted">{text}</p>
            </article>
          ))}
        </div>
      </section>

      {/* Product tour */}
      <section className="border-t border-brand-line">
        <div className="mx-auto w-full max-w-7xl px-6 py-24 sm:px-10 sm:py-32">
          <h2 data-reveal className={`${sectionTitle} max-w-3xl`}>
            One app, from the first question to the reviewed change.
          </h2>
          <div className="mt-14">
            <ProductTour items={TOUR} />
          </div>
        </div>
      </section>

      {/* Security */}
      <section id="security" className="band-ink scroll-mt-16">
        <div className="mx-auto w-full max-w-7xl px-6 py-24 sm:px-10 sm:py-32">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:items-end">
            <div data-reveal>
              <p className={eyebrow}>Security</p>
              <h2 className="font-display mt-4 text-balance text-[2.5rem] leading-[1.03] sm:text-[4rem]">
                Your tenant stays on your machine.
              </h2>
            </div>
            <p data-reveal className="text-lg leading-8 text-brand-muted">
              The model you pick decides where prompts go. The app says which
              before tenant context is sent, and names the provider rather
              than guessing at a region.
            </p>
          </div>

          <dl data-reveal className="mt-12 divide-y divide-brand-line border-y border-brand-line md:hidden">
            {DATA_ROWS.map((row) => (
              <div key={row.label} className="py-4">
                <dt className="text-sm text-brand-faint">{row.label}</dt>
                <dd className="mt-2 grid grid-cols-2 gap-4 text-[15px]">
                  <span>
                    <span className="block text-xs text-brand-ok">Local model</span>
                    {row.local}
                  </span>
                  <span>
                    <span className="block text-xs text-brand-warn">Hosted model</span>
                    {row.hosted}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
          <div data-reveal className="mt-14 hidden md:block">
            <table className="w-full border-collapse text-left text-[15px]">
              <thead>
                <tr className="border-b border-brand-line-strong">
                  <th scope="col" className="py-4 pr-6 font-normal text-brand-faint">
                    Data
                  </th>
                  <th scope="col" className="py-4 pr-6 font-medium">
                    <span className="inline-flex items-center gap-1.5 text-brand-ok">
                      <LockIcon />
                      Local model
                    </span>
                  </th>
                  <th scope="col" className="py-4 font-medium">
                    <span className="inline-flex items-center gap-1.5 text-brand-warn">
                      <span className="h-1.5 w-1.5 rounded-full bg-current" />
                      Hosted model
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {DATA_ROWS.map((row) => (
                  <tr key={row.label} className="border-b border-brand-line">
                    <th scope="row" className="py-4 pr-6 font-normal text-brand-muted">
                      {row.label}
                    </th>
                    <td className="py-4 pr-6">{row.local}</td>
                    <td className="py-4">{row.hosted}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm text-brand-faint">
            Installing a public registry agent sends an anonymous install
            count, which you can turn off in Settings.
          </p>

          <div className="mt-16 grid gap-px overflow-hidden rounded-[18px] border border-brand-line bg-brand-line sm:grid-cols-2 lg:grid-cols-4">
            {GUARANTEES.map(([number, title, text]) => (
              <div key={number} data-reveal className="bg-brand-bg p-7">
                <p className="font-mono text-xs text-brand-faint">{number}</p>
                <p className="font-display mt-6 text-[1.4rem] leading-tight">{title}</p>
                <p className="mt-2 text-sm leading-6 text-brand-muted">{text}</p>
              </div>
            ))}
          </div>

          <div className="mt-10 flex flex-wrap gap-3">
            <Link href="/trust-model" className={buttonSecondary}>
              Read the trust model
            </Link>
            <Link href="/privacy" className={buttonSecondary}>
              Privacy policy
            </Link>
          </div>
        </div>
      </section>

      {/* Write confirmation spotlight */}
      <section className="mx-auto w-full max-w-7xl px-6 py-24 sm:px-10 sm:py-32">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:items-center lg:gap-16">
          <div data-reveal>
            <p className={eyebrow}>Write confirmation</p>
            <h2 className={`${sectionTitle} mt-4`}>Type it to mean it.</h2>
            <p className="mt-6 text-lg leading-8 text-brand-muted">
              Read-only agents run on their own. Anything that changes the
              tenant stops here: every Graph call listed, the devices or
              accounts it touches, and a phrase you type before Apply unlocks.
            </p>
            <p className="mt-8 font-mono text-[clamp(1.4rem,3vw,2.1rem)] tracking-tight text-brand-danger">
              RETIRE 2 DEVICES
              <span
                aria-hidden
                className="figure-caret ml-1 inline-block h-[0.9em] w-[2px] translate-y-[0.12em] bg-current"
              />
            </p>
          </div>
          <Stage tone="clay" className="overflow-hidden rounded-[18px] p-5 sm:p-10">
            <div data-reveal>
              <AppWindow
                screen="write-confirmation"
                alt="Write confirmation for the Offboarding agent: two device retirements, a Microsoft Graph write warning, and the typed phrase RETIRE 2 DEVICES"
                crop={{ x: 662, y: 64, width: 868, aspect: "868 / 830" }}
              />
            </div>
          </Stage>
        </div>
      </section>

      {/* Registry */}
      <section className="border-t border-brand-line">
        <div className="mx-auto w-full max-w-7xl px-6 py-24 sm:px-10 sm:py-32">
          <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <div data-reveal>
              <p className={eyebrow}>Community registry</p>
              <h2 className={`${sectionTitle} mt-4`}>
                Read an agent before it reads your tenant.
              </h2>
              <p className="mt-6 text-lg leading-8 text-brand-muted">
                Each agent is a TypeScript module with a manifest: the Graph
                scopes it needs, whether it reads or makes changes, and the
                models it works with. Use the public registry, contribute to
                it, or point the app at your organization&apos;s own.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link href="/registry" className={buttonSecondary}>
                  How the registry works
                </Link>
                <Link
                  href={DOCS_URL}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonSecondary}
                >
                  Write an agent
                </Link>
              </div>
            </div>
            <div data-reveal>
              <table className="w-full table-fixed border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-brand-line-strong text-brand-faint">
                    <th scope="col" className="w-[42%] py-3 pr-4 font-normal">Agent</th>
                    <th scope="col" className="w-[24%] py-3 pr-4 font-normal">Mode</th>
                    <th scope="col" className="hidden py-3 font-normal sm:table-cell">
                      Graph scopes
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {REGISTRY_AGENTS.filter((agent) => agent.scopes.length > 0)
                    .slice(0, 9)
                    .map((agent) => (
                      <tr key={agent.name} className="border-b border-brand-line">
                        <th scope="row" className="truncate py-3.5 pr-4 font-medium">
                          {agent.name}
                        </th>
                        <td className="whitespace-nowrap py-3.5 pr-4">
                          <span
                            className={`inline-flex items-center gap-1.5 ${
                              agent.mode === "write" ? "text-brand-warn" : "text-brand-ok"
                            }`}
                          >
                            <span className="h-1.5 w-1.5 rounded-full bg-current" />
                            {agent.mode === "write" ? "Makes changes" : "Read-only"}
                          </span>
                        </td>
                        <td className="hidden truncate py-3.5 font-mono text-xs text-brand-muted sm:table-cell">
                          {agent.scopes.join(", ")}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              <p className="mt-4 text-sm text-brand-faint">
                {REGISTRY_AGENTS.length} agents in the public registry.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Benchmarks */}
      <section className="border-t border-brand-line bg-brand-surface">
        <div className="mx-auto w-full max-w-7xl px-6 py-24 sm:px-10 sm:py-32">
          <div className="grid gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:items-center">
            <div data-reveal>
              <p className={eyebrow}>Research · {benchmarks.taskCount} tasks</p>
              <h2 className={`${sectionTitle} mt-4`}>
                You do not need a frontier model for this work.
              </h2>
              <p className="mt-6 text-lg leading-8 text-brand-muted">
                We put {ownModel.name}, Claude Opus 5, and GPT-5.6-sol through
                the same Microsoft 365 administration tasks and scored them
                mechanically. The {ownModel.sizeOnDisk} local model came out{" "}
                {benchmarkLead} tasks ahead, mostly on write safety.
              </p>
              <Link href="/benchmarks" className="text-link mt-6 inline-flex text-base">
                Read the benchmark
              </Link>
            </div>
            <div data-reveal className="space-y-6">
              {benchmarkTiles.map((model) => (
                <div key={model.id}>
                  <div className="flex items-baseline justify-between gap-4">
                    <p className={model.kind === "own" ? "font-medium" : "text-brand-muted"}>
                      {model.name}
                      <span className="ml-2 text-sm text-brand-faint">
                        {model.kind === "own" ? "runs locally" : "hosted"}
                      </span>
                    </p>
                    <p className="font-display text-[2.4rem] leading-none tabular-nums">
                      {model.score}
                      <span className="text-base text-brand-faint">/{benchmarks.taskCount}</span>
                    </p>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-brand-line-soft">
                    <div
                      className={`h-full rounded-full ${
                        model.kind === "own" ? "bg-brand-ink" : "bg-brand-line-strong"
                      }`}
                      style={{ width: `${(model.score / benchmarks.taskCount) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Open source, changelog, voice */}
      <section className="border-t border-brand-line">
        <div className="mx-auto w-full max-w-7xl px-6 py-24 sm:px-10 sm:py-32">
          <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-end">
            <div data-reveal>
              <p className={eyebrow}>Open source</p>
              <h2 className={`${sectionTitle} mt-4`}>Built in the open, shipped often.</h2>
            </div>
            <dl data-reveal className="grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-4">
              {stats.map((item) => (
                <div key={item.label} className="flex flex-col-reverse">
                  <dt className="mt-2 text-sm text-brand-muted">{item.label}</dt>
                  <dd className="font-display text-[2.1rem] leading-none tabular-nums">
                    {item.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          {releases.length > 0 ? (
            <div className="mt-14">
              <div className="flex items-baseline justify-between">
                <h3 className="text-sm text-brand-faint">Changelog</h3>
                <Link
                  href={`${GITHUB_URL}/releases`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-link text-sm"
                >
                  All releases
                </Link>
              </div>
              <ul className="mt-4 grid gap-px overflow-hidden rounded-[14px] border border-brand-line bg-brand-line sm:grid-cols-2 lg:grid-cols-4">
                {releases.map((release) => (
                  <li key={release.version} className="bg-brand-bg">
                    <Link
                      href={release.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex h-full flex-col p-6 transition-colors hover:bg-brand-hover"
                    >
                      <span className="text-sm text-brand-faint">
                        {dateFormat.format(new Date(release.publishedAt))}
                      </span>
                      <span className="mt-2 font-medium">{release.version}</span>
                      {release.summary ? (
                        <span className="mt-1 line-clamp-3 text-sm leading-6 text-brand-muted">
                          {release.summary}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <figure
            data-reveal
            className="mt-16 grid gap-6 border-t border-brand-line pt-10 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]"
          >
            <figcaption className="flex items-center gap-3 md:items-start">
              <img
                src={TESTIMONIAL.image}
                alt=""
                width="44"
                height="44"
                loading="lazy"
                className="h-11 w-11 rounded-full object-cover"
              />
              <div className="text-sm">
                <Link
                  href={TESTIMONIAL.href}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium hover:underline"
                >
                  {TESTIMONIAL.name}
                </Link>
                <p className="text-brand-muted">{TESTIMONIAL.role}</p>
              </div>
            </figcaption>
            <blockquote className="font-display max-w-3xl text-balance text-[1.7rem] leading-[1.3] sm:text-[2rem]">
              &ldquo;{TESTIMONIAL.quote}&rdquo;
            </blockquote>
          </figure>
        </div>
      </section>

      {/* Questions */}
      <section className="border-t border-brand-line">
        <div className="mx-auto grid w-full max-w-7xl gap-12 px-6 py-24 sm:px-10 sm:py-32 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <h2 data-reveal className={`${sectionTitle} max-w-[14ch]`}>
            What admins ask first.
          </h2>
          <div className="border-t border-brand-line" data-reveal>
            {COMMON_QUESTIONS.map((item, index) => (
              <details
                key={item.question}
                open={index === 0}
                className="group border-b border-brand-line"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-left [&::-webkit-details-marker]:hidden">
                  <span className="text-lg font-medium">{item.question}</span>
                  <span
                    aria-hidden
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-brand-line text-lg leading-none text-brand-muted transition-transform duration-200 group-open:rotate-45"
                  >
                    +
                  </span>
                </summary>
                <p className="max-w-2xl pb-6 text-base leading-7 text-brand-muted">
                  {item.answer}
                </p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Closing */}
      <section className="px-3 pb-3 sm:px-6 sm:pb-6">
        <Stage
          tone="sage"
          className="mx-auto flex max-w-[96rem] flex-col items-center overflow-hidden rounded-[18px] px-6 py-24 text-center sm:rounded-[24px] sm:py-32"
        >
          <h2 className="font-display max-w-[16ch] text-balance text-[2.8rem] leading-[1.02] sm:text-[4.6rem]">
            Connect a tenant. Ask it something.
          </h2>
          <p className="mt-6 max-w-xl text-lg leading-8 text-brand-muted">
            Install the app, sign in with Microsoft, and pick a model.
            Read-only agents run once consent is granted. Changes wait for
            you.
          </p>
          <DownloadCta urls={downloadUrls} className="mt-10 justify-center" />
        </Stage>
      </section>
    </MarketingShell>
  );
}
