import { useId, type CSSProperties, type ReactNode } from "react";

/**
 * Card shell for the sections of the run page (progress, report, run
 * details). Keeps headers, spacing and surfaces identical across them.
 */
export function RunSection({
  title,
  meta,
  actions,
  children,
  className = "",
  bodyClassName = "px-5 pb-5",
  style,
}: {
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  style?: CSSProperties;
}) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      style={style}
      className={`rounded-[14px] bg-[var(--color-surface)] shadow-[inset_0_0_0_1px_var(--color-border-soft)] ${className}`}
    >
      <header className="flex min-h-12 flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-3">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h2 id={titleId} className="text-md font-semibold text-[var(--color-text)]">
            {title}
          </h2>
          {meta ? (
            <span className="min-w-0 truncate text-sm text-[var(--color-text-muted)]">{meta}</span>
          ) : null}
        </div>
        {actions ? <div className="flex items-center gap-1.5">{actions}</div> : null}
      </header>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}
