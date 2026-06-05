import Link from "next/link";
import type { ReactNode } from "react";

import { MobileNav, type MobileNavItem } from "./MobileNav";
import { DOCS_URL, GITHUB_URL, LINKEDIN_URL } from "./seo";

const MARKETING_NAV_ITEMS: readonly MobileNavItem[] = [
  { href: "/blog", label: "Blog" },
  { href: DOCS_URL, label: "Documentation", external: true },
  { href: GITHUB_URL, label: "GitHub", external: true },
  { href: "/download", label: "Download", primary: true },
];

export function MarketingShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-[#070709] text-white">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:72px_72px] [mask-image:linear-gradient(to_bottom,black,transparent_72%)]"
      />
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
          {MARKETING_NAV_ITEMS.map((item) => (
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
        <MobileNav items={MARKETING_NAV_ITEMS} />
      </header>

      <main className="relative z-10 mx-auto w-full max-w-7xl flex-1 px-6 pb-20 pt-10 sm:px-10">
        {children}
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
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="underline-offset-4 transition hover:text-white/70 hover:underline"
          >
            GitHub
          </Link>
          {" · "}
          <Link
            href={LINKEDIN_URL}
            target="_blank"
            rel="noreferrer"
            className="underline-offset-4 transition hover:text-white/70 hover:underline"
          >
            LinkedIn
          </Link>
        </span>
        <p className="max-w-2xl text-balance text-[11px] leading-5 text-white/30">
          Microsoft 365, Intune, Entra, and Microsoft Graph are trademarks of the
          Microsoft group of companies. OpenAdminOS is not affiliated with,
          endorsed by, or sponsored by Microsoft.
        </p>
      </footer>
    </div>
  );
}

export function PageIntro({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <section className="max-w-3xl">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/45">
        {eyebrow}
      </p>
      <h1 className="mt-3 text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
        {title}
      </h1>
      <p className="mt-5 text-base leading-7 text-white/62 sm:text-lg">
        {description}
      </p>
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
    <section
      id={id}
      className="rounded-lg border border-white/10 bg-white/[0.035] p-5"
    >
      <h2 className="text-lg font-semibold tracking-tight text-white">
        {title}
      </h2>
      <div className="mt-3 text-sm leading-6 text-white/60">{children}</div>
    </section>
  );
}
