import type { Metadata } from "next";
import Link from "next/link";

import { MarketingShell, PageIntro, TextCard } from "../MarketingShell";
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

const RELEASES_URL = `${GITHUB_URL}/releases`;
const LATEST_RELEASE_URL = `${RELEASES_URL}/latest`;

const TITLE = "Download for macOS and Windows";
const DESCRIPTION =
  "Download OpenAdminOS for macOS, review release notes, and inspect the open-source Microsoft 365 admin agent runtime before running it against a tenant.";

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: "/download",
});

export default function DownloadPage() {
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      organizationSchema(),
      websiteSchema(),
      softwareApplicationSchema({ downloadUrl: LATEST_RELEASE_URL }),
      webPageSchema({
        path: "/download",
        name: TITLE,
        description: DESCRIPTION,
        dateModified: "2026-06-02",
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

      <section className="mt-12 grid gap-4 md:grid-cols-3">
        <TextCard title="macOS">
          <p>
            macOS builds are published through GitHub Releases. Review the
            release notes before connecting a production tenant.
          </p>
          <Link
            href={LATEST_RELEASE_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-5 inline-flex rounded-md bg-white px-3 py-2 text-sm font-semibold text-[#070709] transition hover:bg-white/90"
          >
            Latest macOS release
          </Link>
        </TextCard>
        <TextCard title="Windows">
          <p>
            Windows packaging is planned after signing is complete. The app
            surface and write-confirmation rules are the same across platforms.
          </p>
        </TextCard>
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
