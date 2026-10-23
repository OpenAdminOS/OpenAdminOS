import { type Metadata } from "next";
import Link from "next/link";

import {
  benchmarkData as benchmarks,
  leadOverHosted,
  ownModel,
  rankedModels,
} from "~/lib/benchmarks/data";
import { getAgentStatsSummary } from "~/lib/stats/summary";

import { DiffConfirmationDemo } from "./DiffConfirmationDemo";
import { getGitHubDownloadCount } from "./github-downloads";
import { getGitHubRepoStats } from "./github-repo";
import { AgentRun } from "./home/AgentRun";
import { REGISTRY_AGENTS, type RegistryAgent } from "./home/agents";
import { AppCrop, AppShot, type AppScreen } from "./home/AppShot";
import { DownloadCta } from "./home/DownloadCta";
import { LockIcon } from "./home/icons";
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
import { buttonSecondary, card, eyebrow, sectionTitle } from "./ui";

export const revalidate = 900;

export const metadata: Metadata = pageMetadata({
  title: HOME_TITLE,
  description: HOME_DESCRIPTION,
  path: "/",
  absoluteTitle: true,
});

const benchmarkTiles = rankedModels();
const benchmarkLead = leadOverHosted();

/** Numbered callouts on the hero screenshot, in screenshot pixels. */
const HERO_CALLOUTS = [
  {
    x: 694,
    y: 192,
    title: "Scope and data age",
    text: "Every answer opens with the tenant, the sources it read, and how old the data is.",
  },
  {
    x: 694,
    y: 294,
    title: "Numbered sources",
    text: "Claims point to the Microsoft Graph source and row count behind them.",
  },
  {
    x: 1646,
    y: 25,
    title: "The active model",
    text: "The provider and model in use sit in the title bar, all the time.",
  },
  {
    x: 930,
    y: 989,
    title: "Where data goes",
    text: "Said once, under the composer, in plain words.",
  },
] as const;

const PRINCIPLES = [
  {
    title: "Local-first",
    text: "With a local model, tenant data, prompts, and answers stay on this device.",
  },
  {
    title: "Honest about egress",
    text: "Choose a hosted model and the app says that tenant context will be sent to it.",
  },
  {
    title: "Writes wait for you",
    text: "Every write shows a diff first. Destructive ones need a typed phrase.",
  },
  {
    title: "Open source",
    text: "MIT licensed: the app, the agent runtime, the SDK, and the registry.",
  },
] as const;

const RUN_STEPS = [
  {
    title: "Scope first.",
    text: "No agent starts without an active tenant, and that tenant stays visible in the title bar.",
  },
  {
    title: "Evidence second.",
    text: "Reads go through Microsoft Graph with the scopes the agent declared. Answers carry their sources and data age.",
  },
  {
    title: "Changes last.",
    text: "A write agent prepares a plan and stops. You review each Graph call before anything is applied.",
  },
] as const;

const LOCAL_PROVIDERS = ["Ollama", "LM Studio", "Apple Foundation"] as const;
const HOSTED_PROVIDERS = [
  "Anthropic via Claude Code",
  "OpenAI Codex",
  "GitHub Copilot",
  "Google Gemini",
  "Azure OpenAI",
] as const;

const WRITE_RULES = [
  "No skip toggle and no “trust this agent” exception.",
  "Destructive operations stay disabled until the exact phrase is typed.",
  "The same rule applies to registry agents, private agents, and Agent Team.",
] as const;

const FEATURE_TILES: readonly {
  title: string;
  text: string;
  screen: AppScreen;
  alt: string;
  crop: { x: number; y: number; width: number; aspect: string };
  className: string;
}[] = [
  {
    title: "Chat with sources and data age",
    text: "Ask about the tenant in plain language. Answers open with their scope and data age, cite the Graph sources they used, and suggest an installed agent when one fits.",
    screen: "chat-transcript",
    alt: "Chat answer in OpenAdminOS with tenant scope, data age, and two numbered Microsoft Graph sources",
    crop: { x: 700, y: 60, width: 790, aspect: "16 / 10" },
    className: "lg:col-span-4",
  },
  {
    title: "Your model, labeled",
    text: "Local and hosted providers side by side, each marked for where it runs.",
    screen: "settings",
    alt: "Provider settings listing Ollama, Apple Foundation, and LM Studio as local, and hosted providers marked as hosted",
    crop: { x: 846, y: 188, width: 470, aspect: "4 / 5" },
    className: "lg:col-span-2",
  },
  {
    title: "Scopes before you run",
    text: "Each agent lists the Graph permissions it needs. Missing consent is requested before the first run.",
    screen: "agent-drawer",
    alt: "Agent details for Find inactive devices showing its Microsoft Graph permission and schedule settings",
    crop: { x: 1364, y: 56, width: 440, aspect: "4 / 5" },
    className: "lg:col-span-2",
  },
  {
    title: "Agent Team",
    text: "Give a teammate a role, a tenant, a provider, and up to eight installed agents. Run once or on a schedule. Every result stays linked to the run that produced it.",
    screen: "agent-team",
    alt: "Agent Team page in OpenAdminOS with the office view and assignment history",
    crop: { x: 510, y: 60, width: 1150, aspect: "16 / 10" },
    className: "lg:col-span-4",
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

function formatStat(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

export default async function HomePage() {
  const [latestRelease, githubRepoStats, agentStatsSummary, downloadCount] =
    await Promise.all([
      getLatestReleaseDownloads(),
      getGitHubRepoStats(),
      getAgentStatsSummary(),
      getGitHubDownloadCount(),
    ]);
  // Live numbers only. A source that is unavailable is left out, never faked.
  const tractionItems = [
    ...(githubRepoStats
      ? [{ value: formatStat(githubRepoStats.stars), label: "GitHub stars" }]
      : []),
    ...(downloadCount !== null
      ? [{ value: formatStat(downloadCount), label: "Downloads" }]
      : []),
    ...(agentStatsSummary
      ? [
          {
            value: formatStat(agentStatsSummary.agentCount),
            label: "Community agents",
          },
        ]
      : []),
    { value: "MIT", label: "License" },
  ];
  const downloadUrls = {
    macos: latestRelease.macosDmgUrl,
    windows: latestRelease.windowsExeUrl,
    linux: latestRelease.linuxAppImageUrl,
  };
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
    <MarketingShell bare>
      <JsonLd data={structuredData} />

      {/* Hero */}
      <section className="relative isolate overflow-hidden">
        <div
          aria-hidden
          className="brand-dots brand-dots-fade pointer-events-none absolute inset-0 -z-10"
        />
        <div className="mx-auto w-full max-w-7xl px-6 pb-10 pt-16 sm:px-10 sm:pt-24 lg:pt-28">
          <Link
            href={latestRelease.releaseNotesUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-full border border-brand-line bg-brand-raised py-1 pl-1 pr-3 text-sm text-brand-muted transition-colors hover:text-brand-ink"
          >
            <span className="rounded-full bg-brand-ink px-2 py-0.5 text-xs font-medium text-brand-on-ink">
              {latestRelease.version}
            </span>
            Release notes
            <span aria-hidden>→</span>
          </Link>

          <h1 className="font-display mt-8 max-w-[17ch] text-balance text-[3.1rem] leading-[0.98] sm:text-[5.25rem] lg:text-[6.75rem]">
            Agents for your Microsoft 365 tenant.{" "}
            <em className="text-brand-faint">On your own machine.</em>
          </h1>

          <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <p className="max-w-2xl text-pretty text-lg leading-8 text-brand-muted sm:text-xl sm:leading-9">
              OpenAdminOS is an open-source desktop app for Intune and Entra
              admins. Ask your tenant questions, run agents from a community
              registry, and approve every change before it reaches Microsoft
              Graph.
            </p>
            <div className="flex flex-col gap-3 lg:items-end">
              <DownloadCta urls={downloadUrls} />
              <p className="text-sm text-brand-faint">
                macOS (Apple Silicon), Windows, and Linux. Free and MIT
                licensed.
              </p>
            </div>
          </div>
        </div>

        <div className="mx-auto w-full max-w-[90rem] px-3 pb-6 sm:px-8">
          <figure className="overflow-hidden rounded-[14px] bg-brand-raised shadow-(--shadow-frame) sm:hidden">
            <AppCrop
              screen="chat-transcript"
              alt="OpenAdminOS Chat answer with tenant scope, data age, and two numbered Microsoft Graph sources"
              x={700}
              y={60}
              width={790}
              aspect="4 / 3.4"
            />
          </figure>
          <figure className="relative hidden overflow-hidden rounded-[20px] bg-brand-raised shadow-(--shadow-frame) sm:block">
            <AppShot
              screen="chat-transcript"
              alt="OpenAdminOS Chat answering which managed devices have not synced in the last 7 days, with tenant scope, data age, two Microsoft Graph sources, and a local Ollama model"
              priority
              className="block h-auto w-full"
            />
            {HERO_CALLOUTS.map((callout, index) => (
              <span
                key={callout.title}
                aria-hidden
                className="absolute grid h-6 w-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-brand-ink text-xs font-medium text-brand-on-ink ring-4 ring-brand-ink/15"
                style={{
                  left: `${(callout.x / 1920) * 100}%`,
                  top: `${(callout.y / 1012) * 100}%`,
                }}
              >
                {index + 1}
              </span>
            ))}
          </figure>
          <ol className="mx-auto mt-8 grid max-w-7xl gap-x-8 gap-y-5 px-3 sm:grid-cols-2 sm:px-2 lg:grid-cols-4">
            {HERO_CALLOUTS.map((callout, index) => (
              <li key={callout.title} className="flex gap-3">
                <span className="mt-0.5 hidden h-5 w-5 shrink-0 place-items-center rounded-full border border-brand-line-strong text-[11px] font-medium sm:grid">
                  {index + 1}
                </span>
                <p className="text-sm leading-6 text-brand-muted">
                  <span className="font-medium text-brand-ink">
                    {callout.title}.
                  </span>{" "}
                  {callout.text}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Principles */}
      <section className="border-y border-brand-line bg-brand-surface">
        <div className="mx-auto grid w-full max-w-7xl sm:grid-cols-2 lg:grid-cols-4">
          {PRINCIPLES.map((item) => (
            <div
              key={item.title}
              className="border-brand-line px-6 py-8 sm:px-10 lg:border-l lg:first:border-l-0"
            >
              <p className="font-display text-[1.6rem] leading-tight">
                {item.title}
              </p>
              <p className="mt-2 text-sm leading-6 text-brand-muted">
                {item.text}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* How a run works */}
      <section className="mx-auto w-full max-w-7xl px-6 py-24 sm:px-10 sm:py-32">
        <div className="grid gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,34rem)] lg:items-center lg:gap-20">
          <div data-reveal>
            <p className={eyebrow}>How a run works</p>
            <h2 className={`${sectionTitle} mt-4 max-w-[16ch]`}>
              Read freely. Change nothing without you.
            </h2>
            <p className="mt-6 max-w-xl text-lg leading-8 text-brand-muted">
              Ask a question in Chat or start an agent. OpenAdminOS reads from
              Microsoft Graph inside the tenant you picked, answers with the
              sources it used, and stops before anything changes.
            </p>
            <ol className="mt-10 space-y-6">
              {RUN_STEPS.map((step, index) => (
                <li
                  key={step.title}
                  className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-3 border-t border-brand-line pt-6"
                >
                  <span className="font-display text-2xl leading-none text-brand-faint">
                    {index + 1}
                  </span>
                  <p className="max-w-lg text-base leading-7 text-brand-muted">
                    <span className="font-medium text-brand-ink">
                      {step.title}
                    </span>{" "}
                    {step.text}
                  </p>
                </li>
              ))}
            </ol>
          </div>
          <figure data-reveal>
            <AgentRun />
            <figcaption className="mt-4 text-center text-sm text-brand-faint">
              Illustration using the app&apos;s demo tenant.
            </figcaption>
          </figure>
        </div>
      </section>

      {/* Where data goes */}
      <section className="band-ink">
        <div className="mx-auto w-full max-w-7xl px-6 py-24 sm:px-10 sm:py-32">
          <div className="max-w-4xl" data-reveal>
            <p className={eyebrow}>Where your data goes</p>
            <h2 className="font-display mt-4 text-balance text-[2.5rem] leading-[1.02] sm:text-[4.25rem]">
              With a local model, tenant data never leaves the device.
            </h2>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-brand-muted">
              Choose a hosted model when you want one. The app says so before
              tenant context is sent and names the provider it goes to. It
              does not claim a processing region it cannot confirm.
            </p>
          </div>

          <div className="mt-14 grid gap-4 lg:grid-cols-2" data-reveal>
            <ProviderCard
              chip="Local · Ollama"
              title="Local providers"
              providers={LOCAL_PROVIDERS}
              quote="Local model. Tenant data stays on this device."
              tone="ok"
            />
            <ProviderCard
              chip="Hosted, leaves this device"
              title="Hosted providers"
              providers={HOSTED_PROVIDERS}
              quote="Retrieved tenant context is sent to the selected hosted provider."
              tone="warn"
            />
          </div>

          <div className="mt-10 flex flex-col gap-6 border-t border-brand-line pt-8 md:flex-row md:items-center md:justify-between">
            <p className="max-w-2xl text-sm leading-6 text-brand-muted">
              OpenAdminOS does not collect tenant data, prompts, run results,
              or error reports. Installing a public registry agent sends an
              anonymous install count, which you can turn off in Settings.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link href="/trust-model" className={buttonSecondary}>
                Read the trust model
              </Link>
              <Link href="/llm-providers" className={buttonSecondary}>
                Compare model providers
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Write confirmation */}
      <section
        id="safety"
        className="mx-auto w-full max-w-7xl scroll-mt-20 px-6 py-24 sm:px-10 sm:py-32"
      >
        <div className="grid gap-14 lg:grid-cols-[minmax(0,32rem)_minmax(0,1fr)] lg:items-center lg:gap-20">
          <figure className="order-2 lg:order-1" data-reveal>
            <DiffConfirmationDemo />
            <figcaption className="mt-4 text-center text-sm text-brand-faint">
              Illustration of the desktop write confirmation. Nothing here
              touches a tenant.
            </figcaption>
          </figure>
          <div className="order-1 lg:order-2" data-reveal>
            <p className={eyebrow}>Write confirmation</p>
            <h2 className={`${sectionTitle} mt-4 max-w-[17ch]`}>
              Every write stops at a diff. You type the phrase.
            </h2>
            <p className="mt-6 max-w-xl text-lg leading-8 text-brand-muted">
              Read-only agents can run on their own. Write agents prepare a
              plan and pause. You see each Microsoft Graph call, what it
              touches, and what changes, then decide.
            </p>
            <ul className="mt-8 space-y-3">
              {WRITE_RULES.map((rule) => (
                <li
                  key={rule}
                  className="flex gap-3 text-base leading-7 text-brand-muted"
                >
                  <CheckIcon />
                  {rule}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* The app */}
      <section className="border-t border-brand-line bg-brand-surface">
        <div className="mx-auto w-full max-w-7xl px-6 py-24 sm:px-10 sm:py-32">
          <div className="max-w-3xl" data-reveal>
            <p className={eyebrow}>The app</p>
            <h2 className={`${sectionTitle} mt-4`}>
              One window for questions, agents, and the team that runs them.
            </h2>
          </div>
          <div className="mt-14 grid gap-4 lg:grid-cols-6">
            {FEATURE_TILES.map((tile) => (
              <article
                key={tile.title}
                data-reveal
                className={`${card} flex flex-col overflow-hidden ${tile.className}`}
              >
                <div className="p-6 sm:p-8">
                  <h3 className="font-display text-[1.65rem] leading-tight">
                    {tile.title}
                  </h3>
                  <p className="mt-2 max-w-xl text-[15px] leading-7 text-brand-muted">
                    {tile.text}
                  </p>
                </div>
                <div className="mt-auto px-6 sm:px-8">
                  <AppCrop
                    screen={tile.screen}
                    alt={tile.alt}
                    className="rounded-t-[12px] border border-b-0 border-brand-line bg-brand-bg"
                    {...tile.crop}
                  />
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Registry */}
      <section className="overflow-hidden py-24 sm:py-32">
        <div className="mx-auto grid w-full max-w-7xl gap-10 px-6 sm:px-10 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="max-w-3xl" data-reveal>
            <p className={eyebrow}>Community registry</p>
            <h2 className={`${sectionTitle} mt-4`}>
              Agents you can read before they run.
            </h2>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-brand-muted">
              Each agent is a TypeScript module with a manifest: the Graph
              scopes it needs, whether it reads or makes changes, and the
              models it works with. Browse the public registry, contribute your
              own, or point the app at a private registry for your
              organization.
            </p>
          </div>
          <div className="flex flex-wrap gap-3" data-reveal>
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

        <div className="mt-14 space-y-3" aria-label="Agents in the public registry">
          <AgentMarquee agents={REGISTRY_AGENTS.slice(0, 8)} duration={70} />
          <AgentMarquee agents={REGISTRY_AGENTS.slice(8)} duration={80} reverse />
        </div>
      </section>

      {/* Benchmarks */}
      <section className="border-t border-brand-line">
        <div className="mx-auto grid w-full max-w-7xl gap-12 px-6 py-24 sm:px-10 sm:py-32 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-center">
          <div data-reveal>
            <p className={eyebrow}>Benchmarks</p>
            <h2 className={`${sectionTitle} mt-4 max-w-[18ch]`}>
              You do not need a frontier model for this work.
            </h2>
            <p className="mt-6 max-w-xl text-lg leading-8 text-brand-muted">
              We put {ownModel.name}, Claude Opus 5, and GPT-5.6-sol through{" "}
              {benchmarks.taskCount} identical Microsoft 365 administration
              tasks and scored them mechanically. The {ownModel.sizeOnDisk}{" "}
              local model came out {benchmarkLead} tasks ahead, mostly on
              write safety: refusing destructive requests for the right reason.
            </p>
            <Link href="/benchmarks" className="text-link mt-6 inline-flex text-base">
              See the full benchmark
            </Link>
          </div>
          <div className="grid gap-3 sm:grid-cols-3" data-reveal>
            {benchmarkTiles.map((model) => (
              <div
                key={model.id}
                className={`rounded-[14px] p-6 ${
                  model.kind === "own"
                    ? "bg-brand-ink text-brand-on-ink"
                    : "border border-brand-line bg-brand-card"
                }`}
              >
                <p
                  className={`text-sm ${
                    model.kind === "own" ? "opacity-75" : "text-brand-muted"
                  }`}
                >
                  {model.name}
                </p>
                <p className="font-display mt-6 text-[3.5rem] leading-none tabular-nums">
                  {model.score}
                </p>
                <p
                  className={`mt-2 text-sm ${
                    model.kind === "own" ? "opacity-75" : "text-brand-muted"
                  }`}
                >
                  of {benchmarks.taskCount} tasks ·{" "}
                  {model.kind === "own" ? "runs locally" : "hosted"}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Open source */}
      <section className="border-t border-brand-line bg-brand-surface">
        <div className="mx-auto w-full max-w-7xl px-6 py-24 sm:px-10 sm:py-32">
          <div className="grid gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-20">
            <div data-reveal>
              <p className={eyebrow}>Open source</p>
              <h2 className={`${sectionTitle} mt-4`}>
                Open from the first commit.
              </h2>
              <p className="mt-6 max-w-xl text-lg leading-8 text-brand-muted">
                The desktop app, agent runtime, SDK, and registry contract are
                MIT licensed. Read the code before you connect a tenant, fork
                it, or run your own registry.
              </p>
              <dl className="mt-10 grid grid-cols-2 gap-x-8 gap-y-8 border-t border-brand-line pt-8 sm:grid-cols-4 lg:grid-cols-2">
                {tractionItems.map((item) => (
                  <div key={item.label}>
                    <dd className="font-display text-[2.25rem] leading-none tabular-nums">
                      {item.value}
                    </dd>
                    <dt className="mt-2 text-sm text-brand-muted">
                      {item.label}
                    </dt>
                  </div>
                ))}
              </dl>
              <Link
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className={`${buttonSecondary} mt-10`}
              >
                <GitHubIcon />
                github.com/OpenAdminOS/OpenAdminOS
              </Link>
            </div>

            <figure
              data-reveal
              className="flex flex-col justify-between rounded-[18px] border border-brand-line bg-brand-card p-8 sm:p-10"
            >
              <blockquote className="font-display text-balance text-[1.75rem] leading-[1.3] sm:text-[2.1rem]">
                &ldquo;{TESTIMONIAL.quote}&rdquo;
              </blockquote>
              <figcaption className="mt-10 flex items-center gap-4">
                <img
                  src={TESTIMONIAL.image}
                  alt=""
                  width="48"
                  height="48"
                  loading="lazy"
                  className="h-12 w-12 rounded-full object-cover"
                />
                <div className="min-w-0 text-sm">
                  <Link
                    href={TESTIMONIAL.href}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-brand-ink hover:underline"
                  >
                    {TESTIMONIAL.name}
                  </Link>
                  <p className="text-brand-muted">{TESTIMONIAL.role}</p>
                </div>
              </figcaption>
            </figure>
          </div>
        </div>
      </section>

      {/* Questions */}
      <section className="border-t border-brand-line">
        <div className="mx-auto grid w-full max-w-7xl gap-12 px-6 py-24 sm:px-10 sm:py-32 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <div data-reveal>
            <p className={eyebrow}>Common questions</p>
            <h2 className={`${sectionTitle} mt-4 max-w-[14ch]`}>
              What admins ask first.
            </h2>
          </div>
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
      <section className="band-ink relative isolate overflow-hidden">
        <div
          aria-hidden
          className="brand-dots brand-dots-fade pointer-events-none absolute inset-0 -z-10"
        />
        <div className="mx-auto flex w-full max-w-7xl flex-col items-start px-6 py-24 sm:px-10 sm:py-32">
          <h2 className="font-display max-w-[14ch] text-balance text-[3rem] leading-[0.98] sm:text-[5.5rem]">
            Connect a tenant. Ask it something.
          </h2>
          <p className="mt-6 max-w-xl text-lg leading-8 text-brand-muted">
            Install the app, sign in with Microsoft, and pick a model.
            Read-only agents run once consent is granted. Changes wait for
            you.
          </p>
          <DownloadCta urls={downloadUrls} className="mt-10" />
        </div>
      </section>
    </MarketingShell>
  );
}

function ProviderCard({
  chip,
  title,
  providers,
  quote,
  tone,
}: {
  chip: string;
  title: string;
  providers: readonly string[];
  quote: string;
  tone: "ok" | "warn";
}) {
  return (
    <div className="flex flex-col rounded-[18px] border border-brand-line bg-brand-card p-7 sm:p-9">
      <span
        className={`inline-flex w-fit items-center gap-1.5 rounded-full px-3 py-1 text-sm ${
          tone === "ok"
            ? "bg-brand-ok-surface text-brand-ok"
            : "bg-brand-warn-surface text-brand-warn"
        }`}
      >
        {tone === "ok" ? <LockIcon /> : <ArrowOutIcon />}
        {chip}
      </span>
      <h3 className="font-display mt-6 text-[2rem] leading-tight">{title}</h3>
      <ul className="mt-4 flex flex-wrap gap-2">
        {providers.map((provider) => (
          <li
            key={provider}
            className="rounded-full border border-brand-line px-3 py-1 text-sm text-brand-muted"
          >
            {provider}
          </li>
        ))}
      </ul>
      <p className="mt-8 border-t border-brand-line pt-5 text-sm leading-6 text-brand-muted">
        What the app says:{" "}
        <span className="text-brand-ink">&ldquo;{quote}&rdquo;</span>
      </p>
    </div>
  );
}

function AgentMarquee({
  agents,
  duration,
  reverse = false,
}: {
  agents: readonly RegistryAgent[];
  duration: number;
  reverse?: boolean;
}) {
  return (
    <div className="marquee marquee-mask overflow-hidden">
      <ul
        className={`marquee-track flex w-max gap-3 ${reverse ? "marquee-reverse" : ""}`}
        style={{ ["--marquee-duration" as string]: `${duration}s` }}
      >
        {[...agents, ...agents].map((agent, index) => (
          <li
            key={`${agent.name}-${index}`}
            aria-hidden={index >= agents.length}
            className="w-[19rem] shrink-0 rounded-[14px] border border-brand-line bg-brand-card px-5 py-4"
          >
            <div className="flex items-center justify-between gap-3">
              <p className="truncate font-medium">{agent.name}</p>
              <span
                className={`inline-flex shrink-0 items-center gap-1.5 text-xs ${
                  agent.mode === "write" ? "text-brand-warn" : "text-brand-ok"
                }`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                {agent.mode === "write" ? "Makes changes" : "Read-only"}
              </span>
            </div>
            <p className="mt-2 truncate font-mono text-xs text-brand-muted">
              {agent.scopes.length > 0
                ? agent.scopes.join(" · ")
                : "No Graph scopes · works on supplied evidence"}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ArrowOutIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 17 17 7M9 7h8v8" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="mt-1.5 h-4 w-4 shrink-0 text-brand-ink"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4 fill-current">
      <path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.56-.29-5.25-1.28-5.25-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.7 5.38-5.27 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}
