import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Avatar } from "./Avatar";
import { Button } from "./Button";
import { Modal, ModalHeader } from "./Modal";
import { Pill, StatusDot } from "./Pill";
import {
  IconCheck,
  IconChevronUpDown,
  IconClose,
  IconCloud,
  IconPlus,
} from "./icons";
import { useAppState } from "../state";
import { useToast } from "./Toast";
import { useSetupFlow } from "../setup/SetupFlowContext";

export function TenantSwitcher() {
  const navigate = useNavigate();
  const { state, setActiveTenant, disconnectTenant } = useAppState();
  const { openSetup } = useSetupFlow();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingDisconnect, setPendingDisconnect] = useState<{
    tenantId: string;
    displayName: string;
  } | null>(null);
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

  const requestDisconnect = (tenantId: string, displayName: string) => {
    setPendingDisconnect({ tenantId, displayName });
    setOpen(false);
  };

  const handleDisconnect = async () => {
    if (!pendingDisconnect) return;
    setBusy(true);
    try {
      await disconnectTenant(pendingDisconnect.tenantId);
      toast.success(`${pendingDisconnect.displayName} disconnected.`);
      setPendingDisconnect(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div ref={wrapperRef} className="relative mx-2.5 mt-1">
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2.5 rounded-xl bg-[var(--color-surface)] px-2.5 py-2 text-left ring-1 ring-[var(--color-border-soft)] transition-colors hover:bg-[var(--color-surface-hover)]"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Avatar name={activeTenant?.displayName ?? "—"} size={28} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[12.5px] font-semibold text-[var(--color-text)]">
            {activeTenant?.displayName ?? "No tenant"}
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
                  <div
                    key={tenant.id}
                    className={`group flex items-center transition-colors hover:bg-[var(--color-surface-hover)] ${
                      isActive ? "bg-[var(--color-surface)]" : ""
                    }`}
                  >
                    <button
                      onClick={() => void handlePickTenant(tenant.id)}
                      disabled={busy}
                      role="menuitem"
                      className="flex flex-1 items-center gap-2.5 px-3 py-2 text-left"
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
                    <button
                      onClick={() =>
                        requestDisconnect(tenant.id, tenant.displayName)
                      }
                      disabled={busy}
                      title={`Disconnect ${tenant.displayName}`}
                      aria-label={`Disconnect ${tenant.displayName}`}
                      className="mr-2 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-[var(--color-bg-raised)] hover:text-[var(--color-danger)] group-hover:opacity-100 focus:opacity-100 disabled:opacity-50"
                    >
                      <IconClose size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex items-center gap-1 border-t border-[var(--color-border-soft)] bg-[var(--color-surface)] p-1.5">
            <button
              onClick={() => {
                setOpen(false);
                openSetup();
              }}
              disabled={busy}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface-hover)]"
            >
              <IconPlus size={11} />
              Connect tenant
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
      <DisconnectTenantModal
        open={pendingDisconnect !== null}
        displayName={pendingDisconnect?.displayName ?? ""}
        busy={busy}
        onClose={() => {
          if (!busy) setPendingDisconnect(null);
        }}
        onConfirm={() => void handleDisconnect()}
      />
    </>
  );
}

function DisconnectTenantModal({
  open,
  displayName,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  displayName: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} size="md">
      <ModalHeader
        title="Disconnect tenant"
        subtitle={displayName}
        badge={<Pill tone="danger">Local credentials</Pill>}
        onClose={onClose}
      />
      <div className="space-y-4 p-6">
        <div className="rounded-lg bg-[var(--color-danger-soft)] px-4 py-3 text-[12px] leading-relaxed text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
          Cached credentials for this tenant will be removed from this machine.
          You can reconnect the tenant later.
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy} onClick={onConfirm}>
            {busy ? "Disconnecting" : "Disconnect"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
