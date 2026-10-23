"use client";

import { useEffect, useState } from "react";

import type { DocsHeading } from "~/lib/docs/site";

/** "On this page" list that follows the reader's scroll position. */
export function DocsToc({ headings }: { headings: DocsHeading[] }) {
  const [active, setActive] = useState(headings[0]?.id ?? "");

  useEffect(() => {
    const elements = headings
      .map((heading) => document.getElementById(heading.id))
      .filter((element): element is HTMLElement => Boolean(element));
    if (elements.length === 0) return;

    let frame = 0;
    function update() {
      frame = 0;
      const offset = 120;
      let current = elements[0]?.id ?? "";
      for (const element of elements) {
        if (element.getBoundingClientRect().top - offset <= 0)
          current = element.id;
        else break;
      }
      const atBottom =
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 4;
      if (atBottom) current = elements[elements.length - 1]?.id ?? current;
      setActive(current);
    }
    function onScroll() {
      if (!frame) frame = requestAnimationFrame(update);
    }

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [headings]);

  if (headings.length === 0) return null;

  return (
    <nav aria-label="On this page">
      <p className="text-[13px] font-medium text-brand-faint">On this page</p>
      <ul className="mt-3 space-y-px border-l border-brand-line-soft">
        {headings.map((heading) => {
          const isActive = heading.id === active;
          return (
            <li key={heading.id}>
              <a
                href={`#${heading.id}`}
                aria-current={isActive ? "location" : undefined}
                className={`-ml-px block border-l py-1 text-[13px] leading-5 transition-colors ${
                  heading.depth === 3 ? "pl-6" : "pl-3"
                } ${
                  isActive
                    ? "border-brand-ink text-brand-ink"
                    : "border-transparent text-brand-muted hover:text-brand-ink"
                }`}
              >
                {heading.text}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
