import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { Select } from "../components/Select";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Section,
  StatusDot,
  Toolbar,
  type DataTableColumn,
} from "../components/ui";
import { IconChanges, IconFleet, IconRefresh } from "../components/icons";
import type {
  FleetDriftStatusResult,
  FleetTenantDriftStatus,
  MultiTenantAgentBatch,
  TenantGroup,
} from "../shared/openAdminOS";
import { useAppState } from "../state";

export interface FleetScopeProps {
  reloadToken?: number;
}

export default function FleetScope({ reloadToken = 0 }: FleetScopeProps) {
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
    if (stateLoading || state.tenants.length < 2) {
      setLoading(false);
      return;
    }

    const api = window.openAdminOS;
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
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
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    reloadNonce,
    reloadToken,
    selectedGroupId,
    state.tenants.length,
    stateLoading,
  ]);

  const selectedGroup = groups.find((group) => group.id === selectedGroupId);
  const summary = useMemo(() => {
    if (!fleet) return null;
    return {
      drifted: fleet.tenants.filter((tenant) => driftTotal(tenant) > 0).length,
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

  const columns = useMemo<DataTableColumn<FleetTenantDriftStatus>[]>(
    () => [
      {
        id: "tenant",
        header: "Tenant",
        sortValue: (tenant) => tenant.tenantName,
        sortable: true,
        render: (tenant) => (
          <div className="min-w-0">
            <div className="truncate font-medium text-[var(--color-text)]">
              {tenant.tenantName}
            </div>
            <div className="truncate font-mono text-xs text-[var(--color-text-muted)]">
              {tenant.tenantId}
            </div>
          </div>
        ),
      },
      {
        id: "baseline",
        header: "Baseline",
        sortValue: (tenant) => tenant.baseline?.name ?? "",
        sortable: true,
        render: (tenant) =>
          tenant.baseline ? (
            <div>
              <div className="font-medium text-[var(--color-text-soft)]">
                {tenant.baseline.name}
              </div>
              <div className="text-xs text-[var(--color-text-muted)]">
                Created {formatDate(tenant.baseline.createdAt)}
              </div>
            </div>
          ) : (
            <span className="text-[var(--color-text-muted)]">No baseline</span>
          ),
      },
      {
        id: "drift",
        header: "Drift",
        sortValue: driftTotal,
        sortable: true,
        render: (tenant) => <FleetDriftBadge tenant={tenant} />,
      },
      {
        id: "capture",
        header: "Last capture",
        sortValue: (tenant) => tenant.lastCaptureAt ?? "",
        sortable: true,
        render: (tenant) =>
          tenant.lastCaptureAt ? (
            <time dateTime={tenant.lastCaptureAt} title={formatDateTime(tenant.lastCaptureAt)}>
              {formatRelative(tenant.lastCaptureAt)}
            </time>
          ) : (
            <span className="text-[var(--color-text-muted)]">No capture</span>
          ),
      },
      {
        id: "objects",
        header: "Objects",
        sortValue: (tenant) => tenant.trackedObjectCount,
        sortable: true,
        align: "right",
        render: (tenant) => (
          <span className="tabular-nums">
            {tenant.trackedObjectCount.toLocaleString()}
          </span>
        ),
      },
      {
        id: "action",
        header: "Action",
        align: "right",
        render: (tenant) => (
          <Button
            size="sm"
            variant="ghost"
            disabled={switchingTenantId !== null}
            onClick={() => void viewTenantChanges(tenant)}
            aria-label={`View changes for ${tenant.tenantName}`}
          >
            {switchingTenantId === tenant.tenantId ? "Switching…" : "View changes"}
          </Button>
        ),
      },
    ],
    [switchingTenantId],
  );

  if (!stateLoading && state.tenants.length < 2) {
    return (
      <EmptyState
        icon={<IconFleet size={18} />}
        title="Connect a second tenant"
        description="All-tenant change status is available after two Microsoft 365 tenants are connected."
      />
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={<IconRefresh size={18} />}
        title="All-tenant status could not be loaded"
        description={error}
        action={
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setReloadNonce((value) => value + 1)}
          >
            Try again
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <Toolbar
        filters={
          <>
            <label htmlFor="fleet-group" className="text-sm text-[var(--color-text-muted)]">
              Tenant group
            </label>
            <Select
              id="fleet-group"
              name="fleet-group"
              aria-label="Tenant group"
              value={selectedGroupId}
              disabled={loading}
              onChange={(event) => setSelectedGroupId(event.target.value)}
              className="h-7 min-w-44"
            >
              <option value="">All tenants</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </Select>
          </>
        }
        actions={
          fleet ? (
            <span className="text-xs text-[var(--color-text-muted)]">
              Evaluated {formatDateTime(fleet.evaluatedAt)}
            </span>
          ) : null
        }
      />

      {switchError ? (
        <div
          role="alert"
          className="rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25"
        >
          Tenant switch failed. {switchError}
        </div>
      ) : null}

      {fleet && summary ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--color-text-muted)]">
          <span>{selectedGroup?.name ?? "All tenants"}</span>
          <span aria-hidden="true">·</span>
          <span>{fleet.tenants.length.toLocaleString()} tenants</span>
          <span aria-hidden="true">·</span>
          <span>{summary.drifted.toLocaleString()} with drift</span>
          <span aria-hidden="true">·</span>
          <span>{summary.trackedObjects.toLocaleString()} tracked objects</span>
        </div>
      ) : null}

      {loading && !fleet ? (
        <DataTable
          caption="Tenant fleet drift status"
          columns={columns}
          rows={[]}
          rowKey={(tenant) => tenant.tenantId}
          loading
        />
      ) : fleet?.tenants.length ? (
        <DataTable
          caption="Tenant fleet drift status"
          columns={columns}
          rows={fleet.tenants}
          rowKey={(tenant) => tenant.tenantId}
        />
      ) : (
        <EmptyState
          icon={<IconChanges size={18} />}
          title="No tenants in this group"
          description="Choose another tenant group to review cross-tenant change status."
        />
      )}

      {fleet && !fleet.tenants.some((tenant) => tenant.baseline) ? (
        <div className="flex items-center justify-between gap-4 border-t border-[var(--color-border-soft)] py-3">
          <div>
            <div className="text-base font-medium text-[var(--color-text)]">
              No tenant has an active baseline
            </div>
            <div className="text-sm text-[var(--color-text-muted)]">
              Create a baseline in the tenant-scoped Baselines view to measure drift.
            </div>
          </div>
          <Button
            variant="secondary"
            onClick={() => navigate("/changes?view=baselines")}
          >
            Open Baselines
          </Button>
        </div>
      ) : null}

      <RecentFleetRuns batches={batches} />
    </div>
  );
}

function FleetDriftBadge({ tenant }: { tenant: FleetTenantDriftStatus }) {
  if (!tenant.drift) return <Badge tone="neutral">Not evaluated</Badge>;
  const total = driftTotal(tenant);
  return (
    <Badge
      tone={total === 0 ? "success" : "warning"}
      aria-label={`${tenant.drift.added} added, ${tenant.drift.removed} removed, ${tenant.drift.modified} modified`}
    >
      <StatusDot tone={total === 0 ? "success" : "warning"} />
      {total === 0
        ? "No drift"
        : `${tenant.drift.added} added, ${tenant.drift.removed} removed, ${tenant.drift.modified} modified`}
    </Badge>
  );
}

function RecentFleetRuns({ batches }: { batches: MultiTenantAgentBatch[] }) {
  return (
    <Section title="Recent all-tenant runs">
      {batches.length === 0 ? (
        <EmptyState
          icon={<IconFleet size={18} />}
          title="No all-tenant runs"
          description="Multi-tenant agent runs appear here after they are queued."
          className="py-8"
        />
      ) : (
        <ul aria-label="Recent all-tenant runs" className="divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)]">
          {batches.map((batch) => (
            <li
              key={batch.id}
              className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:gap-6"
            >
              <div className="min-w-0">
                <div className="truncate text-base font-medium text-[var(--color-text)]">
                  {batch.agentName}
                </div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  {batch.resolvedTenantIds.length.toLocaleString()} tenant
                  {batch.resolvedTenantIds.length === 1 ? "" : "s"}
                </div>
              </div>
              <Badge tone={batchStatusTone(batch.status)}>
                <StatusDot tone={batchStatusTone(batch.status)} />
                {batchStatusLabel(batch.status)}
              </Badge>
              <time className="text-sm text-[var(--color-text-muted)]" dateTime={batch.updatedAt}>
                {formatRelative(batch.updatedAt)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </Section>
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
  if (status === "partial" || status === "awaiting-confirmation") {
    return "warning" as const;
  }
  return "neutral" as const;
}

function formatRelative(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const difference = Date.now() - timestamp;
  if (difference < 60_000) return "just now";
  if (difference < 60 * 60_000) return `${Math.floor(difference / 60_000)}m ago`;
  if (difference < 24 * 60 * 60_000) {
    return `${Math.floor(difference / (60 * 60_000))}h ago`;
  }
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
