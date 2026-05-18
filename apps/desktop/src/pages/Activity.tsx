import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { PageBody, PageHeader } from "../components/AppShell";
import { Card } from "../components/Card";
import { Pill } from "../components/Pill";
import { IconSearch } from "../components/icons";
import { useAppState } from "../state";
import type { RunRecord, RunStatus } from "../shared/openAgents";

type Filter = { kind: "all" } | { kind: "tenant"; tenantId: string };

export default function Activity() {
  const navigate = useNavigate();
  const { state } = useAppState();
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [query, setQuery] = useState("");

  const counts = useMemo(() => {
    const total = state.runs.length;
    const byTenant = new Map<string, number>();
    for (const run of state.runs) {
      if (run.tenantId) {
        byTenant.set(run.tenantId, (byTenant.get(run.tenantId) ?? 0) + 1);
      }
    }
    return { total, byTenant };
  }, [state.runs]);

  const filteredRuns = useMemo(() => {
    const base = filter.kind === "all"
      ? state.runs
      : state.runs.filter((run) => run.tenantId === filter.tenantId);
    const q = query.trim().toLowerCase();
    if (q.length === 0) return base;
    return base.filter((run) => {
      const agentName =
        state.installedAgents.find((agent) => agent.slug === run.agentSlug)?.name ?? "";
      return (
        agentName.toLowerCase().includes(q) ||
        run.agentSlug.toLowerCase().includes(q) ||
        run.id.toLowerCase().includes(q) ||
        (run.summary?.toLowerCase().includes(q) ?? false) ||
        (run.providerId?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [filter, state.runs, state.installedAgents, query]);

  // Show the filter row only when 2+ tenants exist — single-tenant case
  // is already implied by the page title.
  const showFilters = state.tenants.length > 1;

  return (
    <>
      <PageHeader
        title="Activity"
        subtitle="A local, append-only history of every agent run on this device."
        actions={
          <div className="relative">
            <IconSearch
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search runs"
              className="h-9 w-[260px] rounded-lg bg-[var(--color-surface)] pl-9 pr-3 text-[13px] text-[var(--color-text)] ring-1 ring-[var(--color-border)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-[var(--color-accent)]/50"
            />
          </div>
        }
      />
      <PageBody>
        {showFilters && (
          <div className="mb-4 flex flex-wrap items-center gap-1.5">
            <FilterChip
              label="All tenants"
              count={counts.total}
              active={filter.kind === "all"}
              onClick={() => setFilter({ kind: "all" })}
            />
            {state.tenants.map((tenant) => (
              <FilterChip
                key={tenant.id}
                label={tenant.displayName}
                count={counts.byTenant.get(tenant.id) ?? 0}
                active={filter.kind === "tenant" && filter.tenantId === tenant.id}
                onClick={() => setFilter({ kind: "tenant", tenantId: tenant.id })}
              />
            ))}
          </div>
        )}

        <Card>
          <div className="divide-y divide-[var(--color-border-soft)]">
            <div className="grid grid-cols-[1.6fr_1fr_1fr_auto_auto] items-center gap-4 px-5 py-3 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              <span>Agent</span>
              <span>Provider</span>
              <span>When</span>
              <span>Duration</span>
              <span>Status</span>
            </div>
            {filteredRuns.length === 0 ? (
              <div className="px-5 py-10 text-center text-[13px] text-[var(--color-text-muted)]">
                {state.runs.length === 0
                  ? "No runs recorded yet."
                  : "No runs match this filter."}
              </div>
            ) : (
              filteredRuns.map((run) => (
                <button
                  key={run.id}
                  onClick={() => navigate(`/runs/${run.id}`)}
                  className="grid w-full grid-cols-[1.6fr_1fr_1fr_auto_auto] items-center gap-4 px-5 py-3 text-left text-[13px] hover:bg-[var(--color-surface-hover)]"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium text-[var(--color-text)]">
                      {agentNameForRun(run, state.installedAgents)}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
                      <span className="truncate">{run.summary ?? run.id}</span>
                      <span className="opacity-50">·</span>
                      <span className="shrink-0">
                        {tenantLabel(run, state.tenants)}
                      </span>
                    </div>
                  </div>
                  <span className="text-[var(--color-text-soft)]">
                    {providerDisplayName(run.providerId, state.providers)}
                  </span>
                  <span className="text-[var(--color-text-soft)]">
                    {formatDate(run.queuedAt)}
                  </span>
                  <span className="font-mono text-[12px] text-[var(--color-text-soft)] tabular-nums">
                    {formatDuration(run)}
                  </span>
                  <Pill tone={statusTone(run.status)}>{statusLabel(run.status)}</Pill>
                </button>
              ))
            )}
          </div>
        </Card>
      </PageBody>
    </>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11.5px] font-medium transition-colors ${
        active
          ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/30"
          : "bg-[var(--color-surface)] text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
      }`}
    >
      <span>{label}</span>
      <span
        className={`font-mono text-[10.5px] tabular-nums ${
          active ? "opacity-80" : "text-[var(--color-text-muted)]"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function agentNameForRun(
  run: RunRecord,
  agents: { slug: string; name: string }[],
) {
  return agents.find((agent) => agent.slug === run.agentSlug)?.name ?? run.agentSlug;
}

function tenantLabel(
  run: RunRecord,
  tenants: { id: string; displayName: string }[],
): string {
  if (run.tenantId) {
    return tenants.find((tenant) => tenant.id === run.tenantId)?.displayName ?? "connected tenant";
  }
  return "—";
}

function providerDisplayName(
  providerId: string | undefined,
  providers: { id: string; name: string }[],
): string {
  if (!providerId) return "—";
  return providers.find((p) => p.id === providerId)?.name ?? providerId;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(run: RunRecord) {
  if (!run.startedAt || !run.finishedAt) return "-";
  const durationMs =
    new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (Number.isNaN(durationMs) || durationMs < 0) return "-";
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function statusLabel(status: RunStatus) {
  if (status === "queued") return "Queued";
  if (status === "running") return "Running";
  if (status === "awaiting-confirmation") return "Awaiting confirmation";
  if (status === "completed") return "Done";
  if (status === "rejected") return "Rejected";
  if (status === "cancelled") return "Cancelled";
  return "Failed";
}

function statusTone(status: RunStatus) {
  if (status === "failed") return "danger";
  if (status === "queued" || status === "running") return "warning";
  if (status === "rejected" || status === "cancelled") return "default";
  return "success";
}
