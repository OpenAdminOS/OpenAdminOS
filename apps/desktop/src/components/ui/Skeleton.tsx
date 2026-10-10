import type { HTMLAttributes } from "react";

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  shape?: "line" | "block" | "circle";
}

export function Skeleton({
  shape = "line",
  className = "",
  ...rest
}: SkeletonProps) {
  return (
    <div
      {...rest}
      aria-hidden="true"
      className={`animate-pulse bg-[var(--color-bg-raised)] ${
        shape === "circle"
          ? "aspect-square rounded-full"
          : shape === "block"
            ? "rounded-lg"
            : "h-3 rounded"
      } ${className}`}
    />
  );
}
