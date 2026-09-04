import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";

import { PageBody, PageHeader } from "../components/AppShell";
import { Avatar } from "../components/Avatar";
import { Button } from "../components/Button";
import { Select } from "../components/Select";
import { Card } from "../components/Card";
import { Pill, StatusDot } from "../components/Pill";
import { IconChanges, IconFleet, IconRefresh } from "../components/icons";
import type {
  FleetDriftStatusResult,
  FleetTenantDriftStatus,
  MultiTenantAgentBatch,
  TenantGroup,
} from "../shared/openAdminOS";
import { useAppState } from "../state";

export default function Fleet() {
  const navigate = useNavigate();
  const { state, loading: stateLoading, setActiveTenant } = useAppState();
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [groups, setGroups] = useState<TenantGroup[]>([]);
  const [fleet, setFleet] = useState<FleetDriftStatusResult | null>(null);
  const [batches, setBatches] = useState<MultiTenantAgentBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [switchingTenantId, setSwitchingTenantId] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (stateLoading || state.tenants.length < 2) return;

    const api = window.openAdminOS;
    let cancelled = false;

    const loadFleet = async () => {
      setLoading(true);
      setError(null);
      try {
        if (!api?.getFleetDriftStatus) {
          throw new Error(
            "Fleet status is unavailable in this build. Update OpenAdminOS and try again.",
          );
        }
        const [nextFleet, nextGroups, nextBatches] = await Promise.all([
          api.getFleetDriftStatus(
            selectedGroupId ? { groupId: selectedGroupId } : {},
          ),
          api.listTenantGroups(),
          api.listMultiTenantAgentBatches(),
        ]);
        if (cancelled) return;
        setFleet(nextFleet);
        setGroups(nextGroups);
        setBatches(
          [...nextBatches]
            .sort(
              (left, right) =>
                Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
            )
            .slice(0, 6),
        );
      } catch (caught) {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void loadFleet();
    return () => {
      cancelled = true;
    };
  }, [reloadNonce, selectedGroupId, state.tenants.length, stateLoading]);

  const selectedGroup = groups.find((group) => group.id === selectedGroupId);
  const hasAnyBaseline = Boolean(
    fleet?.tenants.some((tenant) => tenant.baseline),
  );
  const fleetSummary = useMemo(() => {
    if (!fleet) return null;
    const drifted = fleet.tenants.filter((tenant) => driftTotal(tenant) > 0).length;
    return {
      tenantCount: fleet.tenants.length,
      drifted,
      trackedObjects: fleet.tenants.reduce(
        (total, tenant) => total + tenant.trackedObjectCount,
        0,
      ),
    };
  }, [fleet]);

  const viewTenantChanges = async (tenant: FleetTenantDriftStatus) => {
    setSwitchingTenantId(tenant.tenantId);
    setSwitchError(null);
    try {
      await setActiveTenant(tenant.tenantId);
      navigate("/changes");
    } catch (caught) {
      setSwitchError(
        caught instanceof Error
          ? caught.message
          : `Could not switch to ${tenant.tenantName}.`,
      );
    } finally {
      setSwitchingTenantId(null);
    }
  };

  if (!stateLoading && state.tenants.length < 2) {
    return (
      <FleetEmptyState
        title="Connect more tenants to manage a fleet."
        detail="Fleet status is available after at least two Microsoft 365 tenants are connected."
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Fleet"
        subtitle="Cross-tenant baseline drift from local tracked versions."
        actions={
          <>
            <label htmlFor="fleet-group" className="sr-only">
              Tenant group
            </label>
            <Select
              id="fleet-group"
              name="fleet-group"
              aria-label="Tenant group"
              value={selectedGroupId}
              disabled={loading}
              onChange={(event) => setSelectedGroupId(event.target.value)}
              className="min-w-[180px]"
            >
              <option value="">All tenants</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </Select>
            <Button
              size="md"
              leadingIcon={<IconRefresh size={13} />}
              disabled={loading}
              onClick={() => setReloadNonce((current) => current + 1)}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
          </>
        }
      />

      <PageBody>
        <div role="status" aria-live="polite" className="sr-only">
          {loading
            ? "Loading fleet status."
            : error
              ? `Fleet status could not be loaded. ${error}`
              : `Fleet status loaded for ${fleet?.tenants.length ?? 0} tenants.`}
        </div>

        {error ? (
          <FleetError message={error} onRetry={() => setReloadNonce((value) => value + 1)} />
        ) : !fleet && loading ? (
          <FleetLoading />
        ) : fleet ? (
          <div className="space-y-5">
            <section
              aria-labelledby="fleet-overview-title"
              className="flex flex-wrap items-end justify-between gap-4"
            >
              <div>
                <h2
                  id="fleet-overview-title"
                  className="text-[16px] font-semibold text-[var(--color-text)]"
                >
                  {selectedGroup?.name ?? "All tenants"}
                  <span className="ml-2 font-mono text-[11px] font-normal text-[var(--color-text-muted)]">
                    {fleetSummary?.tenantCount ?? 0} tenants
                  </span>
                </h2>
                <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                  Evaluated {formatDateTime(fleet.evaluatedAt)} from local history.
                </p>
              </div>
              {fleetSummary ? (
                <div className="flex flex-wrap gap-2" aria-label="Fleet summary">
                  <SummaryFact label="With drift" value={fleetSummary.drifted} />
                  <SummaryFact
                    label="Tracked objects"
                    value={fleetSummary.trackedObjects.toLocaleString()}
                  />
                </div>
              ) : null}
            </section>

            {!hasAnyBaseline && fleet.tenants.length > 0 ? (
              <Card>
                <div className="flex items-center gap-3 px-4 py-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                    <IconChanges size={15} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-medium text-[var(--color-text)]">
                      No fleet baselines
                    </div>
                    <p className="mt-0.5 text-[11.5px] text-[var(--color-text-muted)]">
                      Create baselines in Changes to see fleet drift.
                    </p>
                  </div>
                  <Link
                    to="/changes"
                    className="inline-flex h-7 items-center justify-center whitespace-nowrap rounded-md bg-[var(--color-surface)] px-2.5 text-[12px] font-medium text-[var(--color-text)] ring-1 ring-[var(--color-border)] transition-colors duration-150 hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/70"
                  >
                    Open Changes
                  </Link>
                </div>
              </Card>
            ) : null}

            {switchError ? (
              <div
                role="alert"
                className="rounded-lg bg-[var(--color-danger-soft)] px-4 py-3 text-[12px] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25"
              >
                Tenant switch failed. {switchError}
              </div>
            ) : null}

            {/* The base column must be minmax(0,1fr), not auto: an auto column
                grows to the table's min-width and pushes the whole page into a
                horizontal scroll instead of scrolling inside the card. */}
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
              <FleetTable
                tenants={fleet.tenants}
                switchingTenantId={switchingTenantId}
                onViewChanges={viewTenantChanges}
              />
              <RecentFleetRuns batches={batches} />
            </div>
          </div>
        ) : null}
      </PageBody>
    </>
  );
}

function FleetTable({
  tenants,
  switchingTenantId,
  onViewChanges,
}: {
  tenants: FleetTenantDriftStatus[];
  switchingTenantId: string | null;
  onViewChanges: (tenant: FleetTenantDriftStatus) => Promise<void>;
}) {
  return (
    <Card className="min-w-0 overflow-hidden">
      <div className="overflow-x-auto">
        <table
          aria-label="Tenant fleet drift status"
          className="w-full border-collapse text-left text-[12px]"
        >
          <thead>
            <tr className="bg-[var(--color-bg-raised)] text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              <th scope="col" className="px-4 py-3">Tenant</th>
              <th scope="col" className="px-4 py-3">Baseline</th>
              <th scope="col" className="px-4 py-3">Drift</th>
              <th scope="col" className="hidden px-4 py-3 lg:table-cell">Last capture</th>
              <th scope="col" className="hidden px-4 py-3 text-right lg:table-cell">Objects</th>
              <th scope="col" className="px-4 py-3"><span className="sr-only">Action</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border-soft)]">
            {tenants.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-5 py-12 text-center text-[12.5px] text-[var(--color-text-muted)]"
                >
                  No tenants are assigned to this group.
                </td>
              </tr>
            ) : (
              tenants.map((tenant) => (
                <FleetTenantRow
                  key={tenant.tenantId}
                  tenant={tenant}
                  switching={switchingTenantId === tenant.tenantId}
                  disabled={switchingTenantId !== null}
                  onViewChanges={onViewChanges}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function FleetTenantRow({
  tenant,
  switching,
  disabled,
  onViewChanges,
}: {
  tenant: FleetTenantDriftStatus;
  switching: boolean;
  disabled: boolean;
  onViewChanges: (tenant: FleetTenantDriftStatus) => Promise<void>;
}) {
  const total = driftTotal(tenant);
  const driftTone = total === 0 ? "success" : "warning";

  return (
    <tr className="transition-colors hover:bg-[var(--color-surface-hover)]">
      <th scope="row" className="px-4 py-3 font-normal">
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar name={tenant.tenantName} size={28} />
          <div className="min-w-0">
            <div className="truncate font-medium text-[var(--color-text)]">
              {tenant.tenantName}
            </div>
            <div className="mt-0.5 max-w-[220px] truncate font-mono text-[9.5px] text-[var(--color-text-muted)]">
              {tenant.tenantId}
            </div>
          </div>
        </div>
      </th>
      <td className="px-4 py-3">
        {tenant.baseline ? (
          <div>
            <div className="font-medium text-[var(--color-text-soft)]">
              {tenant.baseline.name}
            </div>
            <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
              Created {formatDate(tenant.baseline.createdAt)}
            </div>
          </div>
        ) : (
          <span className="text-[var(--color-text-muted)]">No baseline</span>
        )}
      </td>
      <td className="px-4 py-3">
        {tenant.drift ? (
          <div
            className="flex items-center gap-1.5"
            aria-label={`${tenant.drift.added} added, ${tenant.drift.removed} removed, ${tenant.drift.modified} modified`}
          >
            <Pill tone={driftTone} className="px-2 font-mono text-[10px] tabular-nums">
              +{tenant.drift.added}
            </Pill>
            <Pill tone={driftTone} className="px-2 font-mono text-[10px] tabular-nums">
              -{tenant.drift.removed}
            </Pill>
            <Pill tone={driftTone} className="px-2 font-mono text-[10px] tabular-nums">
              ~{tenant.drift.modified}
            </Pill>
          </div>
        ) : (
          <span className="text-[11px] text-[var(--color-text-muted)]">Not evaluated</span>
        )}
      </td>
      <td className="hidden whitespace-nowrap px-4 py-3 font-mono text-[10.5px] text-[var(--color-text-soft)] lg:table-cell">
        {tenant.lastCaptureAt ? (
          <time dateTime={tenant.lastCaptureAt} title={formatDateTime(tenant.lastCaptureAt)}>
            {formatRelative(tenant.lastCaptureAt)}
          </time>
        ) : (
          <span className="text-[var(--color-text-muted)]">No capture</span>
        )}
      </td>
      <td className="hidden px-4 py-3 text-right font-mono text-[11px] text-[var(--color-text-soft)] tabular-nums lg:table-cell">
        {tenant.trackedObjectCount.toLocaleString()}
      </td>
      <td className="px-4 py-3 text-right">
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => void onViewChanges(tenant)}
          aria-label={`View changes for ${tenant.tenantName}`}
        >
          {switching ? "Switching" : "View changes"}
        </Button>
      </td>
    </tr>
  );
}

function RecentFleetRuns({ batches }: { batches: MultiTenantAgentBatch[] }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-[var(--color-border-soft)] px-4 py-3.5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[12.5px] font-semibold text-[var(--color-text)]">
              Recent fleet runs
            </h2>
            <p className="mt-1 text-[10.5px] leading-4 text-[var(--color-text-muted)]">
              One tenant-pinned run record per tenant.
            </p>
          </div>
          <IconFleet size={16} className="mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
        </div>
      </div>
      {batches.length === 0 ? (
        <div className="px-4 py-10 text-center text-[12px] text-[var(--color-text-muted)]">
          No fleet runs recorded yet.
        </div>
      ) : (
        <ul aria-label="Recent fleet runs" className="divide-y divide-[var(--color-border-soft)]">
          {batches.map((batch) => (
            <li key={batch.id} className="px-4 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-[12px] font-medium text-[var(--color-text)]">
                    {batch.agentName}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
                    <span className="font-mono tabular-nums">
                      {batch.resolvedTenantIds.length} tenant{batch.resolvedTenantIds.length === 1 ? "" : "s"}
                    </span>
                    <span aria-hidden="true" className="opacity-50">·</span>
                    <time dateTime={batch.updatedAt}>{formatRelative(batch.updatedAt)}</time>
                  </div>
                </div>
                <Pill tone={batchStatusTone(batch.status)} className="shrink-0">
                  <StatusDot tone={batchStatusDot(batch.status)} />
                  {batchStatusLabel(batch.status)}
                </Pill>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SummaryFact({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-[92px] rounded-lg bg-[var(--color-surface)] px-3 py-2 text-right ring-1 ring-[var(--color-border-soft)]">
      <div className="font-mono text-[13px] font-semibold text-[var(--color-text)] tabular-nums">
        {value}
      </div>
      <div className="mt-0.5 text-[9px] uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </div>
    </div>
  );
}

function FleetLoading() {
  return (
    <Card>
      <div className="flex min-h-[240px] items-center justify-center gap-2 text-[12px] text-[var(--color-text-muted)]">
        <span className="h-3.5 w-3.5 animate-spin rounded-full border border-[var(--color-border-strong)] border-t-[var(--color-accent)]" />
        Loading fleet status…
      </div>
    </Card>
  );
}

function FleetError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card>
      <div className="mx-auto max-w-[560px] px-6 py-12 text-center">
        <h2 className="text-[16px] font-semibold text-[var(--color-text)]">
          Fleet status could not be loaded
        </h2>
        <p role="alert" className="mt-2 text-[12.5px] leading-5 text-[var(--color-text-muted)]">
          {message}
        </p>
        <Button className="mt-5" size="sm" leadingIcon={<IconRefresh size={12} />} onClick={onRetry}>
          Try again
        </Button>
      </div>
    </Card>
  );
}

function FleetEmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <>
      <PageHeader title="Fleet" subtitle="Cross-tenant baseline drift from local tracked versions." />
      <PageBody>
        <Card>
          <div className="mx-auto max-w-[520px] px-6 py-14 text-center">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
              <IconFleet size={18} />
            </div>
            <h2 className="mt-4 text-[16px] font-semibold text-[var(--color-text)]">{title}</h2>
            <p className="mt-2 text-[12.5px] leading-5 text-[var(--color-text-muted)]">{detail}</p>
          </div>
        </Card>
      </PageBody>
    </>
  );
}

function driftTotal(tenant: FleetTenantDriftStatus): number {
  if (!tenant.drift) return 0;
  return tenant.drift.added + tenant.drift.removed + tenant.drift.modified;
}

function batchStatusLabel(status: MultiTenantAgentBatch["status"]): string {
  if (status === "awaiting-confirmation") return "Needs review";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function batchStatusTone(status: MultiTenantAgentBatch["status"]) {
  if (status === "completed") return "success" as const;
  if (status === "failed") return "danger" as const;
  if (status === "queued" || status === "running") return "info" as const;
  if (status === "partial" || status === "awaiting-confirmation") return "warning" as const;
  return "default" as const;
}

function batchStatusDot(status: MultiTenantAgentBatch["status"]) {
  if (status === "completed") return "success" as const;
  if (status === "failed") return "danger" as const;
  if (status === "queued" || status === "running") return "info" as const;
  if (status === "partial" || status === "awaiting-confirmation") return "warning" as const;
  return "muted" as const;
}

function formatRelative(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const difference = Date.now() - timestamp;
  if (difference < 60_000) return "just now";
  if (difference < 60 * 60_000) return `${Math.floor(difference / 60_000)}m ago`;
  if (difference < 24 * 60 * 60_000) return `${Math.floor(difference / (60 * 60_000))}h ago`;
  return `${Math.floor(difference / (24 * 60 * 60_000))}d ago`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
