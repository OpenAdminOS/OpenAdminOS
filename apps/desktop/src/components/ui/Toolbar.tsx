import type { HTMLAttributes, ReactNode } from "react";

export interface ToolbarProps extends HTMLAttributes<HTMLDivElement> {
  search?: ReactNode;
  filters?: ReactNode;
  actions?: ReactNode;
}

export function Toolbar({
  search,
  filters,
  actions,
  className = "",
  ...rest
}: ToolbarProps) {
  return (
    <div
      {...rest}
      className={`flex min-w-0 flex-wrap items-center justify-between gap-3 ${className}`}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {search}
        {filters}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
