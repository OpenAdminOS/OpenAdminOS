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
  IconConnectors,
  IconFlask,
  IconPlus,
  IconRefresh,
  IconSearch,
} from "./icons";
import { TenantCheckStatus, useTenantCheck } from "./ServiceAccess";
import { Modal, ModalHeader } from "./Modal";
import { Pill } from "./Pill";
import { connectedServiceIds } from "./ServiceMark";
import { useToast } from "./Toast";
import { Tooltip } from "./ui";
import { PILOT_COPY } from "../shared/pilot-mode";
import {
  activeOrganizationOf,
  resolveOrganizations,
  serviceById,
  type OrganizationRecord,
  type TenantRecord,
} from "../shared/openAdminOS";

const MENU_ITEM_CLASS =
  "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm text-[var(--color-text-soft)] hover:bg-[var(--color-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]";

const SWITCHER_MENU_ID = "organization-switcher-menu";

/** From this many organizations the switcher starts with a filter field. */
export const ORGANIZATION_FILTER_FROM = 6;

/**
 * The top-bar organization chip. Each organization shows the services it
 * runs; "No organization" is a valid choice. Sample data is a labeled
 * organization here, opened with Preview with sample data.
 */
export function OrganizationSwitcher() {
  const navigate = useNavigate();
  const { state, addSampleTenant, setActiveOrganization, disconnectTenant } = useAppState();
  const [query, setQuery] = useState("");
  const filterRef = useRef<HTMLInputElement | null>(null);
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

  // Opening moves focus into the menu: the filter when there is one, else
  // the active organization, else the first item. A new opening starts unfiltered.
  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (filterRef.current) {
        filterRef.current.focus();
        return;
      }
      const items = menuItems();
      (items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  /** Down moves into the list; Enter picks the first match; Home and End stay in the input. */
  const onFilterKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      menuItems()[0]?.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const first = shown[0];
      if (first) void pick(first.id);
      else if (showNoOrganization) void pick(null);
    } else if (event.key === "Tab") close(false);
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = menuItems();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const move = (next: number) => {
      event.preventDefault();
      items[(next + items.length) % items.length]?.focus();
    };
    // From outside the list, Down goes to the first item and Up to the last.
    if (event.key === "ArrowDown") move(index < 0 ? 0 : index + 1);
    else if (event.key === "ArrowUp" && index === 0 && filterRef.current) {
      // Up from the first organization returns to the filter.
      event.preventDefault();
      filterRef.current.focus();
    } else if (event.key === "ArrowUp") move(index < 0 ? items.length - 1 : index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(items.length - 1);
    else if (event.key === "Tab") close(false);
  };
  const active = activeOrganizationOf(state);
  const tenantOf = (organization: OrganizationRecord | undefined): TenantRecord | undefined =>
    organization
      ? state.tenants.find((tenant) => tenant.id === organization.connections.microsoft365?.tenantId)
      : undefined;
  // Selectable organizations, the most recently used first.
  const organizations = orderByRecentUse(
    resolveOrganizations(state).filter((organization) => tenantOf(organization) !== undefined),
    (organization) => tenantOf(organization)?.lastUsedAt ?? tenantOf(organization)?.addedAt,
  );
  const showFilter = organizations.length >= ORGANIZATION_FILTER_FROM;
  const shown = showFilter ? filterOrganizations(organizations, query, (organization) => tenantOf(organization)?.username) : organizations;
  const showNoOrganization =
    organizations.length > 0 && (!showFilter || query.trim() === "" || ORGANIZATION_COPY.noOrganization.toLowerCase().includes(query.trim().toLowerCase()));
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
    // Enter in the filter and clicks share this guard while a switch runs.
    if (busy) return;
    if (organizationId === (active?.id ?? null)) {
      close();
      return;
    }
    // On failure focus goes back to the item that was picked, in the open menu.
    const origin = document.activeElement instanceof HTMLElement && menuRef.current?.contains(document.activeElement)
      ? document.activeElement
      : null;
    setBusy(true);
    try {
      await setActiveOrganization(organizationId);
      close();
    } catch (error) {
      window.requestAnimationFrame(() => origin?.focus());
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
            aria-controls={open ? SWITCHER_MENU_ID : undefined}
            aria-label={
              active
                ? ORGANIZATION_COPY.chipLabel(active.name)
                : ORGANIZATION_COPY.chipLabelNone(organizations.length > 0)
            }
            className="flex h-9 max-w-[320px] items-center gap-2 rounded-[9px] px-2 text-left text-base text-[var(--color-text)] transition-colors hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
          >
            {active && activeTenant ? <OrganizationAvatar name={active.name} /> : <NoOrganizationMark />}
            <span className="min-w-0 truncate font-medium">
              {active?.name ?? ORGANIZATION_COPY.noOrganization}
            </span>
            {sampleActive ? <Pill tone="info">{ORGANIZATION_COPY.sampleLabel}</Pill> : null}
            <IconChevronDown size={11} className="shrink-0 text-[var(--color-text-muted)]" />
          </button>
        </Tooltip>

        {open ? (
          <div className="absolute left-0 top-[calc(100%+7px)] z-[90] w-[320px] overflow-hidden rounded-lg bg-[var(--color-bg-elevated)] p-1.5 shadow-[var(--shadow-pop)]">
            {/* The filter sits outside the menu, so the input keeps its own keys. */}
            {showFilter ? (
              <label className="mb-1 flex h-8 items-center gap-2 rounded-md bg-[var(--color-bg-raised)] px-2.5 text-sm text-[var(--color-text-muted)] focus-within:ring-2 focus-within:ring-[var(--color-focus)]">
                <IconSearch size={14} aria-hidden="true" />
                <input
                  ref={filterRef}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={onFilterKeyDown}
                  placeholder={ORGANIZATION_COPY.findOrganization}
                  aria-label={ORGANIZATION_COPY.findOrganization}
                  aria-controls={SWITCHER_MENU_ID}
                  className="min-w-0 flex-1 bg-transparent text-md text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-placeholder)]"
                />
              </label>
            ) : null}
            {showFilter ? (
              <span role="status" aria-live="polite" className="sr-only">
                {query.trim() ? ORGANIZATION_COPY.matchCount(shown.length) : ""}
              </span>
            ) : null}
            <div
              ref={menuRef}
              id={SWITCHER_MENU_ID}
              role="menu"
              aria-label={ORGANIZATION_COPY.menuLabel}
              onKeyDown={onMenuKeyDown}
            >
            {organizations.length === 0 ? (
              <div className="px-2.5 py-3 text-sm leading-5 text-[var(--color-text-muted)]">
                <div className="text-[var(--color-text)]">{ORGANIZATION_COPY.none}</div>
                <div className="mt-0.5">{ORGANIZATION_COPY.noneDetail}</div>
              </div>
            ) : (
              <div className="max-h-[min(360px,55vh)] overflow-y-auto" data-testid="organization-list">
                {shown.length === 0 ? (
                  <div role="status" className="px-2.5 py-3 text-sm text-[var(--color-text-muted)]">
                    {ORGANIZATION_COPY.noMatch(query.trim())}
                  </div>
                ) : null}
                {shown.map((organization) => {
                  const tenant = tenantOf(organization)!;
                  const isActive = organization.id === active?.id;
                  const sample = organization.kind === "sample";
                  const services = sample ? [] : connectedServiceIds(tenant);
                  const detail = sample
                    ? ORGANIZATION_COPY.sampleDetail
                    : ORGANIZATION_COPY.servicesLine(
                        services.map((id) => serviceById(id).title),
                        tenant.appRegistration?.kind === "custom",
                      );
                  return (
                    <div key={organization.id} className={`rounded-md ${isActive ? "bg-[var(--color-active)]" : "hover:bg-[var(--color-hover)]"}`}>
                      <div className="flex items-center">
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={isActive}
                          // Busy keeps focus on the item: aria-disabled, not disabled.
                          aria-disabled={busy || undefined}
                          tabIndex={-1}
                          onClick={() => {
                            if (!busy) void pick(organization.id);
                          }}
                          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]"
                        >
                          <OrganizationAvatar name={organization.name} />
                          <span className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate text-md text-[var(--color-text)]">{organization.name}</span>
                              {sample ? <Pill tone="info">{ORGANIZATION_COPY.sampleLabel}</Pill> : null}
                            </span>
                            <span
                              className="block truncate text-xs text-[var(--color-text-muted)]"
                              {...(sample ? {} : { "aria-label": ORGANIZATION_COPY.servicesLabel(services.map((id) => serviceById(id).title)) })}
                              title={detail}
                            >
                              {detail}
                            </span>
                            {tenant.tierProbeWarning ? (
                              <span className="block truncate text-xs text-[var(--color-text-muted)]" title={tenant.tierProbeWarning.message}>
                                {SERVICE_COPY.tierProbeWarningShort}. {tenant.tierProbeWarning.message}
                              </span>
                            ) : null}
                          </span>
                          {isActive ? <IconCheck size={14} className="shrink-0 text-[var(--color-text)]" /> : null}
                        </button>
                        {tenant.tierProbeWarning ? <SwitcherLicenseRetry tenant={tenant} /> : null}
                      </div>
                      <TenantCheckStatus tenant={tenant} className="px-2.5 pb-1.5" inMenu />
                    </div>
                  );
                })}
                {showNoOrganization ? (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={!active}
                    tabIndex={-1}
                    aria-disabled={busy || undefined}
                    onClick={() => {
                      if (!busy) void pick(null);
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)] ${!active ? "bg-[var(--color-active)]" : ""}`}
                  >
                    <NoOrganizationMark />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-md text-[var(--color-text)]">{ORGANIZATION_COPY.noOrganization}</span>
                      <span className="block truncate text-xs text-[var(--color-text-muted)]">{ORGANIZATION_COPY.noOrganizationDetail}</span>
                    </span>
                    {!active ? <IconCheck size={14} className="shrink-0 text-[var(--color-text)]" /> : null}
                  </button>
                ) : null}
              </div>
            )}
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
              <IconPlus size={14} /> {ORGANIZATION_COPY.addOrganization}
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
                <IconClose size={14} /> {PILOT_COPY.leaveAction}
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
                <IconFlask size={14} /> {ORGANIZATION_COPY.previewSample}
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
              <IconConnectors size={14} /> {ORGANIZATION_COPY.manageConnections}
            </button>
            </div>
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
        // The retry button gives way to Cancel; focus moves there, not to the page.
        window.setTimeout(() =>
          window.requestAnimationFrame(() =>
            document.querySelector<HTMLElement>(`[aria-label="${CSS.escape(SERVICE_COPY.cancelCheckFor(tenant.displayName))}"]`)?.focus(),
          ),
        );
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

/** The most recently used first; ties keep their order. */
export function orderByRecentUse<T>(items: readonly T[], usedAt: (item: T) => string | undefined): T[] {
  const time = (item: T) => {
    const value = Date.parse(usedAt(item) ?? "");
    return Number.isFinite(value) ? value : 0;
  };
  return items.map((item, index) => ({ item, index })).sort((a, b) => time(b.item) - time(a.item) || a.index - b.index).map(({ item }) => item);
}

/** Matches the name, and the signed-in account's domain, case-insensitively. */
export function filterOrganizations<T extends { name: string }>(items: readonly T[], query: string, account: (item: T) => string | undefined): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...items];
  return items.filter((item) => {
    const domain = account(item)?.split("@")[1] ?? "";
    return item.name.toLowerCase().includes(needle) || domain.toLowerCase().includes(needle);
  });
}

/** A neutral two-letter avatar: organizations are told apart by name, not colour. */
function OrganizationAvatar({ name }: { name: string }) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = (words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2)).toUpperCase();
  return (
    <span
      aria-hidden="true"
      className="inline-grid h-6 w-6 shrink-0 place-items-center rounded-[6px] bg-[var(--color-bg-raised)] text-[10.5px] font-semibold text-[var(--color-text-soft)] ring-1 ring-inset ring-[var(--color-border-soft)]"
    >
      {letters}
    </span>
  );
}

/** An empty dashed tile, as for a service that is not connected in mockup 32: nothing is chosen, nothing is wrong. */
function NoOrganizationMark() {
  return (
    <span
      aria-hidden="true"
      data-testid="no-organization-mark"
      className="inline-block h-6 w-6 shrink-0 rounded-[6px] border border-dashed border-[var(--color-border-strong)]"
    />
  );
}
