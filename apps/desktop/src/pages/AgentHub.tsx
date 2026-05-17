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
  IconFire,
  IconSearch,
  IconShield,
  IconSparkle,
  IconTrend,
} from "../components/icons";
import type {
  AgentManifestPreview,
  RegistryAgentSummary,
} from "../shared/openAgents";
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

export default function AgentHub() {
  const { state, registryAgents, installAgent } = useAppState();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("All");
  const [manifestAgent, setManifestAgent] = useState<RegistryAgentSummary | null>(
    null,
  );
  const [manifestPreview, setManifestPreview] = useState<AgentManifestPreview | null>(
    null,
  );
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);

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
    window.openAgents
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
  const visible = registryAgents.filter((a) => {
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

  const featured = registryAgents[0];
  const trending = registryAgents.slice(0, 3);
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
        eyebrow="Built-in"
        title="Agent Hub"
        subtitle={
          <span className="inline-flex items-center gap-2">
            <span>{registryAgents.length} agents bundled in this repo</span>
            <span className="opacity-50">·</span>
            <span>community registry lands in v0.2</span>
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
        {featured ? (
          <FeaturedCard
            agent={featured}
            installed={isInstalled(featured)}
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
                Built-in agents
              </h3>
              <span className="h-px flex-1 bg-[var(--color-border-soft)]" />
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {trending.map((a) => (
                <TrendingCard
                  key={a.id}
                  agent={a}
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
                installed={isInstalled(agent)}
                onInstall={() => onInstall(agent)}
                onViewManifest={() => setManifestAgent(agent)}
              />
            ))}
          </div>
        )}

        <div className="mt-10 flex flex-col items-center gap-2 text-[12px] text-[var(--color-text-muted)]">
          <div className="inline-flex items-center gap-2">
            <Avatar name="Ugur Koc" size={20} />
            <span>
              {visible.length} agents from{" "}
              <span className="font-medium text-[var(--color-text-soft)]">
                this MIT monorepo
              </span>{" "}
              · contributions live under agents/
            </span>
          </div>
          <span>
            Pulled from <span className="font-mono">./agents</span>
          </span>
        </div>
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
  installed,
  onInstall,
  onViewManifest,
}: {
  agent: RegistryAgentSummary;
  installed: boolean;
  onInstall: () => void;
  onViewManifest: () => void;
}) {
  return (
    <Card>
      <div className="grid grid-cols-1 gap-6 p-7 lg:grid-cols-[1.5fr_1fr]">
        <div>
          <div className="mb-3 inline-flex items-center gap-2">
            <Pill tone="accent">
              <IconSparkle size={10} /> Featured
            </Pill>
            <Pill>
              <IconShield size={10} /> {agent.mode === "write" ? "Write" : "Read-only"}
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
            <div className="mt-1.5 text-[13px] capitalize text-[var(--color-text)]">
              {agent.category}
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
  installed,
  onInstall,
  onViewManifest,
}: {
  agent: RegistryAgentSummary;
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
          <span className="font-mono text-[10.5px] text-[var(--color-text-muted)] capitalize">
            {agent.category}
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
  onViewManifest,
}: {
  agent: RegistryAgentSummary;
  installed: boolean;
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
          <Pill>
            {agent.scopes.length} scope{agent.scopes.length === 1 ? "" : "s"}
          </Pill>
        </div>

        <div className="flex items-center justify-between border-t border-[var(--color-border-soft)] pt-3">
          <span className="font-mono text-[11px] text-[var(--color-text-muted)]">
            v{agent.version}
          </span>
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
