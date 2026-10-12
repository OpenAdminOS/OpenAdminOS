import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { PageBody, PageHeader } from "../components/AppShell";
import { IconChevronDown, IconSearch } from "../components/icons";
import { stripMarkdownToPlainText } from "../components/MarkdownPreview";
import {
  Badge,
  Button,
  DataTable,
  Menu,
  Section,
  SegmentedControl,
  StatusDot,
  Toolbar,
  type BadgeTone,
  type DataTableColumn,
  type MenuEntry,
} from "../components/ui";
import { useAppState } from "../state";
import type { RunRecord, RunStatus } from "../shared/openAdminOS";

type RunFilter = "all" | "failed" | "review";
type RunTrigger = "manual" | "scheduled" | "team" | "chat" | "gateway";

const terminalStatuses = new Set<RunStatus>([
  "completed",
  "failed",
  "rejected",
  "cancelled",
]);

export default function Runs() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { state } = useAppState();
  const [query, setQuery] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());

  const statusParam = searchParams.get("status");
  const statusFilter: RunFilter =
    statusParam === "failed" || statusParam === "review" ? statusParam : "all";
  const tenantFilter = searchParams.get("tenant") ?? "";
  const agentFilter = searchParams.get("agent") ?? "";
  const triggerParam = searchParams.get("trigger");
  const triggerFilter: RunTrigger | "" = isRunTrigger(triggerParam) ? triggerParam : "";

  const runningCount = state.runs.filter(
    (run) => run.status === "queued" || run.status === "running",
  ).length;

  useEffect(() => {
    if (runningCount === 0) return;
    const interval = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [runningCount]);

  const filteredRuns = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return state.runs.filter((run) => {
      if (tenantFilter && run.tenantId !== tenantFilter) return false;
      if (agentFilter && run.agentSlug !== agentFilter) return false;
      if (triggerFilter && triggerForRun(run) !== triggerFilter) return false;
      if (!normalizedQuery) return true;
      const agentName = agentNameForRun(run, state.installedAgents);
      const tenantName = tenantNameForRun(run, state.tenants);
      return [
        agentName,
        run.agentSlug,
        run.id,
        tenantName,
        run.summary,
        run.plan?.summary,
        run.providerId,
      ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
    });
  }, [
    agentFilter,
    query,
    state.installedAgents,
    state.runs,
    state.tenants,
    tenantFilter,
    triggerFilter,
  ]);

  const needsReview = useMemo(
    () =>
      filteredRuns
        .filter((run) => run.status === "awaiting-confirmation")
        .sort((left, right) => Date.parse(right.queuedAt) - Date.parse(left.queuedAt)),
    [filteredRuns],
  );
  const running = useMemo(
    () =>
      filteredRuns
        .filter((run) => run.status === "queued" || run.status === "running")
        .sort((left, right) => Date.parse(right.queuedAt) - Date.parse(left.queuedAt)),
    [filteredRuns],
  );
  const history = useMemo(() => {
    if (statusFilter === "review") return [];
    return filteredRuns.filter((run) => {
      if (!terminalStatuses.has(run.status)) return false;
      return statusFilter !== "failed" || run.status === "failed";
    });
  }, [filteredRuns, statusFilter]);
  const hasActiveHistoryFilters = Boolean(
    query.trim() || statusFilter !== "all" || tenantFilter || agentFilter || triggerFilter,
  );

  useEffect(() => {
    const anchor = location.hash.slice(1);
    if (!anchor) return;
    const frame = window.requestAnimationFrame(() => {
      const section = document.getElementById(anchor);
      const scrollRoot = section?.closest<HTMLElement>(".app-page-body");
      if (!(section instanceof HTMLElement) || !scrollRoot) return;
      const rootRect = scrollRoot.getBoundingClientRect();
      const sectionRect = section.getBoundingClientRect();
      const top = Math.max(
        0,
        scrollRoot.scrollTop + sectionRect.top - rootRect.top - 16,
      );
      if (typeof scrollRoot.scrollTo === "function") {
        scrollRoot.scrollTo({ top, behavior: "auto" });
      } else {
        scrollRoot.scrollTop = top;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [history.length, location.hash, needsReview.length, running.length]);

  const updateParam = (key: string, value?: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  const openRun = (run: RunRecord) => {
    const search = searchParams.toString();
    navigate({
      pathname: `/runs/${encodeURIComponent(run.id)}`,
      search: search ? `?${search}` : "",
    });
  };

  const agentOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const run of state.runs) {
      options.set(run.agentSlug, agentNameForRun(run, state.installedAgents));
    }
    return [...options.entries()].sort((left, right) => left[1].localeCompare(right[1]));
  }, [state.installedAgents, state.runs]);

  const filterMenuItems: MenuEntry[] = [
    {
      id: "tenant-all",
      label: `Tenant: All${tenantFilter ? "" : " (selected)"}`,
      onSelect: () => updateParam("tenant"),
    },
    ...state.tenants.map<MenuEntry>((tenant) => ({
      id: `tenant-${tenant.id}`,
      label: `Tenant: ${tenant.displayName}${tenantFilter === tenant.id ? " (selected)" : ""}`,
      onSelect: () => updateParam("tenant", tenant.id),
    })),
    { id: "separator-trigger", type: "separator" },
    {
      id: "trigger-all",
      label: `Trigger: All${triggerFilter ? "" : " (selected)"}`,
      onSelect: () => updateParam("trigger"),
    },
    ...(["manual", "scheduled", "team", "chat", "gateway"] as const).map<MenuEntry>(
      (trigger) => ({
        id: `trigger-${trigger}`,
        label: `Trigger: ${capitalize(trigger)}${triggerFilter === trigger ? " (selected)" : ""}`,
        onSelect: () => updateParam("trigger", trigger),
      }),
    ),
    { id: "separator-agent", type: "separator" },
    {
      id: "agent-all",
      label: `Agent: All${agentFilter ? "" : " (selected)"}`,
      onSelect: () => updateParam("agent"),
    },
    ...agentOptions.map<MenuEntry>(([slug, name]) => ({
      id: `agent-${slug}`,
      label: `Agent: ${name}${agentFilter === slug ? " (selected)" : ""}`,
      onSelect: () => updateParam("agent", slug),
    })),
  ];

  const activeFilterCount = [tenantFilter, agentFilter, triggerFilter].filter(Boolean).length;
  const columns = useMemo<DataTableColumn<RunRecord>[]>(
    () => [
      {
        id: "agent",
        header: "Agent",
        sortable: true,
        sortValue: (run) => agentNameForRun(run, state.installedAgents),
        render: (run) => (
          <div className="min-w-0">
            <div className="truncate font-medium text-[var(--color-text)]">
              {agentNameForRun(run, state.installedAgents)}
            </div>
            <div className="truncate text-xs text-[var(--color-text-muted)]">{run.id}</div>
          </div>
        ),
      },
      {
        id: "tenant",
        header: "Tenant",
        sortable: true,
        sortValue: (run) => tenantNameForRun(run, state.tenants),
        render: (run) => tenantNameForRun(run, state.tenants),
      },
      {
        id: "trigger",
        header: "Trigger",
        sortable: true,
        sortValue: (run) => triggerForRun(run),
        render: (run) => capitalize(triggerForRun(run)),
      },
      {
        id: "status",
        header: "Status",
        sortable: true,
        sortValue: (run) => run.status,
        render: (run) => (
          <Badge tone={statusTone(run.status)}>
            {run.status === "running" ? (
              <StatusDot tone="info" label="Running" />
            ) : null}
            {statusLabel(run.status)}
          </Badge>
        ),
      },
      {
        id: "started",
        header: "Started",
        sortable: true,
        sortValue: (run) => Date.parse(run.startedAt ?? run.queuedAt),
        render: (run) => formatDate(run.startedAt ?? run.queuedAt),
      },
      {
        id: "duration",
        header: "Duration",
        sortable: true,
        align: "right",
        sortValue: (run) => durationMs(run),
        render: (run) => (
          <span className="tabular-nums">{formatDuration(run, nowMs)}</span>
        ),
      },
      {
        id: "provider",
        header: "Provider",
        sortable: true,
        sortValue: (run) => providerNameForRun(run, state.providers),
        render: (run) => providerNameForRun(run, state.providers),
      },
    ],
    [nowMs, state.installedAgents, state.providers, state.tenants],
  );

  return (
    <>
      <PageHeader title="Runs" />
      <PageBody>
        <div className="space-y-7">
          {needsReview.length > 0 && statusFilter !== "failed" ? (
            <Section id="needs-review" title="Needs review" className="scroll-mt-4">
              <div className="divide-y divide-[var(--color-border-soft)] overflow-hidden rounded-[10px] bg-[var(--color-surface)] ring-1 ring-[var(--color-border)]">
                {needsReview.map((run, index) => (
                  <div
                    key={run.id}
                    className="grid grid-cols-[minmax(90px,1fr)_minmax(90px,0.8fr)_64px_minmax(120px,1.4fr)_50px_auto] items-center gap-3 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium text-[var(--color-text)]">
                        {agentNameForRun(run, state.installedAgents)}
                      </div>
                      <div className="truncate text-xs text-[var(--color-text-muted)]">{run.id}</div>
                    </div>
                    <div className="truncate text-sm text-[var(--color-text-soft)]">
                      {tenantNameForRun(run, state.tenants)}
                    </div>
                    <div className="text-sm text-[var(--color-text-muted)]">
                      {capitalize(triggerForRun(run))}
                    </div>
                    <div className="truncate text-sm text-[var(--color-text-soft)]" title={reviewSummary(run)}>
                      {reviewSummary(run)}
                    </div>
                    <div className="text-right text-xs tabular-nums text-[var(--color-text-muted)]">
                      {formatAge(run.queuedAt, nowMs)}
                    </div>
                    <Button
                      size="sm"
                      variant={index === 0 ? "primary" : "secondary"}
                      onClick={() => openRun(run)}
                    >
                      Review
                    </Button>
                  </div>
                ))}
              </div>
            </Section>
          ) : null}

          {running.length > 0 && statusFilter === "all" ? (
            <Section id="running" title="Running" className="scroll-mt-4">
              <div className="divide-y divide-[var(--color-border-soft)] overflow-hidden rounded-[10px] bg-[var(--color-surface)] ring-1 ring-[var(--color-border)]">
                {running.map((run) => {
                  const completed = run.steps.filter(
                    (step) => step.status === "completed" || step.status === "skipped",
                  ).length;
                  const total = run.steps.length;
                  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
                  return (
                    <button
                      key={run.id}
                      type="button"
                      onClick={() => openRun(run)}
                      className="grid w-full grid-cols-[minmax(120px,1.2fr)_minmax(100px,0.8fr)_minmax(150px,1fr)_72px] items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium text-[var(--color-text)]">
                          {agentNameForRun(run, state.installedAgents)}
                        </div>
                        <div className="truncate text-xs text-[var(--color-text-muted)]">
                          {tenantNameForRun(run, state.tenants)}
                        </div>
                      </div>
                      <Badge tone={run.status === "running" ? "info" : "warning"} className="w-fit">
                        <StatusDot tone={run.status === "running" ? "info" : "warning"} />
                        {statusLabel(run.status)}
                      </Badge>
                      <div className="min-w-0">
                        <div className="mb-1 flex items-center justify-between gap-2 text-xs text-[var(--color-text-muted)]">
                          <span>{total > 0 ? `${completed} of ${total} steps` : "Preparing pipeline"}</span>
                          <span className="tabular-nums">{progress}%</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-raised)]">
                          <div
                            className="h-full rounded-full bg-[var(--color-info)] transition-transform motion-reduce:transition-none"
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                      </div>
                      <div className="text-right text-sm tabular-nums text-[var(--color-text-soft)]">
                        {formatDuration(run, nowMs)}
                      </div>
                    </button>
                  );
                })}
              </div>
            </Section>
          ) : null}

          <Section id="history" title="History" className="scroll-mt-4">
            <div className="space-y-3">
              <Toolbar
                aria-label="Run history controls"
                search={
                  <div className="relative min-w-[220px] flex-1 sm:max-w-[320px]">
                    <IconSearch
                      size={14}
                      aria-hidden="true"
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
                    />
                    <label htmlFor="run-search" className="sr-only">
                      Search runs
                    </label>
                    <input
                      id="run-search"
                      name="run-search"
                      type="search"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Search runs"
                      autoComplete="off"
                      className="h-9 w-full rounded-lg bg-[var(--color-surface)] pl-9 pr-3 text-base text-[var(--color-text)] ring-1 ring-[var(--color-border)] placeholder:text-[var(--color-text-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                    />
                  </div>
                }
                filters={
                  <SegmentedControl
                    ariaLabel="Run status"
                    value={statusFilter}
                    onValueChange={(value) =>
                      updateParam("status", value === "all" ? undefined : value)
                    }
                    options={[
                      { id: "all", label: "All" },
                      { id: "failed", label: "Failed" },
                      { id: "review", label: "Needs review" },
                    ]}
                  />
                }
                actions={
                  <Menu
                    ariaLabel="Filter runs"
                    items={filterMenuItems}
                    trigger={
                      <Button
                        size="sm"
                        variant="secondary"
                        trailingIcon={<IconChevronDown size={12} />}
                      >
                        {activeFilterCount > 0 ? `Filter (${activeFilterCount})` : "Filter"}
                      </Button>
                    }
                  />
                }
              />
              <DataTable
                caption="Run history"
                columns={columns}
                rows={history}
                rowKey={(run) => run.id}
                onRowClick={openRun}
                initialSort={{ columnId: "started", direction: "descending" }}
                emptyTitle={
                  statusFilter === "review"
                    ? "No runs awaiting review"
                    : hasActiveHistoryFilters
                      ? "No runs found"
                      : "No finished runs yet"
                }
                emptyDescription={
                  hasActiveHistoryFilters
                    ? "Change the search or filters to see more runs."
                    : state.runs.length === 0
                      ? "Runs appear here after an agent starts."
                      : "Finished runs will appear here."
                }
              />
            </div>
          </Section>
        </div>
      </PageBody>
    </>
  );
}

export function agentNameForRun(
  run: RunRecord,
  agents: { slug: string; name: string }[],
): string {
  if (run.origin === "baseline-rollback") return "Baseline rollback";
  if (run.origin === "external-proposal") {
    return `External proposal from ${run.external?.clientName ?? "unknown client"}`;
  }
  return agents.find((agent) => agent.slug === run.agentSlug)?.name ?? run.agentSlug;
}

export function tenantNameForRun(
  run: RunRecord,
  tenants: { id: string; displayName: string }[],
): string {
  if (!run.tenantId) return "No tenant";
  return tenants.find((tenant) => tenant.id === run.tenantId)?.displayName ?? run.tenantId;
}

export function providerNameForRun(
  run: RunRecord,
  providers: { id: string; name: string }[],
): string {
  if (!run.providerId) return "Not recorded";
  return providers.find((provider) => provider.id === run.providerId)?.name ?? run.providerId;
}

export function triggerForRun(run: RunRecord): RunTrigger {
  if (run.origin === "external-proposal") return "gateway";
  if (run.office || run.officeContext) return "team";
  const source = (run as RunRecord & { source?: { type?: string } }).source;
  if (source?.type === "intune-chat") return "chat";
  if (run.trigger === "schedule") return "scheduled";
  return "manual";
}

export function statusLabel(status: RunStatus): string {
  if (status === "queued") return "Queued";
  if (status === "running") return "Running";
  if (status === "awaiting-confirmation") return "Awaiting confirmation";
  if (status === "completed") return "Completed";
  if (status === "rejected") return "Rejected";
  if (status === "cancelled") return "Cancelled";
  return "Failed";
}

export function statusTone(status: RunStatus): BadgeTone {
  if (status === "failed") return "danger";
  if (status === "completed") return "success";
  if (status === "running") return "info";
  if (status === "queued" || status === "awaiting-confirmation") return "warning";
  return "neutral";
}

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDuration(run: RunRecord, nowMs = Date.now()): string {
  if (run.status === "queued") return "Queued";
  if (run.status === "awaiting-confirmation") return "Paused";
  const milliseconds = durationMs(run, nowMs);
  if (milliseconds === undefined) return "Not recorded";
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.floor(seconds % 60).toString().padStart(2, "0")}s`;
}

function durationMs(run: RunRecord, nowMs = Date.now()): number | undefined {
  if (!run.startedAt) return undefined;
  const end = run.finishedAt ? Date.parse(run.finishedAt) : nowMs;
  const start = Date.parse(run.startedAt);
  const duration = end - start;
  return Number.isNaN(duration) || duration < 0 ? undefined : duration;
}

function reviewSummary(run: RunRecord): string {
  const summary = run.plan?.summary ?? run.summary;
  return summary ? stripMarkdownToPlainText(summary) : "Review the proposed actions.";
}

function formatAge(value: string, nowMs: number): string {
  const elapsed = nowMs - Date.parse(value);
  if (Number.isNaN(elapsed) || elapsed < 0) return "Now";
  if (elapsed < 60_000) return "Now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function isRunTrigger(value: string | null): value is RunTrigger {
  return value === "manual" ||
    value === "scheduled" ||
    value === "team" ||
    value === "chat" ||
    value === "gateway";
}
