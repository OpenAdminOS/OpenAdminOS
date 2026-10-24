import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { useAppState } from "../state";
import { userFacingErrorReason } from "../copy";
import { useSetupFlow } from "../setup/SetupFlowContext";
import { Button } from "./Button";
import {
  IconCheck,
  IconChevronDown,
  IconClose,
  IconPlus,
  IconSettings,
} from "./icons";
import { Modal, ModalHeader } from "./Modal";
import { Pill } from "./Pill";
import { TenantTile } from "./TenantTile";
import { useToast } from "./Toast";
import { Tooltip } from "./ui";

function entraTierLabel(tier: "free" | "p1" | "p2" | "unknown" | undefined): string {
  if (!tier || tier === "unknown") return "Entra tier not detected";
  return tier === "free" ? "Entra Free" : `Entra ${tier.toUpperCase()}`;
}

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
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const pickTenant = async (tenantId: string) => {
    if (tenantId === activeTenant?.id) {
      setOpen(false);
      return;
    }
    setBusy(true);
    try {
      await setActiveTenant(tenantId);
      setOpen(false);
    } catch (error) {
      const detail = userFacingErrorReason(
        error instanceof Error ? error.message : String(error),
      );
      toast.error(
        `Switching tenants failed.${detail ? ` ${detail}` : ""} Try again from the tenant menu.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!pendingDisconnect) return;
    setBusy(true);
    try {
      await disconnectTenant(pendingDisconnect.tenantId);
      toast.success(`${pendingDisconnect.displayName} disconnected.`);
      setPendingDisconnect(null);
    } catch (error) {
      const detail = userFacingErrorReason(
        error instanceof Error ? error.message : String(error),
      );
      toast.error(
        `Disconnecting the tenant failed.${detail ? ` ${detail}` : ""} Try again.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const tooltip = activeTenant
    ? `Signed in as ${activeTenant.username}. ${entraTierLabel(activeTenant.entraTier)}.`
    : state.tenants.length > 0
      ? "No active tenant. Choose a connected tenant."
      : "No tenant connected. Open setup to connect one.";

  return (
    <>
      <div ref={wrapperRef} className="app-region-no-drag relative min-w-0">
        <Tooltip content={tooltip} side="bottom">
          <button
            type="button"
            onClick={() => {
              if (state.tenants.length === 0) {
                openSetup();
                return;
              }
              setOpen((current) => !current);
            }}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={
              activeTenant
                ? `Switch tenant, ${activeTenant.displayName}`
                : state.tenants.length > 0
                  ? "Choose an active tenant"
                  : "Connect a tenant"
            }
            className="flex h-9 max-w-[320px] items-center gap-2 rounded-[9px] px-2 text-left text-base text-[var(--color-text)] transition-colors hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
          >
            {activeTenant ? (
              <TenantTile tenantId={activeTenant.id} displayName={activeTenant.displayName} size="sm" />
            ) : (
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-[5px] bg-[var(--color-warning-soft)] text-xs text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
                ?
              </span>
            )}
            <span className="min-w-0 truncate font-medium">
              {activeTenant?.displayName ?? "No tenant"}
            </span>
            <IconChevronDown size={11} className="shrink-0 text-[var(--color-text-muted)]" />
          </button>
        </Tooltip>

        {open ? (
          <div
            role="menu"
            aria-label="Connected tenants"
            className="absolute left-0 top-[calc(100%+7px)] z-[90] w-[330px] overflow-hidden rounded-[14px] bg-[var(--color-raised)] p-1.5 shadow-[var(--shadow-pop)]"
          >
            <div className="px-2.5 pb-1.5 pt-1 text-sm text-[var(--color-text-muted)]">
              Tenants
            </div>
            {state.tenants.length === 0 ? (
              <div className="px-2.5 py-3 text-sm text-[var(--color-text-muted)]">No tenants connected.</div>
            ) : (
              state.tenants.map((tenant) => {
                const active = tenant.id === activeTenant?.id;
                const domain = tenant.username.includes("@")
                  ? tenant.username.split("@").at(-1)
                  : tenant.username;
                return (
                  <div
                    key={tenant.id}
                    className={`group flex items-center rounded-[9px] ${active ? "bg-[var(--color-active)]" : "hover:bg-[var(--color-hover)]"}`}
                  >
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      disabled={busy}
                      onClick={() => void pickTenant(tenant.id)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]"
                    >
                      <TenantTile tenantId={tenant.id} displayName={tenant.displayName} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-base font-medium text-[var(--color-text)]">{tenant.displayName}</span>
                        <span className="mt-0.5 block truncate text-xs text-[var(--color-text-muted)]">
                          {domain} · {entraTierLabel(tenant.entraTier)}
                        </span>
                      </span>
                      {active ? <IconCheck size={12} className="text-[var(--color-accent)]" /> : null}
                    </button>
                    <button
                      type="button"
                      aria-label={`Disconnect ${tenant.displayName}`}
                      title={`Disconnect ${tenant.displayName}`}
                      disabled={busy}
                      onClick={() => {
                        setPendingDisconnect({ tenantId: tenant.id, displayName: tenant.displayName });
                        setOpen(false);
                      }}
                      className="mr-1.5 rounded-[7px] p-1.5 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)] focus:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-danger)] group-hover:opacity-100"
                    >
                      <IconClose size={11} />
                    </button>
                  </div>
                );
              })
            )}
            <div className="my-1 h-px bg-[var(--color-border-soft)]" />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                openSetup();
              }}
              className="flex w-full items-center gap-2 rounded-[9px] px-2.5 py-2 text-left text-base text-[var(--color-text)] hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]"
            >
              <IconPlus size={12} /> Connect tenant
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                navigate("/settings/tenants");
              }}
              className="flex w-full items-center gap-2 rounded-[9px] px-2.5 py-2 text-left text-base text-[var(--color-text)] hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]"
            >
              <IconSettings size={12} /> Manage tenants
            </button>
          </div>
        ) : null}
      </div>

      <Modal open={pendingDisconnect !== null} onClose={() => { if (!busy) setPendingDisconnect(null); }} size="md">
        <ModalHeader
          title="Disconnect tenant"
          subtitle={pendingDisconnect?.displayName}
          badge={<Pill tone="danger">Local credentials</Pill>}
          onClose={() => setPendingDisconnect(null)}
        />
        <div className="space-y-4 p-6">
          <div className="rounded-[10px] bg-[var(--color-danger-soft)] px-4 py-3 text-sm text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
            Cached credentials for this tenant will be removed from this machine. You can reconnect the tenant later.
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => setPendingDisconnect(null)}>Cancel</Button>
            <Button variant="danger" disabled={busy} onClick={() => void disconnect()}>
              {busy ? "Disconnecting" : "Disconnect"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
