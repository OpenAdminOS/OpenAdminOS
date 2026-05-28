import Image from "next/image";
import Link from "next/link";

import { DiffConfirmationDemo } from "./DiffConfirmationDemo";

const RELEASES_URL = "https://github.com/OpenAdminOS/OpenAdminOS/releases";
const LATEST_RELEASE_URL = `${RELEASES_URL}/latest`;
const LATEST_RELEASE_API_URL =
  "https://api.github.com/repos/OpenAdminOS/OpenAdminOS/releases/latest";

export const revalidate = 900;

interface GitHubReleaseAsset {
  browser_download_url?: string;
  name?: string;
}

interface GitHubLatestRelease {
  assets?: GitHubReleaseAsset[];
  html_url?: string;
  tag_name?: string;
}

async function getLatestRelease() {
  try {
    const response = await fetch(LATEST_RELEASE_API_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      next: { revalidate },
    });

    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);

    const release = (await response.json()) as GitHubLatestRelease;
    const macosAsset = release.assets?.find((asset) => {
      const name = asset.name?.toLowerCase() ?? "";
      return name.endsWith(".dmg") && name.includes("arm64");
    });

    return {
      macosDmgUrl: macosAsset?.browser_download_url ?? LATEST_RELEASE_URL,
      releaseNotesUrl: release.html_url ?? LATEST_RELEASE_URL,
      version: release.tag_name ?? "Latest release",
    };
  } catch {
    return {
      macosDmgUrl: LATEST_RELEASE_URL,
      releaseNotesUrl: LATEST_RELEASE_URL,
      version: "Latest release",
    };
  }
}

const TRUST_ITEMS = [
  {
    label: "Ollama",
    detail: "Local model · tenant data stays on this device",
    command: "ollama serve",
  },
  {
    label: "LM Studio",
    detail: "Local server · no vendor API key stored",
    command: "localhost:1234",
  },
  {
    label: "Hosted providers",
    detail: "OpenAI, Anthropic, or Azure OpenAI · labeled before every run",
    command: "explicit egress",
  },
  {
    label: "Microsoft Graph",
    detail: "Every agent declares scopes before install",
    command: "admin consent",
  },
];

const AGENTS = [
  {
    name: "Intune stale device audit",
    mode: "Read-only",
    scopes: "DeviceManagementManagedDevices.Read.All",
    description: "Find devices that have stopped checking in and explain why they matter.",
  },
  {
    name: "Risky sign-in triage",
    mode: "Read-only",
    scopes: "IdentityRiskEvent.Read.All",
    description: "Summarize risky sign-ins with tenant-specific remediation notes.",
  },
  {
    name: "Stale guest cleanup",
    mode: "Write",
    scopes: "User.ReadWrite.All",
    description: "Prepare a reviewed disable plan for guests that have gone inactive.",
  },
];

const PROOF_ITEMS = [
  ["MIT", "Commercial-friendly license"],
  ["TypeScript", "Agents, runtime, desktop, and site"],
  ["SQLite", "Run history stays local"],
  ["No telemetry", "No tenant content leaves by default"],
];

export default async function HomePage() {
  const latestRelease = await getLatestRelease();

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-[#070709] text-white">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-[size:72px_72px] [mask-image:linear-gradient(to_bottom,black,transparent_78%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/30 to-transparent"
      />

      <header className="relative z-10 mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-6 sm:px-10">
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
        <nav className="hidden items-center gap-6 text-sm text-white/55 sm:flex">
          <Link href="#agents" className="transition hover:text-white">
            Agents
          </Link>
          <Link href="#safety" className="transition hover:text-white">
            Safety
          </Link>
          <Link
            href="https://github.com/OpenAdminOS/OpenAdminOS"
            target="_blank"
            rel="noreferrer"
            className="transition hover:text-white"
          >
            GitHub
          </Link>
          <a
            href={latestRelease.macosDmgUrl}
            className="rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-[#070709] transition hover:bg-white/90"
          >
            Download
          </a>
        </nav>
      </header>

      <main className="relative z-10 flex flex-1 flex-col items-center px-6 sm:px-10">
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
            The open-source control plane for Microsoft 365 agents.
          </h1>

          <p className="mt-5 max-w-2xl text-balance text-base leading-7 text-white/60 sm:text-lg">
            Run scoped agents against Intune and Entra, keep local runs local,
            and review every change before it touches your tenant.
          </p>

          <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
            <a
              href={latestRelease.macosDmgUrl}
              className="inline-flex items-center gap-2 rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-[#0a0a0c] shadow-[0_8px_30px_-4px_rgba(255,255,255,0.25)] transition hover:bg-white/90"
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
            <button
              type="button"
              disabled
              aria-disabled="true"
              title="Windows build is unsigned right now; coming after Microsoft Store signing lands."
              className="inline-flex cursor-not-allowed items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-5 py-2.5 text-sm font-medium text-white/40"
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
            </button>
          </div>

          <p className="mt-3 text-[11.5px] text-white/40">
            Free and open-source. MIT licensed.{" "}
            <Link
              href="https://github.com/OpenAdminOS/OpenAdminOS"
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
            alt="OpenAdminOS app showing agent runs across Intune-managed devices"
            width={2400}
            height={1500}
            priority
            sizes="(min-width: 1408px) 1408px, 100vw"
            className="h-auto w-full drop-shadow-[0_40px_120px_rgba(140,140,255,0.18)]"
          />
        </section>

        <section className="grid w-full max-w-7xl gap-5 py-20 md:grid-cols-[0.95fr_1.05fr] md:items-start">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300/80">
              Local-first by default
            </p>
            <h2 className="mt-3 max-w-xl text-3xl font-semibold tracking-tight sm:text-4xl">
              Bring your own tenant. Bring your own model.
            </h2>
            <p className="mt-4 max-w-xl text-sm leading-6 text-white/60 sm:text-base">
              OpenAdminOS does not resell tokens or hide egress behind vague
              copy. Local providers are marked local. Hosted providers are
              marked hosted before a run starts.
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
                Community agents with declared scopes.
              </h2>
              <p className="mt-4 text-sm leading-6 text-white/60 sm:text-base">
                Agents install from a GitHub-hosted registry. Each one declares
                the Graph scopes it needs, whether it reads or writes, and what
                kind of model it expects.
              </p>
            </div>

            <div className="overflow-hidden rounded-xl border border-white/10 bg-[#0d0e12]">
              <div className="grid grid-cols-[1fr_auto_auto] gap-3 border-b border-white/10 px-4 py-3 font-mono text-[11px] uppercase tracking-wider text-white/40">
                <span>Agent</span>
                <span>Mode</span>
                <span>Scope</span>
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
                  <span
                    className={`h-fit rounded-md border px-2 py-1 text-xs font-medium ${
                      agent.mode === "Write"
                        ? "border-amber-300/25 bg-amber-300/10 text-amber-200"
                        : "border-emerald-300/20 bg-emerald-300/10 text-emerald-200"
                    }`}
                  >
                    {agent.mode}
                  </span>
                  <code className="break-all font-mono text-xs leading-5 text-white/50">
                    {agent.scopes}
                  </code>
                </div>
              ))}
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
          </div>
        </section>

        <section className="w-full max-w-7xl border-t border-white/10 py-20">
          <div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/45">
                Open source
              </p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                If the trust model matters, fork the whole thing.
              </h2>
              <p className="mt-4 text-sm leading-6 text-white/60 sm:text-base">
                The runtime, app, bundled agents, and registry contract are open
                from day one. Audit it, change it, ship your own agents.
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

        <section className="w-full max-w-4xl pb-20 pt-4 text-center">
          <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
            Your Microsoft 365 agents deserve a review gate.
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-sm leading-6 text-white/60 sm:text-base">
            OpenAdminOS is free, open source, and built for admins who need the
            model to help without giving it unchecked access to the tenant.
          </p>
          <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href={latestRelease.macosDmgUrl}
              className="rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-[#070709] transition hover:bg-white/90"
            >
              Download for macOS
            </a>
            <Link
              href="https://github.com/OpenAdminOS/OpenAdminOS"
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
      </footer>
    </div>
  );
}
