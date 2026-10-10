import type { ReactNode } from "react";

export interface PageHeaderProps {
  title: string;
  breadcrumb?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
  subtitle?: ReactNode;
}

export function PageHeader({
  title,
  breadcrumb,
  eyebrow,
  actions,
  subtitle: _subtitle,
}: PageHeaderProps) {
  // Subtitle remains accepted while P2 through P6 remove legacy call-site copy. It is intentionally not rendered.
  const resolvedBreadcrumb = breadcrumb ?? eyebrow;
  return (
    <header className="app-page-header flex shrink-0 items-center justify-between border-b border-[var(--color-border)]">
      <div className="min-w-0">
        {resolvedBreadcrumb ? (
          <div className="mb-1.5 text-xs font-medium text-[var(--color-text-muted)]">
            {resolvedBreadcrumb}
          </div>
        ) : null}
        <h1 className="truncate text-lg font-semibold tracking-tight text-[var(--color-text)]">
          {title}
        </h1>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
