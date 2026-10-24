"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * Fades sections in as they scroll into view. Elements opt in with
 * `data-reveal`. Without JavaScript, or with reduced motion, everything is
 * simply visible. Elements that mount later (client-rendered or streamed in
 * after this effect ran) are picked up too, so nothing stays hidden.
 */
export function RevealObserver() {
  const pathname = usePathname();

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

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

    // Anything already on screen is shown at once, so it never flickers;
    // the rest waits for the observer.
    const track = (elements: Iterable<HTMLElement>) => {
      for (const element of elements) {
        if (element.classList.contains("is-revealed")) continue;
        if (element.getBoundingClientRect().top < window.innerHeight) {
          element.classList.add("is-revealed");
        } else {
          observer.observe(element);
        }
      }
    };

    track(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    document.documentElement.classList.add("js-reveal");

    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches("[data-reveal]")) track([node]);
          track(node.querySelectorAll<HTMLElement>("[data-reveal]"));
        }
      }
    });
    mutations.observe(document.body, { childList: true, subtree: true });

    return () => {
      mutations.disconnect();
      observer.disconnect();
    };
  }, [pathname]);

  return null;
}
