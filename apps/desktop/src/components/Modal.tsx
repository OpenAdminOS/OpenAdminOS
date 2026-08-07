import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createContext, useContext, useEffect, useId, useRef } from "react";
import { COMMON_COPY } from "../copy";
import { registerOverlay } from "../shared/overlay-stack";
import { IconClose } from "./icons";

const ModalHeadingContext = createContext<string | undefined>(undefined);

const focusableSelector = [
  "[data-autofocus]",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "button:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function Modal({
  open,
  onClose,
  children,
  size = "md",
  closeOnScrim = true,
  ariaLabel,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  size?: "md" | "lg";
  closeOnScrim?: boolean;
  ariaLabel?: string;
}) {
  const overlayId = useId();
  const headingId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const unregister = registerOverlay({
      id: overlayId,
      onEscape: () => onCloseRef.current(),
    });
    const frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      const preferred =
        dialog?.querySelector<HTMLElement>("[data-autofocus]:not([disabled])") ??
        dialog?.querySelector<HTMLElement>(focusableSelector);
      (preferred ?? dialog)?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      unregister();
      returnFocusRef.current?.focus();
    };
  }, [open, overlayId]);

  if (!open) return null;

  const widthClass = size === "lg" ? "max-w-[860px]" : "max-w-[680px]";

  const trapFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(
      (element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true",
    );
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-6 py-10"
      style={{ background: "rgba(10, 8, 6, 0.62)" }}
      onClick={() => {
        if (closeOnScrim) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ariaLabel ? undefined : headingId}
        aria-label={ariaLabel}
        tabIndex={-1}
        className={`relative w-full ${widthClass} max-h-full overscroll-contain overflow-hidden rounded-2xl bg-[var(--color-bg-elevated)] shadow-[var(--shadow-modal)] ring-1 ring-[var(--color-border-strong)] animate-fade-in-scale flex flex-col`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapFocus}
      >
        <ModalHeadingContext.Provider value={headingId}>
          {children}
        </ModalHeadingContext.Provider>
      </div>
    </div>
  );
}

export function ModalHeader({
  title,
  subtitle,
  onClose,
  badge,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  badge?: ReactNode;
}) {
  const headingId = useContext(ModalHeadingContext);
  return (
    <div className="flex shrink-0 items-start justify-between border-b border-[var(--color-border-soft)] px-6 py-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <h2 id={headingId} className="text-pretty text-[15px] font-semibold tracking-tight text-[var(--color-text)]">
            {title}
          </h2>
          {badge}
        </div>
        {subtitle && (
          <div className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">
            {subtitle}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        className="rounded-md p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
        aria-label={COMMON_COPY.actions.close}
      >
        <IconClose size={16} />
      </button>
    </div>
  );
}
