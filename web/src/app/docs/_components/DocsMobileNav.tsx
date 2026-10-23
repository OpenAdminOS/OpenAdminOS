"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { type DocsBase, docsHref } from "~/lib/docs/paths";
import type { DocsNavSection } from "~/lib/docs/site";

import { Wordmark } from "../../Logo";
import { GITHUB_URL, SITE_URL } from "../../seo";
import { DocsSidebarNav, useDocsRoute } from "./DocsSidebarNav";

/** Slide-in page list for narrow screens. Closes on navigation and Escape. */
export function DocsMobileNav({
  base,
  nav,
}: {
  base: DocsBase;
  nav: DocsNavSection[];
}) {
  const [open, setOpen] = useState(false);
  const route = useDocsRoute();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    setOpen(false);
  }, [route]);

  useEffect(() => {
    if (!open) {
      if (wasOpen.current) toggleRef.current?.focus();
      wasOpen.current = false;
      return;
    }
    wasOpen.current = true;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    panelRef.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: "center" });

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="lg:hidden">
      <button
        ref={toggleRef}
        type="button"
        aria-expanded={open}
        aria-controls="docs-mobile-nav"
        onClick={() => setOpen(true)}
        className="-ml-1 inline-flex h-10 w-10 items-center justify-center rounded-[10px] text-brand-ink transition-colors hover:bg-brand-hover"
      >
        <span className="sr-only">Open page list</span>
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
        >
          <path d="M3.5 6h13M3.5 10h13M3.5 14h13" />
        </svg>
      </button>

      {/* Portaled to <body>: the header's backdrop-filter would otherwise
          become the containing block for these fixed elements. */}
      {mounted
        ? createPortal(
            <>
              <div
                aria-hidden
                onClick={() => setOpen(false)}
                className={`docs-scrim fixed inset-0 z-50 ${open ? "visible opacity-100" : "invisible opacity-0"}`}
              />
              <div
                id="docs-mobile-nav"
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-label="Documentation pages"
                inert={!open}
                className={`docs-drawer fixed inset-y-0 left-0 z-50 flex w-[min(21rem,88vw)] flex-col bg-brand-bg shadow-(--shadow-pop) ${
                  open ? "visible translate-x-0" : "invisible -translate-x-full"
                }`}
              >
                <div className="flex h-16 shrink-0 items-center justify-between border-b border-brand-line-soft px-4">
                  <a
                    href={docsHref(base, "")}
                    className="flex items-center gap-3 rounded-md"
                  >
                    <Wordmark />
                    <span
                      aria-hidden
                      className="h-4 w-px bg-brand-line-strong"
                    />
                    <span className="text-sm font-medium text-brand-muted">
                      Docs
                    </span>
                  </a>
                  <button
                    ref={closeRef}
                    type="button"
                    onClick={() => setOpen(false)}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-[10px] text-brand-ink transition-colors hover:bg-brand-hover"
                  >
                    <span className="sr-only">Close page list</span>
                    <svg
                      aria-hidden
                      viewBox="0 0 20 20"
                      className="h-5 w-5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeLinecap="round"
                    >
                      <path d="M5 5l10 10M15 5L5 15" />
                    </svg>
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto overscroll-contain px-3 pb-8 pt-6">
                  <DocsSidebarNav
                    base={base}
                    nav={nav}
                    onNavigate={() => setOpen(false)}
                  />
                  <div className="mt-8 space-y-px border-t border-brand-line-soft pt-6 text-sm">
                    <a
                      href={`${SITE_URL}/`}
                      className="block rounded-lg px-3 py-2 text-brand-muted hover:bg-brand-hover hover:text-brand-ink"
                    >
                      Website
                    </a>
                    <a
                      href={GITHUB_URL}
                      className="block rounded-lg px-3 py-2 text-brand-muted hover:bg-brand-hover hover:text-brand-ink"
                    >
                      GitHub
                    </a>
                    <a
                      href={`${SITE_URL}/download`}
                      className="mt-3 flex min-h-11 items-center justify-center rounded-[10px] bg-brand-ink px-4 font-medium text-brand-on-ink transition-colors hover:bg-brand-ink-hover"
                    >
                      Download
                    </a>
                  </div>
                </div>
              </div>
            </>,
            document.body,
          )
        : null}
    </div>
  );
}
