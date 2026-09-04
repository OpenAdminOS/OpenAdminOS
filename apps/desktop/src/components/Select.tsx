import type { SelectHTMLAttributes } from "react";

import { IconChevronDown } from "./icons";

/**
 * Native `<select>` styled to match the app's controls.
 *
 * A bare `<select>` renders the OS default arrow and focus ring, which
 * reads as a foreign control next to Button and the text inputs. This
 * keeps native semantics and keyboard behaviour (which a custom listbox
 * would have to reimplement) while drawing our own chevron and ring.
 */
export function Select({
  className = "",
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={`relative inline-flex min-w-0 ${className}`}>
      <select
        {...props}
        className="h-9 w-full min-w-0 appearance-none rounded-lg bg-[var(--color-surface)] py-0 pl-3 pr-8 text-[12px] text-[var(--color-text)] outline-none ring-1 ring-[var(--color-border)] transition-colors duration-150 hover:bg-[var(--color-surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/70 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {children}
      </select>
      <IconChevronDown
        size={13}
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
      />
    </div>
  );
}
