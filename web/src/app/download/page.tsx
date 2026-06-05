import type { Metadata } from "next";
import Link from "next/link";

import { MarketingShell, PageIntro } from "../MarketingShell";
import { getLatestReleaseDownloads } from "../release-downloads";
import {
  GITHUB_URL,
  JsonLd,
  breadcrumbSchema,
  organizationSchema,
  pageMetadata,
  softwareApplicationSchema,
  webPageSchema,
  websiteSchema,
} from "../seo";

export const revalidate = 900;

const TITLE = "Download for macOS and Linux";
const DESCRIPTION =
  "Download OpenAdminOS for macOS or Linux, review release notes, and inspect the open-source Microsoft 365 admin agent runtime before running it against a tenant.";

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: "/download",
});

export default async function DownloadPage() {
  const latestRelease = await getLatestReleaseDownloads();
  const macosPackages = [
    {
      actionLabel: "Download .dmg",
      badge: "Default",
      detail: "Direct install for individual workstations",
      hash: latestRelease.macosDmg.sha256,
      href: latestRelease.macosDmg.url,
      label: ".dmg",
      meta: "Apple Silicon · signed and notarized",
      primary: true,
    },
    {
      actionLabel: "Download .pkg",
      badge: "Managed",
      detail: "Installer package for MDM, Jamf, Munki, or fleet rollout",
      hash: latestRelease.macosPkg.sha256,
      href: latestRelease.macosPkg.url,
      label: ".pkg",
      meta: "Apple Silicon · signed and notarized",
    },
  ];
  const linuxPackages = [
    {
      actionLabel: "Download AppImage",
      badge: "Portable",
      detail: "Runs on most desktop distributions",
      hash: latestRelease.linuxAppImage.sha256,
      href: latestRelease.linuxAppImage.url,
      label: "AppImage",
      meta: "Linux x64 · unsigned",
      primary: true,
    },
    {
      actionLabel: "Download .deb",
      detail: "Ubuntu and Debian-family systems",
      hash: latestRelease.linuxDeb.sha256,
      href: latestRelease.linuxDeb.url,
      label: ".deb",
      meta: "Linux x64 · unsigned",
    },
    {
      actionLabel: "Download .rpm",
      detail: "Fedora, RHEL, and compatible systems",
      hash: latestRelease.linuxRpm.sha256,
      href: latestRelease.linuxRpm.url,
      label: ".rpm",
      meta: "Linux x64 · unsigned",
    },
  ];
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      organizationSchema(),
      websiteSchema(),
      softwareApplicationSchema({
        downloadUrl: latestRelease.releaseNotesUrl,
        operatingSystem: "macOS, Linux",
        version: latestRelease.version,
      }),
      webPageSchema({
        path: "/download",
        name: TITLE,
        description: DESCRIPTION,
        dateModified: "2026-06-05",
      }),
      breadcrumbSchema([
        { name: "Home", path: "/" },
        { name: "Download", path: "/download" },
      ]),
    ],
  };

  return (
    <MarketingShell>
      <JsonLd data={structuredData} />
      <PageIntro
        eyebrow="Download"
        title="Download the local-first desktop app."
        description={DESCRIPTION}
      />

      <section className="mt-10 border-y border-white/10">
        <div className="flex flex-col gap-3 border-b border-white/10 py-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/38">
              Current release
            </p>
            <p className="mt-1 font-mono text-sm text-white/70">
              {latestRelease.version}
            </p>
          </div>
          <div className="flex flex-wrap gap-3 text-sm">
            <Link
              href={latestRelease.releaseNotesUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 items-center rounded-md border border-white/10 px-3 font-medium text-white/70 transition hover:border-white/25 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/35"
            >
              Release notes
            </Link>
            <Link
              href={latestRelease.checksumUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 items-center rounded-md border border-white/10 px-3 font-medium text-white/70 transition hover:border-white/25 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/35"
            >
              SHA256SUMS.txt
            </Link>
          </div>
        </div>

        <DownloadGroup
          description="Use the DMG for a normal workstation install. Use the PKG when you need a managed deployment package."
          id="macos-packages"
          items={macosPackages}
          title="macOS"
        />
        <DownloadGroup
          description="Linux packages are unsigned preview builds. Verify the SHA-256 hash before installing."
          id="linux-packages"
          items={linuxPackages}
          title="Linux x64"
        />
        <section className="grid gap-4 border-t border-white/10 py-6 md:grid-cols-[180px_1fr]">
          <div>
            <h2 className="text-base font-semibold text-white">Windows</h2>
            <p className="mt-1 text-xs font-semibold uppercase tracking-[0.18em] text-white/35">
              Planned
            </p>
          </div>
          <p className="max-w-2xl text-sm leading-6 text-white/55">
            Windows packaging is planned after signing is complete. The app
            surface and write-confirmation rules are the same across platforms.
          </p>
        </section>
      </section>

      <section className="mt-12 grid gap-8 border-t border-white/10 pt-12 md:grid-cols-[0.8fr_1.2fr]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/45">
            Source
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight">
            Inspect the code before connecting a tenant.
          </h2>
        </div>
        <div className="text-sm leading-6 text-white/62">
          <p>
            The app, runtime, registry contract, and SDK are open-source under
            the MIT License.
          </p>
          <Link
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-5 inline-flex text-sm font-medium text-white underline-offset-4 transition hover:text-white/70 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-white/35"
          >
            Inspect the repository
          </Link>
        </div>
      </section>

      <section className="mt-12 grid gap-5 border-t border-white/10 pt-12 md:grid-cols-[0.9fr_1.1fr]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/45">
            Before first run
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight">
            Connect a tenant and choose a model provider.
          </h2>
        </div>
        <div className="space-y-5 text-sm leading-6 text-white/62">
          <p>
            OpenAdminOS uses MSAL for Microsoft 365 tenant consent and Microsoft
            Graph access. Local model providers keep prompts and tenant context
            on the workstation. Hosted providers are optional and labeled before
            tenant context leaves the device.
          </p>
          <p>
            Read-only agents can run after consent. Write agents always stop at
            a diff confirmation screen before changing tenant state.
          </p>
          <Link
            href="/trust-model"
            className="inline-flex font-medium text-white underline-offset-4 transition hover:text-white/70 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-white/35"
          >
            Read the trust model
          </Link>
        </div>
      </section>
    </MarketingShell>
  );
}

interface DownloadItem {
  actionLabel: string;
  badge?: string;
  detail: string;
  hash: string | undefined;
  href: string;
  label: string;
  meta: string;
  primary?: boolean;
}

function DownloadGroup({
  description,
  id,
  items,
  title,
}: {
  description: string;
  id: string;
  items: DownloadItem[];
  title: string;
}) {
  return (
    <section
      id={id}
      className="grid gap-4 border-b border-white/10 py-6 last:border-b-0 md:grid-cols-[180px_1fr]"
    >
      <div>
        <h2 className="text-base font-semibold text-white">{title}</h2>
        <p className="mt-2 text-sm leading-5 text-white/48">{description}</p>
      </div>
      <div className="divide-y divide-white/10 border-y border-white/10">
        {items.map((item) => (
          <DownloadRow item={item} key={item.label} />
        ))}
      </div>
    </section>
  );
}

function DownloadRow({ item }: { item: DownloadItem }) {
  return (
    <div className="grid gap-4 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-white">{item.label}</h3>
          {item.badge ? (
            <span className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/45">
              {item.badge}
            </span>
          ) : null}
          <span className="text-xs text-white/35">{item.meta}</span>
        </div>
        <p className="mt-1 text-sm leading-5 text-white/55">{item.detail}</p>
        <ChecksumValue hash={item.hash} />
      </div>
      <Link
        href={item.href}
        target="_blank"
        rel="noreferrer"
        className={
          item.primary
            ? "inline-flex min-h-11 w-full items-center justify-center whitespace-nowrap rounded-md bg-white px-3 text-sm font-semibold text-[#070709] transition hover:bg-white/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/35 md:w-44"
            : "inline-flex min-h-11 w-full items-center justify-center whitespace-nowrap rounded-md border border-white/10 px-3 text-sm font-semibold text-white/70 transition hover:border-white/25 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/35 md:w-44"
        }
      >
        {item.actionLabel}
      </Link>
    </div>
  );
}

function ChecksumValue({ hash }: { hash: string | undefined }) {
  return (
    <div className="mt-3 grid min-w-0 gap-1 sm:grid-cols-[72px_1fr] sm:items-start">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/35">
        SHA-256
      </p>
      <code className="block max-w-full break-all font-mono text-[10px] leading-4 text-white/58 [overflow-wrap:anywhere]">
        {hash ?? "Checksum unavailable"}
      </code>
    </div>
  );
}
