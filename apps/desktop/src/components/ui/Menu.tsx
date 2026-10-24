import {
  cloneElement,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { registerOverlay } from "../../shared/overlay-stack";

export type MenuEntry =
  | {
      type?: "item";
      id: string;
      label: string;
      icon?: ReactNode;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { type: "separator"; id: string };

export interface MenuProps {
  trigger: ReactElement<Record<string, unknown>>;
  items: readonly MenuEntry[];
  align?: "start" | "end";
  side?: "top" | "bottom";
  ariaLabel?: string;
  className?: string;
}

export function Menu({
  trigger,
  items,
  align = "end",
  side = "bottom",
  ariaLabel = "Actions",
  className = "",
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const overlayId = useId();
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef(false);

  const close = (returnFocus = true) => {
    returnFocusRef.current = returnFocus;
    setOpen(false);
  };

  const focusItem = (index: number, preventScroll = false) => {
    const entries = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );
    const entry = entries[index];
    if (!entry) return;
    // preventScroll is opt-in per call. Top-side menus open upward from a
    // bottom-anchored trigger, where a plain focus() scrolls every
    // scrollable ancestor (including overflow-hidden shells) to reveal the
    // item and shifts the whole layout. Every other focus keeps the
    // default scroll so items near a scroll edge are revealed.
    if (preventScroll) entry.focus({ preventScroll: true });
    else entry.focus();
  };

  // Only upward menus anchored to a fixed footer suppress focus scrolling.
  // Bottom menus keep the plain focus behavior they have always had.
  const suppressFocusScroll = side === "top";

  useEffect(() => {
    if (!open) {
      if (returnFocusRef.current) {
        returnFocusRef.current = false;
        window.requestAnimationFrame(() => {
          if (suppressFocusScroll) triggerRef.current?.focus({ preventScroll: true });
          else triggerRef.current?.focus();
        });
      }
      return;
    }

    const unregister = registerOverlay({
      id: overlayId,
      onEscape: () => close(true),
    });
    const frame = window.requestAnimationFrame(() => focusItem(0, suppressFocusScroll));
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("mousedown", onPointerDown);
      unregister();
    };
  }, [open, overlayId, suppressFocusScroll]);

  const triggerOnClick = trigger.props.onClick as
    | ((event: React.MouseEvent<HTMLElement>) => void)
    | undefined;
  const triggerOnKeyDown = trigger.props.onKeyDown as
    | ((event: KeyboardEvent<HTMLElement>) => void)
    | undefined;

  const enhancedTrigger = cloneElement(trigger, {
    "aria-haspopup": "menu",
    "aria-expanded": open,
    "aria-controls": open ? menuId : undefined,
    onClick: (event: React.MouseEvent<HTMLElement>) => {
      triggerRef.current = event.currentTarget;
      triggerOnClick?.(event);
      if (!event.defaultPrevented) setOpen((value) => !value);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      triggerRef.current = event.currentTarget;
      triggerOnKeyDown?.(event);
      if (event.defaultPrevented) return;
      if (["ArrowDown", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        setOpen(true);
      }
    },
  });

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const entries = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );
    const current = entries.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusItem((current + 1 + entries.length) % entries.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusItem((current - 1 + entries.length) % entries.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusItem(entries.length - 1);
    } else if (event.key === "Tab") {
      close(false);
    }
  };

  return (
    <span ref={rootRef} className={`relative inline-flex ${className}`}>
      {enhancedTrigger}
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={ariaLabel}
          onKeyDown={onMenuKeyDown}
          className={`absolute z-[80] min-w-48 overflow-hidden rounded-[14px] bg-[var(--color-raised)] p-1.5 shadow-[var(--shadow-pop)] ${
            side === "top" ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+6px)]"
          } ${
            align === "end" ? "right-0" : "left-0"
          }`}
        >
          {items.map((item) =>
            item.type === "separator" ? (
              <div
                key={item.id}
                role="separator"
                className="my-1 h-px bg-[var(--color-border-soft)]"
              />
            ) : (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  item.onSelect();
                  close(true);
                }}
                className={`flex w-full items-center gap-2 rounded-[9px] px-2.5 py-2 text-left text-base transition-colors disabled:opacity-40 ${
                  item.danger
                    ? "text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
                    : "text-[var(--color-text)] hover:bg-[var(--color-hover)]"
                }`}
              >
                {item.icon ? (
                  <span aria-hidden="true" className="inline-flex shrink-0">
                    {item.icon}
                  </span>
                ) : null}
                <span>{item.label}</span>
              </button>
            ),
          )}
        </div>
      )}
    </span>
  );
}
