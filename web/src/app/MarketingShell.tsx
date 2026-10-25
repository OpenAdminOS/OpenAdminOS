import Link from "next/link";
import type { ReactNode } from "react";

import { Stage, type StageTone } from "./home/Stage";
import { LogoMark, Wordmark } from "./Logo";
import { MobileNav, type MobileNavItem } from "./MobileNav";
import { ThemeToggle } from "./ThemeToggle";
import {
  DOCS_URL,
  GITHUB_URL,
  LEGAL_ENTITY_NAME,
  LINKEDIN_URL,
  MICROSOFT_NOTICE,
} from "./seo";
import { card, eyebrow } from "./ui";

const MARKETING_NAV_ITEMS: readonly MobileNavItem[] = [
  { href: "/trust-model", label: "Trust model" },
  { href: "/registry", label: "Registry" },
  { href: "/benchmarks", label: "Benchmarks" },
  { href: "/blog", label: "Blog" },
  { href: DOCS_URL, label: "Documentation", external: true },
  { href: GITHUB_URL, label: "GitHub", external: true },
  { href: "/download", label: "Download", primary: true },
];

const FOOTER_GROUPS: readonly {
  title: string;
  links: readonly { href: string; label: string; external?: boolean }[];
}[] = [
  {
    title: "Product",
    links: [
      { href: "/download", label: "Download" },
      { href: "/trust-model", label: "Trust model" },
      { href: "/registry", label: "Agent registry" },
      { href: "/llm-providers", label: "Model providers" },
      { href: "/benchmarks", label: "Benchmarks" },
    ],
  },
  {
    title: "Learn",
    links: [
      { href: DOCS_URL, label: "Documentation", external: true },
      { href: "/blog", label: "Blog" },
      { href: "/examples", label: "Examples" },
      { href: "/use-cases/intune", label: "Intune use cases" },
    ],
  },
  {
    title: "Project",
    links: [
      { href: GITHUB_URL, label: "GitHub", external: true },
      { href: LINKEDIN_URL, label: "LinkedIn", external: true },
      { href: "/privacy", label: "Privacy" },
      { href: "/terms", label: "Terms" },
      { href: "/legal-notice", label: "Legal notice" },
    ],
  },
];

export function MarketingShell({
  children,
  bare = false,
  announcement,
}: {
  children: ReactNode;
  /** Full-bleed main area for pages that lay out their own bands. */
  bare?: boolean;
  /** One-line notice above the header, such as the latest release. */
  announcement?: { href: string; label: string };
}) {
  return (
    <div className="relative flex min-h-screen flex-col bg-brand-bg text-brand-ink">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-brand-ink focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-brand-on-ink"
      >
        Skip to content
      </a>
      {announcement ? (
        <Link
          href={announcement.href}
          target="_blank"
          rel="noreferrer"
          className="block bg-brand-ink px-6 py-2.5 text-center text-[13px] text-brand-on-ink transition-colors hover:bg-brand-ink-hover"
        >
          <span className="line-clamp-1">
            {announcement.label} <span aria-hidden>→</span>
          </span>
        </Link>
      ) : null}
      <header className="sticky top-0 z-40 border-b border-brand-line-soft bg-brand-bg/85 backdrop-blur-md supports-[backdrop-filter]:bg-brand-bg/70">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-6 sm:px-10">
          <Link href="/" aria-label="OpenAdminOS home" className="rounded-md">
            <Wordmark />
          </Link>
          <nav
            aria-label="Main"
            className="hidden items-center gap-1 text-sm text-brand-muted lg:flex"
          >
            {MARKETING_NAV_ITEMS.filter((item) => !item.primary).map((item) => (
              <Link
                key={item.href}
                href={item.href}
                target={item.external ? "_blank" : undefined}
                rel={item.external ? "noreferrer" : undefined}
                className="rounded-lg px-3 py-1.5 transition-colors hover:bg-brand-hover hover:text-brand-ink"
              >
                {item.label}
              </Link>
            ))}
            <ThemeToggle className="ml-2" />
            {MARKETING_NAV_ITEMS.filter((item) => item.primary).map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="ml-2 inline-flex h-9 items-center rounded-[10px] bg-brand-ink px-3.5 font-medium text-brand-on-ink transition-colors hover:bg-brand-ink-hover"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-2 lg:hidden">
            <ThemeToggle />
            <MobileNav items={MARKETING_NAV_ITEMS} />
          </div>
        </div>
      </header>

      <main
        id="main-content"
        tabIndex={-1}
        className={
          bare
            ? "relative flex-1 focus:outline-none"
            : "relative mx-auto w-full max-w-7xl flex-1 px-6 pb-24 pt-14 focus:outline-none sm:px-10 sm:pt-20"
        }
      >
        {children}
      </main>

      <footer className="border-t border-brand-line bg-brand-surface">
        <div className="mx-auto grid w-full max-w-7xl gap-12 px-6 py-14 sm:px-10 md:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div className="max-w-xs">
            <Link href="/" aria-label="OpenAdminOS home" className="rounded-md">
              <Wordmark />
            </Link>
            <p className="mt-4 text-sm leading-6 text-brand-muted">
              Open-source, local-first agents for Microsoft 365 admins. MIT
              licensed.
            </p>
          </div>
          {FOOTER_GROUPS.map((group) => (
            <nav key={group.title} aria-label={group.title}>
              <p className={eyebrow}>{group.title}</p>
              <ul className="mt-4 space-y-2.5 text-sm">
                {group.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      target={link.external ? "_blank" : undefined}
                      rel={link.external ? "noreferrer" : undefined}
                      className="text-brand-muted transition-colors hover:text-brand-ink"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="border-t border-brand-line-soft">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-6 py-6 text-xs leading-5 text-brand-faint sm:px-10 md:flex-row md:items-center md:justify-between">
            <span className="inline-flex items-center gap-2">
              <LogoMark className="h-3.5 w-3.5" />© {new Date().getFullYear()}{" "}
              {LEGAL_ENTITY_NAME}
            </span>
            <p className="max-w-2xl text-balance md:text-right">{MICROSOFT_NOTICE}</p>
          </div>
        </div>
      </footer>
    </div>
  );
}

export function PageIntro({
  eyebrow: label,
  title,
  description,
  tone = "sand",
}: {
  eyebrow: string;
  title: string;
  description: string;
  tone?: StageTone;
}) {
  return (
    <section>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:items-end lg:gap-16" data-reveal>
        <div>
          <p className={eyebrow}>{label}</p>
          <h1 className="font-display mt-4 text-balance text-[2.6rem] leading-[1.04] sm:text-[4rem]">
            {title}
          </h1>
        </div>
        <p className="text-pretty text-base leading-7 text-brand-muted sm:text-lg sm:leading-8 lg:pb-2">
          {description}
        </p>
      </div>
      <Stage tone={tone} className="mt-12 h-28 rounded-[18px] sm:h-40" />
    </section>
  );
}

export function TextCard({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className={`${card} p-6`}>
      <h2 className="font-display text-[1.45rem] leading-tight">{title}</h2>
      <div className="mt-3 text-sm leading-6 text-brand-muted">{children}</div>
    </section>
  );
}
