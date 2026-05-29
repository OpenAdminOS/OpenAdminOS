import { useState } from "react";
import { useNavigate } from "react-router";
import { PageBody, PageHeader } from "../components/AppShell";
import { AgentCard } from "../components/AgentCard";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { NewAgentModal } from "../components/NewAgentModal";
import { Pill, StatusDot } from "../components/Pill";
import {
  IconActivity,
  IconBolt,
  IconHardDrive,
  IconHub,
  IconPlus,
  IconSearch,
  IconShield,
  IconTrend,
} from "../components/icons";
import type { Agent } from "../types";
import type { AgentSummary } from "../shared/openAdminOS";
import { useAppState } from "../state";

export default function AgentsHome() {
  const navigate = useNavigate();
  const { state, registryAgents, startRun, installAgent } = useAppState();
  const [query, setQuery] = useState("");
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const handleStartRun = async (slug: string) => {
    setRunError(null);
    try {
      const run = await startRun(slug);
      navigate(`/runs/${run.id}`);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    }
  };
  const offboardingAgentId = "offboarding-agent";
  const offboardingInstalled = state.installedAgents.some(
    (agent) => agent.slug === offboardingAgentId,
  );
  const offboardingAvailable = registryAgents.some(
    (agent) => agent.slug === offboardingAgentId,
  );

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
  const activeProvider = state.providers.find(
    (provider) => provider.id === state.activeProviderId,
  );
  const displayAgents = state.installedAgents.map((agent) =>
    toDisplayAgent(agent, state.runs, activeProvider?.defaultModel),
  );

  const filtered = displayAgents.filter(
    (a) =>
      a.name.toLowerCase().includes(query.toLowerCase()) ||
      a.description.toLowerCase().includes(query.toLowerCase()),
  );

  const runsThisWeek = countRecentRuns(state.runs.map((run) => run.queuedAt), 7);
  const completedRuns = state.runs.filter((run) => run.status === "completed").length;
  // The trust label already encodes "{provider} · tenant {name}" — don't
  // append the provider name again or duplicate the tenant in a sibling
  // span. One pill, no echo.
  const providerLabel = state.trust.label;

  return (
    <>
      <PageHeader
        title="Agents"
        subtitle={
          <span className="inline-flex items-center gap-2">
            <span>{state.installedAgents.length} installed</span>
            <span className="opacity-50">·</span>
            <Pill tone={state.trust.isLocal ? "success" : "warning"}>
              <IconHardDrive size={10} /> {providerLabel}
            </Pill>
          </span>
        }
        actions={
          <>
            <div className="relative">
              <IconSearch
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search installed agents"
                className="h-9 w-[260px] rounded-lg bg-[var(--color-surface)] pl-9 pr-3 text-[13px] text-[var(--color-text)] ring-1 ring-[var(--color-border)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-[var(--color-accent)]/50"
              />
            </div>
            <Button
              variant="secondary"
              leadingIcon={<IconHub size={14} />}
              onClick={() => navigate("/hub")}
            >
              Browse hub
            </Button>
            <Button
              variant="primary"
              leadingIcon={<IconPlus size={14} />}
              onClick={() => setNewAgentOpen(true)}
            >
              Build your own Agent
            </Button>
          </>
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

        {/* Stats strip */}
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

        {/* Layout: agents grid + recent activity rail */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[13px] font-medium text-[var(--color-text)]">
                Installed
              </h2>
              <span className="text-[11px] text-[var(--color-text-muted)]">
                {filtered.length} of {state.installedAgents.length}
              </span>
            </div>

            {filtered.length === 0 ? (
              <EmptyState hasAgents={state.installedAgents.length > 0} />
            ) : (
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                {filtered.map((agent) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    onRun={(a) => {
                      if (a.mode === "write") {
                        navigate(`/agents/${a.slug}/confirm`);
                        return;
                      }

                      void handleStartRun(a.slug);
                    }}
                  />
                ))}
              </div>
            )}
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
                  {state.runs.slice(0, 4).map((r) => (
                    <button
                      key={r.id}
                      onClick={() => navigate(`/runs/${r.id}`)}
                      className="flex items-start gap-3 rounded-lg bg-[var(--color-bg-raised)] p-3 text-left ring-1 ring-[var(--color-border-soft)] transition-colors hover:bg-[var(--color-surface-hover)]"
                    >
                      <StatusDot
                        tone={runStatusTone(r.status)}
                        className="mt-1.5"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12.5px] font-medium text-[var(--color-text)]">
                          {r.agentSlug}
                        </div>
                        <div
                          className="mt-0.5 text-[11px] text-[var(--color-text-muted)]"
                        >
                          {r.summary ?? r.status}
                        </div>
                      </div>
                      <span className="font-mono text-[10.5px] text-[var(--color-text-muted)]">
                        {formatShortDate(r.queuedAt)}
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
                    {state.trust.label}
                  </span>
                </div>
                <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-text-soft)]">
                  {state.trust.detail}
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
      <NewAgentModal
        open={newAgentOpen}
        onClose={() => setNewAgentOpen(false)}
      />
    </>
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
  icon: React.ReactNode;
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

function EmptyState({ hasAgents }: { hasAgents: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl bg-[var(--color-surface)] py-16 ring-1 ring-[var(--color-border-soft)]">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
        <IconSearch size={20} />
      </div>
      <div className="text-[15px] font-medium text-[var(--color-text)]">
        {hasAgents ? "No agents match that search" : "No agents installed"}
      </div>
      <div className="mt-1 text-[13px] text-[var(--color-text-muted)]">
        {hasAgents
          ? "Try a different query, or browse the hub for community agents."
          : "Add an agent from the hub once registry support is wired."}
      </div>
    </div>
  );
}

function toDisplayAgent(
  agent: AgentSummary,
  runs: { agentSlug: string; queuedAt: string }[],
  defaultModel?: string,
): Agent {
  const lastRunAt = runs.find((run) => run.agentSlug === agent.slug)?.queuedAt;

  return {
    ...agent,
    category: agent.category,
    author: {
      name: agent.author.name,
      handle: agent.author.handle ?? "local",
      verified: agent.author.verified ?? false,
    },
    installed: true,
    lastRunAt,
    preferredModel: defaultModel,
  };
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

function runStatusTone(status: string) {
  if (status === "failed") return "danger";
  if (status === "queued" || status === "running") return "warning";
  return "success";
}
