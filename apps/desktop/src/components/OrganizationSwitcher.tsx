import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router";

import { useAppState } from "../state";
import { ORGANIZATION_COPY, SERVICE_COPY, userFacingErrorReason } from "../copy";
import { useSetupFlow } from "../setup/SetupFlowContext";
import { Button } from "./Button";
import {
  IconCheck,
  IconChevronDown,
  IconClose,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconSettings,
} from "./icons";
import { TenantCheckStatus, useTenantCheck } from "./ServiceAccess";
import { Modal, ModalHeader } from "./Modal";
import { Pill } from "./Pill";
import { ServiceMark, connectedServiceIds } from "./ServiceMark";
import { TenantTile } from "./TenantTile";
import { useToast } from "./Toast";
import { Tooltip } from "./ui";
import { PILOT_COPY } from "../shared/pilot-mode";
import { tenantRegistrationSummary } from "../shared/app-registration";
import {
  activeOrganizationOf,
  resolveOrganizations,
  serviceById,
  type OrganizationRecord,
  type TenantRecord,
} from "../shared/openAdminOS";

const MENU_ITEM_CLASS =
  "flex w-full items-center gap-2 rounded-[9px] px-2.5 py-2 text-left text-base text-[var(--color-text)] hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]";

/**
 * The top-bar organization chip. Each organization shows the services it
 * runs; "No organization" is a valid choice. Sample data is a labeled
 * organization here, opened with Preview with sample data.
 */
export function OrganizationSwitcher() {
  const navigate = useNavigate();
  const { state, addSampleTenant, setActiveOrganization, disconnectTenant } = useAppState();
  const { openSetup } = useSetupFlow();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingDisconnect, setPendingDisconnect] = useState<{
    tenantId: string;
    name: string;
    sample: boolean;
  } | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  /** Close the menu; focus goes back to the chip unless something else takes it. */
  const close = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const menuItems = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? []);

  // Opening moves focus into the menu: the active organization, else the first item.
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const items = menuItems();
      (items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = menuItems();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const move = (next: number) => {
      event.preventDefault();
      items[(next + items.length) % items.length]?.focus();
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(items.length - 1);
    else if (event.key === "Tab") close(false);
  };
  const organizations = resolveOrganizations(state);
  const active = activeOrganizationOf(state);
  const tenantOf = (organization: OrganizationRecord | undefined): TenantRecord | undefined =>
    organization
      ? state.tenants.find((tenant) => tenant.id === organization.connections.microsoft365?.tenantId)
      : undefined;
  const activeTenant = tenantOf(active);
  const sampleActive = active?.kind === "sample";

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") close();
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const pick = async (organizationId: string | null) => {
    if (organizationId === (active?.id ?? null)) {
      close();
      return;
    }
    setBusy(true);
    try {
      await setActiveOrganization(organizationId);
      close();
    } catch (error) {
      toast.error(
        ORGANIZATION_COPY.switchFailed(
          userFacingErrorReason(error instanceof Error ? error.message : String(error)) ?? "",
        ),
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
      toast.success(
        pendingDisconnect.sample
          ? "Pilot mode ended. Its sample data was deleted from this device."
          : ORGANIZATION_COPY.disconnected(pendingDisconnect.name),
      );
      setPendingDisconnect(null);
    } catch (error) {
      toast.error(
        ORGANIZATION_COPY.disconnectFailed(
          userFacingErrorReason(error instanceof Error ? error.message : String(error)) ?? "",
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  const tooltip = active
    ? sampleActive
      ? ORGANIZATION_COPY.tooltipSample
      : `${ORGANIZATION_COPY.tooltipActive(active.name, activeTenant?.username ?? "")}${
          activeTenant?.tierProbeWarning
            ? ` ${SERVICE_COPY.tierProbeWarningTitle} ${activeTenant.tierProbeWarning.message}`
            : ""
        }`
    : ORGANIZATION_COPY.tooltipNone(organizations.length > 0);

  return (
    <>
      <div ref={wrapperRef} className="app-region-no-drag relative min-w-0">
        <Tooltip content={tooltip} side="bottom">
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setOpen((current) => !current)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && !open) {
                event.preventDefault();
                setOpen(true);
              }
            }}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={
              active
                ? ORGANIZATION_COPY.chipLabel(active.name)
                : ORGANIZATION_COPY.chipLabelNone(organizations.length > 0)
            }
            className="flex h-9 max-w-[320px] items-center gap-2 rounded-[9px] px-2 text-left text-base text-[var(--color-text)] transition-colors hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
          >
            {active && activeTenant ? (
              <TenantTile tenantId={activeTenant.id} displayName={active.name} size="sm" />
            ) : (
              <span aria-hidden="true" className="inline-flex h-5 w-5 items-center justify-center rounded-[5px] bg-[var(--color-bubble)] text-xs text-[var(--color-text-muted)] ring-1 ring-[var(--color-border)]">
                ?
              </span>
            )}
            <span className="min-w-0 truncate font-medium">
              {active?.name ?? ORGANIZATION_COPY.noOrganization}
            </span>
            {sampleActive ? <Pill tone="info">{ORGANIZATION_COPY.sampleLabel}</Pill> : null}
            <IconChevronDown size={11} className="shrink-0 text-[var(--color-text-muted)]" />
          </button>
        </Tooltip>

        {open ? (
          <div
            ref={menuRef}
            role="menu"
            aria-label={ORGANIZATION_COPY.menuLabel}
            onKeyDown={onMenuKeyDown}
            className="absolute left-0 top-[calc(100%+7px)] z-[90] w-[340px] overflow-hidden rounded-[14px] bg-[var(--color-raised)] p-1.5 shadow-[var(--shadow-pop)]"
          >
            <div className="px-2.5 pb-1.5 pt-1 text-sm text-[var(--color-text-muted)]">
              {ORGANIZATION_COPY.menuHeading}
            </div>
            {organizations.length === 0 ? (
              <div className="px-2.5 py-3 text-sm leading-5 text-[var(--color-text-muted)]">
                <div className="text-[var(--color-text)]">{ORGANIZATION_COPY.none}</div>
                <div className="mt-0.5">{ORGANIZATION_COPY.noneDetail}</div>
              </div>
            ) : (
              organizations.map((organization) => {
                const tenant = tenantOf(organization);
                if (!tenant) return null;
                const isActive = organization.id === active?.id;
                const sample = organization.kind === "sample";
                const services = sample ? [] : connectedServiceIds(tenant);
                const registration = tenantRegistrationSummary(tenant);
                return (
                  <div
                    key={organization.id}
                    className={`group flex flex-wrap items-center rounded-[9px] ${isActive ? "bg-[var(--color-active)]" : "hover:bg-[var(--color-hover)]"}`}
                  >
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={isActive}
                      disabled={busy}
                      tabIndex={-1}
                      onClick={() => void pick(organization.id)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]"
                    >
                      <TenantTile tenantId={tenant.id} displayName={organization.name} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-base font-medium text-[var(--color-text)]">{organization.name}</span>
                          {sample ? <Pill tone="info">{ORGANIZATION_COPY.sampleLabel}</Pill> : null}
                        </span>
                        {sample ? (
                          <span className="mt-0.5 block truncate text-xs text-[var(--color-text-muted)]">
                            {ORGANIZATION_COPY.sampleDetail}
                          </span>
                        ) : (
                          <span
                            className="mt-1 flex items-center gap-1"
                            aria-label={ORGANIZATION_COPY.servicesLabel(services.map((id) => serviceById(id).title))}
                          >
                            {services.length > 0 ? (
                              services.map((id) => <ServiceMark key={id} serviceId={id} size="sm" />)
                            ) : (
                              <span className="text-xs text-[var(--color-text-muted)]">
                                {ORGANIZATION_COPY.servicesLabel([])}
                              </span>
                            )}
                          </span>
                        )}
                        {registration ? (
                          <span className="mt-0.5 block truncate text-xs text-[var(--color-text-muted)]" title={registration.title}>
                            {registration.text}
                          </span>
                        ) : null}
                        {tenant.tierProbeWarning ? (
                          <span className="mt-0.5 block truncate text-xs text-[var(--color-warning)]" title={tenant.tierProbeWarning.message}>
                            {SERVICE_COPY.tierProbeWarningShort}. {tenant.tierProbeWarning.message}
                          </span>
                        ) : null}
                      </span>
                      {isActive ? <IconCheck size={12} className="text-[var(--color-accent)]" /> : null}
                    </button>
                    {tenant.tierProbeWarning ? <SwitcherLicenseRetry tenant={tenant} /> : null}
                    {/* Always visible, so it is reachable without hovering the row. */}
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      aria-label={sample ? `${PILOT_COPY.leaveAction}, ${organization.name}` : `Disconnect ${organization.name}`}
                      title={sample ? PILOT_COPY.leaveAction : `Disconnect ${organization.name}`}
                      disabled={busy}
                      onClick={() => {
                        setPendingDisconnect({ tenantId: tenant.id, name: organization.name, sample });
                        close(false);
                      }}
                      className="mr-1.5 rounded-[7px] p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-danger)]"
                    >
                      <IconClose size={11} />
                    </button>
                    <TenantCheckStatus tenant={tenant} className="basis-full px-2.5 pb-1.5" />
                  </div>
                );
              })
            )}
            {organizations.length > 0 ? (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!active}
                tabIndex={-1}
                disabled={busy}
                onClick={() => void pick(null)}
                className={`${MENU_ITEM_CLASS} ${!active ? "bg-[var(--color-active)]" : ""}`}
              >
                <span aria-hidden="true" className="inline-flex h-5 w-5 items-center justify-center rounded-[5px] text-xs text-[var(--color-text-muted)] ring-1 ring-[var(--color-border)]">
                  ?
                </span>
                <span className="min-w-0 flex-1 truncate">{ORGANIZATION_COPY.noOrganization}</span>
                {!active ? <IconCheck size={12} className="text-[var(--color-accent)]" /> : null}
              </button>
            ) : null}
            <div className="my-1 h-px bg-[var(--color-border-soft)]" />
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                close(false);
                openSetup();
              }}
              className={MENU_ITEM_CLASS}
            >
              <IconPlus size={12} /> {ORGANIZATION_COPY.addOrganization}
            </button>
            {sampleActive && activeTenant ? (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={busy}
                onClick={() => {
                  setPendingDisconnect({ tenantId: activeTenant.id, name: active!.name, sample: true });
                  close(false);
                }}
                className={MENU_ITEM_CLASS}
              >
                <IconClose size={12} /> {PILOT_COPY.leaveAction}
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void addSampleTenant()
                    .then(() => {
                      close(false);
                      navigate("/chat");
                    })
                    .catch((error) =>
                      toast.error(
                        ORGANIZATION_COPY.sampleFailed(
                          error instanceof Error ? userFacingErrorReason(error.message) ?? "" : "",
                        ),
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
                className={MENU_ITEM_CLASS}
              >
                <IconPlay size={12} /> {ORGANIZATION_COPY.previewSample}
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                close(false);
                navigate("/connections");
              }}
              className={MENU_ITEM_CLASS}
            >
              <IconSettings size={12} /> {ORGANIZATION_COPY.manageConnections}
            </button>
          </div>
        ) : null}
      </div>

      <Modal open={pendingDisconnect !== null} onClose={() => { if (!busy) setPendingDisconnect(null); }} size="md">
        <ModalHeader
          title={pendingDisconnect?.sample ? PILOT_COPY.leaveTitle : ORGANIZATION_COPY.disconnectTitle(pendingDisconnect?.name ?? "")}
          subtitle={pendingDisconnect?.name}
          badge={
            <Pill tone={pendingDisconnect?.sample ? "info" : "danger"}>
              {pendingDisconnect?.sample ? ORGANIZATION_COPY.sampleLabel : "Permanent local deletion"}
            </Pill>
          }
          onClose={() => setPendingDisconnect(null)}
        />
        <div className="space-y-4 p-6">
          <div className="rounded-[10px] bg-[var(--color-danger-soft)] px-4 py-3 text-sm leading-relaxed text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
            {pendingDisconnect?.sample
              ? `${PILOT_COPY.leaveBody} You can open it again with ${ORGANIZATION_COPY.previewSample}.`
              : ORGANIZATION_COPY.disconnectBody}
          </div>
          {pendingDisconnect?.sample ? null : (
            <p className="text-sm leading-relaxed text-[var(--color-text-muted)]">{ORGANIZATION_COPY.disconnectNote}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => setPendingDisconnect(null)}>Cancel</Button>
            <Button variant="danger" disabled={busy} onClick={() => void disconnect()}>
              {busy ? "Removing" : pendingDisconnect?.sample ? PILOT_COPY.leaveAction : ORGANIZATION_COPY.disconnectAction}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

/**
 * Retry license check from the organization menu. Its progress and Cancel
 * show under the organization, and the result is reported in a toast, so
 * it stays visible after the menu closes.
 */
function SwitcherLicenseRetry({ tenant }: { tenant: TenantRecord }) {
  const { retryTenantLicenseCheck } = useAppState();
  const toast = useToast();
  const check = useTenantCheck(tenant.id);
  if (check.busy) return null;
  const label = SERVICE_COPY.retryLicenseCheckFor(tenant.displayName);
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      aria-label={label}
      title={label}
      onClick={() => {
        void check.run(() => retryTenantLicenseCheck(tenant.id)).then((result) => {
          if (result.status === "ended") {
            if (result.tone === "danger") toast.error(result.message);
            else toast.info(result.message);
          } else if (result.value.tenants.find((entry) => entry.id === tenant.id)?.tierProbeWarning) {
            toast.info(SERVICE_COPY.licenseCheckStillFailing);
          } else toast.success(SERVICE_COPY.licenseCheckFinished);
        });
      }}
      className="rounded-[7px] p-1.5 text-[var(--color-warning)] hover:bg-[var(--color-warning-soft)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-warning)]"
    >
      <IconRefresh size={11} />
    </button>
  );
}
