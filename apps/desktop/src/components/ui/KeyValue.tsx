import type { ReactNode } from "react";

export interface KeyValueProps {
  label: ReactNode;
  value: ReactNode;
  className?: string;
}

export function KeyValue({ label, value, className = "" }: KeyValueProps) {
  return (
    <div className={`grid min-w-0 grid-cols-[minmax(120px,0.6fr)_minmax(0,1fr)] gap-4 py-2 ${className}`}>
      <dt className="text-sm text-[var(--color-text-muted)]">{label}</dt>
      <dd className="min-w-0 text-base text-[var(--color-text)]">{value}</dd>
    </div>
  );
}
