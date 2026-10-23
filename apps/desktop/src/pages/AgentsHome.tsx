import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { NewAgentModal } from "../components/NewAgentModal";
import { useToast } from "../components/Toast";
import {
  IconChevronDown,
  IconBolt,
  IconClock,
  IconPlay,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconShare,
  IconShield,
} from "../components/icons";
import {
  Badge,
  Button,
  IconButton,
  Menu,
  StatusDot,
  Tabs,
  type MenuEntry,
} from "../components/ui";
import type { AgentDisplay } from "../shared/agent-display";
import { formatAgentDisplayName } from "../shared/agent-display";
import type {
  AgentSummary,
  RegistryAgentSummary,
  RunRecord,
} from "../shared/openAdminOS";
import { createPendingIntent, type PendingIntent } from "../setup/pending-intent";
import { useSetupFlow } from "../setup/SetupFlowContext";
import { useAppState } from "../state";

type LibrarySource = "installed" | "hub";
type ModeFilter = "all" | "read" | "write";

interface LibraryRow {
  id: string;
  slug: string;
  source: LibrarySource;
  display: AgentDisplay;
  installed?: AgentSummary;
  registry?: RegistryAgentSummary;
  latestRun?: RunRecord;
  latestScheduledRun?: RunRecord;
  licenseMissing: boolean;
}

export default function AgentsHome() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();
  const {
    state,
    registryAgents,
    refreshRegistry,
    startRun,
  } = useAppState();
  const { requireTenantAndProvider } = useSetupFlow();
  const [query, setQuery] = useState("");
  const [refreshingHub, setRefreshingHub] = useState(false);
  const [bulkRunning, setBulkRunning] = useState<"due" | "all" | null>(null);
  const [schedulerRegistered, setSchedulerRegistered] = useState<boolean | null>(null);
  const resumedBatchRef = useRef<string | null>(null);

  const source: LibrarySource = searchParams.get("source") === "hub" ? "hub" : "installed";
  const modeParam = searchParams.get("mode");
  const modeFilter: ModeFilter = modeParam === "read" || modeParam === "write" ? modeParam : "all";
  const categoryFilter = searchParams.get("category") || "all";
  const scheduledOnly = searchParams.get("filter") === "scheduled";
  const activeTab = source === "hub" ? "hub" : scheduledOnly ? "schedules" : "installed";
  const updatesOnly = searchParams.get("updates") === "available";
  const addFlow = searchParams.get("add");
  const activeTenant = state.activeTenantId
    ? state.tenants.find((tenant) => tenant.id === state.activeTenantId)
    : undefined;

  const installedBySlug = useMemo(
    () => new Map(state.installedAgents.map((agent) => [agent.slug, agent])),
    [state.installedAgents],
  );
  const scheduledAgents = useMemo(
    () => state.installedAgents.filter((agent) => agent.schedule?.enabled === true),
    [state.installedAgents],
  );
  const dueAgents = useMemo(
    () => scheduledAgents.filter((agent) => nextRunTime(agent) <= Date.now()),
    [scheduledAgents],
  );

  useEffect(() => {
    if (addFlow !== "teammate") return;
    const next = new URLSearchParams(searchParams);
    next.set("add", "teammate");
    navigate(
      { pathname: "/office", search: `?${next.toString()}`, hash: location.hash },
      { replace: true },
    );
  }, [addFlow, navigate, searchParams]);

  useEffect(() => {
    if (!scheduledOnly) return;
    let cancelled = false;
    window.openAdminOS
      ?.getSchedulerLaunchSettings()
      .then((settings) => {
        if (!cancelled) setSchedulerRegistered(settings.enabled === true);
      })
      .catch(() => {
        if (!cancelled) setSchedulerRegistered(null);
      });
    return () => {
      cancelled = true;
    };
  }, [scheduledOnly]);

  const runScheduledBatch = useCallback(
    async (agents: AgentSummary[], mode: "due" | "all") => {
      if (agents.length === 0) {
        toast.info(mode === "due" ? "No schedules are due." : "No schedules are enabled.");
        return;
      }
      if (
        !requireTenantAndProvider(
          createPendingIntent({
            kind: "scheduled-batch",
            mode,
            returnTo: "/agents?filter=scheduled",
          }),
        )
      ) {
        return;
      }
      setBulkRunning(mode);
      let started = 0;
      try {
        for (const agent of agents) {
          await startRun(agent.slug);
          started += 1;
        }
        toast.success(`${started} scheduled ${started === 1 ? "run" : "runs"} queued.`);
      } catch (caught) {
        toast.error(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBulkRunning(null);
      }
    },
    [requireTenantAndProvider, startRun, toast],
  );

  useEffect(() => {
    const routeState = location.state as { resumePendingIntent?: PendingIntent } | null;
    const resumed = routeState?.resumePendingIntent;
    if (
      resumed?.kind !== "scheduled-batch" ||
      resumedBatchRef.current === resumed.createdAt
    ) {
      return;
    }
    resumedBatchRef.current = resumed.createdAt;
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    void runScheduledBatch(
      resumed.mode === "due" ? dueAgents : scheduledAgents,
      resumed.mode,
    );
  }, [dueAgents, location.pathname, location.search, location.state, navigate, runScheduledBatch, scheduledAgents]);

  const sourceRows = useMemo<LibraryRow[]>(() => {
    const latestRun = (slug: string, scheduled = false) =>
      state.runs
        .filter((run) => run.agentSlug === slug && (!scheduled || run.trigger === "schedule"))
        .sort((left, right) => Date.parse(right.queuedAt) - Date.parse(left.queuedAt))[0];
    if (source === "installed") {
      return state.installedAgents.map((agent) => ({
        id: agent.id,
        slug: agent.slug,
        source,
        display: toInstalledDisplay(agent),
        installed: agent,
        latestRun: latestRun(agent.slug),
        latestScheduledRun: latestRun(agent.slug, true),
        licenseMissing: hasLicenseShortfall(agent.requiresEntraTier, activeTenant?.entraTier),
      }));
    }
    return registryAgents.map((agent) => {
      const installed = installedBySlug.get(agent.slug);
      return {
        id: agent.id,
        slug: agent.slug,
        source,
        display: toRegistryDisplay(agent, installed),
        registry: agent,
        installed,
        latestRun: latestRun(agent.slug),
        latestScheduledRun: latestRun(agent.slug, true),
        licenseMissing: hasLicenseShortfall(agent.requiresEntraTier, activeTenant?.entraTier),
      };
    });
  }, [activeTenant?.entraTier, installedBySlug, registryAgents, source, state.installedAgents, state.runs]);

  const categories = useMemo(
    () => Array.from(new Set(sourceRows.map((row) => row.display.category))).sort(),
    [sourceRows],
  );
  const rows = sourceRows.filter((row) => {
    const normalizedQuery = query.trim().toLowerCase();
    const matchesQuery =
      normalizedQuery === "" ||
      [
        row.display.name,
        row.display.description,
        row.display.author.name,
        row.display.category,
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    const matchesMode = modeFilter === "all" || row.display.mode === modeFilter;
    const matchesCategory = categoryFilter === "all" || row.display.category === categoryFilter;
    const matchesSchedule = !scheduledOnly || row.installed?.schedule?.enabled === true;
    const matchesUpdates = !updatesOnly || Boolean(row.installed?.updateAvailable);
    return matchesQuery && matchesMode && matchesCategory && matchesSchedule && matchesUpdates;
  });

  const setLibraryTab = (nextTab: string) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("add");
      if (nextTab === "hub") next.set("source", "hub");
      else next.delete("source");
      if (nextTab === "schedules") next.set("filter", "scheduled");
      else next.delete("filter");
      return next;
    });
  };

  const setScheduledOnly = (enabled: boolean) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (enabled) next.set("filter", "scheduled");
      else next.delete("filter");
      return next;
    });
  };

  const setModeFilter = (mode: ModeFilter) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (mode === "all") next.delete("mode");
      else next.set("mode", mode);
      return next;
    });
  };

  const setCategoryFilter = (category: string) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (category === "all") next.delete("category");
      else next.set("category", category);
      return next;
    });
  };

  const setUpdatesOnly = (enabled: boolean) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (enabled) next.set("updates", "available");
      else next.delete("updates");
      return next;
    });
  };

  const closeAddFlow = () => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("add");
      return next;
    }, { replace: true });
  };

  const openAgent = (slug: string, action?: string) => {
    const next = new URLSearchParams(searchParams);
    next.delete("add");
    if (action) next.set("action", action);
    else next.delete("action");
    navigate({
      pathname: `/agents/${encodeURIComponent(slug)}`,
      search: next.toString() ? `?${next.toString()}` : "",
    });
  };

  const runAgent = async (agent: AgentSummary) => {
    if (
      !requireTenantAndProvider(
        createPendingIntent({
          kind: "agent-run",
          slug: agent.slug,
          returnTo: `/agents/${encodeURIComponent(agent.slug)}`,
        }),
      )
    ) {
      return;
    }
    if (agent.mode === "write") {
      navigate(`/agents/${encodeURIComponent(agent.slug)}/confirm`);
      return;
    }
    try {
      const run = await startRun(agent.slug);
      navigate(`/runs/${run.id}`);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : String(caught));
    }
  };

  function installedAgentMenu(row: LibraryRow): MenuEntry[] {
    return [
      {
        id: "schedule",
        label: "Schedule",
        icon: <IconClock size={13} />,
        onSelect: () => openAgent(row.slug, "schedule"),
      },
      {
        id: "configure",
        label: "Configure",
        icon: <IconSettings size={13} />,
        onSelect: () => openAgent(row.slug, "configure"),
      },
      {
        id: "share",
        label: "Share",
        icon: <IconShare size={13} />,
        onSelect: () => openAgent(row.slug, "share"),
      },
      { id: "separator", type: "separator" },
      {
        id: "uninstall",
        label: "Uninstall",
        danger: true,
        onSelect: () => openAgent(row.slug, "uninstall"),
      },
    ];
  }

  const filterItems: MenuEntry[] = [
    {
      id: "mode-all",
      label: `${modeFilter === "all" ? "✓ " : ""}All modes`,
      onSelect: () => setModeFilter("all"),
    },
    {
      id: "mode-read",
      label: `${modeFilter === "read" ? "✓ " : ""}Read mode`,
      onSelect: () => setModeFilter("read"),
    },
    {
      id: "mode-write",
      label: `${modeFilter === "write" ? "✓ " : ""}Write mode`,
      onSelect: () => setModeFilter("write"),
    },
    { id: "mode-separator", type: "separator" },
    {
      id: "category-all",
      label: `${categoryFilter === "all" ? "✓ " : ""}All categories`,
      onSelect: () => setCategoryFilter("all"),
    },
    ...categories.map((category) => ({
      id: `category-${category}`,
      label: `${categoryFilter === category ? "✓ " : ""}${titleCase(category)}`,
      onSelect: () => setCategoryFilter(category),
    })),
    { id: "filter-separator", type: "separator" as const },
    {
      id: "scheduled",
      label: `${scheduledOnly ? "✓ " : ""}Scheduled only`,
      onSelect: () => setScheduledOnly(!scheduledOnly),
    },
    {
      id: "updates",
      label: `${updatesOnly ? "✓ " : ""}Updates available`,
      onSelect: () => setUpdatesOnly(!updatesOnly),
    },
  ];

  return (
    <div className="calm-page-column">
      <section aria-labelledby="agent-library-title">
        <h2 id="agent-library-title" className="sr-only">Library</h2>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <Tabs
            ariaLabel="Agent library sections"
            value={activeTab}
            onValueChange={setLibraryTab}
            tabs={[
              { id: "installed", label: "Installed" },
              { id: "hub", label: "Browse" },
              { id: "schedules", label: "Schedules" },
            ]}
          />
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            <label className="relative min-w-[220px] sm:max-w-[280px]">
              <span className="sr-only">Search agents</span>
              <IconSearch size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
              <input
                name="agent-library-search"
                type="search"
                autoComplete="off"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={source === "hub" ? "Search hub…" : "Search installed agents…"}
                className="h-8 w-full rounded-lg bg-[var(--color-surface)] pl-9 pr-3 text-sm text-[var(--color-text)] ring-1 ring-[var(--color-border)] placeholder:text-[var(--color-text-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--color-focus)]"
              />
            </label>
            <Menu ariaLabel="Filter agents" align="end" trigger={<Button size="sm" variant="ghost">Filter</Button>} items={filterItems} />
            {source === "hub" ? (
              <IconButton
                label="Refresh hub"
                icon={<IconRefresh size={14} className={refreshingHub ? "animate-spin" : ""} />}
                disabled={refreshingHub}
                onClick={() => {
                  setRefreshingHub(true);
                  void refreshRegistry()
                    .catch((caught) => toast.error(caught instanceof Error ? caught.message : String(caught)))
                    .finally(() => setRefreshingHub(false));
                }}
              />
            ) : null}
            <Menu
              ariaLabel="Schedule actions"
              trigger={<IconButton label="Schedule actions" icon={<IconChevronDown size={14} />} />}
              items={[
                {
                  id: "run-due",
                  label: bulkRunning === "due" ? "Queueing due schedules" : `Run due now (${dueAgents.length})`,
                  disabled: bulkRunning !== null || dueAgents.length === 0,
                  icon: <IconPlay size={13} />,
                  onSelect: () => void runScheduledBatch(dueAgents, "due"),
                },
                {
                  id: "run-all",
                  label: bulkRunning === "all" ? "Queueing schedules" : "Run all scheduled",
                  disabled: bulkRunning !== null || scheduledAgents.length === 0,
                  icon: <IconPlay size={13} />,
                  onSelect: () => void runScheduledBatch(scheduledAgents, "all"),
                },
              ]}
            />
          </div>
        </div>
        <div className="mb-2 flex items-center justify-between gap-3 text-xs text-[var(--color-text-muted)]">
          <span>{rows.length} of {sourceRows.length} {source === "hub" ? "hub" : "installed"} agents</span>
          {scheduledOnly ? <Badge tone="info">Scheduled only</Badge> : null}
        </div>
        {scheduledOnly && scheduledAgents.length > 0 && schedulerRegistered === false ? (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-[var(--color-warning-soft)] px-3 py-2 text-sm text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
            <span>Background scheduling is off. Schedules run only while OpenAdminOS is open.</span>
            <Link className="shrink-0 font-medium underline underline-offset-2" to="/settings/general?target=os-scheduler">
              Open setting
            </Link>
          </div>
        ) : null}
        {scheduledOnly && state.schedulerStatus?.lastError ? (
          <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
            <span>Latest scheduled run failed: {state.schedulerStatus.lastError}</span>
            <Link className="shrink-0 font-medium underline underline-offset-2" to="/runs?filter=failed">
              Open runs
            </Link>
          </div>
        ) : null}
        <div aria-label={source === "hub" ? "Agent hub" : "Installed agents"}>
          {rows.map((row) => {
            const scheduled = row.installed?.schedule?.enabled === true;
            const meta = scheduled
              ? `Every ${formatInterval(row.installed!.schedule!.intervalSeconds)}`
              : row.latestRun
                ? `Last run ${formatRelative(row.latestRun.queuedAt)}`
                : "Never run";
            return (
              <div key={row.id} className="calm-list-row group">
                <span className="calm-row-icon">
                  {row.display.mode === "write" ? <IconBolt size={16} /> : <IconShield size={16} />}
                </span>
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => openAgent(row.slug)}>
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="truncate font-medium text-[var(--color-text)]">{formatAgentDisplayName(row.display)}</span>
                    <span className="inline-flex items-center gap-1.5 text-sm text-[var(--color-text-muted)]">
                      <StatusDot tone={row.display.mode === "write" ? "warning" : "success"} />
                      {row.display.mode === "write" ? "Makes changes" : "Read-only"}
                      <span aria-hidden="true">·</span>
                      {meta}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-sm text-[var(--color-text-muted)]">{row.display.description}</span>
                  {row.licenseMissing ? <span className="mt-0.5 block text-xs text-[var(--color-warning)]">License required</span> : null}
                </button>
                <div className="calm-row-actions flex shrink-0 items-center gap-1" onClick={(event) => event.stopPropagation()}>
                  {row.installed ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        leadingIcon={<IconPlay size={13} />}
                        disabled={row.display.compatibility?.supported === false}
                        onClick={() => void runAgent(row.installed!)}
                      >
                        Run
                      </Button>
                      <Menu
                        ariaLabel={`${row.display.name} actions`}
                        trigger={<IconButton label={`More actions for ${row.display.name}`} icon={<IconChevronDown size={13} />} size="sm" />}
                        items={installedAgentMenu(row)}
                      />
                    </>
                  ) : (
                    <>
                      <Button size="sm" variant="secondary" disabled={row.display.compatibility?.supported === false} onClick={() => openAgent(row.slug, "install")}>Install</Button>
                      <Button size="sm" variant="ghost" onClick={() => openAgent(row.slug)}>Details</Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {rows.length === 0 ? (
            <div role="status" className="px-6 py-12 text-center">
              <div className="font-medium text-[var(--color-text)]">{source === "hub" ? "No hub agents match" : "No installed agents match"}</div>
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                {source === "hub" ? "Clear filters or refresh the hub catalog." : state.installedAgents.length === 0 ? "Install an agent from the hub to add it to this library." : "Clear filters or search for another agent."}
              </p>
            </div>
          ) : null}
        </div>
      </section>
      <NewAgentModal open={addFlow === "agent"} onClose={closeAddFlow} />
    </div>
  );
}

function toInstalledDisplay(agent: AgentSummary): AgentDisplay {
  return {
    ...agent,
    installed: true,
    author: {
      name: agent.author.name,
      handle: agent.author.handle ?? "local",
      verified: agent.author.verified ?? false,
    },
  };
}

function toRegistryDisplay(agent: RegistryAgentSummary, installed?: AgentSummary): AgentDisplay {
  return {
    ...agent,
    installed: Boolean(installed),
    lastRunAt: installed?.lastRunAt,
    updateAvailable: installed?.updateAvailable,
    author: {
      name: agent.author.name,
      handle: agent.author.handle ?? "community",
      verified: agent.author.verified ?? false,
    },
  };
}

function hasLicenseShortfall(
  required: "free" | "p1" | "p2",
  actual: "free" | "p1" | "p2" | "unknown" | undefined,
) {
  if (!actual || actual === "unknown") return false;
  const rank = { free: 0, p1: 1, p2: 2 } as const;
  return rank[actual] < rank[required];
}

function nextRunTime(agent: AgentSummary) {
  const schedule = agent.schedule;
  if (!schedule?.enabled) return Number.POSITIVE_INFINITY;
  return schedule.lastScheduledRunAt
    ? Date.parse(schedule.lastScheduledRunAt) + schedule.intervalSeconds * 1000
    : Date.parse(agent.installedAt) + schedule.intervalSeconds * 1000;
}

function formatInterval(seconds: number) {
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function formatRelative(iso: string, future = false) {
  const difference = future ? Date.parse(iso) - Date.now() : Date.now() - Date.parse(iso);
  const absolute = Math.abs(difference);
  if (absolute < 60_000) return future ? "now" : "just now";
  if (absolute < 60 * 60_000) return `${Math.floor(absolute / 60_000)}m ${future ? "from now" : "ago"}`;
  if (absolute < 24 * 60 * 60_000) return `${Math.floor(absolute / (60 * 60_000))}h ${future ? "from now" : "ago"}`;
  return `${Math.floor(absolute / (24 * 60 * 60_000))}d ${future ? "from now" : "ago"}`;
}

function titleCase(value: string) {
  return value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
