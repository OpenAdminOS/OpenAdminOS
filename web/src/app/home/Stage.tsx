import type { ReactNode } from "react";

export type StageTone = "sand" | "sage" | "slate" | "clay";

/** Relief-map artwork behind a product window. Decorative only. */
export function Stage({
  tone,
  className = "",
  children,
}: {
  tone: StageTone;
  className?: string;
  children?: ReactNode;
}) {
  return <div className={`stage stage-${tone} ${className}`}>{children}</div>;
}
