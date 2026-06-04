"use client";

import { usePathname } from "next/navigation";
import { useEffect, useId, useState } from "react";

export interface MobileNavItem {
  href: string;
  label: string;
  external?: boolean;
  primary?: boolean;
}

export function MobileNav({ items }: { items: readonly MobileNavItem[] }) {
  const [isOpen, setIsOpen] = useState(false);
  const menuId = useId();
  const pathname = usePathname();

  function closeIfRouteWillNotChange(item: MobileNavItem) {
    if (item.external || item.href === pathname) setIsOpen(false);
  }

  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setIsOpen(false);
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  useEffect(() => {
    setIsOpen(false);
  }, [pathname]);

  return (
    <div className="relative md:hidden">
      <button
        type="button"
        aria-controls={menuId}
        aria-expanded={isOpen}
        title={isOpen ? "Close menu" : "Open menu"}
        onClick={() => setIsOpen((current) => !current)}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-white/10 bg-white/[0.035] text-white/70 transition hover:border-white/20 hover:text-white focus:outline-none focus:ring-2 focus:ring-white/30"
      >
        <span className="sr-only">{isOpen ? "Close menu" : "Open menu"}</span>
        <span
          aria-hidden
          className="flex h-4 w-4 flex-col justify-center gap-1"
        >
          <span
            className={`block h-px w-4 bg-current transition ${
              isOpen ? "translate-y-[5px] rotate-45" : ""
            }`}
          />
          <span
            className={`block h-px w-4 bg-current transition ${
              isOpen ? "opacity-0" : ""
            }`}
          />
          <span
            className={`block h-px w-4 bg-current transition ${
              isOpen ? "-translate-y-[5px] -rotate-45" : ""
            }`}
          />
        </span>
      </button>

      {isOpen && (
        <div
          aria-hidden="true"
          onClick={() => setIsOpen(false)}
          className="fixed inset-0 z-30 cursor-default bg-transparent"
        />
      )}

      <nav
        id={menuId}
        aria-label="Mobile navigation"
        aria-hidden={!isOpen}
        className={`absolute right-0 top-[calc(100%+0.75rem)] z-40 w-[min(18rem,calc(100vw-3rem))] origin-top-right overflow-hidden rounded-lg border border-white/10 bg-[#101116]/95 p-1 shadow-[0_24px_80px_rgba(0,0,0,0.42)] backdrop-blur transition ${
          isOpen
            ? "pointer-events-auto translate-y-0 scale-100 opacity-100"
            : "pointer-events-none -translate-y-1 scale-[0.98] opacity-0"
        }`}
      >
        {items.map((item) => (
          <a
            key={item.href}
            href={item.href}
            target={item.external ? "_blank" : undefined}
            rel={item.external ? "noreferrer" : undefined}
            tabIndex={isOpen ? undefined : -1}
            onClick={() => closeIfRouteWillNotChange(item)}
            className={`block rounded-md px-3 py-2.5 text-sm transition ${
              item.primary
                ? "bg-white text-[#070709] hover:bg-white/90"
                : "text-white/70 hover:bg-white/[0.06] hover:text-white"
            }`}
          >
            {item.label}
          </a>
        ))}
      </nav>
    </div>
  );
}
