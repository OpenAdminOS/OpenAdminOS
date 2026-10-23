"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

import { type DocsBase, docsHref } from "~/lib/docs/paths";
import type { DocsNavPage, DocsNavSection } from "~/lib/docs/site";

/**
 * Reads the active page from the route params rather than the URL, so it
 * matches on docs.openadminos.com, where requests arrive through a rewrite.
 */
export function useDocsRoute() {
  const params = useParams<{ slug?: string[] }>();
  return (params.slug ?? []).map((part) => decodeURIComponent(part)).join("/");
}

function NavItems({
  pages,
  base,
  current,
  depth,
  onNavigate,
}: {
  pages: DocsNavPage[];
  base: DocsBase;
  current: string;
  depth: number;
  onNavigate?: () => void;
}) {
  return (
    <ul
      className={
        depth > 0
          ? "ml-3 mt-0.5 border-l border-brand-line-soft pl-2"
          : "space-y-px"
      }
    >
      {pages.map((page) => {
        const active = page.route === current;
        return (
          <li key={page.source}>
            <Link
              href={docsHref(base, page.route)}
              aria-current={active ? "page" : undefined}
              onClick={onNavigate}
              className={`block rounded-lg px-3 py-[0.4rem] text-sm leading-5 transition-colors ${
                active
                  ? "bg-brand-hover font-medium text-brand-ink"
                  : "text-brand-muted hover:bg-brand-hover hover:text-brand-ink"
              }`}
            >
              {page.title}
            </Link>
            {page.children.length > 0 ? (
              <NavItems
                pages={page.children}
                base={base}
                current={current}
                depth={depth + 1}
                onNavigate={onNavigate}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function DocsSidebarNav({
  base,
  nav,
  onNavigate,
}: {
  base: DocsBase;
  nav: DocsNavSection[];
  onNavigate?: () => void;
}) {
  const current = useDocsRoute();

  return (
    <nav aria-label="Documentation pages" className="space-y-7">
      {nav.map((section) => (
        <div key={section.slug}>
          <p className="px-3 pb-1.5 text-[13px] font-medium text-brand-faint">
            {section.title}
          </p>
          <NavItems
            pages={section.pages}
            base={base}
            current={current}
            depth={0}
            onNavigate={onNavigate}
          />
        </div>
      ))}
    </nav>
  );
}
