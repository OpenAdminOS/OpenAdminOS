import {
  cloneElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export interface TooltipProps {
  content: ReactNode;
  shortcut?: ReactNode;
  children: ReactElement<Record<string, unknown>>;
  side?: "top" | "right" | "bottom" | "left";
  disabled?: boolean;
  /** Stretch the trigger wrapper to the full width of its container. */
  fullWidth?: boolean;
  className?: string;
}

const GAP = 8;
const EDGE = 8;
const SHOW_DELAY_MS = 450;

/**
 * Computes viewport coordinates for the tooltip, kept inside the window.
 * The tooltip renders in a portal with fixed positioning, so ancestors with
 * overflow clipping (the sidebar, scroll areas) cannot cut it off.
 */
function place(
  anchor: DOMRect,
  tip: { width: number; height: number },
  side: NonNullable<TooltipProps["side"]>,
): { left: number; top: number } {
  let left: number;
  let top: number;
  switch (side) {
    case "top":
      left = anchor.left + anchor.width / 2 - tip.width / 2;
      top = anchor.top - GAP - tip.height;
      break;
    case "bottom":
      left = anchor.left + anchor.width / 2 - tip.width / 2;
      top = anchor.bottom + GAP;
      break;
    case "left":
      left = anchor.left - GAP - tip.width;
      top = anchor.top + anchor.height / 2 - tip.height / 2;
      break;
    case "right":
      left = anchor.right + GAP;
      top = anchor.top + anchor.height / 2 - tip.height / 2;
      break;
  }
  const maxLeft = window.innerWidth - tip.width - EDGE;
  const maxTop = window.innerHeight - tip.height - EDGE;
  return {
    left: Math.max(EDGE, Math.min(left, maxLeft)),
    top: Math.max(EDGE, Math.min(top, maxTop)),
  };
}

export function Tooltip({
  content,
  shortcut,
  children,
  side = "top",
  disabled = false,
  fullWidth = false,
  className = "",
}: TooltipProps) {
  const id = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);

  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), SHOW_DELAY_MS);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const tip = tipRef.current;
    if (!trigger || !tip) return;
    const { left, top } = place(
      trigger.getBoundingClientRect(),
      { width: tip.offsetWidth, height: tip.offsetHeight },
      side,
    );
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }, [open, side, content]);

  useEffect(() => {
    if (!open) return;
    // The position is computed once on show, so hide rather than drift when
    // anything scrolls or the window resizes underneath it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (disabled) return children;

  const describedBy = [children.props["aria-describedby"], id]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      ref={triggerRef}
      className={`relative ${fullWidth ? "flex w-full" : "inline-flex"} ${className}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={(event) => {
        // Keyboard focus only: a mouse click focuses the trigger too, and the
        // tooltip should not reappear right after the click dismissed it.
        if ((event.target as HTMLElement).matches(":focus-visible")) show();
      }}
      onBlur={hide}
      onPointerDown={hide}
    >
      {cloneElement(children, { "aria-describedby": describedBy })}
      {createPortal(
        <span
          ref={tipRef}
          id={id}
          role="tooltip"
          className={`pointer-events-none fixed left-0 top-0 z-[120] flex w-max max-w-56 items-center whitespace-normal rounded-[8px] bg-[var(--color-tip-bg)] px-[9px] py-[5px] text-xs leading-4 text-[var(--color-tip-fg)] shadow-[var(--shadow-pop)] transition-[opacity,visibility] duration-100 ${
            open ? "visible opacity-100" : "invisible opacity-0"
          }`}
        >
          <span>{content}</span>
          {shortcut ? (
            <kbd className="ml-2 font-sans opacity-60">{shortcut}</kbd>
          ) : null}
        </span>,
        document.body,
      )}
    </span>
  );
}
