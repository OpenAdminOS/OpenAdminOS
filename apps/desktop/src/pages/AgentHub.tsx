import { useState } from "react";
import { PageBody, PageHeader } from "../components/AppShell";
import { Card } from "../components/Card";
import { Pill } from "../components/Pill";
import { Button } from "../components/Button";
import { Avatar } from "../components/Avatar";
import {
  IconBadgeCheck,
  IconBolt,
  IconCheck,
  IconFire,
  IconSearch,
  IconShield,
  IconSparkle,
  IconStar,
  IconTrend,
} from "../components/icons";
import { hubAgents } from "../data/agents";
import type { Agent } from "../types";

const filters = [
  "All",
  "Devices",
  "Apps",
  "Policies",
  "Compliance",
  "Updates",
] as const;
type Filter = (typeof filters)[number];

export default function AgentHub() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("All");
  const [installed, setInstalled] = useState<Set<string>>(new Set());

  const visible = hubAgents.filter((a) => {
    const matchesFilter =
      filter === "All" ||
      a.category === (filter.toLowerCase() as Agent["category"]);
    const matchesQuery =
      query.trim() === "" ||
      a.name.toLowerCase().includes(query.toLowerCase()) ||
      a.description.toLowerCase().includes(query.toLowerCase()) ||
      a.author.name.toLowerCase().includes(query.toLowerCase());
    return matchesFilter && matchesQuery;
  });

  // Featured: Configuration drift detector (high-rated, broad appeal)
  const featured = hubAgents[1];
  // Trending rail: Win32 app failures, Update ring health, App deployment health
  const trending = [hubAgents[4], hubAgents[2], hubAgents[0]];

  return (
    <>
      <PageHeader
        eyebrow="Community"
        title="Agent Hub"
        subtitle={
          <span className="inline-flex items-center gap-2">
            <span>{hubAgents.length}+ agents from the community</span>
            <span className="opacity-50">·</span>
            <span>pinned by version, never auto-updated</span>
          </span>
        }
        actions={
          <div className="relative">
            <IconSearch
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search agents, authors, scopes"
              className="h-9 w-[320px] rounded-lg bg-[var(--color-surface)] pl-9 pr-3 text-[13px] text-[var(--color-text)] ring-1 ring-[var(--color-border)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-[var(--color-accent)]/50"
            />
          </div>
        }
      />
      <PageBody>
        {/* Featured */}
        <FeaturedCard
          agent={featured}
          installed={installed.has(featured.id)}
          onInstall={() => setInstalled(new Set([...installed, featured.id]))}
        />

        {/* Trending rail */}
        <div className="mt-8 mb-3 flex items-center gap-2">
          <IconFire size={14} className="text-[var(--color-warning)]" />
          <h3 className="text-[12px] font-medium uppercase tracking-wider text-[var(--color-text)]">
            Trending this week
          </h3>
          <span className="h-px flex-1 bg-[var(--color-border-soft)]" />
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {trending.map((a) => (
            <TrendingCard
              key={a.id}
              agent={a}
              installed={installed.has(a.id)}
              onInstall={() => setInstalled(new Set([...installed, a.id]))}
            />
          ))}
        </div>

        {/* Filters */}
        <div className="mt-10 mb-4 flex items-center justify-between">
          <h3 className="text-[12px] font-medium uppercase tracking-wider text-[var(--color-text)]">
            All agents
          </h3>
          <div className="flex items-center gap-1.5">
            {filters.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors ${
                  f === filter
                    ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/30"
                    : "bg-transparent text-[var(--color-text-soft)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {visible.map((agent) => (
            <HubAgentCard
              key={agent.id}
              agent={agent}
              installed={installed.has(agent.id)}
              onInstall={() =>
                setInstalled(new Set([...installed, agent.id]))
              }
            />
          ))}
        </div>

        <div className="mt-10 flex flex-col items-center gap-2 text-[12px] text-[var(--color-text-muted)]">
          <div className="inline-flex items-center gap-2">
            <Avatar name="Ugur Koc" size={20} />
            <span>
              {visible.length} agents from{" "}
              <span className="font-medium text-[var(--color-text-soft)]">
                Ugur Koc
              </span>{" "}
              · more authors coming soon
            </span>
          </div>
          <span>
            Pulled from{" "}
            <span className="font-mono">github.com/ugurlabs/openagents-registry</span>
          </span>
        </div>
      </PageBody>
    </>
  );
}

function FeaturedCard({
  agent,
  installed,
  onInstall,
}: {
  agent: Agent;
  installed: boolean;
  onInstall: () => void;
}) {
  return (
    <Card>
      <div className="grid grid-cols-1 gap-6 p-7 lg:grid-cols-[1.5fr_1fr]">
        <div>
          <div className="mb-3 inline-flex items-center gap-2">
            <Pill tone="accent">
              <IconSparkle size={10} /> Featured this week
            </Pill>
            <Pill tone="warning">
              <IconTrend size={10} /> Top installed in May
            </Pill>
          </div>
          <h2 className="text-[24px] font-semibold tracking-tight text-[var(--color-text)]">
            {agent.name}
          </h2>
          <div className="mt-2 inline-flex items-center gap-2">
            <Avatar name={agent.author.name} size={22} />
            <span className="text-[12.5px] text-[var(--color-text-soft)]">
              {agent.author.name}
            </span>
            {agent.author.verified && (
              <IconBadgeCheck size={12} className="text-[var(--color-accent)]" />
            )}
            <span className="opacity-50">·</span>
            <span className="font-mono text-[11px] text-[var(--color-text-muted)]">
              v{agent.version}
            </span>
          </div>
          <p className="mt-4 max-w-[520px] text-[14px] leading-relaxed text-[var(--color-text-soft)]">
            {agent.description}
          </p>

          <div className="mt-5 flex items-center gap-2">
            <Button
              size="md"
              variant={installed ? "ghost" : "primary"}
              disabled={installed}
              leadingIcon={installed ? <IconCheck size={12} /> : undefined}
              onClick={onInstall}
            >
              {installed ? "Installed" : "Install"}
            </Button>
            <Button size="md" variant="secondary">
              View on GitHub
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <FeaturedStat
            label="Installs"
            value={(agent.installs ?? 0).toLocaleString()}
            tone="default"
          />
          <FeaturedStat
            label="Rating"
            value={`${agent.rating ?? "—"} / 5`}
            iconLeft={<IconStar size={11} className="text-[var(--color-warning)]" />}
          />
          <div className="rounded-lg bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]">
            <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              From the author
            </div>
            <p className="mt-2 text-[12px] italic leading-relaxed text-[var(--color-text-soft)]">
              "Wrote this after spending a Friday tracing why 200+ devices
              never landed on the new baseline. The Intune blade hides the
              root cause — this surfaces it in seconds."
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
}

function FeaturedStat({
  label,
  value,
  tone = "default",
  iconLeft,
}: {
  label: string;
  value: string;
  tone?: "default" | "success";
  iconLeft?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]">
      <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </div>
      <div
        className={`mt-1 inline-flex items-center gap-1.5 text-[20px] font-semibold tabular-nums ${
          tone === "success"
            ? "text-[var(--color-success)]"
            : "text-[var(--color-text)]"
        }`}
      >
        {iconLeft}
        {value}
      </div>
    </div>
  );
}

function TrendingCard({
  agent,
  installed,
  onInstall,
}: {
  agent: Agent;
  installed: boolean;
  onInstall: () => void;
}) {
  return (
    <Card interactive>
      <div className="flex flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-bg-raised)] ring-1 ring-[var(--color-border)]">
            {agent.mode === "write" ? (
              <IconBolt size={16} className="text-[var(--color-warning)]" />
            ) : (
              <IconShield size={16} className="text-[var(--color-text-soft)]" />
            )}
          </div>
          <div className="flex items-center gap-1 rounded-md bg-[var(--color-warning-soft)] px-2 py-1 text-[10.5px] font-medium text-[var(--color-warning)]">
            <IconTrend size={10} />
            {Math.floor(Math.random() * 30) + 12}%
          </div>
        </div>
        <div>
          <div className="text-[13.5px] font-medium text-[var(--color-text)]">
            {agent.name}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
            <Avatar name={agent.author.name} size={14} />
            <span>{agent.author.name}</span>
            {agent.author.verified && (
              <IconBadgeCheck size={10} className="text-[var(--color-accent)]" />
            )}
          </div>
        </div>
        <p className="line-clamp-2 text-[12px] leading-relaxed text-[var(--color-text-soft)]">
          {agent.description}
        </p>
        <div className="mt-1 flex items-center justify-between">
          <span className="text-[10.5px] text-[var(--color-text-muted)]">
            {agent.installs?.toLocaleString()} installs
          </span>
          <Button
            size="sm"
            variant={installed ? "ghost" : "primary"}
            disabled={installed}
            leadingIcon={installed ? <IconCheck size={11} /> : undefined}
            onClick={(e) => {
              e.stopPropagation();
              onInstall();
            }}
          >
            {installed ? "Installed" : "Install"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function HubAgentCard({
  agent,
  installed,
  onInstall,
}: {
  agent: Agent;
  installed: boolean;
  onInstall: () => void;
}) {
  return (
    <Card>
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-bg-raised)] ring-1 ring-[var(--color-border)]">
              {agent.mode === "write" ? (
                <IconBolt size={18} className="text-[var(--color-warning)]" />
              ) : (
                <IconShield size={18} className="text-[var(--color-text-soft)]" />
              )}
            </div>
            <div className="min-w-0">
              <div className="truncate text-[14px] font-medium text-[var(--color-text)]">
                {agent.name}
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
                <Avatar name={agent.author.name} size={14} />
                <span>{agent.author.name}</span>
                {agent.author.verified && (
                  <IconBadgeCheck
                    size={11}
                    className="text-[var(--color-accent)]"
                  />
                )}
                <span className="opacity-50">·</span>
                <span className="font-mono">{agent.version}</span>
              </div>
            </div>
          </div>
          {agent.rating !== undefined && (
            <div className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--color-text-soft)]">
              <IconStar size={11} className="text-[var(--color-warning)]" />
              <span className="font-medium tabular-nums">{agent.rating}</span>
            </div>
          )}
        </div>

        <p className="text-[13px] leading-relaxed text-[var(--color-text-soft)]">
          {agent.description}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={agent.mode === "write" ? "warning" : "default"}>
            {agent.mode === "write" ? "Write" : "Read-only"}
          </Pill>
          <Pill className="capitalize">{agent.category}</Pill>
          <Pill>
            {agent.scopes.length} scope{agent.scopes.length === 1 ? "" : "s"}
          </Pill>
        </div>

        <div className="flex items-center justify-between border-t border-[var(--color-border-soft)] pt-3">
          <span className="text-[11px] text-[var(--color-text-muted)] tabular-nums">
            {agent.installs?.toLocaleString()} installs
          </span>
          {installed ? (
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<IconCheck size={12} />}
              disabled
            >
              Installed
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={onInstall}>
              Install
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
