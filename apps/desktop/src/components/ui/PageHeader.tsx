import type { ReactNode } from "react";

export interface PageHeaderProps {
  title: string;
  breadcrumb?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
  subtitle?: ReactNode;
  wide?: boolean;
}

export function PageHeader({
  title,
  breadcrumb,
  eyebrow,
  actions,
  subtitle,
  wide = false,
}: PageHeaderProps) {
  const resolvedBreadcrumb = breadcrumb ?? eyebrow;
  return (
    <header className="app-page-header shrink-0 border-b border-[var(--color-border-soft)]">
      <div className={`app-page-header-inner ${wide ? "app-page-header-inner-wide" : ""}`}>
        <div className="min-w-0">
          {resolvedBreadcrumb ? (
            <div className="mb-1.5 text-xs font-medium text-[var(--color-text-muted)]">
              {resolvedBreadcrumb}
            </div>
          ) : null}
          <h1 className="truncate text-balance font-serif text-[28px] font-medium leading-[34px] tracking-[-0.015em] text-[var(--color-text)]">
            {title}
          </h1>
          {subtitle ? (
            <div className="mt-1 max-w-2xl text-sm text-[var(--color-text-muted)]">
              {subtitle}
            </div>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {actions}
          </div>
        ) : null}
      </div>
    </header>
  );
}
