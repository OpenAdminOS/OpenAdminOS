"use client";

import { useEffect, useState } from "react";

import { THEME_STORAGE_KEY, type ThemePreference } from "./theme";

const ORDER: readonly ThemePreference[] = ["system", "light", "dark"];

const LABELS: Record<ThemePreference, string> = {
  system: "System theme",
  light: "Light theme",
  dark: "Dark theme",
};

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function applyPreference(preference: ThemePreference) {
  const resolved =
    preference === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : preference;
  document.documentElement.dataset.theme = resolved;
  try {
    if (preference === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage can be unavailable (private modes); the choice still applies
    // for this page view.
  }
}

/** Cycles System, Light, and Dark. The choice stays on this device. */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const [preference, setPreference] = useState<ThemePreference>("system");

  useEffect(() => {
    setPreference(readPreference());
  }, []);

  const next = ORDER[(ORDER.indexOf(preference) + 1) % ORDER.length]!;

  return (
    <button
      type="button"
      onClick={() => {
        applyPreference(next);
        setPreference(next);
      }}
      aria-label={`${LABELS[preference]}. Switch to ${LABELS[next].toLowerCase()}`}
      title={`${LABELS[preference]} (switch to ${LABELS[next].toLowerCase()})`}
      className={`theme-toggle inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-brand-muted transition-colors hover:bg-brand-hover hover:text-brand-ink ${className}`}
    >
      <ThemeIcon preference={preference} />
    </button>
  );
}

function ThemeIcon({ preference }: { preference: ThemePreference }) {
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
  if (preference === "light") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.64 5.64l1.06 1.06M17.3 17.3l1.06 1.06M5.64 18.36l1.06-1.06M17.3 6.7l1.06-1.06" />
      </svg>
    );
  }
  if (preference === "dark") {
    return (
      <svg {...common}>
        <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="3" y="4.5" width="18" height="12" rx="2" />
      <path d="M8.5 20h7M12 16.5V20" />
    </svg>
  );
}
