import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createContext, useContext, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { COMMON_COPY } from "../copy";
import { registerOverlay } from "../shared/overlay-stack";
import { IconClose } from "./icons";
import { IconButton } from "./ui/IconButton";

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
      // A fast user may already have focused a field in the dialog;
      // stealing focus back to the preferred control ate their first
      // keystrokes (and made modal form tests timing-fragile).
      const active = document.activeElement;
      if (dialog && active instanceof HTMLElement && active !== dialog && dialog.contains(active)) {
        return;
      }
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

  // Portaled to the body and stacked above drawers (z-90) so dialogs opened
  // from a drawer, such as Configure or the run review, are never covered.
  return createPortal(
    <div
      className="app-shell-scrim fixed inset-x-0 bottom-0 top-[52px] z-[95] flex items-center justify-center px-6 py-10"
      style={{ background: "var(--color-scrim)" }}
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
        className={`relative w-full ${widthClass} max-h-full overscroll-contain overflow-hidden rounded-[18px] bg-[var(--color-raised)] shadow-[var(--shadow-dialog)] animate-fade-in-scale flex flex-col`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapFocus}
      >
        <ModalHeadingContext.Provider value={headingId}>
          {children}
        </ModalHeadingContext.Provider>
      </div>
    </div>,
    document.body,
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
          <h2 id={headingId} className="text-pretty text-md font-semibold text-[var(--color-text)]">
            {title}
          </h2>
          {badge}
        </div>
        {subtitle && (
          <div className="mt-0.5 text-sm text-[var(--color-text-muted)]">
            {subtitle}
          </div>
        )}
      </div>
      <IconButton
        onClick={onClose}
        label={COMMON_COPY.actions.close}
        icon={<IconClose size={16} />}
      />
    </div>
  );
}
