import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { PageBody, PageHeader } from "../components/AppShell";
import { Card } from "../components/Card";
import { Pill } from "../components/Pill";
import { useAppState } from "../state";
import type { RunRecord, RunStatus } from "../shared/openAgents";

type Filter = { kind: "all" } | { kind: "synthetic" } | { kind: "tenant"; tenantId: string };

export default function Activity() {
  const navigate = useNavigate();
  const { state } = useAppState();
  const [filter, setFilter] = useState<Filter>({ kind: "all" });

  const counts = useMemo(() => {
    const total = state.runs.length;
    const synthetic = state.runs.filter((run) => run.dataSource === "synthetic").length;
    const byTenant = new Map<string, number>();
    for (const run of state.runs) {
      if (run.tenantId) {
        byTenant.set(run.tenantId, (byTenant.get(run.tenantId) ?? 0) + 1);
      }
    }
    return { total, synthetic, byTenant };
  }, [state.runs]);

  const filteredRuns = useMemo(() => {
    if (filter.kind === "all") return state.runs;
    if (filter.kind === "synthetic") {
      return state.runs.filter((run) => run.dataSource === "synthetic");
    }
    return state.runs.filter((run) => run.tenantId === filter.tenantId);
  }, [filter, state.runs]);

  const showFilters = state.tenants.length > 0 || counts.synthetic > 0;

  return (
    <>
      <PageHeader
        title="Activity"
        subtitle="A local, append-only history of every agent run on this device."
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
            <FilterChip
              label="Synthetic"
              count={counts.synthetic}
              active={filter.kind === "synthetic"}
              onClick={() => setFilter({ kind: "synthetic" })}
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
            <div className="grid grid-cols-[1.6fr_1fr_1fr_auto_auto_auto] items-center gap-4 px-5 py-3 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              <span>Agent</span>
              <span>Provider</span>
              <span>When</span>
              <span>Duration</span>
              <span>Cost</span>
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
                  className="grid w-full grid-cols-[1.6fr_1fr_1fr_auto_auto_auto] items-center gap-4 px-5 py-3 text-left text-[13px] hover:bg-[var(--color-surface-hover)]"
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
                    {run.providerId ?? "-"}
                  </span>
                  <span className="text-[var(--color-text-soft)]">
                    {formatDate(run.queuedAt)}
                  </span>
                  <span className="font-mono text-[12px] text-[var(--color-text-soft)] tabular-nums">
                    {formatDuration(run)}
                  </span>
                  <span className="font-mono text-[12px] text-[var(--color-success)] tabular-nums">
                    {state.trust.isLocal ? "$0.00" : "External"}
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
  if (run.dataSource === "graph" && run.tenantId) {
    return tenants.find((tenant) => tenant.id === run.tenantId)?.displayName ?? "real tenant";
  }
  return "synthetic";
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
  if (status === "completed") return "Done";
  return "Failed";
}

function statusTone(status: RunStatus) {
  if (status === "failed") return "danger";
  if (status === "queued" || status === "running") return "warning";
  return "success";
}
