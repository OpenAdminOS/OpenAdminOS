import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { hasLicenseShortfall } from "../components/marketplace/AgentHubList";
import { NewAgentModal } from "../components/NewAgentModal";
import { SchedulesPausedNotice } from "../components/SchedulesPausedNotice";
import { useToast } from "../components/Toast";
import { ServiceAccessDialog } from "../components/ServiceAccess";
import { AgentNeedChips } from "../components/AgentNeedChips";
import { AGENT_COPY, SCHEDULE_ORGANIZATION_COPY, SERVICE_COPY } from "../copy";
import { reportDestinations, resultDestinations } from "../shared/delivery-destinations";
import {
  IconChevronDown,
  IconClock,
  IconPlay,
  IconSearch,
  IconSettings,
  IconShare,
} from "../components/icons";
import {
  Badge,
  Button,
  IconButton,
  Menu,
  Tabs,
  type MenuEntry,
} from "../components/ui";
import type { AgentDisplay } from "../shared/agent-display";
import { formatAgentDisplayName } from "../shared/agent-display";
import {
  AVAILABLE_SERVICES,
  activeOrganizationOf,
  agentServiceIds,
  isServiceId,
  resolveOrganizations,
  serviceById,
  type AgentSummary,
  type InvalidAgentManifest,
  type RunRecord,
  type ServiceId,
} from "../shared/openAdminOS";
import { createPendingIntent, type PendingIntent } from "../setup/pending-intent";
import { useSetupFlow } from "../setup/SetupFlowContext";
import { useAppState } from "../state";
import { agentNeeds, type AgentNeeds } from "../shared/agent-needs";

type ModeFilter = "all" | "read" | "write";

/** Installed agents only. The registry catalog lives in the Marketplace. */
interface LibraryRow {
  id: string;
  slug: string;
  display: AgentDisplay;
  installed: AgentSummary;
  latestRun?: RunRecord;
  latestScheduledRun?: RunRecord;
  licenseMissing: boolean;
}

export default function AgentsHome() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();
  const { state, startRun } = useAppState();
  const { requireTenantAndProvider } = useSetupFlow();
  const [query, setQuery] = useState("");
  const [bulkRunning, setBulkRunning] = useState<"due" | "all" | null>(null);
  const [scheduler, setScheduler] = useState<{ enabled: boolean; canTurnOn: boolean } | null>(null);
  const [schedulerBusy, setSchedulerBusy] = useState(false);
  const [schedulerError, setSchedulerError] = useState<string | null>(null);
  const resumedBatchRef = useRef<string | null>(null);
  const [editingInvalid, setEditingInvalid] = useState<InvalidAgentManifest | null>(null);
  const invalidAgents = state.invalidAgents ?? [];
  const invalidEntryFor = (agent: AgentSummary | undefined) =>
    agent?.manifestError
      ? invalidAgents.find((entry) => entry.registryPath === agent.registryPath)
      : undefined;
  const editableInvalid = (entry: InvalidAgentManifest | undefined) =>
    entry?.source === "user" && entry.sourceText !== undefined ? entry : undefined;

  const modeParam = searchParams.get("mode");
  const modeFilter: ModeFilter = modeParam === "read" || modeParam === "write" ? modeParam : "all";
  const categoryFilter = searchParams.get("category") || "all";
  const serviceParam = searchParams.get("service");
  const serviceFilter: ServiceId | "all" = isServiceId(serviceParam) ? serviceParam : "all";
  const scheduledOnly = searchParams.get("filter") === "scheduled";
  const activeTab = scheduledOnly ? "schedules" : "installed";
  const updatesOnly = searchParams.get("updates") === "available";
  const addFlow = searchParams.get("add");
  const activeTenant = state.activeTenantId
    ? state.tenants.find((tenant) => tenant.id === state.activeTenantId)
    : undefined;
  const organizations = resolveOrganizations(state);
  const activeOrganization = activeOrganizationOf(state);
  const schedulesPaused = activeTenant?.kind === "sample" || !activeOrganization;
  const [access, setAccess] = useState<{ serviceId: ServiceId; partIds?: string[] } | null>(null);

  // Run due now and Run all scheduled run only the schedules of the active
  // organization; the others wait for their organization.
  const scheduledAgents = useMemo(
    () =>
      state.installedAgents.filter(
        (agent) =>
          agent.schedule?.enabled === true &&
          activeOrganization !== undefined &&
          agent.schedule.organizationId === activeOrganization.id,
      ),
    [activeOrganization, state.installedAgents],
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
        if (!cancelled) setScheduler({ enabled: settings.enabled === true, canTurnOn: settings.supported === true && !settings.requiresTenant });
      })
      .catch(() => {
        if (!cancelled) setScheduler(null);
      });
    return () => {
      cancelled = true;
    };
  }, [scheduledOnly]);

  const runScheduledBatch = useCallback(
    async (agents: AgentSummary[], mode: "due" | "all") => {
      if (schedulesPaused) return;
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
        // Each start is a scheduled start, so the host refuses it if the
        // schedule's organization is no longer the active one.
        for (const agent of agents) {
          await startRun(agent.slug, { trigger: "schedule" });
          started += 1;
        }
        toast.success(`${started} scheduled ${started === 1 ? "run" : "runs"} queued.`);
      } catch (caught) {
        toast.error(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBulkRunning(null);
      }
    },
    [requireTenantAndProvider, schedulesPaused, startRun, toast],
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
    return state.installedAgents.map((agent) => ({
      id: agent.id,
      slug: agent.slug,
      display: toInstalledDisplay(agent),
      installed: agent,
      latestRun: latestRun(agent.slug),
      latestScheduledRun: latestRun(agent.slug, true),
      licenseMissing: hasLicenseShortfall(agent.requiresEntraTier, activeTenant?.entraTier),
    }));
  }, [activeTenant?.entraTier, state.installedAgents, state.runs]);

  // The sample organization has every service; only the pilot agents run there.
  const rowNeeds = (row: LibraryRow): AgentNeeds =>
    agentNeeds(row.installed, activeTenant, organizations.length > 0);

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
    const matchesService =
      serviceFilter === "all" || agentServiceIds(row.display).includes(serviceFilter);
    const matchesSchedule = !scheduledOnly || row.installed.schedule?.enabled === true;
    const matchesUpdates = !updatesOnly || Boolean(row.installed.updateAvailable);
    return matchesQuery && matchesMode && matchesCategory && matchesService && matchesSchedule && matchesUpdates;
  });

  const setLibraryTab = (nextTab: string) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("add");
      next.delete("source");
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

  const setServiceFilter = (service: ServiceId | "all") => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (service === "all") next.delete("service");
      else next.set("service", service);
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

  const runAgent = async (agent: AgentSummary, needs: AgentNeeds) => {
    if (needs.action.kind === "connect-service") {
      setAccess({ serviceId: needs.action.serviceId });
      return;
    }
    if (needs.action.kind === "add-part") {
      setAccess({ serviceId: needs.action.serviceId, partIds: [needs.action.partId] });
      return;
    }
    // Without an organization the preflight names the services the agent
    // needs, and runs an agent that calls no service API.
    if (!activeTenant) {
      navigate(`/agents/${encodeURIComponent(agent.slug)}/confirm`);
      return;
    }
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
    const editable = editableInvalid(invalidEntryFor(row.installed));
    return [
      ...(editable
        ? [{
            id: "edit-manifest",
            label: AGENT_COPY.invalidEditAction,
            onSelect: () => setEditingInvalid(editable),
          }]
        : []),
      {
        id: "schedule",
        label: "Schedule",
        icon: <IconClock size={13} />,
        disabled: Boolean(row.installed.manifestError),
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
      label: "All modes",
      checked: modeFilter === "all",
      radio: true,
      onSelect: () => setModeFilter("all"),
    },
    {
      id: "mode-read",
      label: "Read mode",
      checked: modeFilter === "read",
      radio: true,
      onSelect: () => setModeFilter("read"),
    },
    {
      id: "mode-write",
      label: "Write mode",
      checked: modeFilter === "write",
      radio: true,
      onSelect: () => setModeFilter("write"),
    },
    { id: "mode-separator", type: "separator" },
    {
      id: "category-all",
      label: "All categories",
      checked: categoryFilter === "all",
      radio: true,
      onSelect: () => setCategoryFilter("all"),
    },
    ...categories.map((category) => ({
      id: `category-${category}`,
      label: titleCase(category),
      checked: categoryFilter === category,
      radio: true,
      onSelect: () => setCategoryFilter(category),
    })),
    { id: "service-separator", type: "separator" as const },
    {
      id: "service-all",
      label: SERVICE_COPY.filterAll,
      checked: serviceFilter === "all",
      radio: true,
      onSelect: () => setServiceFilter("all"),
    },
    ...AVAILABLE_SERVICES.map((service) => ({
      id: `service-${service.id}`,
      label: SERVICE_COPY.filterLabel(service.title),
      checked: serviceFilter === service.id,
      radio: true,
      onSelect: () => setServiceFilter(service.id),
    })),
    { id: "filter-separator", type: "separator" as const },
    {
      id: "scheduled",
      label: "Scheduled only",
      checked: scheduledOnly,
      onSelect: () => setScheduledOnly(!scheduledOnly),
    },
    {
      id: "updates",
      label: "Updates available",
      checked: updatesOnly,
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
                placeholder="Search installed agents…"
                className="h-8 w-full rounded-lg bg-[var(--color-surface)] pl-9 pr-3 text-sm text-[var(--color-text)] ring-1 ring-[var(--color-border)] placeholder:text-[var(--color-text-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--color-focus)]"
              />
            </label>
            <Menu ariaLabel="Filter agents" align="end" trigger={<Button size="sm" variant="ghost">Filter</Button>} items={filterItems} />
            <Menu
              ariaLabel="Schedule actions"
              trigger={<IconButton label="Schedule actions" icon={<IconChevronDown size={14} />} />}
              items={[
                {
                  id: "run-due",
                  label: bulkRunning === "due" ? "Queueing due schedules" : `Run due now (${dueAgents.length})`,
                  disabled: schedulesPaused || bulkRunning !== null || dueAgents.length === 0,
                  icon: <IconPlay size={13} />,
                  onSelect: () => void runScheduledBatch(dueAgents, "due"),
                },
                {
                  id: "run-all",
                  label: bulkRunning === "all" ? "Queueing schedules" : "Run all scheduled",
                  disabled: schedulesPaused || bulkRunning !== null || scheduledAgents.length === 0,
                  icon: <IconPlay size={13} />,
                  onSelect: () => void runScheduledBatch(scheduledAgents, "all"),
                },
              ]}
            />
          </div>
        </div>
        <div className="mb-2 flex items-center justify-between gap-3 text-xs text-[var(--color-text-muted)]">
          <span>{rows.length} of {sourceRows.length} installed agents</span>
          <span className="flex items-center gap-2">
            {serviceFilter !== "all" ? (
              <Badge tone="info">{SERVICE_COPY.filterLabel(serviceById(serviceFilter).title)}</Badge>
            ) : null}
          </span>
        </div>
        {/* The persistent warning with its fix comes first; one-time notes follow as plain text. */}
        {scheduledOnly && scheduledAgents.length > 0 && scheduler?.enabled === false ? (
          <div className="mb-2 flex items-center justify-between gap-3 rounded-lg bg-[var(--color-warning-soft)] px-3.5 py-2.5 text-md text-[var(--color-warning)]">
            <span>{SCHEDULE_ORGANIZATION_COPY.backgroundOff}</span>
            <Button
              size="sm"
              variant="secondary"
              disabled={schedulerBusy}
              onClick={() => {
                if (!scheduler.canTurnOn) {
                  navigate("/settings/general?target=os-scheduler");
                  return;
                }
                setSchedulerBusy(true);
                setSchedulerError(null);
                void window.openAdminOS
                  ?.setSchedulerLaunchEnabled(true)
                  .then((next) => setScheduler({ enabled: next.enabled === true, canTurnOn: next.supported === true && !next.requiresTenant }))
                  .catch((caught) => setSchedulerError(caught instanceof Error ? caught.message : String(caught)))
                  .finally(() => setSchedulerBusy(false));
              }}
            >
              {schedulerBusy ? "Turning on" : scheduler.canTurnOn ? "Turn on" : "Open setting"}
            </Button>
          </div>
        ) : null}
        {schedulerError ? (
          <p role="alert" className="mb-2 text-sm text-[var(--color-danger)]">{SCHEDULE_ORGANIZATION_COPY.backgroundFailed(schedulerError)}</p>
        ) : null}
        {scheduledOnly ? <SchedulesPausedNotice className="mb-3" /> : null}
        {scheduledOnly && state.schedulerStatus?.lastError ? (
          <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
            <span>Latest scheduled run failed: {state.schedulerStatus.lastError}</span>
            <Link className="shrink-0 font-medium underline underline-offset-2" to="/runs?filter=failed">
              Open runs
            </Link>
          </div>
        ) : null}
        <div aria-label="Installed agents">
          {rows.map((row) => {
            const scheduled = row.installed.schedule?.enabled === true;
            const needs = rowNeeds(row);
            const scheduleOrganization = organizations.find(
              (organization) => organization.id === row.installed.schedule?.organizationId && organization.kind !== "sample",
            );
            const modeText = row.display.mode === "write" ? "Makes changes" : "Read-only";
            const every = scheduled ? `Every ${intervalWords(row.installed.schedule!.intervalSeconds)}` : "";
            // A sentence, not a dotted string: what it does, then when.
            const meta = scheduledOnly
              ? `${every}. ${scheduleOrganization ? scheduleOrganization.name : "Unassigned, paused"}`
              : `${modeText}. ${
                  scheduled
                    ? `${every}${scheduleOrganization ? "" : ". Unassigned, paused"}`
                    : row.latestRun
                      ? `Last run ${formatRelative(row.latestRun.queuedAt)}`
                      : "Never run"
                }`;
            return (
              <div key={row.id} className="calm-list-row group">
                <div className="min-w-0 flex-1">
                  <button type="button" className="block w-full min-w-0 text-left" onClick={() => openAgent(row.slug)}>
                    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="truncate text-md font-medium text-[var(--color-text)]">{formatAgentDisplayName(row.display)}</span>
                      <span className="text-sm text-[var(--color-text-muted)]">{meta}</span>
                    </span>
                    {scheduledOnly ? (
                      <span className="mt-0.5 block truncate text-sm text-[var(--color-text-soft)]">
                        {scheduleLine(row.installed, scheduleOrganization, activeOrganization?.id)}
                      </span>
                    ) : (
                      <>
                        <span className="mt-0.5 block truncate text-sm text-[var(--color-text-soft)]">{row.display.description}</span>
                        <AgentNeedChips needs={needs} />
                      </>
                    )}
                    {row.licenseMissing ? <span className="mt-0.5 block text-xs text-[var(--color-text-muted)]">License required</span> : null}
                    {row.installed.manifestError ? (
                      <span className="mt-0.5 block truncate text-xs text-[var(--color-danger)]" title={row.installed.manifestError}>
                        {AGENT_COPY.invalidRowHint} {row.installed.manifestError}
                      </span>
                    ) : null}
                  </button>
                </div>
                <div
                  className="calm-row-actions flex shrink-0 items-center gap-1"
                  // The row's action is its next step: the fix, or Run.
                  data-persistent="true"
                  onClick={(event) => event.stopPropagation()}
                >
                  {scheduledOnly ? (
                    <Button size="sm" variant="ghost" onClick={() => openAgent(row.slug)} aria-label={`Edit the schedule of ${row.display.name}`}>
                      Edit
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={row.display.compatibility?.supported === false || Boolean(row.installed.manifestError)}
                      title={row.installed.manifestError ? AGENT_COPY.invalidRowHint : undefined}
                      onClick={() => void runAgent(row.installed, needs)}
                    >
                      {needs.action.label}
                    </Button>
                  )}
                  <Menu
                    ariaLabel={`${row.display.name} actions`}
                    trigger={<IconButton label={`More actions for ${row.display.name}`} icon={<IconChevronDown size={13} />} size="sm" />}
                    items={installedAgentMenu(row)}
                  />
                </div>
              </div>
            );
          })}
          {rows.length === 0 ? (
            <div role="status" className="px-6 py-12 text-center">
              <div className="font-medium text-[var(--color-text)]">No installed agents match</div>
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                {state.installedAgents.length === 0 ? (
                  <>
                    Install an agent from the Marketplace to add it to this library.{" "}
                    <Link className="font-medium text-[var(--color-text)] underline underline-offset-2" to="/marketplace?kind=agents">Open the Marketplace</Link>
                  </>
                ) : "Clear filters or search for another agent."}
              </p>
            </div>
          ) : null}
        </div>
      </section>
      {activeTenant ? (
        <ServiceAccessDialog
          tenant={activeTenant}
          serviceId={access?.serviceId ?? null}
          {...(access?.partIds ? { initialPartIds: access.partIds } : {})}
          open={access !== null}
          onClose={() => setAccess(null)}
        />
      ) : null}
      <NewAgentModal open={addFlow === "agent"} onClose={closeAddFlow} />
      {editingInvalid ? (
        <NewAgentModal
          open
          onClose={() => setEditingInvalid(null)}
          initialYamlSource={editingInvalid.sourceText}
          editingSlug={editingInvalid.folder}
        />
      ) : null}
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

function nextRunTime(agent: AgentSummary) {
  const schedule = agent.schedule;
  if (!schedule?.enabled) return Number.POSITIVE_INFINITY;
  return schedule.lastScheduledRunAt
    ? Date.parse(schedule.lastScheduledRunAt) + schedule.intervalSeconds * 1000
    : Date.parse(agent.installedAt) + schedule.intervalSeconds * 1000;
}

/** "day", "week", "6 hours", "15 minutes": how often, in words. */
export function intervalWords(seconds: number): string {
  const unit = (count: number, word: string) => (count === 1 ? word : `${count} ${word}s`);
  if (seconds % 604800 === 0) return unit(seconds / 604800, "week");
  if (seconds % 86400 === 0) return unit(seconds / 86400, "day");
  if (seconds >= 3600 && seconds % 3600 === 0) return unit(seconds / 3600, "hour");
  return unit(Math.max(1, Math.round(seconds / 60)), "minute");
}

/** "today at 07:00", "tomorrow at 07:00", "Monday at 08:00", or a date. */
export function nextRunWords(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  const startOf = (value: number) => new Date(new Date(value).toDateString()).getTime();
  const days = Math.round((startOf(at) - startOf(now)) / 86400000);
  if (days <= 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days < 7) return `${date.toLocaleDateString(undefined, { weekday: "long" })} at ${time}`;
  return `${date.toLocaleDateString(undefined, { day: "numeric", month: "long" })} at ${time}`;
}

/** The Schedules row's second line: when it runs next, and where results go. */
function scheduleLine(
  agent: AgentSummary,
  organization: { id: string; name: string } | undefined,
  activeOrganizationId: string | undefined,
): string {
  const when = !organization
    ? "Paused until it is assigned to an organization."
    : organization.id !== activeOrganizationId
      ? `Runs only while ${organization.name} is active.`
      : `Next run ${nextRunWords(Math.max(nextRunTime(agent), Date.now()))}.`;
  const destinations = reportDestinations(resultDestinations([agent], undefined));
  const results = destinations.length > 0 ? `Results can go to ${listWords(destinations)}.` : "Results stay in Runs.";
  return `${when} ${results}`;
}

function listWords(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
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

