"use client";

import { useSyncExternalStore } from "react";

import { THEME_STORAGE_KEY } from "./theme";

type Theme = "light" | "dark";

/*
 * One source of truth for every toggle on the page: the data-theme attribute
 * the head script sets on <html>. Each instance subscribes to it, so the
 * header and mobile toggles (and the system-change listener in the head
 * script) always agree. Choices made in another tab arrive as storage events.
 */

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function storedTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : null;
  } catch {
    return null;
  }
}

function subscribe(onChange: () => void) {
  const root = document.documentElement;
  const attributes = new MutationObserver(onChange);
  attributes.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    root.dataset.theme = storedTheme() ?? systemTheme();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    attributes.disconnect();
    window.removeEventListener("storage", onStorage);
  };
}

function getTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/**
 * Switches between light and dark; every click changes what you see. A choice
 * that matches the operating system clears the saved preference, so the site
 * goes back to following the system. The choice stays on this device.
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  // Null on the server and during hydration; the head script has already
  // painted the right theme, only the label waits.
  const theme = useSyncExternalStore(subscribe, getTheme, () => null);
  const next: Theme = theme === "dark" ? "light" : "dark";
  const label = theme ? `Switch to ${next} theme` : "Switch theme";

  return (
    <button
      type="button"
      onClick={() => {
        try {
          if (next === systemTheme()) localStorage.removeItem(THEME_STORAGE_KEY);
          else localStorage.setItem(THEME_STORAGE_KEY, next);
        } catch {
          // Storage can be unavailable (private modes); the choice still
          // applies for this page view.
        }
        document.documentElement.dataset.theme = next;
      }}
      aria-label={label}
      title={label}
      className={`theme-toggle inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-brand-muted transition-colors hover:bg-brand-hover hover:text-brand-ink ${className}`}
    >
      <ThemeIcon theme={theme} />
    </button>
  );
}

/** Shows the theme a click switches to; a neutral mark until hydration. */
function ThemeIcon({ theme }: { theme: Theme | null }) {
  const common = {
    "aria-hidden": true,
    viewBox: "0 0 24 24",
    className: "h-[18px] w-[18px]",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (theme === "dark") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.64 5.64l1.06 1.06M17.3 17.3l1.06 1.06M5.64 18.36l1.06-1.06M17.3 6.7l1.06-1.06" />
      </svg>
    );
  }
  if (theme === "light") {
    return (
      <svg {...common}>
        <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" />
    </svg>
  );
}
