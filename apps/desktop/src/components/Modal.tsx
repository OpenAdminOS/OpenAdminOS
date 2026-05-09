import type { ReactNode } from "react";
import { useEffect } from "react";
import { IconClose } from "./icons";

export function Modal({
  open,
  onClose,
  children,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  size?: "md" | "lg";
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const widthClass = size === "lg" ? "max-w-[860px]" : "max-w-[680px]";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-6 py-10"
      style={{ background: "rgba(10, 8, 6, 0.62)" }}
      onClick={onClose}
    >
      <div
        className={`relative w-full ${widthClass} max-h-full overflow-hidden rounded-2xl bg-[var(--color-bg-elevated)] shadow-[var(--shadow-modal)] ring-1 ring-[var(--color-border-strong)] animate-fade-in-scale flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
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
  return (
    <div className="flex shrink-0 items-start justify-between border-b border-[var(--color-border-soft)] px-6 py-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <h2 className="text-[15px] font-semibold tracking-tight text-[var(--color-text)]">
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
        onClick={onClose}
        className="rounded-md p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
        aria-label="Close"
      >
        <IconClose size={16} />
      </button>
    </div>
  );
}
