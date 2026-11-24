import Link from "next/link";
import type { ReactNode } from "react";

import { buttonPrimary, buttonSecondary, eyebrow } from "~/app/ui";

const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-focus";
export const primary = `${buttonPrimary} ${focus} motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50`;
export const secondary = `${buttonSecondary} ${focus} motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50`;
export const textLink = `text-link underline underline-offset-4 ${focus}`;
export const field = `w-full rounded-[10px] border border-brand-line-strong bg-brand-card px-3 py-2 text-base text-brand-ink ${focus}`;
export const heading = "font-display text-[1.65rem] leading-tight text-brand-ink";
export const NOT_CONFIGURED = "Campaign accounts are not configured yet.";
export const STORAGE_UNAVAILABLE = "Campaign storage is temporarily unavailable. Reload the page to try again.";

export function BackToCalendar() {
  return <Link href="/advent" className={textLink}>Back to the calendar</Link>;
}

export function AdventTitle({ title, description, label }: { title: string; description?: string; label?: string }) {
  return (
    <header className="max-w-3xl">
      {label && <p className={eyebrow}>{label}</p>}
      <h1 className="font-display mt-3 text-balance text-[2.75rem] leading-[1.04] sm:text-[4rem]">{title}</h1>
      {description && <p className="mt-4 max-w-2xl text-pretty text-base leading-7 text-brand-muted sm:text-lg">{description}</p>}
    </header>
  );
}

export function Notice({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "ok" | "error" }) {
  const colors = tone === "ok" ? "border-brand-line bg-brand-ok-surface"
    : tone === "error" ? "border-brand-danger-line bg-brand-danger-surface"
    : "border-brand-line bg-brand-surface";
  return <div className={`rounded-[10px] border px-4 py-3 text-sm leading-6 text-brand-ink ${colors}`}>{children}</div>;
}
