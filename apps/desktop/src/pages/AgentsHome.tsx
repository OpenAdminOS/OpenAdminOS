import { useState } from "react";
import { useNavigate } from "react-router";
import { PageBody, PageHeader } from "../components/AppShell";
import { AgentCard } from "../components/AgentCard";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
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
  IconClock,
} from "../components/icons";
import { installedAgents } from "../data/agents";
import { homeStats, recentActivity } from "../data/stats";
import { LiveRunModal } from "./LiveRun";
import type { Agent } from "../types";

export default function AgentsHome() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [runningAgent, setRunningAgent] = useState<Agent | null>(null);

  const filtered = installedAgents.filter(
    (a) =>
      a.name.toLowerCase().includes(query.toLowerCase()) ||
      a.description.toLowerCase().includes(query.toLowerCase()),
  );

  const trendVsLast =
    homeStats.runsThisWeek - homeStats.runsLastWeek > 0
      ? `+${homeStats.runsThisWeek - homeStats.runsLastWeek}`
      : `${homeStats.runsThisWeek - homeStats.runsLastWeek}`;

  return (
    <>
      <PageHeader
        title="Agents"
        subtitle={
          <span className="inline-flex items-center gap-2">
            <span>{installedAgents.length} installed</span>
            <span className="opacity-50">·</span>
            <Pill tone="success">
              <IconHardDrive size={10} /> Local · Ollama
            </Pill>
            <span className="opacity-50">·</span>
            <span>Tenant: UgurLabs</span>
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
                placeholder="Search agents"
                className="h-9 w-[260px] rounded-lg bg-[var(--color-surface)] pl-9 pr-12 text-[13px] text-[var(--color-text)] ring-1 ring-[var(--color-border)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-[var(--color-accent)]/50"
              />
              <kbd className="absolute right-2 top-1/2 -translate-y-1/2 rounded bg-[var(--color-bg-raised)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border)]">
                ⌘K
              </kbd>
            </div>
            <Button
              variant="secondary"
              leadingIcon={<IconHub size={14} />}
              onClick={() => navigate("/hub")}
            >
              Browse hub
            </Button>
            <Button variant="primary" leadingIcon={<IconPlus size={14} />}>
              New agent
            </Button>
          </>
        }
      />
      <PageBody>
        {/* Stats strip */}
        <div className="mb-7 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Runs this week"
            value={String(homeStats.runsThisWeek)}
            change={`${trendVsLast} vs last week`}
            icon={<IconActivity size={14} className="text-[var(--color-accent)]" />}
            mono
          />
          <StatTile
            label="Time saved"
            value={`${homeStats.timeSavedHours}h`}
            change="estimated · this month"
            icon={<IconClock size={14} className="text-[var(--color-success)]" />}
          />
          <StatTile
            label="Items resolved"
            value={String(homeStats.itemsResolved)}
            change="across all agents"
            icon={<IconTrend size={14} className="text-[var(--color-info)]" />}
            mono
          />
          <StatTile
            label="Cost"
            value={homeStats.costSpent}
            change={homeStats.costLabel}
            icon={<IconHardDrive size={14} className="text-[var(--color-success)]" />}
            valueClass="text-[var(--color-success)]"
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
                {filtered.length} of {installedAgents.length}
              </span>
            </div>

            {filtered.length === 0 ? (
              <EmptyState />
            ) : (
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                {filtered.map((agent) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    onRun={(a) =>
                      a.mode === "write"
                        ? navigate(`/agents/${a.slug}/confirm`)
                        : navigate("/runs/last")
                    }
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
                  {recentActivity.map((r, i) => (
                    <button
                      key={i}
                      onClick={() => navigate("/runs/last")}
                      className="flex items-start gap-3 rounded-lg bg-[var(--color-bg-raised)] p-3 text-left ring-1 ring-[var(--color-border-soft)] transition-colors hover:bg-[var(--color-surface-hover)]"
                    >
                      <StatusDot
                        tone={r.status === "alert" ? "warning" : "success"}
                        className="mt-1.5"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12.5px] font-medium text-[var(--color-text)]">
                          {r.agent}
                        </div>
                        <div
                          className={`mt-0.5 text-[11px] ${
                            r.status === "alert"
                              ? "text-[var(--color-warning)]"
                              : "text-[var(--color-text-muted)]"
                          }`}
                        >
                          {r.result}
                        </div>
                      </div>
                      <span className="font-mono text-[10.5px] text-[var(--color-text-muted)]">
                        {r.when}
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
                    Local-first guarantee
                  </span>
                </div>
                <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-text-soft)]">
                  Your tenant data and prompts never leave this device while
                  Ollama is the active provider.
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
                  Pair "Find inactive devices" with "Retire inactive devices" to
                  see the diff confirmation flow.
                </p>
                <button
                  onClick={() =>
                    navigate("/agents/retire-inactive-devices/confirm")
                  }
                  className="mt-3 text-[11.5px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"
                >
                  Preview the diff →
                </button>
              </div>
            </Card>
          </aside>
        </div>
      </PageBody>
      <LiveRunModal
        agent={runningAgent}
        onClose={() => setRunningAgent(null)}
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

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl bg-[var(--color-surface)] py-16 ring-1 ring-[var(--color-border-soft)]">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
        <IconSearch size={20} />
      </div>
      <div className="text-[15px] font-medium text-[var(--color-text)]">
        No agents match that search
      </div>
      <div className="mt-1 text-[13px] text-[var(--color-text-muted)]">
        Try a different query, or browse the hub for community agents.
      </div>
    </div>
  );
}
