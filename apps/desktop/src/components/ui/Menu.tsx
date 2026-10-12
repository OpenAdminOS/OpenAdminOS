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
  ariaLabel?: string;
  className?: string;
}

export function Menu({
  trigger,
  items,
  align = "end",
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

  const focusItem = (index: number) => {
    const entries = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );
    entries[index]?.focus();
  };

  useEffect(() => {
    if (!open) {
      if (returnFocusRef.current) {
        returnFocusRef.current = false;
        window.requestAnimationFrame(() => triggerRef.current?.focus());
      }
      return;
    }

    const unregister = registerOverlay({
      id: overlayId,
      onEscape: () => close(true),
    });
    const frame = window.requestAnimationFrame(() => focusItem(0));
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("mousedown", onPointerDown);
      unregister();
    };
  }, [open, overlayId]);

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
      entries[(current + 1 + entries.length) % entries.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      entries[(current - 1 + entries.length) % entries.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      entries[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      entries.at(-1)?.focus();
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
          className={`absolute top-[calc(100%+6px)] z-[80] min-w-48 overflow-hidden rounded-lg bg-[var(--color-bg-elevated)] p-1 shadow-[var(--shadow-modal)] ring-1 ring-[var(--color-border-strong)] ${
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
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors disabled:opacity-50 ${
                  item.danger
                    ? "text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
                    : "text-[var(--color-text-soft)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
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
