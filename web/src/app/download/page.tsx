import type { Metadata } from "next";
import Link from "next/link";

import { MarketingShell, PageIntro, TextCard } from "../MarketingShell";
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
        dateModified: "2026-06-04",
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

      <section className="mt-12 grid gap-4 lg:grid-cols-[0.85fr_1.4fr_0.85fr]">
        <TextCard title="macOS">
          <p>
            macOS builds are published through GitHub Releases. Review the
            release notes before connecting a production tenant.
          </p>
          <Link
            href={latestRelease.macosDmgUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-5 inline-flex rounded-md bg-white px-3 py-2 text-sm font-semibold text-[#070709] transition hover:bg-white/90"
          >
            Download DMG
          </Link>
        </TextCard>
        <TextCard id="linux-packages" title="Linux x64">
          <p>
            Pick the package format that matches your workstation. Linux
            packages are unsigned, so verify the SHA-256 hash before
            installing.
          </p>

          <div className="mt-5 grid gap-3">
            <PackageDownload
              actionLabel="Download AppImage"
              detail="Most desktop distros"
              hash={latestRelease.linuxAppImage.sha256}
              href={latestRelease.linuxAppImage.url}
              label="AppImage"
              primary
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <PackageDownload
                actionLabel="Download .deb"
                detail="Ubuntu, Debian"
                hash={latestRelease.linuxDeb.sha256}
                href={latestRelease.linuxDeb.url}
                label=".deb"
              />
              <PackageDownload
                actionLabel="Download .rpm"
                detail="Fedora, RHEL"
                hash={latestRelease.linuxRpm.sha256}
                href={latestRelease.linuxRpm.url}
                label=".rpm"
              />
            </div>
          </div>

          <Link
            href={latestRelease.checksumUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-4 inline-flex text-sm font-medium text-white underline-offset-4 transition hover:text-white/70 hover:underline"
          >
            Open SHA256SUMS.txt
          </Link>
        </TextCard>
        <TextCard title="Windows">
          <p>
            Windows packaging is planned after signing is complete. The app
            surface and write-confirmation rules are the same across platforms.
          </p>
        </TextCard>
      </section>

      <section className="mt-4">
        <TextCard title="Source">
          <p>
            The app, runtime, registry contract, and SDK are open-source under
            the MIT License.
          </p>
          <Link
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-5 inline-flex text-sm font-medium text-white underline-offset-4 transition hover:text-white/70 hover:underline"
          >
            Inspect the repository
          </Link>
        </TextCard>
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
            className="inline-flex font-medium text-white underline-offset-4 transition hover:text-white/70 hover:underline"
          >
            Read the trust model
          </Link>
        </div>
      </section>
    </MarketingShell>
  );
}

function PackageDownload({
  actionLabel,
  detail,
  hash,
  href,
  label,
  primary = false,
}: {
  actionLabel: string;
  detail: string;
  hash: string | undefined;
  href: string;
  label: string;
  primary?: boolean;
}) {
  return (
    <div
      className={
        primary
          ? "min-w-0 rounded-md border border-white/15 bg-white/[0.055] p-3"
          : "min-w-0 rounded-md border border-white/10 bg-white/[0.035] p-3"
      }
    >
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-white">{label}</h3>
          <p className="mt-1 text-xs leading-4 text-white/45">{detail}</p>
        </div>
        <Link
          href={href}
          target="_blank"
          rel="noreferrer"
          className={
            primary
              ? "inline-flex shrink-0 items-center justify-center gap-2 rounded-md bg-white px-3 py-2 text-sm font-semibold text-[#070709] transition hover:bg-white/90"
              : "inline-flex shrink-0 items-center justify-center rounded-md border border-white/10 px-3 py-2 text-xs font-semibold text-white/70 transition hover:border-white/25 hover:text-white"
          }
        >
          {primary ? (
            <img
              src="/linux.svg"
              alt=""
              aria-hidden
              width={16}
              height={16}
              className="h-4 w-4"
            />
          ) : null}
          {actionLabel}
        </Link>
      </div>
      <ChecksumValue hash={hash} />
    </div>
  );
}

function ChecksumValue({ hash }: { hash: string | undefined }) {
  return (
    <div className="mt-3 min-w-0">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/35">
        SHA-256
      </p>
      <code
        className={
          hash
            ? "mt-1 block max-w-full break-all rounded border border-white/10 bg-black/25 px-2 py-1.5 font-mono text-[10px] leading-4 text-white/65 [overflow-wrap:anywhere]"
            : "mt-1 block max-w-full rounded border border-white/10 bg-black/20 px-2 py-1.5 text-[11px] leading-4 text-white/35"
        }
      >
        {hash ?? "Checksum unavailable"}
      </code>
    </div>
  );
}
