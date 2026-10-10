import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { AgentIdentity } from "../components/AgentCard";
import { NewAgentModal } from "../components/NewAgentModal";
import { PersonaEditor } from "../components/office/PersonaEditor";
import { PersonaAvatar } from "../components/office/OfficeScene";
import { useToast } from "../components/Toast";
import {
  IconAgentTeam,
  IconChevronDown,
  IconClock,
  IconPlay,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconShare,
} from "../components/icons";
import {
  Badge,
  Button,
  DataTable,
  Drawer,
  EmptyState,
  IconButton,
  KeyValue,
  Menu,
  Section,
  SegmentedControl,
  StatusDot,
  Toolbar,
  type DataTableColumn,
  type MenuEntry,
} from "../components/ui";
import type { AgentDisplay } from "../shared/agent-display";
import type {
  AgentSummary,
  OfficeFinding,
  OfficeMission,
  OfficePersona,
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
  const { personaId } = useParams<{ personaId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();
  const {
    state,
    registryAgents,
    refresh,
    refreshRegistry,
    startRun,
  } = useAppState();
  const { requireTenantAndProvider } = useSetupFlow();
  const [query, setQuery] = useState("");
  const [refreshingHub, setRefreshingHub] = useState(false);
  const [bulkRunning, setBulkRunning] = useState<"due" | "all" | null>(null);
  const [schedulerRegistered, setSchedulerRegistered] = useState<boolean | null>(null);
  const [personaEditing, setPersonaEditing] = useState<OfficePersona | undefined>();
  const [personaBusy, setPersonaBusy] = useState(false);
  const [personaError, setPersonaError] = useState("");
  const resumedBatchRef = useRef<string | null>(null);

  const source: LibrarySource = searchParams.get("source") === "hub" ? "hub" : "installed";
  const modeParam = searchParams.get("mode");
  const modeFilter: ModeFilter = modeParam === "read" || modeParam === "write" ? modeParam : "all";
  const categoryFilter = searchParams.get("category") || "all";
  const scheduledOnly = searchParams.get("filter") === "scheduled";
  const updatesOnly = searchParams.get("updates") === "available";
  const addFlow = searchParams.get("add");
  const office = state.office ?? { personas: [], missions: [] };
  const selectedPersona = office.personas.find((persona) => persona.id === personaId);
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

  const setSource = (nextSource: string) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("add");
      if (nextSource === "hub") next.set("source", "hub");
      else next.delete("source");
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

  const columns: DataTableColumn<LibraryRow>[] = [
    {
      id: "agent",
      header: "Agent",
      sortable: true,
      sortValue: (row) => row.display.name,
      width: "34%",
      render: (row) => (
        <div className="flex min-w-0 items-center gap-2">
          <AgentIdentity agent={row.display} />
          {row.licenseMissing ? <Badge tone="warning">License required</Badge> : null}
        </div>
      ),
    },
    {
      id: "mode",
      header: "Mode",
      sortable: true,
      sortValue: (row) => row.display.mode,
      render: (row) => (
        <Badge tone={row.display.mode === "write" ? "warning" : "neutral"}>
          {row.display.mode === "write" ? "Write" : "Read"}
        </Badge>
      ),
    },
    {
      id: "category",
      header: "Category",
      sortable: true,
      sortValue: (row) => row.display.category,
      render: (row) => <span className="capitalize">{row.display.category}</span>,
    },
    {
      id: "schedule",
      header: "Schedule",
      sortable: true,
      sortValue: (row) => row.installed?.schedule?.intervalSeconds ?? 0,
      render: (row) => (
        <button
          type="button"
          className="rounded text-left text-sm text-[var(--color-text-soft)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          onClick={(event) => {
            event.stopPropagation();
            openAgent(row.slug, "schedule");
          }}
        >
          <span className="block">
            {row.installed?.schedule?.enabled
              ? `Every ${formatInterval(row.installed.schedule.intervalSeconds)}`
              : "Manual"}
          </span>
          {row.installed?.schedule?.enabled && row.latestScheduledRun ? (
            <span className="mt-0.5 inline-flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
              <StatusDot
                tone={runStatusTone(row.latestScheduledRun)}
                label={`Last scheduled run ${runStatusLabel(row.latestScheduledRun.status)}`}
              />
              {runStatusLabel(row.latestScheduledRun.status)}
              {row.latestScheduledRun.changeState
                ? `, ${runChangeLabel(row.latestScheduledRun.changeState)}`
                : ""}
            </span>
          ) : null}
        </button>
      ),
    },
    {
      id: "last-run",
      header: "Last run",
      sortable: true,
      sortValue: (row) => row.latestRun?.queuedAt,
      render: (row) => (
        <span className="inline-flex items-center gap-2 text-sm">
          <StatusDot
            tone={runStatusTone(row.latestRun)}
            label={row.latestRun ? runStatusLabel(row.latestRun.status) : "Never run"}
          />
          <span>{row.latestRun ? formatRelative(row.latestRun.queuedAt) : "Never"}</span>
        </span>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      align: "right",
      render: (row) => (
        <div
          className="flex items-center justify-end gap-1"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {row.installed ? (
            <>
              <IconButton
                label={`Run ${row.display.name}`}
                icon={<IconPlay size={13} />}
                size="sm"
                disabled={row.display.compatibility?.supported === false}
                onClick={() => void runAgent(row.installed!)}
              />
              <Menu
                ariaLabel={`${row.display.name} actions`}
                trigger={
                  <IconButton
                    label={`More actions for ${row.display.name}`}
                    icon={<IconChevronDown size={13} />}
                    size="sm"
                  />
                }
                items={installedAgentMenu(row)}
              />
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={row.display.compatibility?.supported === false}
                onClick={() => openAgent(row.slug, "install")}
              >
                Install
              </Button>
              <Button size="sm" variant="ghost" onClick={() => openAgent(row.slug)}>
                Details
              </Button>
            </>
          )}
        </div>
      ),
    },
  ];

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

  const attentionPersonas = office.personas.filter((persona) =>
    personaNeedsAttention(persona, state.runs, office.findings),
  );
  const reviewRun = state.runs.find(
    (run) => run.office && run.status === "awaiting-confirmation",
  );

  const personaAct = async (action: () => Promise<unknown>) => {
    setPersonaBusy(true);
    setPersonaError("");
    try {
      await action();
      await refresh();
      return true;
    } catch (caught) {
      setPersonaError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setPersonaBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <Section
        title="Team"
        action={
          <div className="flex items-center gap-2">
            {attentionPersonas.length > 0 ? (
              <Link
                to={reviewRun ? `/runs/${reviewRun.id}` : "/agents/office?inbox=1"}
                className="rounded-md px-2 py-1 text-sm text-[var(--color-warning)] hover:bg-[var(--color-warning-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              >
                Review inbox ({attentionPersonas.length})
              </Link>
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => navigate("/agents/office")}>
              Open office
            </Button>
          </div>
        }
      >
        {office.personas.length === 0 ? (
          <EmptyState
            icon={<IconAgentTeam size={18} />}
            title="No teammates"
            description="Add a teammate to assign installed agents, a tenant, and a schedule."
            action={
              <Button variant="secondary" size="sm" onClick={() => navigate("/agents?add=teammate")}>
                Add teammate
              </Button>
            }
            className="py-6"
          />
        ) : (
          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-[10px] bg-[var(--color-border-soft)] ring-1 ring-[var(--color-border)] sm:grid-cols-2 xl:grid-cols-4">
            {office.personas.map((persona) => {
              const mission = office.missions.find((candidate) => candidate.personaId === persona.id);
              const personaStatus = getPersonaStatus(persona, mission, state.runs, office.findings);
              const attention = countPersonaAttention(persona, state.runs, office.findings);
              return (
                <button
                  key={persona.id}
                  type="button"
                  className="min-w-0 bg-[var(--color-surface)] p-3 text-left transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                  onClick={() => navigate(`/agents/team/${encodeURIComponent(persona.id)}${location.search}`)}
                >
                  <div className="flex items-start gap-3">
                    <span className="shrink-0 scale-75 origin-top-left">
                      <PersonaAvatar avatar={persona.avatar} color={persona.color} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-[var(--color-text)]">{persona.name}</span>
                      <span className="mt-0.5 block truncate text-xs text-[var(--color-text-muted)]">{persona.responsibility}</span>
                    </span>
                    <Badge tone={personaStatusTone(personaStatus)}>{personaStatus}</Badge>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--color-border-soft)] pt-2 text-xs text-[var(--color-text-muted)]">
                    <span className="truncate">
                      {persona.nextRunAt ? `Next ${formatRelative(persona.nextRunAt, true)}` : persona.enabled ? "Manual" : "Paused"}
                    </span>
                    {attention > 0 ? <Badge tone="warning">{attention} attention</Badge> : <span>Clear</span>}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Library">
        <Toolbar
          search={
            <label className="relative min-w-[220px] flex-1 sm:max-w-sm">
              <span className="sr-only">Search agents</span>
              <IconSearch
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
              />
              <input
                name="agent-library-search"
                type="search"
                autoComplete="off"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={source === "hub" ? "Search hub…" : "Search installed agents…"}
                className="h-9 w-full rounded-lg bg-[var(--color-surface)] pl-9 pr-3 text-base text-[var(--color-text)] ring-1 ring-[var(--color-border)] placeholder:text-[var(--color-text-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              />
            </label>
          }
          filters={
            <>
              <SegmentedControl
                ariaLabel="Agent source"
                value={source}
                onValueChange={setSource}
                options={[
                  { id: "installed", label: "Installed" },
                  { id: "hub", label: "Hub" },
                ]}
              />
              <Menu
                ariaLabel="Filter agents"
                align="start"
                trigger={<Button size="sm" variant="secondary">Filter</Button>}
                items={filterItems}
              />
            </>
          }
          actions={
            <>
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
                trigger={
                  <IconButton
                    label="Schedule actions"
                    icon={<IconChevronDown size={14} />}
                  />
                }
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
            </>
          }
          className="mb-3"
        />
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
        <DataTable
          caption={source === "hub" ? "Agent hub" : "Installed agents"}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          onRowClick={(row) => openAgent(row.slug)}
          emptyTitle={source === "hub" ? "No hub agents match" : "No installed agents match"}
          emptyDescription={
            source === "hub"
              ? "Clear filters or refresh the hub catalog."
              : state.installedAgents.length === 0
                ? "Install an agent from the hub to add it to this library."
                : "Clear filters or search for another agent."
          }
        />
      </Section>

      <PersonaDrawer
        persona={selectedPersona}
        missions={office.missions}
        findings={office.findings}
        runs={state.runs}
        installedAgents={state.installedAgents}
        busy={personaBusy}
        error={personaError}
        onClose={() => navigate(`/agents${location.search}`)}
        onEdit={() => selectedPersona && setPersonaEditing(selectedPersona)}
        onRun={() =>
          selectedPersona
            ? void personaAct(() => window.openAdminOS!.startOfficePersona!(selectedPersona.id))
            : undefined
        }
        onStop={() =>
          selectedPersona
            ? void personaAct(() => window.openAdminOS!.stopOfficePersona!(selectedPersona.id))
            : undefined
        }
      />

      {(addFlow === "teammate" || personaEditing) ? (
        <PersonaEditor
          persona={personaEditing}
          state={state}
          busy={personaBusy}
          error={personaError}
          onClose={() => {
            if (personaBusy) return;
            setPersonaEditing(undefined);
            setPersonaError("");
            closeAddFlow();
          }}
          onSave={async (input) => {
            let savedId = input.id;
            if (
              await personaAct(async () => {
                const result = await window.openAdminOS!.saveOfficePersona!(input);
                savedId ??= result.personas.find(
                  (persona) => !office.personas.some((existing) => existing.id === persona.id),
                )?.id;
              })
            ) {
              setPersonaEditing(undefined);
              if (savedId) navigate(`/agents/team/${encodeURIComponent(savedId)}`);
              else closeAddFlow();
            }
          }}
        />
      ) : null}
      <NewAgentModal open={addFlow === "agent"} onClose={closeAddFlow} />
    </div>
  );
}

function PersonaDrawer({
  persona,
  missions,
  findings,
  runs,
  installedAgents,
  busy,
  error,
  onClose,
  onEdit,
  onRun,
  onStop,
}: {
  persona?: OfficePersona;
  missions: OfficeMission[];
  findings?: OfficeFinding[];
  runs: RunRecord[];
  installedAgents: AgentSummary[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onEdit: () => void;
  onRun: () => void;
  onStop: () => void;
}) {
  const personaMissions = missions
    .filter((mission) => mission.personaId === persona?.id)
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
  const activeMission = personaMissions.find((mission) =>
    ["queued", "running", "executing", "awaiting-review"].includes(mission.status),
  );
  const personaStatus = persona
    ? getPersonaStatus(persona, activeMission, runs, findings)
    : "Ready";

  return (
    <Drawer
      open={Boolean(persona)}
      title={persona?.name ?? "Teammate"}
      onClose={onClose}
      actions={
        persona ? (
          <>
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !persona.enabled || Boolean(activeMission)}
              onClick={onRun}
            >
              {personaMissions.length === 0 ? "Run first assignment" : "Run assignment"}
            </Button>
            <Menu
              ariaLabel={`${persona.name} actions`}
              trigger={
                <IconButton
                  label={`${persona.name} actions`}
                  icon={<IconChevronDown size={13} />}
                  size="sm"
                />
              }
              items={[
                { id: "edit", label: "Edit", onSelect: onEdit },
                {
                  id: "stop",
                  label: "Stop & pause",
                  danger: true,
                  disabled: busy || (!persona.enabled && !activeMission),
                  onSelect: onStop,
                },
              ]}
            />
          </>
        ) : null
      }
    >
      {persona ? (
        <div className="space-y-6 p-5">
          <div className="flex items-start gap-3">
            <PersonaAvatar avatar={persona.avatar} color={persona.color} />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-[var(--color-text)]">{persona.responsibility}</div>
              <div className="mt-1 flex items-center gap-2">
                <Badge tone={personaStatusTone(personaStatus)}>{personaStatus}</Badge>
                {countPersonaAttention(persona, runs, findings) > 0 ? (
                  <Badge tone="warning">Needs review</Badge>
                ) : null}
              </div>
            </div>
          </div>

          {error ? (
            <div role="alert" className="text-sm text-[var(--color-danger)]">
              {error} Review the assignment and try again.
            </div>
          ) : null}

          <Section title="Assignment">
            <dl className="divide-y divide-[var(--color-border-soft)]">
              <KeyValue label="State" value={activeMission?.status.replaceAll("-", " ") ?? "Idle"} />
              <KeyValue label="Schedule" value={formatPersonaSchedule(persona)} />
              <KeyValue label="Next run" value={persona.nextRunAt ? new Date(persona.nextRunAt).toLocaleString() : "Manual"} />
              <KeyValue label="Time budget" value={`${persona.maxMinutes} minutes`} />
            </dl>
          </Section>

          <Section title="Work order">
            <ol className="divide-y divide-[var(--color-border-soft)] rounded-lg bg-[var(--color-surface)] ring-1 ring-[var(--color-border)]">
              {persona.agentSlugs.map((slug, index) => {
                const agent = installedAgents.find((candidate) => candidate.slug === slug);
                const run = runs.find(
                  (candidate) => activeMission?.runIds.includes(candidate.id) && candidate.agentSlug === slug,
                );
                return (
                  <li key={slug} className="flex items-center gap-3 px-3 py-2.5">
                    <span className="font-mono text-xs text-[var(--color-text-muted)]">{index + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base text-[var(--color-text)]">{agent?.name ?? slug}</span>
                      <span className="block text-xs text-[var(--color-text-muted)]">
                        {run?.status.replaceAll("-", " ") ?? "Not started"}
                        {agent?.mode === "write" ? ", approval required" : ""}
                      </span>
                    </span>
                    {run ? <Link className="text-sm text-[var(--color-text-soft)] hover:text-[var(--color-text)]" to={`/runs/${run.id}`}>View</Link> : null}
                  </li>
                );
              })}
            </ol>
          </Section>

          <Section title="Recent assignments">
            {personaMissions.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">No assignments have run.</p>
            ) : (
              <div className="divide-y divide-[var(--color-border-soft)]">
                {personaMissions.slice(0, 5).map((mission) => (
                  <div key={mission.id} className="flex items-center justify-between gap-3 py-2.5">
                    <span>
                      <span className="block text-base text-[var(--color-text)]">{mission.status.replaceAll("-", " ")}</span>
                      <span className="block text-xs text-[var(--color-text-muted)]">{new Date(mission.startedAt).toLocaleString()}</span>
                    </span>
                    {mission.runIds[0] ? <Link className="text-sm text-[var(--color-text-soft)] hover:text-[var(--color-text)]" to={`/runs/${mission.runIds[0]}`}>View evidence</Link> : null}
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>
      ) : null}
    </Drawer>
  );
}

function getPersonaStatus(
  persona: OfficePersona,
  mission: OfficeMission | undefined,
  runs: RunRecord[],
  findings?: OfficeFinding[],
) {
  const currentRun = runs.find(
    (run) => mission?.runIds.includes(run.id) && ["queued", "running", "awaiting-confirmation"].includes(run.status),
  );
  if (currentRun?.status === "awaiting-confirmation") return "Needs approval";
  if (currentRun?.status === "running") return "Working";
  if (["queued", "running", "executing", "awaiting-review"].includes(mission?.status ?? "")) return "Queued";
  if (personaNeedsAttention(persona, runs, findings)) return "Needs attention";
  if (!persona.enabled) return "Paused";
  return persona.nextRunAt ? "Scheduled" : "Ready";
}

function personaStatusTone(status: string): "neutral" | "success" | "warning" | "danger" | "info" {
  if (status === "Working") return "info";
  if (status === "Needs approval" || status === "Needs attention") return "warning";
  if (status === "Paused") return "neutral";
  return "success";
}

function personaNeedsAttention(
  persona: OfficePersona,
  runs: RunRecord[],
  findings?: OfficeFinding[],
) {
  return countPersonaAttention(persona, runs, findings) > 0;
}

function countPersonaAttention(
  persona: OfficePersona,
  runs: RunRecord[],
  findings?: OfficeFinding[],
) {
  return (
    (persona.lastError ? 1 : 0) +
    (findings?.filter((finding) => finding.personaId === persona.id && finding.state === "open").length ?? 0) +
    runs.filter((run) => run.office?.personaId === persona.id && run.status === "awaiting-confirmation").length
  );
}

function formatPersonaSchedule(persona: OfficePersona) {
  if (!persona.enabled) return "Paused";
  if (persona.calendar) return `${persona.calendar.time}, ${persona.calendar.timeZone}`;
  if (persona.intervalMinutes) return `Every ${formatInterval(persona.intervalMinutes * 60)}`;
  if (persona.watch) return "On finding change";
  return "Manual";
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

function runStatusTone(run?: RunRecord): "neutral" | "success" | "warning" | "danger" | "info" {
  if (!run) return "neutral";
  if (run.status === "completed") return "success";
  if (run.status === "failed" || run.status === "cancelled" || run.status === "rejected") return "danger";
  if (run.status === "awaiting-confirmation") return "warning";
  return "info";
}

function runStatusLabel(status: RunRecord["status"]) {
  return status.replaceAll("-", " ");
}

function runChangeLabel(changeState: NonNullable<RunRecord["changeState"]>) {
  if (changeState === "unchanged") return "no changes";
  if (changeState === "changed") return "changes found";
  return changeState.replaceAll("-", " ");
}

function titleCase(value: string) {
  return value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
