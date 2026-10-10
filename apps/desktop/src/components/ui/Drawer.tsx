import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { registerOverlay } from "../../shared/overlay-stack";
import { IconClose } from "../icons";
import { IconButton } from "./IconButton";

const DrawerTitleContext = createContext<string | undefined>(undefined);

const focusableSelector = [
  "[data-autofocus]",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "button:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export interface DrawerProps {
  open: boolean;
  title: string;
  onClose: () => void;
  actions?: ReactNode;
  children: ReactNode;
  closeOnScrim?: boolean;
}

export function Drawer({
  open,
  title,
  onClose,
  actions,
  children,
  closeOnScrim = true,
}: DrawerProps) {
  const overlayId = useId();
  const titleId = useId();
  const drawerRef = useRef<HTMLElement | null>(null);
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
      const drawer = drawerRef.current;
      const first = drawer?.querySelector<HTMLElement>(focusableSelector);
      (first ?? drawer)?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      unregister();
      window.requestAnimationFrame(() => returnFocusRef.current?.focus());
    };
  }, [open, overlayId]);

  if (!open) return null;

  const trapFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const drawer = drawerRef.current;
    if (!drawer) return;
    const focusable = Array.from(
      drawer.querySelectorAll<HTMLElement>(focusableSelector),
    ).filter((element) => !element.hasAttribute("disabled"));
    if (focusable.length === 0) {
      event.preventDefault();
      drawer.focus();
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

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex justify-end bg-black/60"
      onMouseDown={(event) => {
        if (closeOnScrim && event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={trapFocus}
        className="flex h-full w-[min(560px,45vw)] max-w-full flex-col bg-[var(--color-bg-elevated)] shadow-[var(--shadow-modal)] ring-1 ring-[var(--color-border-strong)] transition-transform duration-200 ease-out motion-reduce:transition-none"
      >
        <DrawerTitleContext.Provider value={titleId}>
          <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-[var(--color-border-soft)] px-5 py-3">
            <h2 id={titleId} className="min-w-0 flex-1 truncate text-md font-semibold text-[var(--color-text)]">
              {title}
            </h2>
            {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
            <IconButton
              label="Close drawer"
              icon={<IconClose size={16} />}
              onClick={onClose}
              size="sm"
            />
          </header>
          <div
            data-drawer-scroll-root
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            {children}
          </div>
        </DrawerTitleContext.Provider>
      </aside>
    </div>,
    document.body,
  );
}

export function useDrawerTitleId() {
  return useContext(DrawerTitleContext);
}
