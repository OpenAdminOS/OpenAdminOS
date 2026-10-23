"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Renders the prebuilt page HTML and adds the two interactive bits it needs:
 * copy buttons on code blocks and client-side navigation for docs links.
 */
export function DocsArticle({ html }: { html: string }) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const timers = new Set<ReturnType<typeof setTimeout>>();

    function onClick(event: MouseEvent) {
      const target = event.target as HTMLElement | null;

      const copy = target?.closest<HTMLButtonElement>("button[data-copy]");
      if (copy) {
        const code =
          copy.parentElement?.querySelector("pre")?.textContent ?? "";
        // The Clipboard API exists only in secure contexts.
        const write = navigator.clipboard
          ? navigator.clipboard.writeText(code)
          : Promise.reject(new Error("Clipboard unavailable"));
        write.then(
          () => {
            copy.textContent = "Copied";
          },
          () => {
            copy.textContent = "Copy failed";
          },
        );
        const timer = setTimeout(() => {
          copy.textContent = "Copy";
          timers.delete(timer);
        }, 1600);
        timers.add(timer);
        return;
      }

      const link = target?.closest<HTMLAnchorElement>("a[data-docs-link]");
      if (
        link &&
        event.button === 0 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey
      ) {
        event.preventDefault();
        router.push(link.getAttribute("href") ?? "/");
      }
    }

    root.addEventListener("click", onClick);
    return () => {
      root.removeEventListener("click", onClick);
      for (const timer of timers) clearTimeout(timer);
    };
  }, [router]);

  return (
    <div
      ref={ref}
      className="docs-prose"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
