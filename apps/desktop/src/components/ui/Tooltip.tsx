import {
  cloneElement,
  useId,
  type ReactElement,
  type ReactNode,
} from "react";

export interface TooltipProps {
  content: ReactNode;
  shortcut?: ReactNode;
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
  shortcut,
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
        className={`pointer-events-none invisible absolute z-[120] flex w-max max-w-56 items-center whitespace-normal rounded-[8px] bg-[var(--color-tip-bg)] px-[9px] py-[5px] text-xs leading-4 text-[var(--color-tip-fg)] opacity-0 shadow-[var(--shadow-pop)] transition-[opacity,visibility] duration-100 [transition-delay:0ms] group-hover/tooltip:visible group-hover/tooltip:opacity-100 group-hover/tooltip:[transition-delay:450ms] group-focus-within/tooltip:visible group-focus-within/tooltip:opacity-100 group-focus-within/tooltip:[transition-delay:450ms] ${positions[side]}`}
      >
        <span>{content}</span>
        {shortcut ? (
          <kbd className="ml-2 font-sans opacity-60">{shortcut}</kbd>
        ) : null}
      </span>
    </span>
  );
}
