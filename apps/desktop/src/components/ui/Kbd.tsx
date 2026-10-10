import type { HTMLAttributes, ReactNode } from "react";

export interface KbdProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
}

export function Kbd({ children, className = "", ...rest }: KbdProps) {
  return (
    <kbd
      {...rest}
      className={`inline-flex min-w-5 items-center justify-center rounded bg-[var(--color-bg-raised)] px-1.5 py-px font-mono text-xs text-[var(--color-text-soft)] ring-1 ring-[var(--color-border)] ${className}`}
    >
      {children}
    </kbd>
  );
}
