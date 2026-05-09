import type { HTMLAttributes, ReactNode } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
  children: ReactNode;
}

export function Card({ interactive = false, className = "", children, ...rest }: CardProps) {
  return (
    <div
      {...rest}
      className={`rounded-xl bg-[var(--color-surface)] ring-1 ring-[var(--color-border-soft)] ${
        interactive
          ? "transition-all duration-150 hover:ring-[var(--color-border-strong)] hover:bg-[var(--color-surface-hover)] cursor-pointer"
          : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}
