import { useEffect, useState } from "react";
import { PageBody, PageHeader } from "../components/AppShell";
import { Card } from "../components/Card";
import { Pill } from "../components/Pill";
import { Button } from "../components/Button";
import { Avatar } from "../components/Avatar";
import { ManifestPreview } from "../components/ManifestPreview";
import { Modal, ModalHeader } from "../components/Modal";
import {
  IconBadgeCheck,
  IconBolt,
  IconCheck,
  IconDownload,
  IconFire,
  IconRefresh,
  IconSearch,
  IconShield,
  IconSparkle,
  IconTrend,
} from "../components/icons";
import type {
  AgentManifestPreview,
  RegistryAgentSummary,
} from "../shared/openAdminOS";
import { useAppState } from "../state";

const filters = [
  "All",
  "Devices",
  "Apps",
  "Policies",
  "Compliance",
  "Updates",
] as const;
type Filter = (typeof filters)[number];

type TierTab = "agent" | "dashboard";

const tierLabels: Record<TierTab, string> = {
  agent: "Agents",
  dashboard: "Dashboards",
};

const tierDescriptions: Record<TierTab, string> = {
  agent:
    "Multi-step reasoning across Graph. Investigators, advisors, write actions with judgment.",
  dashboard:
    "Single-source LLM-narrated reports. Useful at a glance; not what a PowerShell script can't do.",
};

/**
 * Renders a small "Requires Entra ID P1/P2" pill when the agent
 * declares a non-free Entra tier. Tone:
 *   - `warning` when the active tenant's detected tier is known and
 *     falls short (the run will be blocked at preflight).
 *   - muted neutral when the tenant's tier is unknown or satisfies
 *     the requirement (informational only).
 * Returns null for free-tier agents (no badge needed).
 */
function EntraTierBadge({
  required,
  tenantTier,
}: {
  required: "free" | "p1" | "p2";
  tenantTier: "free" | "p1" | "p2" | "unknown" | undefined;
}) {
  if (required === "free") return null;
  const label = `Requires Entra ID ${required.toUpperCase()}`;
  const rank: Record<string, number> = { free: 0, p1: 1, p2: 2 };
  const tenantRank = tenantTier && tenantTier !== "unknown" ? rank[tenantTier] : -1;
  const shortfall = tenantRank >= 0 && tenantRank < rank[required];
  const tooltip = shortfall
    ? `Active tenant is on Entra ID ${tenantTier?.toUpperCase()}. This agent needs ${required.toUpperCase()} to return useful data.`
    : `This agent reads Graph endpoints that require Entra ID ${required.toUpperCase()}.`;
  return (
    <span title={tooltip} className="inline-flex">
      <Pill tone={shortfall ? "warning" : "default"}>{label}</Pill>
    </span>
  );
}

export default function AgentHub() {
  const { state, registryAgents, installAgent, refreshRegistry } = useAppState();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("All");
  const [tier, setTier] = useState<TierTab>("agent");
  const [refreshing, setRefreshing] = useState(false);
  const activeTenant = state.activeTenantId
    ? state.tenants.find((t) => t.id === state.activeTenantId)
    : undefined;
  const tenantTier = activeTenant?.entraTier;
  const [manifestAgent, setManifestAgent] = useState<RegistryAgentSummary | null>(
    null,
  );
  const [manifestPreview, setManifestPreview] = useState<AgentManifestPreview | null>(
    null,
  );
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  // Live install counts fetched from the public stats endpoint on Hub
  // mount. Falls back silently to the bundled values on `agent.installs`
  // when the fetch fails (offline, network error, etc.).
  const liveInstalls = useLiveInstalls();

  useEffect(() => {
    if (!manifestAgent) {
      setManifestPreview(null);
      setManifestError(null);
      setManifestLoading(false);
      return;
    }
    let cancelled = false;
    setManifestLoading(true);
    setManifestError(null);
    setManifestPreview(null);
    window.openAdminOS
      ?.getAgentManifest(manifestAgent.slug)
      .then((result) => {
        if (cancelled) return;
        setManifestPreview(result ?? null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setManifestError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setManifestLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [manifestAgent]);

  const installedIds = new Set(
    state.installedAgents.flatMap((agent) => [
      agent.id,
      agent.slug,
      agent.registryId ?? "",
    ]),
  );
  const tierAgents = registryAgents.filter((a) => (a.tier ?? "agent") === tier);
  const tierCounts = registryAgents.reduce(
    (acc, a) => {
      const t = (a.tier ?? "agent") as TierTab;
      acc[t] = (acc[t] ?? 0) + 1;
      return acc;
    },
    { agent: 0, dashboard: 0 } as Record<TierTab, number>,
  );
  const visible = tierAgents.filter((a) => {
    const matchesFilter =
      filter === "All" ||
      a.category === (filter.toLowerCase() as RegistryAgentSummary["category"]);
    const matchesQuery =
      query.trim() === "" ||
      a.name.toLowerCase().includes(query.toLowerCase()) ||
      a.description.toLowerCase().includes(query.toLowerCase()) ||
      a.author.name.toLowerCase().includes(query.toLowerCase());
    return matchesFilter && matchesQuery;
  });

  const featured = tierAgents[0];
  const trending = tierAgents.slice(0, 3);
  const isInstalled = (agent: RegistryAgentSummary) =>
    installedIds.has(agent.id) ||
    installedIds.has(agent.slug) ||
    installedIds.has(agent.registryId);
  const onInstall = (agent: RegistryAgentSummary) => {
    void installAgent(agent.registryId);
  };

  return (
    <>
      <PageHeader
        eyebrow="Registry"
        title="Agent Hub"
        subtitle={
          <span className="inline-flex items-center gap-2">
            <span>
              {tierCounts.agent} agents · {tierCounts.dashboard} dashboards
            </span>
            {state.lastRegistryRefresh && (
              <>
                <span className="opacity-50">·</span>
                <span className="text-[var(--color-text-soft)]">
                  remote · refreshed {new Date(state.lastRegistryRefresh).toLocaleTimeString()}
                </span>
              </>
            )}
            {state.registryRefreshError && !state.lastRegistryRefresh && (
              <>
                <span className="opacity-50">·</span>
                <span className="text-[var(--color-text-soft)]">
                  bundled · remote registry unreachable
                </span>
              </>
            )}
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                setRefreshing(true);
                await refreshRegistry().catch(() => undefined);
                setRefreshing(false);
              }}
              disabled={refreshing}
              title="Refresh agent registry"
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--color-surface)] text-[var(--color-text-soft)] ring-1 ring-[var(--color-border)] transition-colors hover:text-[var(--color-text)] disabled:opacity-50"
            >
              <IconRefresh size={14} className={refreshing ? "animate-spin" : ""} />
            </button>
            <div className="relative">
              <IconSearch
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search agents, authors, scopes"
                className="h-9 w-[300px] rounded-lg bg-[var(--color-surface)] pl-9 pr-3 text-[13px] text-[var(--color-text)] ring-1 ring-[var(--color-border)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-[var(--color-accent)]/50"
              />
            </div>
          </div>
        }
      />
      <PageBody>
        {/* Tier toggle */}
        <div className="mb-6 flex items-center justify-between gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <div className="inline-flex items-center rounded-lg bg-[var(--color-bg)] p-1 ring-1 ring-[var(--color-border)]">
            {(["agent", "dashboard"] as TierTab[]).map((t) => (
              <button
                key={t}
                onClick={() => {
                  setTier(t);
                  setFilter("All");
                }}
                className={`rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors ${
                  t === tier
                    ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/30"
                    : "text-[var(--color-text-soft)] hover:text-[var(--color-text)]"
                }`}
              >
                {tierLabels[t]}{" "}
                <span className="ml-1 text-[var(--color-text-muted)]">
                  {tierCounts[t]}
                </span>
              </button>
            ))}
          </div>
          <p className="text-[12px] text-[var(--color-text-soft)]">
            {tierDescriptions[tier]}
          </p>
        </div>

        {/* Featured */}
        {featured ? (
          <FeaturedCard
            agent={featured}
            installs={resolveInstallCount(featured, liveInstalls)}
            installed={isInstalled(featured)}
            tenantTier={tenantTier}
            onInstall={() => onInstall(featured)}
            onViewManifest={() => setManifestAgent(featured)}
          />
        ) : (
          <EmptyRegistry />
        )}

        {/* Trending rail */}
        {trending.length > 0 && (
          <>
            <div className="mt-8 mb-3 flex items-center gap-2">
              <IconFire size={14} className="text-[var(--color-warning)]" />
              <h3 className="text-[12px] font-medium uppercase tracking-wider text-[var(--color-text)]">
                Built-in {tier === "dashboard" ? "dashboards" : "agents"}
              </h3>
              <span className="h-px flex-1 bg-[var(--color-border-soft)]" />
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {trending.map((a) => (
                <TrendingCard
                  key={a.id}
                  agent={a}
                  installs={resolveInstallCount(a, liveInstalls)}
                  installed={isInstalled(a)}
                  onInstall={() => onInstall(a)}
                  onViewManifest={() => setManifestAgent(a)}
                />
              ))}
            </div>
          </>
        )}

        {/* Filters */}
        <div className="mt-10 mb-4 flex items-center justify-between">
          <h3 className="text-[12px] font-medium uppercase tracking-wider text-[var(--color-text)]">
            All {tier === "dashboard" ? "dashboards" : "agents"}
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

        {visible.length === 0 ? (
          <HubFilterEmpty
            query={query}
            filter={filter}
            onReset={() => {
              setQuery("");
              setFilter("All");
            }}
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {visible.map((agent) => (
              <HubAgentCard
                key={agent.id}
                agent={agent}
                installs={resolveInstallCount(agent, liveInstalls)}
                installed={isInstalled(agent)}
                tenantTier={tenantTier}
                onInstall={() => onInstall(agent)}
                onViewManifest={() => setManifestAgent(agent)}
              />
            ))}
          </div>
        )}

      </PageBody>
      <Modal
        open={manifestAgent !== null}
        onClose={() => setManifestAgent(null)}
        size="lg"
      >
        <ModalHeader
          title={manifestAgent?.name ?? "Manifest"}
          subtitle={manifestAgent ? `v${manifestAgent.version} · ${manifestAgent.author.name}` : undefined}
          onClose={() => setManifestAgent(null)}
        />
        <div className="overflow-y-auto p-6">
          {manifestLoading && (
            <div className="text-[13px] text-[var(--color-text-muted)]">Loading manifest…</div>
          )}
          {manifestError && (
            <div className="text-[13px] text-[var(--color-danger)]">
              Couldn't load manifest: {manifestError}
            </div>
          )}
          {!manifestLoading && !manifestError && manifestPreview && (
            <ManifestPreview preview={manifestPreview} />
          )}
          {!manifestLoading && !manifestError && !manifestPreview && manifestAgent && (
            <div className="text-[13px] text-[var(--color-text-muted)]">
              No manifest is available for this agent yet.
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}

function FeaturedCard({
  agent,
  installs,
  installed,
  tenantTier,
  onInstall,
  onViewManifest,
}: {
  agent: RegistryAgentSummary;
  installs: number | undefined;
  installed: boolean;
  tenantTier: "free" | "p1" | "p2" | "unknown" | undefined;
  onInstall: () => void;
  onViewManifest: () => void;
}) {
  return (
    <Card>
      <div className="grid grid-cols-1 gap-6 p-7 lg:grid-cols-[1.5fr_1fr]">
        <div>
          <div className="mb-3 inline-flex flex-wrap items-center gap-2">
            <Pill tone="accent">
              <IconSparkle size={10} /> Featured
            </Pill>
            <Pill>
              <IconShield size={10} /> {agent.mode === "write" ? "Write" : "Read-only"}
            </Pill>
            <EntraTierBadge
              required={agent.requiresEntraTier ?? "free"}
              tenantTier={tenantTier}
            />
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
            <Button size="md" variant="secondary" onClick={onViewManifest}>
              View manifest
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div className="rounded-lg bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]">
            <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              Category
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-3 text-[13px] capitalize text-[var(--color-text)]">
              <span>{agent.category}</span>
              <InstallCount count={installs} size="md" />
            </div>
          </div>
          <div className="rounded-lg bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]">
            <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              Graph scopes
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {agent.scopes.length === 0 ? (
                <span className="text-[12px] text-[var(--color-text-muted)]">
                  None declared
                </span>
              ) : (
                agent.scopes.slice(0, 3).map((scope) => (
                  <Pill key={scope}>
                    <span className="font-mono text-[10px]">{scope}</span>
                  </Pill>
                ))
              )}
              {agent.scopes.length > 3 && (
                <span className="text-[10.5px] text-[var(--color-text-muted)]">
                  +{agent.scopes.length - 3}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

function TrendingCard({
  agent,
  installs,
  installed,
  onInstall,
  onViewManifest,
}: {
  agent: RegistryAgentSummary;
  installs: number | undefined;
  installed: boolean;
  onInstall: () => void;
  onViewManifest: () => void;
}) {
  return (
    <Card interactive onClick={onViewManifest}>
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
            Built-in
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
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10.5px] text-[var(--color-text-muted)] capitalize">
              {agent.category}
            </span>
            {typeof installs === "number" && (
              <>
                <span className="text-[10.5px] text-[var(--color-text-muted)] opacity-50">·</span>
                <InstallCount count={installs} />
              </>
            )}
          </div>
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
  installs,
  installed,
  tenantTier,
  onInstall,
  onViewManifest,
}: {
  agent: RegistryAgentSummary;
  installs: number | undefined;
  installed: boolean;
  tenantTier: "free" | "p1" | "p2" | "unknown" | undefined;
  onInstall: () => void;
  onViewManifest: () => void;
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
        </div>

        <p className="text-[13px] leading-relaxed text-[var(--color-text-soft)]">
          {agent.description}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={agent.mode === "write" ? "warning" : "default"}>
            {agent.mode === "write" ? "Write" : "Read-only"}
          </Pill>
          <Pill className="capitalize">{agent.category}</Pill>
          <EntraTierBadge
            required={agent.requiresEntraTier ?? "free"}
            tenantTier={tenantTier}
          />
          <Pill>
            {agent.scopes.length} scope{agent.scopes.length === 1 ? "" : "s"}
          </Pill>
        </div>

        <div className="flex items-center justify-between border-t border-[var(--color-border-soft)] pt-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-[var(--color-text-muted)]">
              v{agent.version}
            </span>
            {typeof installs === "number" && (
              <>
                <span className="text-[11px] text-[var(--color-text-muted)] opacity-50">·</span>
                <InstallCount count={installs} />
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onViewManifest}>
              View manifest
            </Button>
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
      </div>
    </Card>
  );
}

function EmptyRegistry() {
  return (
    <Card>
      <div className="flex flex-col items-center justify-center p-10 text-center">
        <div className="text-[15px] font-medium text-[var(--color-text)]">
          No built-in agents found
        </div>
        <div className="mt-1 max-w-[440px] text-[13px] text-[var(--color-text-muted)]">
          Add an agent manifest under the root agents directory to make it appear
          here.
        </div>
      </div>
    </Card>
  );
}

const LIVE_STATS_URL = "https://openadminos.example/stats/agents.json";
const LIVE_STATS_TIMEOUT_MS = 5_000;

interface LiveStatsFile {
  updatedAt?: string;
  agents?: Record<string, { installs?: number; installs7d?: number }>;
}

/**
 * Pulls the public stats file on Hub mount. Lives at a static URL on
 * the marketing site (synced from the canonical `stats/agents.json` at
 * deploy time). When the fetch fails — offline, DNS error, marketing
 * site down — we silently fall back to the bundled `agent.installs`
 * value baked into the desktop release. The Hub never shows a loading
 * spinner for stats; the bundled values are used until/unless the
 * fetch resolves, at which point counts swap in.
 */
function useLiveInstalls(): Map<string, number> | null {
  const [live, setLive] = useState<Map<string, number> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIVE_STATS_TIMEOUT_MS);
    fetch(LIVE_STATS_URL, {
      method: "GET",
      cache: "no-cache",
      signal: controller.signal,
    })
      .then((response) => (response.ok ? (response.json() as Promise<LiveStatsFile>) : null))
      .then((data) => {
        if (!data || typeof data !== "object" || !data.agents) return;
        const next = new Map<string, number>();
        for (const [slug, entry] of Object.entries(data.agents)) {
          if (entry && typeof entry.installs === "number") {
            next.set(slug, entry.installs);
          }
        }
        setLive(next);
      })
      .catch((error: unknown) => {
        console.debug("[hub] live stats fetch failed; using bundled values", error);
      })
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  return live;
}

/**
 * Returns the live install count for an agent when the fetch has
 * resolved, otherwise the bundled value, otherwise `undefined` (which
 * tells `<InstallCount>` to render nothing).
 */
function resolveInstallCount(
  agent: RegistryAgentSummary,
  live: Map<string, number> | null,
): number | undefined {
  if (live && live.has(agent.slug)) return live.get(agent.slug);
  return agent.installs;
}

/**
 * Compact install counter — `12 installs`, `1.2k installs`, etc.
 * Renders nothing when the stats file has no entry for this agent so
 * we don't surface a misleading "0 installs" before the counter is
 * actually wired up to the live aggregator.
 */
function InstallCount({
  count,
  size = "sm",
}: {
  count: number | undefined;
  size?: "sm" | "md";
}) {
  if (typeof count !== "number") return null;
  const iconSize = size === "md" ? 11 : 10;
  const textClass =
    size === "md"
      ? "text-[11.5px] text-[var(--color-text-muted)]"
      : "text-[10.5px] text-[var(--color-text-muted)]";
  return (
    <span className={`inline-flex items-center gap-1 ${textClass}`}>
      <IconDownload size={iconSize} />
      {formatInstallCount(count)} install{count === 1 ? "" : "s"}
    </span>
  );
}

function formatInstallCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function HubFilterEmpty({
  query,
  filter,
  onReset,
}: {
  query: string;
  filter: Filter;
  onReset: () => void;
}) {
  const hasQuery = query.trim().length > 0;
  const hasFilter = filter !== "All";
  return (
    <Card>
      <div className="flex flex-col items-center justify-center gap-3 p-10 text-center">
        <IconSearch size={24} className="text-[var(--color-text-muted)]" />
        <div className="text-[15px] font-medium text-[var(--color-text)]">
          No agents match
        </div>
        <div className="max-w-[440px] text-[13px] text-[var(--color-text-muted)]">
          {hasQuery && hasFilter
            ? `Nothing matches "${query}" in the ${filter} category.`
            : hasQuery
              ? `Nothing matches "${query}" across all categories.`
              : `No agents in the ${filter} category yet.`}
        </div>
        {(hasQuery || hasFilter) && (
          <Button variant="secondary" size="sm" onClick={onReset}>
            Clear filters
          </Button>
        )}
      </div>
    </Card>
  );
}
