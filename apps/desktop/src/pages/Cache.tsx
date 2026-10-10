import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { PageBody, PageHeader } from "../components/AppShell";
import { Modal, ModalHeader } from "../components/Modal";
import {
  Badge,
  Button,
  DataTable,
  SegmentedControl,
  Toolbar,
  type DataTableColumn,
} from "../components/ui";
import { userFacingErrorReason } from "../copy";
import { createPendingIntent, type PendingIntent } from "../setup/pending-intent";
import { useSetupFlow } from "../setup/SetupFlowContext";
import type {
  GraphCacheResourceKind,
  GraphCacheStatus,
  LocalDataSummary,
} from "../shared/openAdminOS";
import { useAppState } from "../state";

type CacheResource = GraphCacheStatus["resources"][number];
type ClearTarget = "chat" | "graph" | null;

export default function Cache() {
  return (
    <>
      <PageHeader title="Data" />
      <PageBody>
        <DataSettingsSection />
      </PageBody>
    </>
  );
}

export function DataSettingsSection() {
  const { state } = useAppState();
  const { requireTenant } = useSetupFlow();
  const location = useLocation();
  const navigate = useNavigate();
  const tenantId = state.activeTenantId;
  const activeTenant = tenantId
    ? state.tenants.find((tenant) => tenant.id === tenantId)
    : undefined;
  const [status, setStatus] = useState<GraphCacheStatus>();
  const [localData, setLocalData] = useState<LocalDataSummary>();
  const [selected, setSelected] = useState<Set<GraphCacheResourceKind>>(new Set());
  const [search, setSearch] = useState("");
  const [resourceFilter, setResourceFilter] = useState("all");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [clearTarget, setClearTarget] = useState<ClearTarget>(null);
  const [clearing, setClearing] = useState(false);
  const epoch = useRef(0);
  const resumedIntentRef = useRef<string | null>(null);

  const load = useCallback(async (generation = epoch.current) => {
    if (!tenantId) {
      setStatus(undefined);
      setSelected(new Set());
      setLocalData(await window.openAdminOS?.getLocalDataSummary().catch(() => undefined));
      return;
    }
    const [nextStatus, nextLocalData] = await Promise.all([
      window.openAdminOS!.getGraphCacheStatus(tenantId),
      window.openAdminOS!.getLocalDataSummary(tenantId).catch(() => undefined),
    ]);
    if (generation !== epoch.current) return;
    setStatus(nextStatus);
    setLocalData(nextLocalData);
    setSelected((current) =>
      current.size > 0
        ? current
        : new Set(nextStatus.resources.map((resource) => resource.resource)),
    );
  }, [tenantId]);

  useEffect(() => {
    const generation = ++epoch.current;
    setStatus(undefined);
    setSelected(new Set());
    setError("");
    setBusy(false);
    void load(generation).catch((caught) => {
      if (generation === epoch.current) setError(String(caught));
    });
    if (!tenantId) return;
    const timer = window.setInterval(() => {
      void load(generation).catch((caught) => {
        if (generation === epoch.current) setError(String(caught));
      });
    }, 1000);
    return () => {
      epoch.current += 1;
      window.clearInterval(timer);
    };
  }, [load, tenantId]);

  const issues = useMemo(
    () =>
      status?.resources.filter(
        (resource) =>
          !resource.refreshedAt || Boolean(resource.lastError) || resource.pageLimitReached,
      ) ?? [],
    [status],
  );
  const visibleResources = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase();
    return (status?.resources ?? []).filter(
      (resource) =>
        (!normalizedSearch ||
          resource.label.toLocaleLowerCase().includes(normalizedSearch) ||
          resource.resource.toLocaleLowerCase().includes(normalizedSearch) ||
          resource.scopeSet.some((scope) =>
            scope.toLocaleLowerCase().includes(normalizedSearch),
          )) &&
        (resourceFilter === "all" || issues.includes(resource)),
    );
  }, [issues, resourceFilter, search, status]);
  const latestRefresh = useMemo(
    () =>
      (status?.resources ?? [])
        .flatMap((resource) => (resource.refreshedAt ? [resource.refreshedAt] : []))
        .sort()
        .at(-1),
    [status],
  );
  const job = status?.preload;
  const running = busy || job?.status === "running";

  const runAction = async (action: () => Promise<unknown>) => {
    const generation = epoch.current;
    setBusy(true);
    setError("");
    try {
      await action();
      await load(generation);
    } catch (caught) {
      if (generation === epoch.current) setError(String(caught));
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  };

  const preload = (retry: boolean) => {
    if (!tenantId) return;
    void runAction(() =>
      window.openAdminOS!.startGraphCachePreload({
        tenantId,
        resources: [...selected].filter(
          (resource) => !retry || issues.some((issue) => issue.resource === resource),
        ),
      }),
    );
  };

  const refreshNow = useCallback(async () => {
    const api = window.openAdminOS;
    if (!api || refreshing) return;
    if (
      !requireTenant(
        createPendingIntent({
          kind: "refresh-cache",
          returnTo: `${location.pathname}${location.search}`,
        }),
      )
    ) {
      return;
    }
    setRefreshing(true);
    setError("");
    try {
      await api.refreshGraphCache();
      await load();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setRefreshing(false);
    }
  }, [load, location.pathname, location.search, refreshing, requireTenant]);

  useEffect(() => {
    const routeState = location.state as { resumePendingIntent?: PendingIntent } | null;
    const resumed = routeState?.resumePendingIntent;
    if (
      resumed?.kind !== "refresh-cache" ||
      resumedIntentRef.current === resumed.createdAt
    ) {
      return;
    }
    resumedIntentRef.current = resumed.createdAt;
    navigate(location.pathname + location.search, { replace: true, state: null });
    void refreshNow();
  }, [location.pathname, location.search, location.state, navigate, refreshNow]);

  const clearLocalData = async () => {
    const api = window.openAdminOS;
    if (!api || !clearTarget || clearing) return;
    setClearing(true);
    setError("");
    try {
      const next =
        clearTarget === "chat"
          ? await api.clearIntuneChatHistory()
          : await api.clearGraphCache(tenantId);
      setLocalData(next);
      if (clearTarget === "graph") await load();
      setClearTarget(null);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setClearing(false);
    }
  };

  const columns = useMemo<DataTableColumn<CacheResource>[]>(
    () => [
      {
        id: "resource",
        header: "Resource",
        sortable: true,
        sortValue: (resource) => resource.label,
        render: (resource) => (
          <label className="flex min-w-44 items-center gap-2 text-base font-medium text-[var(--color-text)]">
            <input
              type="checkbox"
              checked={selected.has(resource.resource)}
              disabled={running}
              onChange={(event) =>
                setSelected((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(resource.resource);
                  else next.delete(resource.resource);
                  return next;
                })
              }
            />
            {resource.label}
          </label>
        ),
      },
      {
        id: "rows",
        header: "Rows",
        sortable: true,
        align: "right",
        sortValue: (resource) => resource.rows,
        render: (resource) => resource.rows.toLocaleString(),
      },
      {
        id: "pages",
        header: "Pages",
        sortable: true,
        align: "right",
        sortValue: (resource) => resource.pages ?? 0,
        render: (resource) => resource.pages?.toLocaleString() ?? "0",
      },
      {
        id: "refreshed",
        header: "Last refresh",
        sortable: true,
        sortValue: (resource) => resource.refreshedAt ?? "",
        render: (resource) =>
          resource.lastError ? (
            <span className="text-[var(--color-danger)]">Refresh failed</span>
          ) : resource.refreshedAt ? (
            formatDateTime(resource.refreshedAt)
          ) : (
            "Not refreshed"
          ),
      },
      {
        id: "permission",
        header: "Permission",
        render: (resource) => (
          <span className="break-words font-mono text-xs">
            {resource.scopeSet.join(", ") || "None"}
          </span>
        ),
      },
    ],
    [running, selected],
  );

  const selectedIssueCount = issues.filter((resource) =>
    selected.has(resource.resource),
  ).length;
  const graphRows =
    localData?.activeTenantGraphRowCount ??
    status?.resources.reduce((total, resource) => total + resource.rows, 0) ??
    0;

  return (
    <div className="max-w-[1040px] rounded-[10px] bg-[var(--color-surface)] ring-1 ring-[var(--color-border)]">
      <div
        id="setting-tenant-cache"
        tabIndex={-1}
        className="setting-row grid gap-4 border-b border-[var(--color-border-soft)] px-5 py-4 lg:grid-cols-[minmax(220px,0.7fr)_minmax(0,1fr)]"
      >
        <div>
          <div className="text-base font-medium text-[var(--color-text)]">Tenant cache</div>
          <p className="mt-0.5 text-sm text-[var(--color-text-muted)]">
            {activeTenant
              ? `${activeTenant.displayName}, ${latestRefresh ? `last refreshed ${formatDateTime(latestRefresh)}` : "not refreshed"}. Stored on this device.`
              : "Connect a tenant before refreshing local Microsoft Graph data."}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Badge tone={latestRefresh ? "success" : "neutral"}>
            {latestRefresh ? "Ready" : "No cache"}
          </Badge>
          <Button
            size="sm"
            variant="secondary"
            disabled={refreshing}
            onClick={() => void refreshNow()}
          >
            {refreshing ? "Refreshing…" : "Refresh now"}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={running || !tenantId || selected.size === 0}
            onClick={() => preload(false)}
          >
            Preload {selected.size === status?.resources.length ? "all " : ""}
            {selected.size} resources
          </Button>
        </div>
      </div>

      <div className="grid gap-4 border-b border-[var(--color-border-soft)] px-5 py-4 lg:grid-cols-[minmax(220px,0.7fr)_minmax(0,1fr)]">
        <div>
          <div className="text-base font-medium text-[var(--color-text)]">Preload progress</div>
          <p className="mt-0.5 text-sm text-[var(--color-text-muted)]">
            Failed or cancelled collections keep their previous local snapshot.
          </p>
        </div>
        <div className="min-w-0">
          {job ? (
            <div role="status" className="space-y-2">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span>
                  {job.status === "running"
                    ? "Preloading…"
                    : job.status === "complete"
                      ? "Selected resources complete"
                      : job.status === "cancelled"
                        ? "Refresh cancelled"
                        : "Refresh finished with incomplete coverage"}
                </span>
                <span className="font-mono text-xs">{job.completed}/{job.total}</span>
              </div>
              <progress
                className="w-full accent-[var(--color-accent)]"
                aria-label="Cache preload progress"
                max={job.total || 1}
                value={job.completed}
              />
              {job.error ? <p className="text-sm text-[var(--color-danger)]">{job.error}</p> : null}
            </div>
          ) : (
            <p className="text-sm text-[var(--color-text-muted)]">No preload job has run for this tenant.</p>
          )}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={running || selectedIssueCount === 0 || !tenantId}
              onClick={() => preload(true)}
            >
              Retry incomplete
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={job?.status !== "running" || busy || !tenantId}
              onClick={() => {
                if (tenantId) {
                  void runAction(() => window.openAdminOS!.cancelGraphCachePreload(tenantId));
                }
              }}
            >
              Cancel refresh
            </Button>
          </div>
        </div>
      </div>

      <div
        id="setting-periodic-cache-refresh"
        tabIndex={-1}
        className="setting-row grid gap-4 border-b border-[var(--color-border-soft)] px-5 py-4 lg:grid-cols-[minmax(220px,0.7fr)_minmax(0,1fr)] lg:items-center"
      >
        <div>
          <div className="text-base font-medium text-[var(--color-text)]">Automatic refresh</div>
          <p className="mt-0.5 text-sm text-[var(--color-text-muted)]">
            Runs while this device is awake, the app is running, and the tenant is signed in.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <label htmlFor="cache-refresh-frequency" className="text-sm text-[var(--color-text-muted)]">Frequency</label>
          <select
            id="cache-refresh-frequency"
            aria-label="Cache refresh frequency"
            disabled={busy || !status || !tenantId}
            className="h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-3 text-base"
            value={status?.schedule?.enabled ? status.schedule.intervalMinutes : 0}
            onChange={(event) => {
              if (!tenantId) return;
              const intervalMinutes = Number(event.target.value);
              void runAction(() =>
                window.openAdminOS!.setGraphCacheRefreshSchedule({
                  tenantId,
                  enabled: intervalMinutes > 0,
                  intervalMinutes: intervalMinutes || 360,
                }),
              );
            }}
          >
            <option value={0}>Manual only</option>
            <option value={60}>Every hour</option>
            <option value={360}>Every 6 hours</option>
            <option value={720}>Every 12 hours</option>
            <option value={1440}>Daily</option>
          </select>
        </div>
      </div>

      <div className="grid gap-4 border-b border-[var(--color-border-soft)] px-5 py-4 lg:grid-cols-[minmax(220px,0.7fr)_minmax(0,1fr)]">
        <div>
          <div className="text-base font-medium text-[var(--color-text)]">Local retention</div>
          <p className="mt-0.5 text-sm text-[var(--color-text-muted)]">
            Clear local chat or active-tenant cache records without disconnecting the tenant.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Badge tone="neutral">{localData?.chatConversationCount ?? 0} conversations</Badge>
          <Badge tone="neutral">{graphRows.toLocaleString()} cache rows</Badge>
          <Button size="sm" variant="danger" disabled={clearing || !localData?.chatConversationCount} onClick={() => setClearTarget("chat")}>
            Clear chat history
          </Button>
          <Button size="sm" variant="danger" disabled={clearing || !tenantId || graphRows === 0} onClick={() => setClearTarget("graph")}>
            Clear active tenant cache
          </Button>
        </div>
      </div>

      <details className="group px-5 py-4">
        <summary className="cursor-pointer text-base font-medium text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]">
          Show {status?.resources.length ?? 0} resources
        </summary>
        <div className="mt-4 space-y-3">
          <Toolbar
            search={
              <input
                type="search"
                aria-label="Find a resource"
                name="resource-search"
                autoComplete="off"
                placeholder="Find a resource"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="h-9 min-w-52 flex-1 rounded-lg bg-[var(--color-bg-raised)] px-3 text-base ring-1 ring-[var(--color-border)] placeholder:text-[var(--color-text-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              />
            }
            filters={
              <SegmentedControl
                ariaLabel="Resource filter"
                value={resourceFilter}
                onValueChange={setResourceFilter}
                options={[
                  { id: "all", label: "All" },
                  { id: "issues", label: "Needs attention" },
                ]}
              />
            }
            actions={
              <label className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
                <input
                  type="checkbox"
                  disabled={running || !status}
                  checked={Boolean(status?.resources.length) && selected.size === status?.resources.length}
                  onChange={(event) =>
                    setSelected(new Set(event.target.checked ? status?.resources.map((resource) => resource.resource) : []))
                  }
                />
                Select all
              </label>
            }
          />
          <DataTable
            caption="Tenant cache resources"
            columns={columns}
            rows={visibleResources}
            rowKey={(resource) => resource.resource}
            loading={Boolean(tenantId) && !status}
            emptyTitle={tenantId ? "No matching resources" : "No active tenant"}
            emptyDescription={tenantId ? "Change the resource search or filter." : "Connect a tenant before inspecting cache resources."}
          />
        </div>
      </details>

      {error ? (
        <div role="alert" className="border-t border-[var(--color-border-soft)] px-5 py-4 text-sm text-[var(--color-danger)]">
          {userFacingErrorReason(error) ?? "Local data could not be updated. Review the tenant connection, then try again."}
        </div>
      ) : null}

      <ClearLocalDataModal
        target={clearTarget}
        activeTenantName={activeTenant?.displayName}
        busy={clearing}
        onClose={() => setClearTarget(null)}
        onConfirm={() => void clearLocalData()}
      />
    </div>
  );
}

function ClearLocalDataModal({
  target,
  activeTenantName,
  busy,
  onClose,
  onConfirm,
}: {
  target: ClearTarget;
  activeTenantName?: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const chat = target === "chat";
  return (
    <Modal open={target !== null} onClose={onClose} size="md">
      <ModalHeader
        title={chat ? "Clear chat history" : "Clear active tenant cache"}
        subtitle="Local SQLite cleanup"
        badge={<Badge tone="danger">Local deletion</Badge>}
        onClose={onClose}
      />
      <div className="space-y-4 p-6">
        <p className="text-base leading-5 text-[var(--color-text-soft)]">
          {chat
            ? "This removes local Chat conversations, messages, and tool-call records. It does not clear Graph cache rows, disconnect tenants, or alter run history."
            : `This removes cached Graph rows and cache status for ${activeTenantName ?? "the active tenant"}. The next chat that needs tenant context refreshes the required resources again.`}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={busy} onClick={onConfirm}>{busy ? "Clearing…" : "Clear"}</Button>
        </div>
      </div>
    </Modal>
  );
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
