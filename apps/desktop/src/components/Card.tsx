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
          ? "cursor-pointer transition-colors duration-150 hover:bg-[var(--color-surface-hover)] hover:ring-[var(--color-border-strong)]"
          : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}
