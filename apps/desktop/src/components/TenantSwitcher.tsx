import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Avatar } from "./Avatar";
import { StatusDot } from "./Pill";
import {
  IconCheck,
  IconChevronUpDown,
  IconCloud,
  IconHardDrive,
  IconPlus,
} from "./icons";
import { useAppState } from "../state";

export function TenantSwitcher() {
  const navigate = useNavigate();
  const { state, setActiveTenant, connectTenant } = useAppState();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const activeTenant = state.activeTenantId
    ? state.tenants.find((tenant) => tenant.id === state.activeTenantId)
    : undefined;

  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", handleClick);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleClick);
      window.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const handlePickSynthetic = async () => {
    if (!activeTenant) {
      setOpen(false);
      return;
    }
    // Setting active is per-tenant; "Synthetic data" can't be set as a tenant.
    // Route to Settings → Tenants where the user can disconnect or manage.
    navigate("/settings");
    setOpen(false);
  };

  const handlePickTenant = async (tenantId: string) => {
    if (tenantId === activeTenant?.id) {
      setOpen(false);
      return;
    }
    setBusy(true);
    try {
      await setActiveTenant(tenantId);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const handleConnect = async () => {
    setBusy(true);
    try {
      await connectTenant();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={wrapperRef} className="relative mx-2.5 mt-1">
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2.5 rounded-xl bg-[var(--color-surface)] px-2.5 py-2 text-left ring-1 ring-[var(--color-border-soft)] transition-colors hover:bg-[var(--color-surface-hover)]"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Avatar name={activeTenant?.displayName ?? "Synthetic"} size={28} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[12.5px] font-semibold text-[var(--color-text)]">
            {activeTenant?.displayName ?? "Synthetic data"}
          </div>
          <div className="mt-0.5 flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
            <StatusDot tone={activeTenant ? "success" : "muted"} />
            <span className="truncate">
              {activeTenant ? activeTenant.username : "No tenant connected"}
            </span>
          </div>
        </div>
        <IconChevronUpDown size={12} className="text-[var(--color-text-muted)]" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 overflow-hidden rounded-xl bg-[var(--color-bg-elevated)] shadow-[var(--shadow-modal)] ring-1 ring-[var(--color-border-strong)] animate-fade-in"
        >
          <div className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Tenants
          </div>
          {state.tenants.length === 0 ? (
            <div className="px-3 pb-2 pt-1 text-[12px] text-[var(--color-text-muted)]">
              No tenants connected.
            </div>
          ) : (
            <div className="flex flex-col">
              {state.tenants.map((tenant) => {
                const isActive = tenant.id === activeTenant?.id;
                return (
                  <button
                    key={tenant.id}
                    onClick={() => void handlePickTenant(tenant.id)}
                    disabled={busy}
                    role="menuitem"
                    className={`flex items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-hover)] ${
                      isActive ? "bg-[var(--color-surface)]" : ""
                    }`}
                  >
                    <Avatar name={tenant.displayName} size={22} />
                    <div className="min-w-0 flex-1 leading-tight">
                      <div className="truncate text-[12.5px] font-medium text-[var(--color-text)]">
                        {tenant.displayName}
                      </div>
                      <div className="mt-0.5 truncate text-[10px] text-[var(--color-text-muted)]">
                        {tenant.username}
                      </div>
                    </div>
                    {isActive && (
                      <IconCheck size={12} className="text-[var(--color-accent)]" />
                    )}
                  </button>
                );
              })}
            </div>
          )}

          <button
            onClick={() => void handlePickSynthetic()}
            disabled={busy}
            role="menuitem"
            className={`flex w-full items-center gap-2.5 border-t border-[var(--color-border-soft)] px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-hover)] ${
              !activeTenant ? "bg-[var(--color-surface)]" : ""
            }`}
          >
            <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-[var(--color-bg-raised)] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border)]">
              <IconHardDrive size={11} />
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-[12.5px] font-medium text-[var(--color-text)]">
                Synthetic data
              </div>
              <div className="mt-0.5 truncate text-[10px] text-[var(--color-text-muted)]">
                Built-in fixture; no Microsoft Graph call
              </div>
            </div>
            {!activeTenant && (
              <IconCheck size={12} className="text-[var(--color-accent)]" />
            )}
          </button>

          <div className="flex items-center gap-1 border-t border-[var(--color-border-soft)] bg-[var(--color-surface)] p-1.5">
            <button
              onClick={() => void handleConnect()}
              disabled={busy}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface-hover)]"
            >
              <IconPlus size={11} />
              {busy ? "Waiting for sign-in…" : "Connect tenant"}
            </button>
            <button
              onClick={() => {
                navigate("/settings");
                setOpen(false);
              }}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
            >
              <IconCloud size={11} /> Manage
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
