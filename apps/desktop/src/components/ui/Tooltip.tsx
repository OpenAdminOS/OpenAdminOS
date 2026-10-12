import {
  cloneElement,
  useId,
  type ReactElement,
  type ReactNode,
} from "react";

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement<Record<string, unknown>>;
  side?: "top" | "right" | "bottom" | "left";
  disabled?: boolean;
  className?: string;
}

const positions = {
  top: "bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2",
  right: "left-[calc(100%+8px)] top-1/2 -translate-y-1/2",
  bottom: "left-1/2 top-[calc(100%+8px)] -translate-x-1/2",
  left: "right-[calc(100%+8px)] top-1/2 -translate-y-1/2",
} as const;

export function Tooltip({
  content,
  children,
  side = "top",
  disabled = false,
  className = "",
}: TooltipProps) {
  const id = useId();
  if (disabled) return children;

  const describedBy = [children.props["aria-describedby"], id]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={`group/tooltip relative inline-flex ${className}`}>
      {cloneElement(children, { "aria-describedby": describedBy })}
      <span
        id={id}
        role="tooltip"
        className={`pointer-events-none absolute z-[120] hidden w-max max-w-56 whitespace-normal rounded-md bg-[var(--color-bg-elevated)] px-2 py-1 text-xs leading-4 text-[var(--color-text)] shadow-[var(--shadow-soft)] ring-1 ring-[var(--color-border-strong)] group-hover/tooltip:block group-focus-within/tooltip:block ${positions[side]}`}
      >
        {content}
      </span>
    </span>
  );
}
