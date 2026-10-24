"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { buttonPrimary } from "../ui";

type Platform = "macos" | "windows" | "linux";

const LABELS: Record<Platform, string> = {
  macos: "Download for macOS",
  windows: "Download for Windows",
  linux: "Download for Linux",
};

function detectPlatform(): Platform | null {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Android|CrOS/i.test(ua)) return null;
  if (/Linux|X11/i.test(ua)) return "linux";
  if (/Macintosh|Mac OS X/i.test(ua)) return "macos";
  return null;
}

/**
 * Primary download button. Server-renders the macOS build and switches to
 * the visitor's platform after hydration. Unknown platforms keep macOS and
 * can pick another build on /download.
 */
export function DownloadCta({
  urls,
  className = "",
}: {
  urls: Record<Platform, string>;
  className?: string;
}) {
  const [platform, setPlatform] = useState<Platform>("macos");

  useEffect(() => {
    const detected = detectPlatform();
    if (detected) setPlatform(detected);
  }, []);

  return (
    <div className={`flex flex-col gap-3 sm:flex-row sm:items-center ${className}`}>
      <a href={urls[platform]} className={`${buttonPrimary} h-12 px-5 text-[15px]`}>
        <PlatformIcon platform={platform} />
        {LABELS[platform]}
      </a>
      <Link
        href="/download"
        className="inline-flex h-12 items-center justify-center whitespace-nowrap rounded-[10px] px-4 text-[15px] font-medium text-brand-muted transition-colors hover:bg-brand-hover hover:text-brand-ink"
      >
        All platforms and checksums
      </Link>
    </div>
  );
}

function PlatformIcon({ platform }: { platform: Platform }) {
  if (platform === "windows") {
    return (
      <svg aria-hidden viewBox="0 0 448 512" className="h-4 w-4 fill-current">
        <path d="M0 93.7l183.6-25.3v177.4H0V93.7zm0 324.6l183.6 25.3V268.4H0v149.9zm203.8 28L448 480V268.4H203.8v177.9zm0-380.6v180.1H448V32L203.8 65.7z" />
      </svg>
    );
  }
  if (platform === "linux") {
    return (
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="4" width="18" height="14" rx="2.5" />
        <path d="m7 9 3 2.5L7 14M12.5 14H17" />
      </svg>
    );
  }
  return (
    <svg aria-hidden viewBox="0 0 384 512" className="h-4 w-4 fill-current">
      <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zM256.6 105.8c30.3-36 27.6-68.8 26.7-80.6-26.8 1.6-57.8 18.3-75.5 38.8-19.5 22-31 49.2-28.5 80 29 2.2 55.5-12.7 77.3-38.2z" />
    </svg>
  );
}
