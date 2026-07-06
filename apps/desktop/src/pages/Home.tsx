import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { PageBody, PageHeader } from "../components/AppShell";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Pill, StatusDot } from "../components/Pill";
import {
  IconActivity,
  IconBolt,
  IconHardDrive,
  IconHub,
  IconShield,
  IconTrend,
} from "../components/icons";
import {
  deriveTrustState,
  resolveProviderDefaultModel,
  type AgentSummary,
  type RunRecord,
} from "../shared/openAdminOS";
import { useAppState } from "../state";

export default function Home() {
  const navigate = useNavigate();
  const { state, registryAgents, startRun, installAgent } = useAppState();
  const [runError, setRunError] = useState<string | null>(null);
  const offboardingAgentId = "offboarding-agent";
  const offboardingInstalled = state.installedAgents.some(
    (agent) => agent.slug === offboardingAgentId,
  );
  const offboardingAvailable = registryAgents.some(
    (agent) => agent.slug === offboardingAgentId,
  );
  const activeProvider = state.providers.find(
    (provider) => provider.id === state.activeProviderId,
  );
  const activeTenant = state.activeTenantId
    ? state.tenants.find((tenant) => tenant.id === state.activeTenantId)
    : undefined;
  const activeModel = resolveProviderDefaultModel(
    activeProvider,
    state.activeModelByProviderId,
  ).model;
  const activeTrust = deriveTrustState({
    provider: activeProvider,
    activeTenant,
    model: activeModel,
  });
  const runsThisWeek = countRecentRuns(state.runs.map((run) => run.queuedAt), 7);
  const completedRuns = state.runs.filter((run) => run.status === "completed").length;
  const providerLabel = activeTrust.label;
  const visibleAgents = state.installedAgents.slice(0, 4);

  const handleStartRun = async (agent: AgentSummary) => {
    setRunError(null);
    if (agent.mode === "write") {
      navigate(`/agents/${agent.slug}/confirm`);
      return;
    }

    try {
      const run = await startRun(agent.slug);
      navigate(`/runs/${run.id}`);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleTryWriteAgent = async () => {
    setRunError(null);
    try {
      if (!offboardingInstalled) {
        if (!offboardingAvailable) return;
        await installAgent(offboardingAgentId);
      }
      const run = await startRun(offboardingAgentId);
      navigate(`/runs/${run.id}`);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <>
      <PageHeader
        title="Home"
        subtitle={
          <span className="inline-flex items-center gap-2">
            <span>{activeTenant?.displayName ?? "No active tenant"}</span>
            <span className="opacity-50">·</span>
            <Pill tone={activeTrust.isLocal ? "success" : "warning"}>
              <IconHardDrive size={10} /> {providerLabel}
            </Pill>
          </span>
        }
      />
      <PageBody>
        {runError && (
          <div className="mb-4 flex items-start justify-between gap-3 rounded-lg bg-[var(--color-danger-soft)] px-4 py-3 ring-1 ring-[var(--color-danger)]/30">
            <div className="text-[12.5px] leading-relaxed text-[var(--color-danger)]">
              {runError}
            </div>
            <button
              onClick={() => setRunError(null)}
              aria-label="Dismiss"
              className="text-[var(--color-danger)]/70 hover:text-[var(--color-danger)]"
            >
              ×
            </button>
          </div>
        )}

        <div className="mb-7 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <StatTile
            label="Runs this week"
            value={String(runsThisWeek)}
            change="from local run history"
            icon={<IconActivity size={14} className="text-[var(--color-accent)]" />}
            mono
          />
          <StatTile
            label="Items resolved"
            value={String(completedRuns)}
            change="completed runs"
            icon={<IconTrend size={14} className="text-[var(--color-info)]" />}
            mono
          />
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section>
            <Card>
              <div className="p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-[13px] font-medium text-[var(--color-text)]">
                      Your agents
                    </h2>
                    <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">
                      {state.installedAgents.length} installed
                    </p>
                  </div>
                  <button
                    onClick={() => navigate("/agents")}
                    className="text-[11.5px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"
                  >
                    All agents →
                  </button>
                </div>

                {visibleAgents.length === 0 ? (
                  <div className="mt-4 rounded-lg bg-[var(--color-bg-raised)] p-4 text-[12.5px] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
                    No agents installed. Browse the hub to add one.
                  </div>
                ) : (
                  <div className="mt-4 divide-y divide-[var(--color-border-soft)]">
                    {visibleAgents.map((agent) => (
                      <AgentRow
                        key={agent.slug}
                        agent={agent}
                        onOpen={() => navigate(`/agents/${agent.slug}`)}
                        onRun={() => void handleStartRun(agent)}
                      />
                    ))}
                  </div>
                )}

                {visibleAgents.length === 0 && (
                  <Button
                    variant="secondary"
                    leadingIcon={<IconHub size={14} />}
                    className="mt-4"
                    onClick={() => navigate("/agents/hub")}
                  >
                    Browse hub
                  </Button>
                )}
              </div>
            </Card>
          </section>

          <aside className="flex flex-col gap-4">
            <Card>
              <div className="p-5">
                <div className="flex items-center justify-between">
                  <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                    Recent runs
                  </div>
                  <button
                    onClick={() => navigate("/activity")}
                    className="text-[11px] text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"
                  >
                    View all
                  </button>
                </div>
                <div className="mt-3 flex flex-col gap-2.5">
                  {state.runs.length === 0 && (
                    <div className="rounded-lg bg-[var(--color-bg-raised)] p-3 text-[12px] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
                      No runs recorded yet.
                    </div>
                  )}
                  {state.runs.slice(0, 4).map((run) => (
                    <button
                      key={run.id}
                      onClick={() => navigate(`/runs/${run.id}`)}
                      className="flex items-start gap-3 rounded-lg bg-[var(--color-bg-raised)] p-3 text-left ring-1 ring-[var(--color-border-soft)] transition-colors hover:bg-[var(--color-surface-hover)]"
                    >
                      <StatusDot
                        tone={runStatusTone(run.status)}
                        className="mt-1.5"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12.5px] font-medium text-[var(--color-text)]">
                          {run.agentSlug}
                        </div>
                        <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                          {run.summary ?? run.status}
                        </div>
                      </div>
                      <span className="font-mono text-[10.5px] text-[var(--color-text-muted)]">
                        {formatShortDate(run.queuedAt)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </Card>

            <Card>
              <div className="p-5">
                <div className="flex items-center gap-2">
                  <IconShield
                    size={14}
                    className="text-[var(--color-success)]"
                  />
                  <span className="text-[12.5px] font-medium text-[var(--color-text)]">
                    {activeTrust.label}
                  </span>
                </div>
                <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-text-soft)]">
                  {activeTrust.detail}
                </p>
                <button
                  onClick={() => navigate("/settings")}
                  className="mt-3 text-[11.5px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"
                >
                  Review providers →
                </button>
              </div>
            </Card>

            <Card>
              <div className="p-5">
                <div className="flex items-center gap-2">
                  <IconBolt size={14} className="text-[var(--color-warning)]" />
                  <span className="text-[12.5px] font-medium text-[var(--color-text)]">
                    Try a write agent
                  </span>
                </div>
                <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-text-soft)]">
                  Pair "Find inactive devices" with the "Offboarding agent" to
                  see the diff confirmation flow.
                </p>
                <button
                  onClick={() => void handleTryWriteAgent()}
                  disabled={!offboardingAvailable}
                  className="mt-3 text-[11.5px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {offboardingInstalled ? "Run offboarding" : "Add + run offboarding"} →
                </button>
              </div>
            </Card>
          </aside>
        </div>
      </PageBody>
    </>
  );
}

function AgentRow({
  agent,
  onOpen,
  onRun,
}: {
  agent: AgentSummary;
  onOpen: () => void;
  onRun: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 md:flex-row md:items-center md:justify-between">
      <button onClick={onOpen} className="min-w-0 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13px] font-medium text-[var(--color-text)] hover:text-[var(--color-accent)]">
            {agent.name}
          </span>
          <Pill tone={agent.mode === "write" ? "warning" : "default"}>
            {agent.mode === "write" ? "Write" : "Read-only"}
          </Pill>
        </div>
        <p className="mt-1 line-clamp-1 text-[12px] text-[var(--color-text-muted)]">
          {agent.description}
        </p>
      </button>
      <Button variant="secondary" size="sm" onClick={onRun}>
        Run
      </Button>
    </div>
  );
}

function StatTile({
  label,
  value,
  change,
  icon,
  mono = false,
  valueClass = "text-[var(--color-text)]",
}: {
  label: string;
  value: string;
  change: string;
  icon: ReactNode;
  mono?: boolean;
  valueClass?: string;
}) {
  return (
    <Card>
      <div className="p-4">
        <div className="flex items-center justify-between">
          <span className="text-[10.5px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            {label}
          </span>
          {icon}
        </div>
        <div
          className={`mt-2 text-[26px] font-semibold leading-none tracking-tight tabular-nums ${valueClass} ${
            mono ? "font-mono" : ""
          }`}
        >
          {value}
        </div>
        <div className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
          {change}
        </div>
      </div>
    </Card>
  );
}

function countRecentRuns(startedAtValues: string[], days: number) {
  const cutoff = Date.now() - days * 86_400_000;
  return startedAtValues.filter((value) => {
    const timestamp = new Date(value).getTime();
    return !Number.isNaN(timestamp) && timestamp >= cutoff;
  }).length;
}

function formatShortDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function runStatusTone(status: RunRecord["status"]) {
  if (status === "failed") return "danger";
  if (status === "queued" || status === "running" || status === "awaiting-confirmation") {
    return "warning";
  }
  return "success";
}
