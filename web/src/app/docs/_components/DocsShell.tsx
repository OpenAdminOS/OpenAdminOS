import "./docs.css";

import Link from "next/link";
import type { ReactNode } from "react";

import { DOCS_NAV, type DocsBase, docsHref } from "~/lib/docs/site";

import { LogoMark, Wordmark } from "../../Logo";
import { GITHUB_URL, SITE_URL } from "../../seo";
import { ThemeToggle } from "../../ThemeToggle";
import { DocsMobileNav } from "./DocsMobileNav";
import { DocsSearch } from "./DocsSearch";
import { DocsSidebarNav } from "./DocsSidebarNav";

export const DOCS_TOP_LINKS = [
  { href: `${SITE_URL}/`, label: "Website" },
  { href: GITHUB_URL, label: "GitHub" },
] as const;

export const DOCS_DOWNLOAD_URL = `${SITE_URL}/download`;

/**
 * Persistent docs chrome: top bar, sidebar, and footer. Rendered from a
 * layout so the sidebar keeps its scroll position between pages.
 */
export function DocsShell({
  base,
  children,
}: {
  base: DocsBase;
  children: ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen flex-col bg-brand-bg text-brand-ink">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-brand-ink focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-brand-on-ink"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-brand-line-soft bg-brand-bg/85 backdrop-blur-md supports-[backdrop-filter]:bg-brand-bg/70">
        <div className="mx-auto flex h-16 w-full max-w-[90rem] items-center gap-2 px-4 sm:px-6 lg:gap-6 lg:px-8">
          <DocsMobileNav base={base} nav={DOCS_NAV} />
          <Link
            href={docsHref(base, "")}
            aria-label="OpenAdminOS docs home"
            className="flex shrink-0 items-center gap-3 rounded-md"
          >
            <Wordmark />
            <span aria-hidden className="h-4 w-px bg-brand-line-strong" />
            <span className="text-sm font-medium text-brand-muted">Docs</span>
          </Link>
          <div className="flex flex-1 items-center justify-end gap-1 md:justify-center">
            <DocsSearch base={base} />
            <ThemeToggle className="md:hidden" />
          </div>
          <nav
            aria-label="Site"
            className="hidden items-center gap-1 text-sm text-brand-muted md:flex"
          >
            {DOCS_TOP_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="rounded-lg px-3 py-1.5 transition-colors hover:bg-brand-hover hover:text-brand-ink"
              >
                {link.label}
              </a>
            ))}
            <ThemeToggle className="ml-1" />
            <a
              href={DOCS_DOWNLOAD_URL}
              className="ml-2 inline-flex h-9 items-center rounded-[10px] bg-brand-ink px-3.5 font-medium text-brand-on-ink transition-colors hover:bg-brand-ink-hover"
            >
              Download
            </a>
          </nav>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[90rem] flex-1 lg:grid lg:grid-cols-[17rem_minmax(0,1fr)]">
        <aside
          aria-label="Documentation"
          className="sticky top-16 hidden h-[calc(100dvh-4rem)] overflow-y-auto overscroll-contain border-r border-brand-line-soft px-4 pb-10 pt-3 lg:block"
        >
          <DocsSidebarNav base={base} nav={DOCS_NAV} />
        </aside>
        <div className="min-w-0">{children}</div>
      </div>

      <footer className="border-t border-brand-line-soft">
        <div className="mx-auto flex w-full max-w-[90rem] flex-col gap-4 px-4 py-8 text-xs leading-5 text-brand-faint sm:px-6 md:flex-row md:items-center md:justify-between lg:px-8">
          <span className="inline-flex items-center gap-2">
            <LogoMark className="h-3.5 w-3.5" />© {new Date().getFullYear()}{" "}
            OpenAdminOS. MIT licensed.
          </span>
          <nav aria-label="Legal" className="flex flex-wrap gap-x-5 gap-y-2">
            <a
              href={`${SITE_URL}/`}
              className="transition-colors hover:text-brand-ink"
            >
              openadminos.com
            </a>
            <a
              href={`${SITE_URL}/privacy`}
              className="transition-colors hover:text-brand-ink"
            >
              Privacy
            </a>
            <a
              href={`${SITE_URL}/legal-notice`}
              className="transition-colors hover:text-brand-ink"
            >
              Legal notice
            </a>
            <a
              href={GITHUB_URL}
              className="transition-colors hover:text-brand-ink"
            >
              GitHub
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
