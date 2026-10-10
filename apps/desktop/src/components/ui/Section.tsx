import type { HTMLAttributes, ReactNode } from "react";

export interface SectionProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}

export function Section({
  title,
  action,
  children,
  className = "",
  ...rest
}: SectionProps) {
  return (
    <section {...rest} className={`min-w-0 ${className}`}>
      <div className="mb-3 flex min-h-8 items-center justify-between gap-4 border-b border-[var(--color-border-soft)] pb-2">
        <h2 className="text-md font-semibold text-[var(--color-text)]">{title}</h2>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}
