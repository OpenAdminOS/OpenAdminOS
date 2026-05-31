import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
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
  IconRefresh,
  IconSearch,
  IconShield,
} from "../components/icons";
import type {
  AgentManifestPreview,
  RegistryAgentSummary,
} from "../shared/openAdminOS";
import { useAppState } from "../state";

type InstallFilter = "all" | "available" | "installed";
type ModeFilter = "all" | "read" | "write";

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

function CompatibilityBadge({
  minAppVersion,
  supported,
}: {
  minAppVersion?: string;
  supported?: boolean;
}) {
  if (!minAppVersion) return null;
  return (
    <Pill tone={supported === false ? "warning" : "default"}>
      {supported === false ? `Needs OpenAdminOS ${minAppVersion}` : `OpenAdminOS ${minAppVersion}+`}
    </Pill>
  );
}

export default function AgentHub() {
  const { state, registryAgents, installAgent, refreshRegistry } = useAppState();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [installFilter, setInstallFilter] = useState<InstallFilter>("all");
  const [modeFilter, setModeFilter] = useState<ModeFilter>("all");
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
  const [showManifestRaw, setShowManifestRaw] = useState(false);
  const [confirmInstall, setConfirmInstall] = useState(false);
  const [installingAgentId, setInstallingAgentId] = useState<string | null>(null);
  // Live install counts fetched from the public stats endpoint on Hub
  // mount. Falls back silently to the bundled values on `agent.installs`
  // when the fetch fails (offline, network error, etc.).
  const liveInstalls = useLiveInstalls();

  useEffect(() => {
    if (!manifestAgent) {
      setManifestPreview(null);
      setManifestError(null);
      setManifestLoading(false);
      setShowManifestRaw(false);
      setConfirmInstall(false);
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
  const isInstalled = (agent: RegistryAgentSummary) =>
    installedIds.has(agent.id) ||
    installedIds.has(agent.slug) ||
    installedIds.has(agent.registryId);
  const categories = Array.from(
    new Set(registryAgents.map((agent) => agent.category).filter(Boolean)),
  ).sort((a, b) => a.localeCompare(b));
  const visible = registryAgents.filter((a) => {
    const installed = isInstalled(a);
    const normalizedQuery = query.trim().toLowerCase();
    const matchesCategory = category === "all" || a.category === category;
    const matchesInstall =
      installFilter === "all" ||
      (installFilter === "installed" ? installed : !installed);
    const matchesMode = modeFilter === "all" || a.mode === modeFilter;
    const matchesQuery =
      normalizedQuery === "" ||
      [
        a.name,
        a.description,
        a.author.name,
        a.category,
        a.mode,
        a.version,
        ...a.scopes,
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    return matchesCategory && matchesInstall && matchesMode && matchesQuery;
  });

  const installedCount = registryAgents.filter(isInstalled).length;
  const onInstall = async (agent: RegistryAgentSummary) => {
    if (agent.compatibility?.supported === false) {
      setManifestAgent(agent);
      setConfirmInstall(false);
      return;
    }
    setInstallingAgentId(agent.id);
    try {
      await installAgent(agent.registryId);
      setConfirmInstall(false);
    } finally {
      setInstallingAgentId(null);
    }
  };
  const onOpenAgent = (agent: RegistryAgentSummary) => {
    navigate(`/agents/${agent.slug}`);
  };

  return (
    <>
      <PageHeader
        eyebrow="Store"
        title="Agent Hub"
        subtitle={
          <span className="inline-flex items-center gap-2">
            <span>
              {registryAgents.length} agents · {installedCount} installed
            </span>
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
              title="Refresh agent catalog"
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
        {registryAgents.length === 0 ? (
          <EmptyRegistry />
        ) : (
          <>
            <div className="mb-4 flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
              <div>
                <h3 className="text-[12px] font-medium uppercase tracking-wider text-[var(--color-text)]">
                  Agents
                </h3>
                <p className="mt-1 text-[11.5px] text-[var(--color-text-muted)]">
                  {visible.length} shown · {installedCount} installed · write agents always require confirmation
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 xl:justify-end">
                <FilterButton active={installFilter === "all"} onClick={() => setInstallFilter("all")}>
                  All
                </FilterButton>
                <FilterButton active={installFilter === "available"} onClick={() => setInstallFilter("available")}>
                  Available
                </FilterButton>
                <FilterButton active={installFilter === "installed"} onClick={() => setInstallFilter("installed")}>
                  Installed
                </FilterButton>
                <span className="mx-1 hidden h-5 w-px bg-[var(--color-border-soft)] md:block" />
                <FilterButton active={modeFilter === "all"} onClick={() => setModeFilter("all")}>
                  Read + write
                </FilterButton>
                <FilterButton active={modeFilter === "read"} onClick={() => setModeFilter("read")}>
                  Read-only
                </FilterButton>
                <FilterButton active={modeFilter === "write"} onClick={() => setModeFilter("write")}>
                  Write
                </FilterButton>
                <span className="mx-1 hidden h-5 w-px bg-[var(--color-border-soft)] md:block" />
                <FilterButton active={category === "all"} onClick={() => setCategory("all")}>
                  All categories
                </FilterButton>
                {categories.map((entry) => (
                  <FilterButton
                    key={entry}
                    active={category === entry}
                    onClick={() => setCategory(entry)}
                  >
                    {titleCase(entry)}
                  </FilterButton>
                ))}
              </div>
            </div>

            {visible.length === 0 ? (
              <HubFilterEmpty
                query={query}
                category={category}
                onReset={() => {
                  setQuery("");
                  setCategory("all");
                  setInstallFilter("all");
                  setModeFilter("all");
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
                    onInstall={() => {
                      setManifestAgent(agent);
                      setConfirmInstall(agent.compatibility?.supported !== false);
                    }}
                    onOpen={() => onOpenAgent(agent)}
                    onViewDetails={() => {
                      setConfirmInstall(false);
                      setManifestAgent(agent);
                    }}
                  />
                ))}
              </div>
            )}
          </>
        )}

      </PageBody>
      <Modal
        open={manifestAgent !== null}
        onClose={() => setManifestAgent(null)}
        size="lg"
      >
        <ModalHeader
          title={manifestAgent?.name ?? "Agent details"}
          subtitle={manifestAgent ? `${manifestAgent.category} · v${manifestAgent.version}` : undefined}
          onClose={() => setManifestAgent(null)}
        />
        <div className="overflow-y-auto p-6">
          {manifestAgent && (
            <AgentInstallDetails
              agent={manifestAgent}
              installed={isInstalled(manifestAgent)}
              tenantTier={tenantTier}
              manifestPreview={manifestPreview}
              manifestLoading={manifestLoading}
              manifestError={manifestError}
              confirmInstall={confirmInstall}
              installing={installingAgentId === manifestAgent.id}
              showRaw={showManifestRaw}
              onToggleRaw={() => setShowManifestRaw((current) => !current)}
              onRequestInstall={() => setConfirmInstall(true)}
              onCancelInstall={() => setConfirmInstall(false)}
              onConfirmInstall={() => {
                void onInstall(manifestAgent);
              }}
              onOpen={() => onOpenAgent(manifestAgent)}
            />
          )}
        </div>
      </Modal>
    </>
  );
}

function AgentInstallDetails({
  agent,
  installed,
  tenantTier,
  manifestPreview,
  manifestLoading,
  manifestError,
  confirmInstall,
  installing,
  showRaw,
  onToggleRaw,
  onRequestInstall,
  onCancelInstall,
  onConfirmInstall,
  onOpen,
}: {
  agent: RegistryAgentSummary;
  installed: boolean;
  tenantTier: "free" | "p1" | "p2" | "unknown" | undefined;
  manifestPreview: AgentManifestPreview | null;
  manifestLoading: boolean;
  manifestError: string | null;
  confirmInstall: boolean;
  installing: boolean;
  showRaw: boolean;
  onToggleRaw: () => void;
  onRequestInstall: () => void;
  onCancelInstall: () => void;
  onConfirmInstall: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={agent.mode === "write" ? "warning" : "default"}>
              {agent.mode === "write" ? "Write" : "Read-only"}
            </Pill>
            <Pill className="capitalize">{agent.category}</Pill>
            <EntraTierBadge
              required={agent.requiresEntraTier ?? "free"}
              tenantTier={tenantTier}
            />
            <CompatibilityBadge
              minAppVersion={agent.compatibility?.minAppVersion ?? agent.minAppVersion}
              supported={agent.compatibility?.supported}
            />
          </div>
          <p className="mt-4 text-[14px] leading-relaxed text-[var(--color-text)]">
            {agent.description}
          </p>
          <div className="mt-5 flex items-center gap-2">
            {installed ? (
              <Button variant="primary" leadingIcon={<IconCheck size={12} />} onClick={onOpen}>
                Open agent
              </Button>
            ) : agent.compatibility?.supported === false ? (
              <Button variant="secondary" onClick={onRequestInstall}>
                Update OpenAdminOS
              </Button>
            ) : (
              <Button variant="primary" onClick={onRequestInstall}>
                Install
              </Button>
            )}
            <Button variant="secondary" onClick={onToggleRaw}>
              {showRaw ? "Hide manifest" : "Review manifest"}
            </Button>
          </div>
        </div>
        <div className="rounded-lg bg-[var(--color-bg-raised)] p-4 ring-1 ring-[var(--color-border-soft)]">
          <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Author
          </div>
          <div className="mt-2 flex items-center gap-2 text-[13px] text-[var(--color-text)]">
            <Avatar name={agent.author.name} size={20} />
            <span>{agent.author.name}</span>
            {agent.author.verified && (
              <IconBadgeCheck size={12} className="text-[var(--color-accent)]" />
            )}
          </div>
          <div className="mt-4 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Permissions
          </div>
          <div className="mt-2 text-[12px] text-[var(--color-text-soft)]">
            {agent.scopes.length} Graph scope{agent.scopes.length === 1 ? "" : "s"}
          </div>
        </div>
      </div>

      {!installed && confirmInstall && (
        <div className="rounded-lg bg-[var(--color-bg-raised)] p-4 ring-1 ring-[var(--color-accent)]/35">
          <div className="text-[13px] font-medium text-[var(--color-text)]">
            Confirm installation
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-text-soft)]">
            OpenAdminOS will pin this agent locally. It can request the Graph
            scopes listed below when you run it, and write-mode agents still
            pause for diff confirmation before tenant changes.
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {agent.scopes.map((scope) => (
              <Pill key={scope}>
                <span className="font-mono text-[10.5px]">{scope}</span>
              </Pill>
            ))}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={installing} onClick={onCancelInstall}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" disabled={installing} onClick={onConfirmInstall}>
              {installing ? "Installing…" : "Confirm install"}
            </Button>
          </div>
        </div>
      )}

      {!installed && agent.compatibility?.supported === false && (
        <div className="rounded-lg bg-[var(--color-warning-soft)] p-4 ring-1 ring-[var(--color-warning)]/30">
          <div className="text-[13px] font-medium text-[var(--color-text)]">
            Update OpenAdminOS
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-text-soft)]">
            This agent requires OpenAdminOS {agent.compatibility.minAppVersion} or newer.
            You are running {agent.compatibility.appVersion}. Install is blocked so the
            app does not attempt to run unsupported agent syntax.
          </p>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-4">
        <DecisionFact
          label="Tenant impact"
          value={agent.mode === "write" ? "Can propose changes" : "Read-only"}
          detail={agent.mode === "write" ? "Changes still require confirmation." : "Cannot mutate tenant state."}
        />
        <DecisionFact
          label="License"
          value={(agent.requiresEntraTier ?? "free") === "free" ? "No premium tier declared" : `Entra ID ${(agent.requiresEntraTier ?? "free").toUpperCase()}`}
          detail="Checked before a run when tenant tier is known."
        />
        <DecisionFact
          label="Compatibility"
          value={
            agent.compatibility?.supported === false
              ? "Update required"
              : `OpenAdminOS ${agent.compatibility?.minAppVersion ?? agent.minAppVersion ?? "0.1.0"}+`
          }
          detail={
            agent.compatibility?.supported === false
              ? `Requires ${agent.compatibility.minAppVersion}; current app is ${agent.compatibility.appVersion}.`
              : "Compatible with this app version."
          }
        />
        <DecisionFact
          label="Install state"
          value={installed ? "Installed" : "Available"}
          detail={installed ? "Open it from this dialog or Agents." : "Installs a local pinned copy."}
        />
      </div>

      {agent.scopes.length > 0 && (
        <div>
          <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Required scopes
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {agent.scopes.map((scope) => (
              <Pill key={scope}>
                <span className="font-mono text-[10.5px]">{scope}</span>
              </Pill>
            ))}
          </div>
        </div>
      )}

      {showRaw && (
        <div className="rounded-lg bg-[var(--color-bg-raised)] p-4 ring-1 ring-[var(--color-border-soft)]">
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
          {!manifestLoading && !manifestError && !manifestPreview && (
            <div className="text-[13px] text-[var(--color-text-muted)]">
              No manifest is available for this agent yet.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DecisionFact({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-lg bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]">
      <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </div>
      <div className="mt-1 text-[13px] font-medium text-[var(--color-text)]">
        {value}
      </div>
      <div className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        {detail}
      </div>
    </div>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors ${
        active
          ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/30"
          : "bg-transparent text-[var(--color-text-soft)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
      }`}
    >
      {children}
    </button>
  );
}

function HubAgentCard({
  agent,
  installs,
  installed,
  tenantTier,
  onInstall,
  onOpen,
  onViewDetails,
}: {
  agent: RegistryAgentSummary;
  installs: number | undefined;
  installed: boolean;
  tenantTier: "free" | "p1" | "p2" | "unknown" | undefined;
  onInstall: () => void;
  onOpen: () => void;
  onViewDetails: () => void;
}) {
  return (
    <Card>
      <div
        role="button"
        tabIndex={0}
        onClick={onViewDetails}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") onViewDetails();
        }}
        className="flex cursor-pointer flex-col gap-4 p-5 outline-none transition-colors hover:bg-[var(--color-surface)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/40"
      >
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
          <CompatibilityBadge
            minAppVersion={agent.compatibility?.minAppVersion ?? agent.minAppVersion}
            supported={agent.compatibility?.supported}
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
            <Button
              variant="ghost"
              size="sm"
              onClick={(event) => {
                event.stopPropagation();
                onViewDetails();
              }}
            >
              Details
            </Button>
            {installed ? (
              <Button
                variant="secondary"
                size="sm"
                leadingIcon={<IconCheck size={12} />}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpen();
                }}
              >
                Open
              </Button>
            ) : agent.compatibility?.supported === false ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={(event) => {
                  event.stopPropagation();
                  onViewDetails();
                }}
              >
                Update app
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                onClick={(event) => {
                  event.stopPropagation();
                  onInstall();
                }}
              >
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
          No agents found
        </div>
        <div className="mt-1 max-w-[440px] text-[13px] text-[var(--color-text-muted)]">
          Refresh the catalog or point Settings to a source with agent manifests.
        </div>
      </div>
    </Card>
  );
}

const LIVE_STATS_URL = "https://openadminos.com/stats/agents.json";
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

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function HubFilterEmpty({
  query,
  category,
  onReset,
}: {
  query: string;
  category: string;
  onReset: () => void;
}) {
  const hasQuery = query.trim().length > 0;
  const hasFilter = category !== "all";
  return (
    <Card>
      <div className="flex flex-col items-center justify-center gap-3 p-10 text-center">
        <IconSearch size={24} className="text-[var(--color-text-muted)]" />
        <div className="text-[15px] font-medium text-[var(--color-text)]">
          No agents match
        </div>
        <div className="max-w-[440px] text-[13px] text-[var(--color-text-muted)]">
          {hasQuery && hasFilter
            ? `Nothing matches "${query}" in the ${titleCase(category)} category.`
            : hasQuery
              ? `Nothing matches "${query}" across all categories.`
              : `No agents in the ${titleCase(category)} category yet.`}
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
