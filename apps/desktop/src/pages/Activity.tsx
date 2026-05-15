import { useNavigate } from "react-router";
import { PageBody, PageHeader } from "../components/AppShell";
import { Card } from "../components/Card";
import { Pill } from "../components/Pill";
import { useAppState } from "../state";
import type { RunRecord, RunStatus } from "../shared/openAgents";

export default function Activity() {
  const navigate = useNavigate();
  const { state } = useAppState();

  return (
    <>
      <PageHeader
        title="Activity"
        subtitle="A local, append-only history of every agent run on this device."
      />
      <PageBody>
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
            {state.runs.length === 0 ? (
              <div className="px-5 py-10 text-center text-[13px] text-[var(--color-text-muted)]">
                No runs recorded yet.
              </div>
            ) : (
              state.runs.map((run) => (
                <button
                  key={run.id}
                  onClick={() => navigate(`/runs/${run.id}`)}
                  className="grid w-full grid-cols-[1.6fr_1fr_1fr_auto_auto_auto] items-center gap-4 px-5 py-3 text-left text-[13px] hover:bg-[var(--color-surface-hover)]"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium text-[var(--color-text)]">
                      {agentNameForRun(run, state.installedAgents)}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]">
                      {run.summary ?? run.id}
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

function agentNameForRun(
  run: RunRecord,
  agents: { slug: string; name: string }[],
) {
  return agents.find((agent) => agent.slug === run.agentSlug)?.name ?? run.agentSlug;
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
