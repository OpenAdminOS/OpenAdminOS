"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * Fades sections in as they scroll into view. Elements opt in with
 * `data-reveal`. Without JavaScript, or with reduced motion, everything is
 * simply visible.
 */
export function RevealObserver() {
  const pathname = usePathname();

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const elements = Array.from(
      document.querySelectorAll<HTMLElement>("[data-reveal]:not(.is-revealed)"),
    );
    // Anything already on screen is shown before the hiding class lands, so
    // the first paint never flickers.
    for (const element of elements) {
      if (element.getBoundingClientRect().top < window.innerHeight) {
        element.classList.add("is-revealed");
      }
    }
    document.documentElement.classList.add("js-reveal");

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-revealed");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.08 },
    );

    for (const element of elements) {
      if (!element.classList.contains("is-revealed")) observer.observe(element);
    }

    return () => observer.disconnect();
  }, [pathname]);

  return null;
}
