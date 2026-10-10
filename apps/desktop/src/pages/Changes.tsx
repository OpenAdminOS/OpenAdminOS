import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router";

import { PageBody } from "../components/AppShell";
import { Modal, ModalHeader } from "../components/Modal";
import { Select } from "../components/Select";
import {
  Badge,
  Button,
  DataTable,
  Drawer,
  EmptyState,
  IconButton,
  KeyValue,
  Menu,
  PageHeader,
  Section,
  SegmentedControl,
  StatusDot,
  Tabs,
  Toolbar,
  type BadgeTone,
  type DataTableColumn,
} from "../components/ui";
import {
  IconChanges,
  IconChevronDown,
  IconClock,
  IconCopy,
  IconHardDrive,
  IconRefresh,
  IconSearch,
  IconWarning,
} from "../components/icons";
import { copyTextToClipboard } from "../shared/clipboard";
import { userFacingErrorReason } from "../copy/errors";
import type {
  DriftAttribution,
  DriftBaseline,
  DriftBaselineDriftEntry,
  DriftBaselineDriftResult,
  DriftBaselineResourceDrift,
  DriftEntryDetail,
  DriftFieldChange,
  DriftObjectHistoryResult,
  DriftResourceStatus,
  DriftTenantCompareEntry,
  DriftTenantCompareResourceCounts,
  DriftTenantCompareResult,
  DriftTimeCompareResult,
  DriftTimelineChangeKind,
  DriftTimelineEntry,
  DriftTimelineResult,
  GraphCacheResourceKind,
  GraphCacheStatus,
  WorkspaceSummary,
} from "../shared/openAdminOS";
import { useAppState } from "../state";
import { createPendingIntent, type PendingIntent } from "../setup/pending-intent";
import { useSetupFlow } from "../setup/SetupFlowContext";
import FleetScope from "./Fleet";

type DateRangeValue = "24h" | "7d" | "30d" | "all";
type ChangesView = "timeline" | "baselines" | "compare";
type CompareMode = "time" | "tenant";
type BaselineNameMode = "create" | "rename";

const DATE_RANGES: Array<{
  value: DateRangeValue;
  label: string;
  ms?: number;
}> = [
  { value: "24h", label: "Last 24h", ms: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "Last 7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", label: "Last 30d", ms: 30 * 24 * 60 * 60 * 1000 },
  { value: "all", label: "All" },
];

const INITIAL_LIMIT = 100;
const LOAD_MORE_STEP = 100;

export default function Changes() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { requireTenant } = useSetupFlow();
  const { state } = useAppState();
  const activeTenant = state.activeTenantId
    ? state.tenants.find((tenant) => tenant.id === state.activeTenantId)
    : undefined;
  const baselinesAvailable = Boolean(window.openAdminOS?.listDriftBaselines);
  const compareAvailable = Boolean(window.openAdminOS?.getDriftTimeCompare);
  const baselineRollbackAvailable = Boolean(
    window.openAdminOS?.startBaselineRollback,
  );
  const requestedView = searchParams.get("view");
  const view: ChangesView =
    requestedView === "baselines" && baselinesAvailable
      ? "baselines"
      : requestedView === "compare" && compareAvailable
        ? "compare"
        : "timeline";
  const allTenantScope =
    searchParams.get("scope") === "all" && state.tenants.length >= 2;
  const otherTenants = useMemo(
    () => state.tenants.filter((tenant) => tenant.id !== activeTenant?.id),
    [activeTenant?.id, state.tenants],
  );

  const [cacheStatus, setCacheStatus] = useState<GraphCacheStatus | null>(null);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [refreshStarting, setRefreshStarting] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const resumedIntentRef = useRef<string | null>(null);
  const previousPreloadRef = useRef<{
    tenantId?: string;
    status?: NonNullable<GraphCacheStatus["preload"]>["status"];
  }>({});

  const [status, setStatus] = useState<DriftTimelineStatus | null>(null);
  const [timeline, setTimeline] = useState<DriftTimelineResult | null>(null);
  const [selectedResource, setSelectedResource] = useState<
    "all" | GraphCacheResourceKind
  >("all");
  const [dateRange, setDateRange] = useState<DateRangeValue>("all");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [limit, setLimit] = useState(INITIAL_LIMIT);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadAnnouncement, setLoadAnnouncement] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<DriftTimelineEntry | null>(
    null,
  );
  const [detail, setDetail] = useState<DriftEntryDetail | null>(null);
  const [history, setHistory] = useState<DriftObjectHistoryResult | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [pinOpen, setPinOpen] = useState(false);
  const [pinWorkspaceId, setPinWorkspaceId] = useState("");

  const [baselines, setBaselines] = useState<DriftBaseline[] | null>(null);
  const [baselineDrift, setBaselineDrift] =
    useState<DriftBaselineDriftResult | null>(null);
  const [baselineLoading, setBaselineLoading] = useState(false);
  const [baselineAnnouncement, setBaselineAnnouncement] = useState("");
  const [baselineError, setBaselineError] = useState<string | null>(null);
  const [baselineNoActive, setBaselineNoActive] = useState(false);
  const [baselineReloadNonce, setBaselineReloadNonce] = useState(0);
  const [selectedBaselineDrift, setSelectedBaselineDrift] =
    useState<DriftBaselineDriftEntry | null>(null);
  const [baselineNameMode, setBaselineNameMode] =
    useState<BaselineNameMode | null>(null);
  const [baselineName, setBaselineName] = useState("");
  const [baselineNameError, setBaselineNameError] = useState<string | null>(
    null,
  );
  const [baselineNameBusy, setBaselineNameBusy] = useState(false);
  const [retireBaselineOpen, setRetireBaselineOpen] = useState(false);
  const [retireBaselineError, setRetireBaselineError] = useState<string | null>(
    null,
  );
  const [retireBaselineBusy, setRetireBaselineBusy] = useState(false);
  const [baselineRollbackOpen, setBaselineRollbackOpen] = useState(false);
  const [baselineRollbackError, setBaselineRollbackError] = useState<
    string | null
  >(null);
  const [baselineRollbackBusy, setBaselineRollbackBusy] = useState(false);
  const [rollbackSelection, setRollbackSelection] = useState<ReadonlySet<string>>(
    new Set<string>(),
  );

  const [compareMode, setCompareMode] = useState<CompareMode>("time");
  const [timeCompareFrom, setTimeCompareFrom] = useState(() =>
    defaultCompareDateValue(-7),
  );
  const [timeCompareTo, setTimeCompareTo] = useState(() =>
    defaultCompareDateValue(0),
  );
  const [timeCompare, setTimeCompare] = useState<DriftTimeCompareResult | null>(
    null,
  );
  const [timeCompareLoading, setTimeCompareLoading] = useState(false);
  const [timeCompareAnnouncement, setTimeCompareAnnouncement] = useState("");
  const [timeCompareError, setTimeCompareError] = useState<string | null>(null);
  const [selectedTimeCompareEntry, setSelectedTimeCompareEntry] =
    useState<DriftBaselineDriftEntry | null>(null);
  const timeCompareRequestId = useRef(0);
  const [tenantCompareId, setTenantCompareId] = useState("");
  const [includeAssignments, setIncludeAssignments] = useState(false);
  const [tenantCompare, setTenantCompare] =
    useState<DriftTenantCompareResult | null>(null);
  const [tenantCompareLoading, setTenantCompareLoading] = useState(false);
  const [tenantCompareAnnouncement, setTenantCompareAnnouncement] =
    useState("");
  const [tenantCompareError, setTenantCompareError] = useState<string | null>(
    null,
  );
  const [selectedTenantCompareEntry, setSelectedTenantCompareEntry] =
    useState<DriftTenantCompareEntry | null>(null);

  const replaceSearchParams = useCallback(
    (changes: Record<string, string | null>, replace = false) => {
      const next = new URLSearchParams(searchParams);
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) next.delete(key);
        else next.set(key, value);
      }
      setSearchParams(next, { replace });
    },
    [searchParams, setSearchParams],
  );

  const handleViewChange = (nextView: string) => {
    const resolved = nextView as ChangesView;
    replaceSearchParams({
      view: resolved === "timeline" ? null : resolved,
      scope: resolved === "timeline" ? searchParams.get("scope") : null,
      change: null,
    });
    setSelectedEntry(null);
  };

  const handleScopeChange = (nextScope: string) => {
    replaceSearchParams({
      scope: nextScope === "all" ? "all" : null,
      view: nextScope === "all" ? null : searchParams.get("view"),
      change: null,
    });
    setSelectedEntry(null);
  };

  useEffect(() => {
    const normalized = query.trim();
    if (!normalized) {
      setDebouncedQuery("");
      return;
    }
    const timer = window.setTimeout(() => setDebouncedQuery(normalized), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!activeTenant) {
      setCacheStatus(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await window.openAdminOS?.getGraphCacheStatus(
          activeTenant.id,
        );
        if (cancelled || !next) return;
        setCacheStatus(next);
        setCacheError(null);
      } catch (caught) {
        if (!cancelled) {
          setCacheError(caught instanceof Error ? caught.message : String(caught));
        }
      }
      if (!cancelled) timer = setTimeout(() => void load(), 1000);
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeTenant]);

  useEffect(() => {
    const tenantId = activeTenant?.id;
    if (!tenantId) {
      previousPreloadRef.current = {};
      return;
    }
    if (cacheStatus?.tenantId && cacheStatus.tenantId !== tenantId) return;
    const status = cacheStatus?.preload?.status;
    const previous = previousPreloadRef.current;
    if (
      previous.tenantId === tenantId &&
      previous.status === "running" &&
      status &&
      status !== "running"
    ) {
      setReloadNonce((value) => value + 1);
      setBaselineReloadNonce((value) => value + 1);
      setRefreshToken((value) => value + 1);
    }
    previousPreloadRef.current = { tenantId, status };
  }, [activeTenant?.id, cacheStatus?.preload?.status, cacheStatus?.tenantId]);

  const handleRefreshCache = useCallback(async () => {
    const api = window.openAdminOS;
    if (!api || refreshStarting) return;
    if (
      !requireTenant(
        createPendingIntent({
          kind: "refresh-cache",
          returnTo: `${location.pathname}${location.search}`,
        }),
      )
    ) {
      return;
    }
    if (!activeTenant) return;

    setRefreshStarting(true);
    setCacheError(null);
    try {
      const resources = cacheStatus?.resources.map((resource) => resource.resource);
      await api.startGraphCachePreload({
        tenantId: activeTenant.id,
        ...(resources?.length ? { resources } : {}),
      });
      const nextStatus = await api.getGraphCacheStatus(activeTenant.id);
      setCacheStatus(nextStatus);
      if (nextStatus.preload?.status !== "running") {
        setReloadNonce((value) => value + 1);
        setBaselineReloadNonce((value) => value + 1);
        setRefreshToken((value) => value + 1);
      }
    } catch (caught) {
      setCacheError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRefreshStarting(false);
    }
  }, [
    activeTenant,
    cacheStatus?.resources,
    location.pathname,
    location.search,
    refreshStarting,
    requireTenant,
  ]);

  const handleCancelRefresh = async () => {
    if (!activeTenant || !window.openAdminOS) return;
    setCacheError(null);
    try {
      await window.openAdminOS.cancelGraphCachePreload(activeTenant.id);
      setCacheStatus(
        await window.openAdminOS.getGraphCacheStatus(activeTenant.id),
      );
    } catch (caught) {
      setCacheError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  useEffect(() => {
    const routeState = location.state as {
      resumePendingIntent?: PendingIntent;
    } | null;
    const resumed = routeState?.resumePendingIntent;
    if (
      resumed?.kind !== "refresh-cache" ||
      resumedIntentRef.current === resumed.createdAt
    ) {
      return;
    }
    resumedIntentRef.current = resumed.createdAt;
    navigate(`${location.pathname}${location.search}`, {
      replace: true,
      state: null,
    });
    void handleRefreshCache();
  }, [
    handleRefreshCache,
    location.pathname,
    location.search,
    location.state,
    navigate,
  ]);

  useEffect(() => {
    const api = window.openAdminOS;
    if (allTenantScope || view !== "timeline") {
      setLoading(false);
      return;
    }
    if (!activeTenant) {
      setStatus(null);
      setTimeline(null);
      setLoading(false);
      return;
    }
    if (!api?.getDriftStatus || !api.getDriftTimeline) {
      setError(
        "Change history is unavailable in this build. Update OpenAdminOS and try again.",
      );
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setLoadAnnouncement("Loading change history…");
    const bounds = dateRangeBounds(dateRange);
    const resources =
      selectedResource === "all" ? undefined : [selectedResource];

    void Promise.all([
      api.getDriftStatus(activeTenant.id),
      api.getDriftTimeline({
        tenantId: activeTenant.id,
        limit,
        ...(bounds.from ? { from: bounds.from } : {}),
        ...(bounds.to ? { to: bounds.to } : {}),
        ...(resources ? { resources } : {}),
        ...(debouncedQuery ? { query: debouncedQuery } : {}),
      }),
    ])
      .then(([nextStatus, nextTimeline]) => {
        if (cancelled) return;
        setStatus(nextStatus);
        setTimeline(nextTimeline);
        setLoadAnnouncement(
          nextTimeline.entries.length === 1
            ? "Showing 1 change history entry."
            : `Showing ${nextTimeline.entries.length} change history entries.`,
        );
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : String(caught));
        setLoadAnnouncement("Change history could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeTenant,
    allTenantScope,
    dateRange,
    debouncedQuery,
    limit,
    reloadNonce,
    selectedResource,
    view,
  ]);

  useEffect(() => {
    const api = window.openAdminOS;
    if (allTenantScope || view !== "baselines" || !baselinesAvailable) {
      setBaselineLoading(false);
      return;
    }
    if (!activeTenant || !api?.listDriftBaselines) {
      setBaselines(null);
      setBaselineDrift(null);
      setBaselineLoading(false);
      return;
    }
    const listDriftBaselines = api.listDriftBaselines;

    let cancelled = false;
    setBaselineLoading(true);
    setBaselineError(null);
    setBaselineAnnouncement("Loading baselines…");

    void (async () => {
      try {
        const nextBaselines = await listDriftBaselines({
          tenantId: activeTenant.id,
        });
        if (cancelled) return;
        setBaselines(nextBaselines);
        const nextActive = nextBaselines.find(
          (baseline) => baseline.status === "active",
        );
        if (!nextActive) {
          setBaselineDrift(null);
          setBaselineNoActive(true);
          setBaselineAnnouncement("No active baseline.");
          return;
        }
        if (!api.getDriftBaselineDrift) {
          throw new Error(
            "Baseline drift is unavailable in this build. Update OpenAdminOS and try again.",
          );
        }
        try {
          const nextDrift = await api.getDriftBaselineDrift({
            tenantId: activeTenant.id,
            baselineId: nextActive.id,
          });
          if (cancelled) return;
          setBaselineDrift(nextDrift);
          setBaselineNoActive(false);
          setBaselineAnnouncement(
            nextDrift.entries.length === 1
              ? "Showing 1 baseline drift entry."
              : `Showing ${nextDrift.entries.length} baseline drift entries.`,
          );
        } catch (caught) {
          if (cancelled) return;
          if (isNoActiveBaselineError(caught)) {
            setBaselineDrift(null);
            setBaselineNoActive(true);
            setBaselineAnnouncement("No active baseline.");
            return;
          }
          throw caught;
        }
      } catch (caught) {
        if (!cancelled) {
          setBaselineError(
            caught instanceof Error ? caught.message : String(caught),
          );
          setBaselineAnnouncement("Baselines could not be loaded.");
        }
      } finally {
        if (!cancelled) setBaselineLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeTenant,
    allTenantScope,
    baselineReloadNonce,
    baselinesAvailable,
    view,
  ]);

  useEffect(() => {
    const api = window.openAdminOS;
    if (!api || !activeTenant) {
      setWorkspaces([]);
      return;
    }
    let cancelled = false;
    void api
      .listWorkspaces(activeTenant.id)
      .then((nextWorkspaces) => {
        if (cancelled) return;
        setWorkspaces(nextWorkspaces);
        setPinWorkspaceId((current) =>
          current && nextWorkspaces.some((workspace) => workspace.id === current)
            ? current
            : (nextWorkspaces[0]?.id ?? ""),
        );
      })
      .catch(() => {
        if (!cancelled) setWorkspaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTenant]);

  useEffect(() => {
    setTenantCompareId((current) =>
      current && otherTenants.some((tenant) => tenant.id === current)
        ? current
        : (otherTenants[0]?.id ?? ""),
    );
  }, [otherTenants]);

  useEffect(() => {
    timeCompareRequestId.current += 1;
    setTimeCompare(null);
    setTimeCompareError(null);
    setTimeCompareLoading(false);
    setSelectedTimeCompareEntry(null);
    setTenantCompare(null);
    setTenantCompareError(null);
    setSelectedTenantCompareEntry(null);
    setRollbackSelection(new Set());
  }, [activeTenant?.id]);

  useEffect(() => {
    if (
      selectedResource !== "all" &&
      status &&
      !status.resources.some(
        (resource) => resource.resource === selectedResource,
      )
    ) {
      setSelectedResource("all");
    }
  }, [selectedResource, status]);

  useEffect(() => {
    const entryId = searchParams.get("change");
    if (!entryId || !timeline) return;
    const next = timeline.entries.find((entry) => entry.id === entryId);
    if (next && next.id !== selectedEntry?.id) setSelectedEntry(next);
  }, [searchParams, selectedEntry?.id, timeline]);

  useEffect(() => {
    const api = window.openAdminOS;
    if (
      !api?.getDriftEntryDetail ||
      !api.getDriftObjectHistory ||
      !activeTenant ||
      !selectedEntry ||
      selectedEntry.changeKind === "baseline" ||
      !selectedEntry.graphId
    ) {
      setDetail(null);
      setHistory(null);
      setDetailLoading(false);
      setDetailError(null);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    setDetail(null);
    setHistory(null);
    void Promise.all([
      api.getDriftEntryDetail({
        tenantId: activeTenant.id,
        snapshotId: selectedEntry.snapshotId,
        resource: selectedEntry.resource,
        graphId: selectedEntry.graphId,
      }),
      api.getDriftObjectHistory({
        tenantId: activeTenant.id,
        resource: selectedEntry.resource,
        graphId: selectedEntry.graphId,
        limit: 20,
      }),
    ])
      .then(([nextDetail, nextHistory]) => {
        if (cancelled) return;
        setDetail(nextDetail);
        setHistory(nextHistory);
      })
      .catch((caught) => {
        if (!cancelled) {
          setDetailError(
            caught instanceof Error ? caught.message : String(caught),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeTenant, selectedEntry]);

  const selectedStatusResources = useMemo(() => {
    if (!status) return [];
    if (selectedResource === "all") return status.resources;
    return status.resources.filter(
      (resource) => resource.resource === selectedResource,
    );
  }, [selectedResource, status]);
  const visibleEntries = timeline?.entries ?? [];
  const noBaselineYet =
    Boolean(status) &&
    (selectedStatusResources.length === 0 ||
      selectedStatusResources.every((resource) => !resource.baselineCaptured));
  const hasRealChanges = Boolean(
    timeline?.entries.some((entry) => entry.changeKind !== "baseline"),
  );
  const baselineOnly =
    Boolean(status) &&
    !loading &&
    selectedStatusResources.length > 0 &&
    selectedStatusResources.every((resource) => resource.baselineCaptured) &&
    !hasRealChanges &&
    query.trim().length === 0 &&
    dateRange === "all";
  const baselineDate = latestBaselineDate(
    selectedStatusResources,
    timeline?.entries ?? [],
  );
  const selectedMarkdown = selectedEntry
    ? buildChangeMarkdown(selectedEntry, detail, history)
    : "";
  const tenantBaselines = (baselines ?? []).filter(
    (baseline) => baseline.tenantId === activeTenant?.id,
  );
  const tenantBaselineDrift =
    baselineDrift?.tenantId === activeTenant?.id ? baselineDrift : null;
  const activeBaseline = baselineNoActive
    ? undefined
    : (tenantBaselineDrift?.baseline ??
      tenantBaselines.find((baseline) => baseline.status === "active"));
  const selectedCompareTenant = otherTenants.find(
    (tenant) => tenant.id === tenantCompareId,
  );
  const timeCompareValidation = compareDateValidation(
    timeCompareFrom,
    timeCompareTo,
  );
  const latestRefresh = cacheStatus?.resources
    .map((resource) => resource.refreshedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  const refreshJob = cacheStatus?.preload;
  const refreshing = refreshStarting || refreshJob?.status === "running";
  const freshnessLabel = refreshJob?.status === "running"
    ? `Refreshing ${refreshJob.completed} of ${refreshJob.total}`
    : latestRefresh
      ? `Updated ${formatRelativeTime(latestRefresh)}`
      : "Not refreshed yet";

  const handleResourceChange = (value: string) => {
    setSelectedResource(
      value === "all" ? "all" : (value as GraphCacheResourceKind),
    );
    setLimit(INITIAL_LIMIT);
    closeChangeDrawer(true);
  };

  const handleDateRangeChange = (value: string) => {
    setDateRange(value as DateRangeValue);
    setLimit(INITIAL_LIMIT);
    closeChangeDrawer(true);
  };

  function openChangeDrawer(entry: DriftTimelineEntry) {
    setSelectedEntry(entry);
    replaceSearchParams({ change: entry.id });
  }

  function closeChangeDrawer(replace = false) {
    setSelectedEntry(null);
    setDetail(null);
    setHistory(null);
    replaceSearchParams({ change: null }, replace);
  }

  const handleTimeCompare = async () => {
    const api = window.openAdminOS;
    if (!activeTenant || timeCompareValidation || !api?.getDriftTimeCompare) {
      return;
    }
    const requestId = timeCompareRequestId.current + 1;
    timeCompareRequestId.current = requestId;
    setTimeCompareLoading(true);
    setTimeCompareError(null);
    setTimeCompare(null);
    setSelectedTimeCompareEntry(null);
    setTimeCompareAnnouncement("Comparing configuration over time…");
    try {
      const result = await api.getDriftTimeCompare({
        tenantId: activeTenant.id,
        from: compareDateToIso(timeCompareFrom),
        to: compareDateToIso(timeCompareTo),
        limit: INITIAL_LIMIT,
      });
      if (timeCompareRequestId.current !== requestId) return;
      setTimeCompare(result);
      setTimeCompareAnnouncement(
        result.entries.length === 1
          ? "Showing 1 time comparison entry."
          : `Showing ${result.entries.length} time comparison entries.`,
      );
    } catch (caught) {
      if (timeCompareRequestId.current !== requestId) return;
      setTimeCompareError(
        caught instanceof Error ? caught.message : String(caught),
      );
      setTimeCompareAnnouncement("Time comparison could not be loaded.");
    } finally {
      if (timeCompareRequestId.current === requestId) {
        setTimeCompareLoading(false);
      }
    }
  };

  const handleTenantCompare = async () => {
    const api = window.openAdminOS;
    if (!activeTenant || !tenantCompareId || !api?.getDriftTenantCompare) return;
    setTenantCompareLoading(true);
    setTenantCompareError(null);
    setTenantCompare(null);
    setSelectedTenantCompareEntry(null);
    setTenantCompareAnnouncement("Comparing tenant configuration…");
    try {
      const result = await api.getDriftTenantCompare({
        tenantIdA: activeTenant.id,
        tenantIdB: tenantCompareId,
        limit: INITIAL_LIMIT,
        includeAssignments,
      });
      setTenantCompare(result);
      setTenantCompareAnnouncement(
        result.entries.length === 1
          ? "Showing 1 tenant comparison entry."
          : `Showing ${result.entries.length} tenant comparison entries.`,
      );
    } catch (caught) {
      setTenantCompareError(
        caught instanceof Error ? caught.message : String(caught),
      );
      setTenantCompareAnnouncement("Tenant comparison could not be loaded.");
    } finally {
      setTenantCompareLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!selectedEntry) return;
    setError(null);
    setNotice(null);
    try {
      await copyTextToClipboard(selectedMarkdown);
      setNotice("Copied change diff as Markdown.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const handlePin = async () => {
    const api = window.openAdminOS;
    const workspaceId = pinWorkspaceId || workspaces[0]?.id;
    if (!api || !activeTenant || !selectedEntry || !workspaceId) return;
    setError(null);
    setNotice(null);
    try {
      const workspace = workspaces.find((entry) => entry.id === workspaceId);
      const evidence = await api.pinWorkspaceEvidence({
        workspaceId,
        tenantId: activeTenant.id,
        title: `Change · ${displayNameForEntry(selectedEntry)} · ${formatShortDateTime(
          selectedEntry.capturedAt,
        )}`,
        sourceType: "manual",
        sourceRef: {
          kind: "drift-change",
          entryId: selectedEntry.id,
          snapshotId: selectedEntry.snapshotId,
          resource: selectedEntry.resource,
          ...(selectedEntry.graphId ? { graphId: selectedEntry.graphId } : {}),
        },
        content: selectedMarkdown,
        freshness: {
          resource: selectedEntry.resource,
          refreshedAt: selectedEntry.capturedAt,
          rowCount: selectedEntry.rowCount ?? 1,
          cacheStatus: "cache",
        },
      });
      setPinOpen(false);
      setNotice(
        `Pinned change to ${workspace?.title ?? "workspace"} as ${evidence.title}.`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const openCreateBaseline = () => {
    setBaselineNameMode("create");
    setBaselineName("");
    setBaselineNameError(null);
  };

  const openRenameBaseline = () => {
    if (!activeBaseline) return;
    setBaselineNameMode("rename");
    setBaselineName(activeBaseline.name);
    setBaselineNameError(null);
  };

  const closeBaselineNameModal = () => {
    if (baselineNameBusy) return;
    setBaselineNameMode(null);
    setBaselineNameError(null);
  };

  const handleBaselineNameSubmit = async () => {
    const api = window.openAdminOS;
    const name = baselineName.trim();
    if (!name) {
      setBaselineNameError("Enter a baseline name.");
      return;
    }
    if (name.length > 80) {
      setBaselineNameError("Baseline names can contain at most 80 characters.");
      return;
    }
    if (!activeTenant || !baselineNameMode) return;

    setBaselineNameBusy(true);
    setBaselineNameError(null);
    try {
      if (baselineNameMode === "create") {
        if (!api?.createDriftBaseline) {
          throw new Error("Baseline creation is unavailable in this build.");
        }
        const created = await api.createDriftBaseline({
          tenantId: activeTenant.id,
          name,
        });
        setBaselines((current) => [
          created,
          ...(current ?? []).filter((baseline) => baseline.id !== created.id),
        ]);
        setBaselineNoActive(false);
        setBaselineNameMode(null);
        if (api.getDriftBaselineDrift) {
          const nextDrift = await api.getDriftBaselineDrift({
            tenantId: activeTenant.id,
            baselineId: created.id,
          });
          setBaselineDrift(nextDrift);
        }
        return;
      }

      if (!activeBaseline || !api?.renameDriftBaseline) {
        throw new Error("No active baseline exists to rename.");
      }
      const renamed = await api.renameDriftBaseline({
        tenantId: activeTenant.id,
        baselineId: activeBaseline.id,
        name,
      });
      setBaselines((current) =>
        (current ?? []).map((baseline) =>
          baseline.id === renamed.id ? renamed : baseline,
        ),
      );
      setBaselineDrift((current) =>
        current && current.baseline.id === renamed.id
          ? { ...current, baseline: renamed }
          : current,
      );
      setBaselineNameMode(null);
    } catch (caught) {
      setBaselineNameError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setBaselineNameBusy(false);
    }
  };

  const handleRetireBaseline = async () => {
    const api = window.openAdminOS;
    if (!activeTenant || !activeBaseline) return;
    setRetireBaselineBusy(true);
    setRetireBaselineError(null);
    try {
      if (!api?.retireDriftBaseline) {
        throw new Error("Baseline retirement is unavailable in this build.");
      }
      const retired = await api.retireDriftBaseline({
        tenantId: activeTenant.id,
        baselineId: activeBaseline.id,
      });
      setBaselines((current) => {
        const existing = current ?? [];
        return existing.some((baseline) => baseline.id === retired.id)
          ? existing.map((baseline) =>
              baseline.id === retired.id ? retired : baseline,
            )
          : [retired, ...existing];
      });
      setBaselineDrift(null);
      setBaselineNoActive(true);
      setRollbackSelection(new Set());
      setRetireBaselineOpen(false);
    } catch (caught) {
      setRetireBaselineError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setRetireBaselineBusy(false);
    }
  };

  const toggleRollbackSelection = (entry: DriftBaselineDriftEntry) => {
    const key = baselineDriftEntryKey(entry);
    setRollbackSelection((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleBaselineRollback = async () => {
    const startBaselineRollback = window.openAdminOS?.startBaselineRollback;
    if (!activeTenant) return;
    setBaselineRollbackBusy(true);
    setBaselineRollbackError(null);
    try {
      if (!startBaselineRollback) {
        throw new Error("Baseline rollback is unavailable in this build.");
      }
      const picked = baselineDrift?.entries.filter((entry) =>
        rollbackSelection.has(baselineDriftEntryKey(entry)),
      );
      const run = await startBaselineRollback({
        tenantId: activeTenant.id,
        ...(picked?.length
          ? {
              selections: picked.map((entry) => ({
                resource: entry.resource,
                graphId: entry.graphId,
              })),
            }
          : {}),
      });
      setBaselineRollbackOpen(false);
      navigate(`/runs/${run.id}`);
    } catch (caught) {
      setBaselineRollbackError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setBaselineRollbackBusy(false);
    }
  };

  const viewTabs = [
    { id: "timeline", label: "Timeline", panelId: "changes-panel" },
    ...(baselinesAvailable
      ? [{ id: "baselines", label: "Baselines", panelId: "changes-panel" }]
      : []),
    ...(compareAvailable
      ? [{ id: "compare", label: "Compare", panelId: "changes-panel" }]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Changes"
        actions={
          <>
            <span
              aria-live="polite"
              className="text-sm text-[var(--color-text-muted)]"
            >
              {freshnessLabel}
            </span>
            <Button
              size="sm"
              variant="secondary"
              icon={<IconRefresh size={13} className={refreshing ? "animate-spin" : ""} />}
              onClick={() =>
                refreshing ? void handleCancelRefresh() : void handleRefreshCache()
              }
            >
              {refreshing ? "Cancel" : "Refresh"}
            </Button>
          </>
        }
      />
      <PageBody>
        <div role="status" aria-live="polite" className="sr-only">
          {allTenantScope
            ? "Showing all-tenant change status."
            : view === "baselines"
              ? baselineLoading
                ? "Loading baselines…"
                : baselineAnnouncement
              : view === "compare"
                ? compareMode === "time"
                  ? timeCompareLoading
                    ? "Comparing configuration over time…"
                    : timeCompareAnnouncement
                  : tenantCompareLoading
                    ? "Comparing tenant configuration…"
                    : tenantCompareAnnouncement
                : loading
                  ? "Loading change history…"
                  : loadAnnouncement}
        </div>

        <Toolbar
          className="mb-5 border-b border-[var(--color-border-soft)] pb-3"
          search={
            <Tabs
              ariaLabel="Changes views"
              tabs={viewTabs}
              value={allTenantScope ? "timeline" : view}
              onValueChange={handleViewChange}
            />
          }
          filters={
            <>
              {state.tenants.length >= 2 ? (
                <SegmentedControl
                  ariaLabel="Tenant scope"
                  value={allTenantScope ? "all" : "tenant"}
                  onValueChange={handleScopeChange}
                  options={[
                    { id: "tenant", label: "This tenant" },
                    { id: "all", label: "All tenants" },
                  ]}
                />
              ) : null}
              {!allTenantScope && view === "timeline" ? (
                <TimelineFilters
                  resources={status?.resources ?? []}
                  selectedResource={selectedResource}
                  onResourceChange={handleResourceChange}
                  dateRange={dateRange}
                  onDateRangeChange={handleDateRangeChange}
                  query={query}
                  onQueryChange={setQuery}
                  disabled={loading && !timeline}
                />
              ) : null}
            </>
          }
        />

        {cacheError ? (
          <CompactNotice tone="danger">
            Cache refresh status could not be updated.{" "}
            {userFacingErrorReason(cacheError) ?? "Check the tenant connection, then refresh again."}
          </CompactNotice>
        ) : null}
        {refreshJob?.status === "running" ? (
          <div className="mb-4 flex items-center gap-3 text-sm text-[var(--color-text-muted)]">
            <progress
              className="h-1.5 min-w-32 flex-1 accent-[var(--color-accent)]"
              aria-label="Cache refresh progress"
              max={refreshJob.total || 1}
              value={refreshJob.completed}
            />
            <span className="shrink-0">
              {refreshJob.completed.toLocaleString()} of {refreshJob.total.toLocaleString()}
            </span>
          </div>
        ) : null}

        <div id="changes-panel" role="tabpanel">
          {allTenantScope ? (
            <FleetScope reloadToken={refreshToken} />
          ) : !activeTenant ? (
            <EmptyState
              icon={<IconWarning size={18} />}
              title="No active tenant"
              description="Connect a Microsoft 365 tenant before reviewing tenant changes."
              action={
                <Button
                  variant="primary"
                  onClick={() =>
                    requireTenant(
                      createPendingIntent({
                        kind: "view-changes",
                        returnTo: "/changes",
                      }),
                    )
                  }
                >
                  Connect tenant
                </Button>
              }
            />
          ) : view === "baselines" ? (
            <BaselinesView
              loading={baselineLoading}
              error={baselineError}
              baselines={tenantBaselines}
              activeBaseline={activeBaseline}
              drift={tenantBaselineDrift}
              rollbackSelection={rollbackSelection}
              rollbackAvailable={baselineRollbackAvailable}
              selectedDriftEntry={selectedBaselineDrift}
              onSelectDriftEntry={setSelectedBaselineDrift}
              onToggleRollbackSelection={toggleRollbackSelection}
              onCreate={openCreateBaseline}
              onRename={openRenameBaseline}
              onRetire={() => {
                setRetireBaselineError(null);
                setRetireBaselineOpen(true);
              }}
              onRollback={() => {
                setBaselineRollbackError(null);
                setBaselineRollbackOpen(true);
              }}
              onRetry={() => setBaselineReloadNonce((value) => value + 1)}
            />
          ) : view === "compare" ? (
            <CompareView
              mode={compareMode}
              onModeChange={(mode) => {
                setCompareMode(mode);
                setTimeCompareError(null);
                setTenantCompareError(null);
              }}
              timeFrom={timeCompareFrom}
              timeTo={timeCompareTo}
              timeValidation={timeCompareValidation}
              timeLoading={timeCompareLoading}
              timeError={timeCompareError}
              timeResult={timeCompare}
              selectedTimeEntry={selectedTimeCompareEntry}
              onTimeFromChange={(value) => {
                setTimeCompareFrom(value);
                setTimeCompare(null);
              }}
              onTimeToChange={(value) => {
                setTimeCompareTo(value);
                setTimeCompare(null);
              }}
              onRunTimeCompare={() => void handleTimeCompare()}
              onSelectTimeEntry={setSelectedTimeCompareEntry}
              tenants={otherTenants}
              activeTenant={activeTenant}
              selectedTenant={selectedCompareTenant}
              selectedTenantId={tenantCompareId}
              includeAssignments={includeAssignments}
              tenantLoading={tenantCompareLoading}
              tenantError={tenantCompareError}
              tenantResult={tenantCompare}
              selectedTenantEntry={selectedTenantCompareEntry}
              onTenantChange={(tenantId) => {
                setTenantCompareId(tenantId);
                setTenantCompare(null);
              }}
              onIncludeAssignmentsChange={(include) => {
                setIncludeAssignments(include);
                setTenantCompare(null);
              }}
              onRunTenantCompare={() => void handleTenantCompare()}
              onSelectTenantEntry={setSelectedTenantCompareEntry}
              onOpenTenantSettings={() => navigate("/settings/tenants")}
            />
          ) : error ? (
            <EmptyState
              icon={<IconWarning size={18} />}
              title="Change history unavailable"
              description={error}
              action={
                <Button
                  variant="secondary"
                  onClick={() => setReloadNonce((value) => value + 1)}
                >
                  Try again
                </Button>
              }
            />
          ) : (
            <TimelineView
              loading={loading}
              entries={visibleEntries}
              hasMore={Boolean(timeline?.hasMore)}
              historyTruncated={Boolean(timeline?.historyTruncated)}
              coverageCapped={Boolean(
                status?.resources.some((resource) => resource.pageLimitReached),
              )}
              noBaselineYet={noBaselineYet}
              baselineOnly={baselineOnly}
              baselineDate={baselineDate}
              notice={notice}
              filtersActive={
                selectedResource !== "all" ||
                dateRange !== "all" ||
                query.trim().length > 0
              }
              onSelectEntry={openChangeDrawer}
              onLoadMore={() => setLimit((value) => value + LOAD_MORE_STEP)}
              onClearFilters={() => {
                setSelectedResource("all");
                setDateRange("all");
                setQuery("");
                setLimit(INITIAL_LIMIT);
              }}
              onRefresh={() => void handleRefreshCache()}
            />
          )}
        </div>
      </PageBody>

      <ChangeDetailDrawer
        entry={selectedEntry}
        detail={detail}
        history={history}
        loading={detailLoading}
        error={detailError}
        onClose={() => closeChangeDrawer()}
        onCopy={() => void handleCopy()}
        onPin={() => setPinOpen(true)}
      />
      <PinChangeToWorkspaceModal
        open={pinOpen}
        workspaces={workspaces}
        selectedWorkspaceId={pinWorkspaceId}
        markdown={selectedMarkdown}
        onWorkspaceChange={setPinWorkspaceId}
        onClose={() => setPinOpen(false)}
        onConfirm={() => void handlePin()}
        onOpenWorkspaces={() => navigate("/workspaces")}
      />
      <BaselineNameModal
        mode={baselineNameMode}
        name={baselineName}
        error={baselineNameError}
        busy={baselineNameBusy}
        onNameChange={setBaselineName}
        onClose={closeBaselineNameModal}
        onSubmit={() => void handleBaselineNameSubmit()}
      />
      <RetireBaselineModal
        open={retireBaselineOpen}
        baseline={activeBaseline}
        error={retireBaselineError}
        busy={retireBaselineBusy}
        onClose={() => {
          if (!retireBaselineBusy) setRetireBaselineOpen(false);
        }}
        onConfirm={() => void handleRetireBaseline()}
      />
      <BaselineRollbackModal
        open={baselineRollbackOpen}
        entryCount={
          rollbackSelection.size > 0
            ? rollbackSelection.size
            : tenantBaselineDrift?.entries.length ?? 0
        }
        selectionActive={rollbackSelection.size > 0}
        error={baselineRollbackError}
        busy={baselineRollbackBusy}
        onClose={() => {
          if (!baselineRollbackBusy) setBaselineRollbackOpen(false);
        }}
        onConfirm={() => void handleBaselineRollback()}
      />
    </>
  );
}

type DriftTimelineStatus = {
  tenantId: string;
  resources: DriftResourceStatus[];
};

function TimelineFilters({
  resources,
  selectedResource,
  onResourceChange,
  dateRange,
  onDateRangeChange,
  query,
  onQueryChange,
  disabled,
}: {
  resources: DriftResourceStatus[];
  selectedResource: "all" | GraphCacheResourceKind;
  onResourceChange: (value: string) => void;
  dateRange: DateRangeValue;
  onDateRangeChange: (value: string) => void;
  query: string;
  onQueryChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <>
      <label htmlFor="changes-resource-filter" className="sr-only">
        Resource
      </label>
      <Select
        id="changes-resource-filter"
        name="changes-resource-filter"
        aria-label="Resource"
        value={selectedResource}
        disabled={disabled}
        onChange={(event) => onResourceChange(event.target.value)}
        className="h-7 min-w-44"
      >
        <option value="all">All resources</option>
        {resources.map((resource) => (
          <option key={resource.resource} value={resource.resource}>
            {resource.resourceLabel}
          </option>
        ))}
      </Select>
      <label htmlFor="changes-date-range" className="sr-only">
        Date range
      </label>
      <Select
        id="changes-date-range"
        name="changes-date-range"
        aria-label="Date range"
        value={dateRange}
        disabled={disabled}
        onChange={(event) => onDateRangeChange(event.target.value)}
        className="h-7 min-w-28"
      >
        {DATE_RANGES.map((range) => (
          <option key={range.value} value={range.value}>
            {range.label}
          </option>
        ))}
      </Select>
      <div className="relative min-w-48 flex-1">
        <IconSearch
          size={13}
          aria-hidden="true"
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
        />
        <label htmlFor="changes-display-name-filter" className="sr-only">
          Search changes
        </label>
        <input
          id="changes-display-name-filter"
          name="changes-display-name-filter"
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search changes…"
          autoComplete="off"
          className="h-7 w-full rounded-md bg-[var(--color-surface)] pl-8 pr-2 text-sm text-[var(--color-text)] ring-1 ring-[var(--color-border)] placeholder:text-[var(--color-text-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
        />
      </div>
    </>
  );
}

function TimelineView({
  loading,
  entries,
  hasMore,
  historyTruncated,
  coverageCapped,
  noBaselineYet,
  baselineOnly,
  baselineDate,
  notice,
  filtersActive,
  onSelectEntry,
  onLoadMore,
  onClearFilters,
  onRefresh,
}: {
  loading: boolean;
  entries: DriftTimelineEntry[];
  hasMore: boolean;
  historyTruncated: boolean;
  coverageCapped: boolean;
  noBaselineYet: boolean;
  baselineOnly: boolean;
  baselineDate?: string;
  notice: string | null;
  filtersActive: boolean;
  onSelectEntry: (entry: DriftTimelineEntry) => void;
  onLoadMore: () => void;
  onClearFilters: () => void;
  onRefresh: () => void;
}) {
  const columns = useMemo<DataTableColumn<DriftTimelineEntry>[]>(
    () => [
      {
        id: "day",
        header: "Day",
        sortValue: (entry) => entry.capturedAt,
        sortable: true,
        render: (entry) => formatDay(entry.capturedAt),
      },
      {
        id: "object",
        header: "Object",
        sortValue: displayNameForEntry,
        sortable: true,
        render: (entry) => (
          <div className="min-w-0">
            <div className="truncate font-medium text-[var(--color-text)]">
              {displayNameForEntry(entry)}
            </div>
            {entry.graphId ? (
              <div className="truncate font-mono text-xs text-[var(--color-text-muted)]">
                {entry.graphId}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        id: "resource",
        header: "Resource type",
        accessor: "resourceLabel",
        sortable: true,
      },
      {
        id: "kind",
        header: "Change kind",
        accessor: "changeKind",
        sortable: true,
        render: (entry) => <ChangeKindBadge kind={entry.changeKind} />,
      },
      {
        id: "time",
        header: "Time",
        sortValue: (entry) => entry.capturedAt,
        sortable: true,
        render: (entry) => (
          <time dateTime={entry.capturedAt} title={formatDateTime(entry.capturedAt)}>
            {formatTime(entry.capturedAt)}
          </time>
        ),
      },
      {
        id: "actor",
        header: "Actor or source",
        sortValue: (entry) => attributionSummary(entry.attribution),
        sortable: true,
        render: (entry) => <AttributionCell attribution={entry.attribution} />,
      },
    ],
    [],
  );

  if (noBaselineYet) {
    return (
      <EmptyState
        icon={<IconClock size={18} />}
        title="No change history yet"
        description="Refresh the tenant cache to capture a baseline, then refresh again to detect changes."
        action={
          <Button variant="primary" onClick={onRefresh}>
            Refresh data
          </Button>
        }
      />
    );
  }
  if (baselineOnly) {
    return (
      <EmptyState
        icon={<StatusDot tone="success" size="md" />}
        title="Baseline captured"
        description={`No configuration changes detected${
          baselineDate ? ` since ${formatDateTime(baselineDate)}` : ""
        }.`}
      />
    );
  }

  return (
    <div className="space-y-3">
      {notice ? <CompactNotice tone="success">{notice}</CompactNotice> : null}
      {coverageCapped ? (
        <CompactNotice tone="info">
          At least one collection exceeded the local 1,000-row cache limit. Unseen objects are not inferred as removed.
        </CompactNotice>
      ) : null}
      {historyTruncated ? (
        <CompactNotice tone="info">
          Search covered the newest 5,000 snapshots per resource. Narrow the filters to inspect older retained history.
        </CompactNotice>
      ) : null}
      {loading && entries.length === 0 ? (
        <DataTable
          caption="Tenant change timeline"
          columns={columns}
          rows={[]}
          rowKey={(entry) => entry.id}
          loading
        />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<IconSearch size={18} />}
          title="No changes match these filters"
          description="Widen the date range, choose another resource, or clear the search."
          action={
            filtersActive ? (
              <Button variant="secondary" onClick={onClearFilters}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <DataTable
          caption="Tenant change timeline"
          columns={columns}
          rows={entries}
          rowKey={(entry) => entry.id}
          onRowClick={onSelectEntry}
          initialSort={{ columnId: "time", direction: "descending" }}
        />
      )}
      {hasMore ? (
        <div className="flex items-center justify-between gap-3 text-sm text-[var(--color-text-muted)]">
          <span>More retained changes match this filter.</span>
          <Button size="sm" variant="secondary" onClick={onLoadMore}>
            Load more
          </Button>
        </div>
      ) : entries.length > 0 ? (
        <div className="text-sm text-[var(--color-text-muted)]">
          End of local change history for this filter.
        </div>
      ) : null}
    </div>
  );
}

function ChangeDetailDrawer({
  entry,
  detail,
  history,
  loading,
  error,
  onClose,
  onCopy,
  onPin,
}: {
  entry: DriftTimelineEntry | null;
  detail: DriftEntryDetail | null;
  history: DriftObjectHistoryResult | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onCopy: () => void;
  onPin: () => void;
}) {
  const canUseDetail = entry?.changeKind === "baseline" || Boolean(detail);
  return (
    <Drawer
      open={Boolean(entry)}
      title={entry ? displayNameForEntry(entry) : "Change detail"}
      onClose={onClose}
      actions={
        entry ? (
          <>
            <IconButton
              label="Copy change as Markdown"
              icon={<IconCopy size={14} />}
              disabled={!canUseDetail}
              onClick={onCopy}
            />
            <IconButton
              label="Pin change to workspace"
              icon={<IconHardDrive size={14} />}
              disabled={!canUseDetail}
              onClick={onPin}
            />
          </>
        ) : null
      }
    >
      {entry ? (
        <div className="space-y-6 p-5">
          <dl className="divide-y divide-[var(--color-border-soft)]">
            <KeyValue label="Resource" value={entry.resourceLabel} />
            <KeyValue
              label="Change kind"
              value={<ChangeKindBadge kind={entry.changeKind} />}
            />
            <KeyValue label="Captured" value={formatDateTime(entry.capturedAt)} />
            {entry.graphId ? (
              <KeyValue
                label="Graph object"
                value={<span className="break-all font-mono">{entry.graphId}</span>}
              />
            ) : null}
          </dl>

          {entry.changeKind === "baseline" ? (
            <CompactNotice tone="info">
              {(entry.rowCount ?? 0).toLocaleString()} objects were captured as the local reference point for later drift detection.
            </CompactNotice>
          ) : loading ? (
            <div role="status" className="text-sm text-[var(--color-text-muted)]">
              Loading change detail…
            </div>
          ) : error ? (
            <CompactNotice tone="danger">{error}</CompactNotice>
          ) : detail ? (
            <>
              <AttributionDetails attribution={detail.attribution ?? entry.attribution} />
              {detail.truncated ? (
                <CompactNotice tone="warning">
                  Raw before and after bodies exceeded the local display cap. The field list is complete.
                </CompactNotice>
              ) : null}
              <FieldChangesTable changes={detail.changes} />
              {history && history.versions.length > 1 ? (
                <Section title={`History (${history.versions.length})`}>
                  <ul className="divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)]">
                    {history.versions.map((version) => (
                      <li
                        key={`${version.snapshotId}:${version.version}`}
                        className="grid gap-1 py-2 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center sm:gap-3"
                      >
                        <span className="font-mono text-sm text-[var(--color-text)]">
                          v{version.version}
                        </span>
                        <span className="truncate font-mono text-xs text-[var(--color-text-muted)]">
                          {version.contentHash}
                        </span>
                        <time className="text-sm text-[var(--color-text-muted)]">
                          {formatDateTime(version.capturedAt)}
                        </time>
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}

function AttributionCell({ attribution }: { attribution?: DriftAttribution }) {
  if (attribution?.status === "matched") {
    return (
      <div className="min-w-0">
        <div className="truncate text-[var(--color-text-soft)]">
          {actorLabel(attribution)}
        </div>
        <div className="truncate text-xs text-[var(--color-text-muted)]">
          {sourceLabel(attribution.source)}
        </div>
      </div>
    );
  }
  return (
    <div>
      <div className="text-[var(--color-text-muted)]">Actor unknown</div>
      {attribution?.reason === "audit-cache-stale" ? (
        <div className="text-xs text-[var(--color-text-muted)]">
          Refresh audit data to attribute
        </div>
      ) : null}
    </div>
  );
}

function AttributionDetails({ attribution }: { attribution?: DriftAttribution }) {
  return (
    <Section title="Attribution">
      <dl className="divide-y divide-[var(--color-border-soft)]">
        <KeyValue
          label="Actor"
          value={
            attribution?.status === "matched"
              ? actorLabel(attribution)
              : "Actor unknown"
          }
        />
        <KeyValue
          label="Activity"
          value={attribution?.activity ?? "No audit activity attached"}
        />
        <KeyValue label="Source" value={sourceLabel(attribution?.source)} />
        <KeyValue
          label="When"
          value={
            attribution?.activityDateTime
              ? formatDateTime(attribution.activityDateTime)
              : "No audit timestamp"
          }
        />
      </dl>
      {attribution?.reason === "audit-cache-stale" ? (
        <div className="mt-2 text-sm text-[var(--color-text-muted)]">
          Refresh audit data to attribute this change.
        </div>
      ) : null}
    </Section>
  );
}

function BaselinesView({
  loading,
  error,
  baselines,
  activeBaseline,
  drift,
  rollbackSelection,
  rollbackAvailable,
  selectedDriftEntry,
  onSelectDriftEntry,
  onToggleRollbackSelection,
  onCreate,
  onRename,
  onRetire,
  onRollback,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  baselines: DriftBaseline[];
  activeBaseline?: DriftBaseline;
  drift: DriftBaselineDriftResult | null;
  rollbackSelection: ReadonlySet<string>;
  rollbackAvailable: boolean;
  selectedDriftEntry: DriftBaselineDriftEntry | null;
  onSelectDriftEntry: (entry: DriftBaselineDriftEntry | null) => void;
  onToggleRollbackSelection: (entry: DriftBaselineDriftEntry) => void;
  onCreate: () => void;
  onRename: () => void;
  onRetire: () => void;
  onRollback: () => void;
  onRetry: () => void;
}) {
  const columns = useMemo<DataTableColumn<DriftBaseline>[]>(
    () => [
      {
        id: "name",
        header: "Baseline",
        accessor: "name",
        sortable: true,
        render: (baseline) => (
          <span className="font-medium text-[var(--color-text)]">{baseline.name}</span>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        sortable: true,
        render: (baseline) => (
          <Badge tone={baseline.status === "active" ? "success" : "neutral"}>
            <StatusDot tone={baseline.status === "active" ? "success" : "neutral"} />
            {baseline.status === "active" ? "Active" : "Retired"}
          </Badge>
        ),
      },
      {
        id: "created",
        header: "Created",
        accessor: "createdAt",
        sortable: true,
        render: (baseline) => (
          <div>
            <div>{formatDateTime(baseline.createdAt)}</div>
            {baseline.retiredAt ? (
              <div className="text-xs text-[var(--color-text-muted)]">
                Retired {formatDateTime(baseline.retiredAt)}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        id: "objects",
        header: "Objects",
        accessor: "pinnedObjectCount",
        sortable: true,
        align: "right",
        render: (baseline) => baseline.pinnedObjectCount.toLocaleString(),
      },
      {
        id: "resources",
        header: "Resources",
        sortValue: (baseline) => baseline.resources.length,
        sortable: true,
        align: "right",
        render: (baseline) => baseline.resources.length.toLocaleString(),
      },
      {
        id: "actions",
        header: "Actions",
        align: "right",
        render: (baseline) =>
          baseline.status === "active" ? (
            <Menu
              ariaLabel={`Actions for ${baseline.name}`}
              trigger={
                <IconButton
                  label={`Actions for ${baseline.name}`}
                  icon={<IconChevronDown size={14} />}
                />
              }
              items={[
                { id: "rename", label: "Rename", onSelect: onRename },
                ...(rollbackAvailable && (drift?.entries.length ?? 0) > 0
                  ? [
                      {
                        id: "rollback",
                        label:
                          rollbackSelection.size > 0
                            ? `Roll back ${rollbackSelection.size} selected`
                            : "Roll back drift",
                        onSelect: onRollback,
                      },
                    ]
                  : []),
                { id: "separator", type: "separator" as const },
                {
                  id: "retire",
                  label: "Retire",
                  danger: true,
                  onSelect: onRetire,
                },
              ]}
            />
          ) : (
            <span className="text-[var(--color-text-muted)]">None</span>
          ),
      },
    ],
    [
      drift?.entries.length,
      onRename,
      onRetire,
      onRollback,
      rollbackAvailable,
      rollbackSelection.size,
    ],
  );

  if (error) {
    return (
      <EmptyState
        icon={<IconWarning size={18} />}
        title="Baselines unavailable"
        description={error}
        action={
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      {!activeBaseline ? (
        <EmptyState
          icon={<IconClock size={18} />}
          title="No active baseline"
          description="Create a baseline to pin the tenant's current tracked configuration."
          action={
            <Button variant="primary" onClick={onCreate}>
              Create baseline
            </Button>
          }
        />
      ) : null}

      <Section title="Baselines">
        {loading && baselines.length === 0 ? (
          <DataTable
            caption="Tenant baselines"
            columns={columns}
            rows={[]}
            rowKey={(baseline) => baseline.id}
            loading
          />
        ) : baselines.length > 0 ? (
          <DataTable
            caption="Tenant baselines"
            columns={columns}
            rows={baselines}
            rowKey={(baseline) => baseline.id}
            initialSort={{ columnId: "created", direction: "descending" }}
          />
        ) : null}
      </Section>

      {activeBaseline && drift ? (
        <BaselineDriftSection
          drift={drift}
          selected={rollbackSelection}
          onToggleSelected={onToggleRollbackSelection}
          onSelectEntry={onSelectDriftEntry}
          onRollback={rollbackAvailable ? onRollback : undefined}
        />
      ) : null}

      <ComparisonDiffDrawer
        open={Boolean(selectedDriftEntry)}
        title={
          selectedDriftEntry
            ? selectedDriftEntry.displayName ?? selectedDriftEntry.graphId
            : "Baseline drift"
        }
        entry={selectedDriftEntry}
        onClose={() => onSelectDriftEntry(null)}
      />
    </div>
  );
}

function BaselineDriftSection({
  drift,
  selected,
  onToggleSelected,
  onSelectEntry,
  onRollback,
}: {
  drift: DriftBaselineDriftResult;
  selected: ReadonlySet<string>;
  onToggleSelected: (entry: DriftBaselineDriftEntry) => void;
  onSelectEntry: (entry: DriftBaselineDriftEntry) => void;
  onRollback?: () => void;
}) {
  const summaryColumns = useMemo<DataTableColumn<DriftBaselineResourceDrift>[]>(
    () => [
      {
        id: "resource",
        header: "Resource",
        accessor: "resourceLabel",
        sortable: true,
      },
      { id: "added", header: "Added", accessor: "added", sortable: true, align: "right" },
      { id: "removed", header: "Removed", accessor: "removed", sortable: true, align: "right" },
      { id: "modified", header: "Modified", accessor: "modified", sortable: true, align: "right" },
    ],
    [],
  );
  const entryColumns = useMemo<DataTableColumn<DriftBaselineDriftEntry>[]>(
    () => [
      {
        id: "select",
        header: "Select",
        render: (entry) => (
          <input
            type="checkbox"
            checked={selected.has(baselineDriftEntryKey(entry))}
            onClick={(event) => event.stopPropagation()}
            onChange={() => onToggleSelected(entry)}
            aria-label={`Select ${entry.displayName ?? entry.graphId} for rollback`}
            className="h-4 w-4 accent-[var(--color-accent)]"
          />
        ),
      },
      {
        id: "object",
        header: "Object",
        sortValue: (entry) => entry.displayName ?? entry.graphId,
        sortable: true,
        render: (entry) => (
          <div className="min-w-0">
            <div className="truncate font-medium text-[var(--color-text)]">
              {entry.displayName ?? entry.graphId}
            </div>
            <div className="truncate font-mono text-xs text-[var(--color-text-muted)]">
              {entry.graphId}
            </div>
          </div>
        ),
      },
      {
        id: "resource",
        header: "Resource",
        accessor: "resourceLabel",
        sortable: true,
      },
      {
        id: "kind",
        header: "Change kind",
        accessor: "changeKind",
        sortable: true,
        render: (entry) => <ChangeKindBadge kind={entry.changeKind} />,
      },
      {
        id: "fields",
        header: "Fields",
        accessor: "fieldChangeCount",
        sortable: true,
        align: "right",
      },
    ],
    [onToggleSelected, selected],
  );

  return (
    <div className="space-y-6">
      <Section
        title="Drift by resource"
        action={
          <span className="text-xs text-[var(--color-text-muted)]">
            Evaluated {formatDateTime(drift.evaluatedAt)}
          </span>
        }
      >
        <DataTable
          caption="Baseline drift by resource"
          columns={summaryColumns}
          rows={drift.resources}
          rowKey={(resource) => resource.resource}
        />
      </Section>
      <Section
        title="Drift entries"
        action={
          onRollback && drift.entries.length > 0 ? (
            <Button variant="secondary" onClick={onRollback}>
              {selected.size > 0
                ? `Roll back ${selected.size} selected`
                : "Roll back drift"}
            </Button>
          ) : null
        }
      >
        {drift.entries.length === 0 ? (
          <EmptyState
            icon={<StatusDot tone="success" size="md" />}
            title="No baseline drift"
            description="The latest tracked configuration matches this baseline."
          />
        ) : (
          <DataTable
            caption="Baseline drift entries"
            columns={entryColumns}
            rows={drift.entries}
            rowKey={baselineDriftEntryKey}
            onRowClick={onSelectEntry}
          />
        )}
        {drift.hasMore ? (
          <div className="mt-3 text-sm text-[var(--color-text-muted)]">
            This evaluation contains more entries than the local display limit.
          </div>
        ) : null}
      </Section>
    </div>
  );
}

function CompareView({
  mode,
  onModeChange,
  timeFrom,
  timeTo,
  timeValidation,
  timeLoading,
  timeError,
  timeResult,
  selectedTimeEntry,
  onTimeFromChange,
  onTimeToChange,
  onRunTimeCompare,
  onSelectTimeEntry,
  tenants,
  activeTenant,
  selectedTenant,
  selectedTenantId,
  includeAssignments,
  tenantLoading,
  tenantError,
  tenantResult,
  selectedTenantEntry,
  onTenantChange,
  onIncludeAssignmentsChange,
  onRunTenantCompare,
  onSelectTenantEntry,
  onOpenTenantSettings,
}: {
  mode: CompareMode;
  onModeChange: (mode: CompareMode) => void;
  timeFrom: string;
  timeTo: string;
  timeValidation: string | null;
  timeLoading: boolean;
  timeError: string | null;
  timeResult: DriftTimeCompareResult | null;
  selectedTimeEntry: DriftBaselineDriftEntry | null;
  onTimeFromChange: (value: string) => void;
  onTimeToChange: (value: string) => void;
  onRunTimeCompare: () => void;
  onSelectTimeEntry: (entry: DriftBaselineDriftEntry | null) => void;
  tenants: Array<{ id: string; displayName: string }>;
  activeTenant: { id: string; displayName: string };
  selectedTenant?: { id: string; displayName: string };
  selectedTenantId: string;
  includeAssignments: boolean;
  tenantLoading: boolean;
  tenantError: string | null;
  tenantResult: DriftTenantCompareResult | null;
  selectedTenantEntry: DriftTenantCompareEntry | null;
  onTenantChange: (tenantId: string) => void;
  onIncludeAssignmentsChange: (include: boolean) => void;
  onRunTenantCompare: () => void;
  onSelectTenantEntry: (entry: DriftTenantCompareEntry | null) => void;
  onOpenTenantSettings: () => void;
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3 border-b border-[var(--color-border-soft)] pb-4">
        <SegmentedControl
          ariaLabel="Comparison mode"
          value={mode}
          onValueChange={(value) => onModeChange(value as CompareMode)}
          options={[
            { id: "time", label: "Over time" },
            { id: "tenant", label: "Between tenants" },
          ]}
        />
        {mode === "time" ? (
          <>
            <CompareDateField
              id="compare-from-date"
              label="From"
              value={timeFrom}
              disabled={timeLoading}
              invalid={Boolean(timeValidation)}
              onChange={onTimeFromChange}
            />
            <CompareDateField
              id="compare-to-date"
              label="To"
              value={timeTo}
              disabled={timeLoading}
              invalid={Boolean(timeValidation)}
              onChange={onTimeToChange}
            />
            <Button
              variant="primary"
              disabled={timeLoading || Boolean(timeValidation)}
              onClick={onRunTimeCompare}
            >
              {timeLoading ? "Comparing…" : "Run compare"}
            </Button>
          </>
        ) : tenants.length > 0 ? (
          <>
            <div className="min-w-44">
              <div className="text-xs text-[var(--color-text-muted)]">Tenant A</div>
              <div className="mt-1 h-9 rounded-md bg-[var(--color-surface)] px-3 py-2 text-base text-[var(--color-text)] ring-1 ring-[var(--color-border)]">
                {activeTenant.displayName}
              </div>
            </div>
            <label htmlFor="compare-tenant-b" className="min-w-44">
              <span className="text-xs text-[var(--color-text-muted)]">Tenant B</span>
              <Select
                id="compare-tenant-b"
                name="compare-tenant-b"
                aria-label="Tenant B"
                value={selectedTenantId}
                disabled={tenantLoading}
                onChange={(event) => onTenantChange(event.target.value)}
                className="mt-1 h-9 w-full"
              >
                {tenants.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>
                    {tenant.displayName}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex h-9 items-center gap-2 text-sm text-[var(--color-text-soft)]">
              <input
                type="checkbox"
                name="include-assignments"
                checked={includeAssignments}
                disabled={tenantLoading}
                onChange={(event) =>
                  onIncludeAssignmentsChange(event.target.checked)
                }
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              Include assignments
            </label>
            <Button
              variant="primary"
              disabled={tenantLoading || !selectedTenantId}
              onClick={onRunTenantCompare}
            >
              {tenantLoading ? "Comparing…" : "Run compare"}
            </Button>
          </>
        ) : null}
      </div>

      {timeValidation && mode === "time" ? (
        <CompactNotice tone="danger">{timeValidation}</CompactNotice>
      ) : null}

      {mode === "time" ? (
        <TimeCompareResults
          loading={timeLoading}
          error={timeError}
          result={timeResult}
          selectedEntry={selectedTimeEntry}
          onSelectEntry={onSelectTimeEntry}
          onRetry={onRunTimeCompare}
        />
      ) : tenants.length === 0 ? (
        <EmptyState
          icon={<IconChanges size={18} />}
          title="Connect a second tenant"
          description="Between-tenant comparison requires two connected Microsoft 365 tenants."
          action={
            <Button variant="secondary" onClick={onOpenTenantSettings}>
              Open tenant settings
            </Button>
          }
        />
      ) : (
        <TenantCompareResults
          loading={tenantLoading}
          error={tenantError}
          result={tenantResult}
          tenantA={activeTenant}
          tenantB={selectedTenant}
          selectedEntry={selectedTenantEntry}
          onSelectEntry={onSelectTenantEntry}
          onRetry={onRunTenantCompare}
        />
      )}
    </div>
  );
}

function CompareDateField({
  id,
  label,
  value,
  disabled,
  invalid,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label htmlFor={id} className="block">
      <span className="text-xs text-[var(--color-text-muted)]">{label}</span>
      <input
        id={id}
        name={id}
        type="date"
        value={value}
        disabled={disabled}
        aria-invalid={invalid}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 h-9 rounded-md bg-[var(--color-surface)] px-3 text-base text-[var(--color-text)] ring-1 ring-[var(--color-border)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-50"
      />
    </label>
  );
}

function TimeCompareResults({
  loading,
  error,
  result,
  selectedEntry,
  onSelectEntry,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  result: DriftTimeCompareResult | null;
  selectedEntry: DriftBaselineDriftEntry | null;
  onSelectEntry: (entry: DriftBaselineDriftEntry | null) => void;
  onRetry: () => void;
}) {
  if (loading) return <ComparisonLoading />;
  if (error) {
    return (
      <EmptyState
        icon={<IconWarning size={18} />}
        title="Time comparison unavailable"
        description={error}
        action={
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    );
  }
  if (!result) return null;

  return (
    <div className="space-y-6">
      {result.retentionLimited ? (
        <CompactNotice tone="info">
          Retention pruned part of this window, so the earlier side may be incomplete.
        </CompactNotice>
      ) : null}
      <ResourceDriftTable resources={result.resources} caption="Changes by resource" />
      <DriftEntriesTable
        entries={result.entries}
        caption="Objects changed over time"
        onSelectEntry={onSelectEntry}
      />
      {result.entries.length === 0 ? (
        <EmptyState
          icon={<StatusDot tone="success" size="md" />}
          title="No changes in this window"
          description="Tracked configuration was unchanged between the selected dates."
        />
      ) : null}
      {result.hasMore ? (
        <div className="text-sm text-[var(--color-text-muted)]">
          More comparison entries exist than the local display limit.
        </div>
      ) : null}
      <ComparisonDiffDrawer
        open={Boolean(selectedEntry)}
        title={selectedEntry?.displayName ?? selectedEntry?.graphId ?? "Changed object"}
        entry={selectedEntry}
        onClose={() => onSelectEntry(null)}
      />
    </div>
  );
}

function TenantCompareResults({
  loading,
  error,
  result,
  tenantA,
  tenantB,
  selectedEntry,
  onSelectEntry,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  result: DriftTenantCompareResult | null;
  tenantA: { displayName: string };
  tenantB?: { displayName: string };
  selectedEntry: DriftTenantCompareEntry | null;
  onSelectEntry: (entry: DriftTenantCompareEntry | null) => void;
  onRetry: () => void;
}) {
  if (loading) return <ComparisonLoading />;
  if (error) {
    return (
      <EmptyState
        icon={<IconWarning size={18} />}
        title="Tenant comparison unavailable"
        description={error}
        action={
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    );
  }
  if (!result || !tenantB) return null;
  if (!result.tenantAHasData || !result.tenantBHasData) {
    const missing = [
      ...(!result.tenantAHasData ? [tenantA.displayName] : []),
      ...(!result.tenantBHasData ? [tenantB.displayName] : []),
    ];
    return (
      <EmptyState
        icon={<IconRefresh size={18} />}
        title="Captured configuration is missing"
        description={`Refresh tenant data for ${missing.join(" and ")}, then run the comparison again.`}
        action={
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <TenantResourceTable resources={result.resources} />
      <TenantDifferenceTable
        entries={result.entries}
        onSelectEntry={onSelectEntry}
      />
      {result.entries.length === 0 ? (
        <EmptyState
          icon={<StatusDot tone="success" size="md" />}
          title="No configuration differences"
          description={`${tenantA.displayName} and ${tenantB.displayName} match across the tracked resources.`}
        />
      ) : null}
      {result.hasMore ? (
        <div className="text-sm text-[var(--color-text-muted)]">
          More comparison entries exist than the local display limit.
        </div>
      ) : null}
      <ComparisonDiffDrawer
        open={Boolean(selectedEntry)}
        title={selectedEntry?.displayName ?? "Configuration difference"}
        entry={selectedEntry}
        onClose={() => onSelectEntry(null)}
      />
    </div>
  );
}

function ResourceDriftTable({
  resources,
  caption,
}: {
  resources: DriftBaselineResourceDrift[];
  caption: string;
}) {
  const columns = useMemo<DataTableColumn<DriftBaselineResourceDrift>[]>(
    () => [
      { id: "resource", header: "Resource", accessor: "resourceLabel", sortable: true },
      { id: "added", header: "Added", accessor: "added", sortable: true, align: "right" },
      { id: "removed", header: "Removed", accessor: "removed", sortable: true, align: "right" },
      { id: "modified", header: "Modified", accessor: "modified", sortable: true, align: "right" },
    ],
    [],
  );
  const changed = resources.filter(
    (resource) => resource.added + resource.removed + resource.modified > 0,
  );
  if (changed.length === 0) return null;
  return (
    <Section title={caption}>
      <DataTable
        caption={caption}
        columns={columns}
        rows={changed}
        rowKey={(resource) => resource.resource}
      />
    </Section>
  );
}

function DriftEntriesTable({
  entries,
  caption,
  onSelectEntry,
}: {
  entries: DriftBaselineDriftEntry[];
  caption: string;
  onSelectEntry: (entry: DriftBaselineDriftEntry) => void;
}) {
  const columns = useMemo<DataTableColumn<DriftBaselineDriftEntry>[]>(
    () => [
      {
        id: "object",
        header: "Object",
        sortValue: (entry) => entry.displayName ?? entry.graphId,
        sortable: true,
        render: (entry) => (
          <div className="min-w-0">
            <div className="truncate font-medium text-[var(--color-text)]">
              {entry.displayName ?? entry.graphId}
            </div>
            <div className="truncate font-mono text-xs text-[var(--color-text-muted)]">
              {entry.graphId}
            </div>
          </div>
        ),
      },
      { id: "resource", header: "Resource", accessor: "resourceLabel", sortable: true },
      {
        id: "kind",
        header: "Change kind",
        accessor: "changeKind",
        sortable: true,
        render: (entry) => <ChangeKindBadge kind={entry.changeKind} />,
      },
      {
        id: "fields",
        header: "Fields",
        accessor: "fieldChangeCount",
        sortable: true,
        align: "right",
      },
    ],
    [],
  );
  if (entries.length === 0) return null;
  return (
    <Section title="Changed objects">
      <DataTable
        caption={caption}
        columns={columns}
        rows={entries}
        rowKey={baselineDriftEntryKey}
        onRowClick={onSelectEntry}
      />
    </Section>
  );
}

function TenantResourceTable({
  resources,
}: {
  resources: DriftTenantCompareResourceCounts[];
}) {
  const columns = useMemo<DataTableColumn<DriftTenantCompareResourceCounts>[]>(
    () => [
      { id: "resource", header: "Resource", accessor: "resourceLabel", sortable: true },
      { id: "same", header: "Same", accessor: "matchedSame", sortable: true, align: "right" },
      { id: "different", header: "Different", accessor: "different", sortable: true, align: "right" },
      { id: "onlyA", header: "Only in A", accessor: "onlyInA", sortable: true, align: "right" },
      { id: "onlyB", header: "Only in B", accessor: "onlyInB", sortable: true, align: "right" },
      { id: "ambiguous", header: "Ambiguous", accessor: "ambiguous", sortable: true, align: "right" },
    ],
    [],
  );
  const visible = resources.filter(
    (resource) =>
      resource.matchedSame +
        resource.different +
        resource.onlyInA +
        resource.onlyInB +
        resource.ambiguous >
      0,
  );
  if (visible.length === 0) return null;
  return (
    <Section title="Comparison by resource">
      <DataTable
        caption="Tenant comparison by resource"
        columns={columns}
        rows={visible}
        rowKey={(resource) => resource.resource}
      />
      {visible.some((resource) => resource.ambiguous > 0) ? (
        <div className="mt-3 text-sm text-[var(--color-text-muted)]">
          Objects with duplicate display names are marked ambiguous and are not matched.
        </div>
      ) : null}
    </Section>
  );
}

function TenantDifferenceTable({
  entries,
  onSelectEntry,
}: {
  entries: DriftTenantCompareEntry[];
  onSelectEntry: (entry: DriftTenantCompareEntry) => void;
}) {
  const columns = useMemo<DataTableColumn<DriftTenantCompareEntry>[]>(
    () => [
      {
        id: "object",
        header: "Object",
        accessor: "displayName",
        sortable: true,
        render: (entry) => (
          <span className="font-medium text-[var(--color-text)]">{entry.displayName}</span>
        ),
      },
      { id: "resource", header: "Resource", accessor: "resourceLabel", sortable: true },
      {
        id: "kind",
        header: "Change kind",
        accessor: "bucket",
        sortable: true,
        render: (entry) => <TenantDifferenceBadge bucket={entry.bucket} />,
      },
      {
        id: "fields",
        header: "Fields",
        accessor: "fieldChangeCount",
        sortable: true,
        align: "right",
      },
    ],
    [],
  );
  if (entries.length === 0) return null;
  return (
    <Section title="Configuration differences">
      <DataTable
        caption="Tenant configuration differences"
        columns={columns}
        rows={entries}
        rowKey={(entry) => `${entry.resource}:${entry.displayName}:${entry.bucket}`}
        onRowClick={onSelectEntry}
      />
    </Section>
  );
}

function ComparisonDiffDrawer({
  open,
  title,
  entry,
  onClose,
}: {
  open: boolean;
  title: string;
  entry:
    | DriftBaselineDriftEntry
    | DriftTenantCompareEntry
    | null;
  onClose: () => void;
}) {
  return (
    <Drawer open={open} title={title} onClose={onClose}>
      {entry ? (
        <div className="space-y-5 p-5">
          <dl className="divide-y divide-[var(--color-border-soft)]">
            <KeyValue label="Resource" value={entry.resourceLabel} />
            <KeyValue
              label="Change kind"
              value={
                "bucket" in entry ? (
                  <TenantDifferenceBadge bucket={entry.bucket} />
                ) : (
                  <ChangeKindBadge kind={entry.changeKind} />
                )
              }
            />
            <KeyValue
              label="Fields changed"
              value={entry.fieldChangeCount.toLocaleString()}
            />
          </dl>
          {entry.truncated ? (
            <CompactNotice tone="warning">
              Raw before and after bodies exceeded the local display cap. The field list is complete.
            </CompactNotice>
          ) : null}
          <FieldChangesTable changes={entry.changes} />
        </div>
      ) : null}
    </Drawer>
  );
}

function ComparisonLoading() {
  return (
    <DataTable
      caption="Loading comparison results"
      columns={[
        { id: "object", header: "Object" },
        { id: "resource", header: "Resource" },
        { id: "kind", header: "Change kind" },
      ]}
      rows={[] as Array<Record<string, never>>}
      rowKey={(_, index?: never) => String(index ?? "loading")}
      loading
    />
  );
}

function FieldChangesTable({ changes }: { changes: DriftFieldChange[] }) {
  const columns = useMemo<DataTableColumn<DriftFieldChange>[]>(
    () => [
      {
        id: "path",
        header: "Path",
        accessor: "path",
        render: (change) => (
          <span className="break-all font-mono text-[var(--color-info)]">
            {change.path}
          </span>
        ),
      },
      {
        id: "before",
        header: "Before",
        render: (change) => <LongValue value={change.before} />,
      },
      {
        id: "after",
        header: "After",
        render: (change) => <LongValue value={change.after} />,
      },
    ],
    [],
  );
  return (
    <Section title="Field changes">
      {changes.length === 0 ? (
        <EmptyState
          icon={<IconChanges size={18} />}
          title="No field changes"
          description="This comparison did not record field-level differences for the object."
          className="py-8"
        />
      ) : (
        <DataTable
          caption="Field-level changes"
          columns={columns}
          rows={changes}
          rowKey={(change) => `${change.path}:${change.kind}`}
        />
      )}
    </Section>
  );
}

function LongValue({ value }: { value: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const text = valueToText(value);
  const long = text.length > 180 || text.includes("\n");
  return (
    <div className="min-w-40">
      <pre className="whitespace-pre-wrap break-words font-mono text-xs text-[var(--color-text-soft)]">
        {long && !expanded ? `${text.slice(0, 180)}…` : text}
      </pre>
      {long ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 text-xs font-medium text-[var(--color-info)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      ) : null}
    </div>
  );
}

function ChangeKindBadge({ kind }: { kind: DriftTimelineChangeKind }) {
  const config = changeKindConfig(kind);
  return (
    <Badge tone={config.tone}>
      <StatusDot tone={config.tone} />
      {config.label}
    </Badge>
  );
}

function TenantDifferenceBadge({
  bucket,
}: {
  bucket: DriftTenantCompareEntry["bucket"];
}) {
  if (bucket === "different") return <Badge tone="warning">Modified</Badge>;
  if (bucket === "only-in-b") return <Badge tone="info">Only in B</Badge>;
  return <Badge tone="neutral">Only in A</Badge>;
}

function CompactNotice({
  tone,
  children,
}: {
  tone: "success" | "warning" | "danger" | "info";
  children: ReactNode;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`mb-3 flex items-start gap-2 rounded-md px-3 py-2 text-sm ring-1 ${
        tone === "danger"
          ? "bg-[var(--color-danger-soft)] text-[var(--color-danger)] ring-[var(--color-danger)]/25"
          : tone === "warning"
            ? "bg-[var(--color-warning-soft)] text-[var(--color-warning)] ring-[var(--color-warning)]/25"
            : tone === "success"
              ? "bg-[var(--color-success-soft)] text-[var(--color-success)] ring-[var(--color-success)]/25"
              : "bg-[var(--color-bg-raised)] text-[var(--color-text-soft)] ring-[var(--color-border)]"
      }`}
    >
      <StatusDot tone={tone} className="mt-1.5" />
      <span>{children}</span>
    </div>
  );
}

function BaselineNameModal({
  mode,
  name,
  error,
  busy,
  onNameChange,
  onClose,
  onSubmit,
}: {
  mode: BaselineNameMode | null;
  name: string;
  error: string | null;
  busy: boolean;
  onNameChange: (name: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const creating = mode === "create";
  return (
    <Modal open={mode !== null} onClose={onClose} size="md">
      <ModalHeader
        title={creating ? "Create baseline" : "Rename baseline"}
        subtitle={
          creating
            ? "Pins the tenant's current tracked configuration versions"
            : "Changes the local baseline label"
        }
        onClose={onClose}
      />
      <form
        className="space-y-4 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label htmlFor="baseline-name" className="block text-sm text-[var(--color-text-muted)]">
          Baseline name
        </label>
        <input
          id="baseline-name"
          name="baseline-name"
          type="text"
          data-autofocus
          autoComplete="off"
          maxLength={80}
          value={name}
          aria-invalid={Boolean(error)}
          disabled={busy}
          onChange={(event) => onNameChange(event.target.value)}
          className="h-9 w-full rounded-md bg-[var(--color-surface)] px-3 text-base text-[var(--color-text)] ring-1 ring-[var(--color-border)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-50"
        />
        <div className="text-xs text-[var(--color-text-muted)]">
          Use 1 to 80 characters. Leading and trailing spaces are removed.
        </div>
        {error ? (
          <CompactNotice tone="danger">
            {error}
            {isRefreshCacheRequired(error)
              ? " Refresh tenant data, then try again."
              : ""}
          </CompactNotice>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy
              ? creating
                ? "Creating…"
                : "Renaming…"
              : creating
                ? "Create baseline"
                : "Rename baseline"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RetireBaselineModal({
  open,
  baseline,
  error,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  baseline?: DriftBaseline;
  error: string | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} size="md">
      <ModalHeader title="Retire baseline" subtitle={baseline?.name} onClose={onClose} />
      <div className="space-y-4 p-6">
        <p className="text-base text-[var(--color-text-soft)]">
          Retiring keeps history but stops drift evaluation and pruning protection.
        </p>
        {error ? <CompactNotice tone="danger">{error}</CompactNotice> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy || !baseline} onClick={onConfirm}>
            {busy ? "Retiring…" : "Retire baseline"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function BaselineRollbackModal({
  open,
  entryCount,
  selectionActive,
  error,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  entryCount: number;
  selectionActive: boolean;
  error: string | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} size="md">
      <ModalHeader title="Roll back baseline drift" subtitle="Pre-flight review" onClose={onClose} />
      <div className="space-y-4 p-6">
        <p className="text-base text-[var(--color-text-soft)]">
          This builds a rollback plan for {selectionActive ? "the selected entries" : "all drifted objects"}. Nothing is applied until you review the plan and type the confirmation phrase on the run page.
        </p>
        <div className="text-sm text-[var(--color-text-muted)]">
          {entryCount.toLocaleString()} drifted {entryCount === 1 ? "entry" : "entries"} included.
        </div>
        {error ? <CompactNotice tone="danger">{error}</CompactNotice> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            data-autofocus
            variant="primary"
            disabled={busy || entryCount === 0}
            onClick={onConfirm}
          >
            {busy ? "Building rollback plan…" : "Build rollback plan"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function PinChangeToWorkspaceModal({
  open,
  workspaces,
  selectedWorkspaceId,
  markdown,
  onWorkspaceChange,
  onClose,
  onConfirm,
  onOpenWorkspaces,
}: {
  open: boolean;
  workspaces: WorkspaceSummary[];
  selectedWorkspaceId: string;
  markdown: string;
  onWorkspaceChange: (workspaceId: string) => void;
  onClose: () => void;
  onConfirm: () => void;
  onOpenWorkspaces: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} size="md">
      <ModalHeader title="Pin change to workspace" onClose={onClose} />
      <div className="space-y-4 p-6">
        {workspaces.length === 0 ? (
          <p className="text-base text-[var(--color-text-soft)]">
            No active workspace exists for this tenant.
          </p>
        ) : (
          <label htmlFor="pin-change-workspace" className="block text-sm text-[var(--color-text-muted)]">
            Workspace
            <Select
              id="pin-change-workspace"
              name="pin-change-workspace"
              value={selectedWorkspaceId}
              onChange={(event) => onWorkspaceChange(event.target.value)}
              className="mt-1 h-9 w-full"
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.title}
                </option>
              ))}
            </Select>
          </label>
        )}
        <pre className="max-h-44 overflow-y-auto whitespace-pre-wrap rounded-md bg-[var(--color-bg)] p-3 font-mono text-xs text-[var(--color-text-muted)] ring-1 ring-[var(--color-border)]">
          {markdown.slice(0, 900)}
          {markdown.length > 900 ? "\n…" : ""}
        </pre>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {workspaces.length === 0 ? (
            <Button variant="secondary" onClick={onOpenWorkspaces}>
              Open Workspaces
            </Button>
          ) : (
            <Button variant="primary" disabled={!selectedWorkspaceId} onClick={onConfirm}>
              Pin change
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function dateRangeBounds(value: DateRangeValue): { from?: string; to?: string } {
  const range = DATE_RANGES.find((entry) => entry.value === value);
  if (!range?.ms) return {};
  const to = new Date();
  return {
    from: new Date(to.getTime() - range.ms).toISOString(),
    to: to.toISOString(),
  };
}

function defaultCompareDateValue(dayOffset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function compareDateValidation(from: string, to: string): string | null {
  if (!from || !to) return "Choose both dates.";
  if (from >= to) return "From date must be earlier than the to date.";
  return null;
}

function compareDateToIso(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString();
}

function latestBaselineDate(
  resources: DriftResourceStatus[],
  entries: DriftTimelineEntry[],
): string | undefined {
  const dates = [
    ...resources
      .map((resource) => resource.baselineCapturedAt)
      .filter((value): value is string => Boolean(value)),
    ...entries
      .filter((entry) => entry.changeKind === "baseline")
      .map((entry) => entry.capturedAt),
  ];
  return dates.sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function changeKindConfig(kind: DriftTimelineChangeKind): {
  label: string;
  tone: BadgeTone;
} {
  if (kind === "added") return { label: "Added", tone: "success" };
  if (kind === "removed") return { label: "Removed", tone: "danger" };
  if (kind === "modified") return { label: "Modified", tone: "info" };
  return { label: "Baseline", tone: "neutral" };
}

function displayNameForEntry(entry: DriftTimelineEntry): string {
  return entry.displayName ?? entry.graphId ?? entry.resourceLabel;
}

function attributionSummary(attribution?: DriftAttribution): string {
  if (attribution?.status === "matched") return actorLabel(attribution);
  return "Actor unknown";
}

function actorLabel(attribution: DriftAttribution): string {
  return (
    attribution.actor?.userPrincipalName ??
    attribution.actor?.appDisplayName ??
    attribution.actor?.actorType ??
    "Actor recorded"
  );
}

function sourceLabel(source?: DriftAttribution["source"]): string {
  if (source === "intuneAudit") return "Intune audit";
  if (source === "directoryAudit") return "Directory audit";
  return "No audit source";
}

function baselineDriftEntryKey(entry: DriftBaselineDriftEntry): string {
  return `${entry.resource}:${entry.graphId}:${entry.changeKind}`;
}

function isNoActiveBaselineError(caught: unknown): boolean {
  const message = caught instanceof Error ? caught.message : String(caught);
  return message.toLowerCase().includes("no active baseline");
}

function isRefreshCacheRequired(message: string): boolean {
  return message.toLowerCase().includes("refresh the tenant cache first");
}

function valueToText(value: unknown): string {
  if (value === undefined || value === null || value === "") return "Not set";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2) ?? "Not set";
  } catch {
    return String(value);
  }
}

function buildChangeMarkdown(
  entry: DriftTimelineEntry,
  detail: DriftEntryDetail | null,
  history: DriftObjectHistoryResult | null,
): string {
  const lines = [
    `# ${changeKindConfig(entry.changeKind).label}: ${displayNameForEntry(entry)}`,
    "",
    `- Resource: ${entry.resourceLabel}`,
    `- Captured: ${formatDateTime(entry.capturedAt)}`,
    `- Snapshot: \`${entry.snapshotId}\``,
  ];
  if (entry.graphId) lines.push(`- Graph object: \`${entry.graphId}\``);
  if (entry.changeKind === "baseline") {
    lines.push(
      `- Baseline objects tracked: ${(entry.rowCount ?? 0).toLocaleString()}`,
      "",
      "Baseline captured. This is not presented as a list of additions.",
    );
    return `${lines.join("\n")}\n`;
  }

  const attribution = detail?.attribution ?? entry.attribution;
  lines.push(
    `- Attribution: ${
      attribution?.status === "matched" ? actorLabel(attribution) : "Actor unknown"
    }`,
  );
  if (attribution?.activity) lines.push(`- Activity: ${attribution.activity}`);
  if (attribution?.source) lines.push(`- Source: ${sourceLabel(attribution.source)}`);
  lines.push("", "## Field changes", "");
  if (!detail || detail.changes.length === 0) {
    lines.push("_No field-level changes loaded._");
  } else {
    lines.push("| Path | Before | After |", "| --- | --- | --- |");
    for (const change of detail.changes) {
      lines.push(
        `| \`${escapeMarkdownTable(change.path)}\` | ${escapeMarkdownTable(
          inlineMarkdownValue(change.before),
        )} | ${escapeMarkdownTable(inlineMarkdownValue(change.after))} |`,
      );
    }
  }
  if (history && history.versions.length > 1) {
    lines.push("", `## History (${history.versions.length} versions)`, "");
    for (const version of history.versions) {
      lines.push(
        `- v${version.version} · ${formatDateTime(version.capturedAt)} · \`${version.contentHash}\``,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function inlineMarkdownValue(value: unknown): string {
  const text = valueToText(value).replace(/\s+/g, " ").trim();
  if (text === "Not set") return "Not set";
  return `\`${text.length > 160 ? `${text.slice(0, 157)}…` : text}\``;
}

function escapeMarkdownTable(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatDay(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatShortDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRelativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return formatDateTime(value);
  const difference = Math.max(0, Date.now() - timestamp);
  if (difference < 60_000) return "just now";
  if (difference < 60 * 60_000) {
    const minutes = Math.floor(difference / 60_000);
    return `${minutes} min ago`;
  }
  if (difference < 24 * 60 * 60_000) {
    return `${Math.floor(difference / (60 * 60_000))} hr ago`;
  }
  return `${Math.floor(difference / (24 * 60 * 60_000))} d ago`;
}
