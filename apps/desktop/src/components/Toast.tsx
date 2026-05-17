import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { IconCheck, IconClose, IconWarning } from "./icons";

type ToastTone = "success" | "error" | "info";

interface Toast {
  id: string;
  tone: ToastTone;
  message: string;
  /** Auto-dismiss timeout in ms. `null` keeps the toast until dismissed. */
  durationMs: number | null;
}

interface ToastContextValue {
  push(toast: { tone?: ToastTone; message: string; durationMs?: number | null }): void;
  success(message: string, durationMs?: number | null): void;
  error(message: string, durationMs?: number | null): void;
  info(message: string, durationMs?: number | null): void;
  dismiss(id: string): void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

const DEFAULT_DURATIONS: Record<ToastTone, number | null> = {
  success: 3500,
  info: 4000,
  error: null, // errors stick until dismissed
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback<ToastContextValue["push"]>((input) => {
    const tone = input.tone ?? "info";
    const id = `toast_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const durationMs =
      input.durationMs === undefined ? DEFAULT_DURATIONS[tone] : input.durationMs;
    setToasts((current) => [...current, { id, tone, message: input.message, durationMs }]);
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      push,
      success: (message, durationMs) => push({ tone: "success", message, durationMs }),
      error: (message, durationMs) => push({ tone: "error", message, durationMs }),
      info: (message, durationMs) => push({ tone: "info", message, durationMs }),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-10 left-1/2 z-[100] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastRow({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) {
  useEffect(() => {
    if (toast.durationMs === null) return;
    const id = window.setTimeout(() => onDismiss(toast.id), toast.durationMs);
    return () => window.clearTimeout(id);
  }, [toast.id, toast.durationMs, onDismiss]);

  const palette =
    toast.tone === "success"
      ? "bg-[var(--color-success-soft)] ring-[var(--color-success)]/35 text-[var(--color-success)]"
      : toast.tone === "error"
        ? "bg-[var(--color-danger-soft)] ring-[var(--color-danger)]/40 text-[var(--color-danger)]"
        : "bg-[var(--color-bg-elevated)] ring-[var(--color-border-strong)] text-[var(--color-text)]";

  return (
    <div
      role="status"
      className={`pointer-events-auto flex min-w-[280px] max-w-[480px] items-start gap-2.5 rounded-lg px-3.5 py-2.5 shadow-[var(--shadow-modal)] ring-1 animate-fade-in-scale ${palette}`}
    >
      <span className="mt-0.5 shrink-0">
        {toast.tone === "success" ? (
          <IconCheck size={12} />
        ) : toast.tone === "error" ? (
          <IconWarning size={12} />
        ) : (
          <span className="inline-block h-2 w-2 rounded-full bg-[var(--color-info)]" />
        )}
      </span>
      <span className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-[var(--color-text)]">
        {toast.message}
      </span>
      <button
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss"
        className="rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      >
        <IconClose size={11} />
      </button>
    </div>
  );
}
