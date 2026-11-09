import { useMemo, useState } from "react";

import { useAppState } from "../state";
import { SCHEDULE_ORGANIZATION_COPY, userFacingErrorReason } from "../copy";
import { activeOrganizationOf, resolveOrganizations } from "../shared/openAdminOS";
import { Button } from "./Button";
import { IconWarning } from "./icons";

/**
 * Why schedules are not running, wherever schedules are shown. Each
 * schedule belongs to one organization and runs only while it is active;
 * an unassigned schedule waits until the admin assigns it. After the move
 * to organizations, a one-time notice says where existing schedules went.
 */
export function SchedulesPausedNotice({ className = "" }: { className?: string }) {
  const { state, setActiveOrganization, dismissOrganizationMigrationNotice } = useAppState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const organizations = resolveOrganizations(state);
  const active = activeOrganizationOf(state);
  const sampleActive = active?.kind === "sample";
  const enabled = state.installedAgents.filter((agent) => agent.schedule?.enabled);
  const unassigned = enabled.filter(
    (agent) => !organizations.some((organization) => organization.id === agent.schedule?.organizationId && organization.kind !== "sample"),
  ).length;
  const elsewhere = enabled.filter(
    (agent) =>
      active !== undefined &&
      agent.schedule?.organizationId !== active.id &&
      organizations.some((organization) => organization.id === agent.schedule?.organizationId),
  ).length;
  const recent = useMemo(() => {
    const realIds = new Set(
      organizations.filter((organization) => organization.kind !== "sample").map((organization) => organization.connections.microsoft365?.tenantId),
    );
    const tenant = state.tenants
      .filter((entry) => realIds.has(entry.id))
      .sort((left, right) => Date.parse(right.lastUsedAt ?? right.addedAt) - Date.parse(left.lastUsedAt ?? left.addedAt))[0];
    return tenant ? organizations.find((organization) => organization.connections.microsoft365?.tenantId === tenant.id) : undefined;
  }, [organizations, state.tenants]);
  const migration = state.organizationMigration;
  const migratedTo = migration?.assignedOrganizationId
    ? organizations.find((organization) => organization.id === migration.assignedOrganizationId)
    : undefined;

  const paused = sampleActive
    ? SCHEDULE_ORGANIZATION_COPY.pausedSample
    : !active && enabled.length > 0
      ? SCHEDULE_ORGANIZATION_COPY.pausedNone
      : undefined;
  const waiting = !paused && (unassigned > 0 || elsewhere > 0)
    ? SCHEDULE_ORGANIZATION_COPY.waiting(unassigned, elsewhere)
    : undefined;

  if (!paused && !waiting && !migration) return null;

  const run = (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    void task()
      .catch((caught) =>
        setError(userFacingErrorReason(caught instanceof Error ? caught.message : String(caught)) ?? ""),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className={`space-y-2 ${className}`}>
      {paused || waiting ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--color-warning-soft)] px-3 py-2 text-sm text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25"
        >
          <span className="flex min-w-0 items-center gap-2">
            <IconWarning size={14} className="shrink-0" />
            <span>{paused ?? waiting}</span>
          </span>
          {paused && recent ? (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => setActiveOrganization(recent.id))}>
              {busy ? "Switching" : `Switch to ${recent.name}`}
            </Button>
          ) : null}
        </div>
      ) : null}
      {migration ? (
        // A one-time note: plain text after the warnings, with an inline Dismiss.
        <p role="status" className="px-0.5 text-sm text-[var(--color-text-muted)]">
          {SCHEDULE_ORGANIZATION_COPY.migrated(migration, migratedTo?.name)}{" "}
          <button
            type="button"
            disabled={busy}
            onClick={() => run(dismissOrganizationMigrationNotice)}
            className="text-[var(--color-text-soft)] underline underline-offset-2 hover:text-[var(--color-text)]"
          >
            {SCHEDULE_ORGANIZATION_COPY.dismiss}
          </button>
        </p>
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">{SCHEDULE_ORGANIZATION_COPY.failed(error)}</p>
      ) : null}
    </div>
  );
}
