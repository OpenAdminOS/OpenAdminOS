import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { PageBody, PageHeader } from "../components/AppShell";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Modal, ModalHeader } from "../components/Modal";
import { OutputPane, OutputPaneSection } from "../components/OutputPane";
import { Pill, StatusDot } from "../components/Pill";
import {
  IconChanges,
  IconChevronDown,
  IconClock,
  IconClose,
  IconCopy,
  IconHardDrive,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconWarning,
} from "../components/icons";
import { copyTextToClipboard } from "../shared/clipboard";
import type {
  DriftAttribution,
  DriftBaseline,
  DriftBaselineDriftEntry,
  DriftBaselineDriftResult,
  DriftEntryDetail,
  DriftFieldChange,
  DriftObjectHistoryResult,
  DriftResourceStatus,
  DriftTenantCompareEntry,
  DriftTenantCompareResult,
  DriftTimeCompareResult,
  DriftTimelineChangeKind,
  DriftTimelineEntry,
  DriftTimelineResult,
  GraphCacheResourceKind,
  WorkspaceSummary,
} from "../shared/openAdminOS";
import { useAppState } from "../state";
import { createPendingIntent } from "../setup/pending-intent";
import { useSetupFlow } from "../setup/SetupFlowContext";

type DateRangeValue = "24h" | "7d" | "30d" | "all";
type ChangesSegment = "timeline" | "baselines" | "compare";
type CompareMode = "time" | "tenant";
type BaselineNameMode = "create" | "rename";

const DATE_RANGES: {
  value: DateRangeValue;
  label: string;
  ms?: number;
}[] = [
  { value: "24h", label: "Last 24h", ms: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "Last 7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", label: "Last 30d", ms: 30 * 24 * 60 * 60 * 1000 },
  { value: "all", label: "All" },
];

const INITIAL_LIMIT = 100;
const LOAD_MORE_STEP = 100;
const focusRingClass =
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]";

export default function Changes() {
  const navigate = useNavigate();
  const { requireTenant } = useSetupFlow();
  const { state } = useAppState();
  const activeTenant = state.activeTenantId
    ? state.tenants.find((tenant) => tenant.id === state.activeTenantId)
    : state.tenants[0];
  const baselinesAvailable = Boolean(window.openAdminOS?.listDriftBaselines);
  const compareAvailable = Boolean(window.openAdminOS?.getDriftTimeCompare);
  const baselineRollbackAvailable = Boolean(
    window.openAdminOS?.startBaselineRollback,
  );
  const otherTenants = useMemo(
    () => state.tenants.filter((tenant) => tenant.id !== activeTenant?.id),
    [activeTenant?.id, state.tenants],
  );
  const [segment, setSegment] = useState<ChangesSegment>("timeline");
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
  const [baselineLoadAnnouncement, setBaselineLoadAnnouncement] = useState("");
  const [baselineError, setBaselineError] = useState<string | null>(null);
  const [baselineNoActive, setBaselineNoActive] = useState(false);
  const [baselineReloadNonce, setBaselineReloadNonce] = useState(0);
  const [expandedBaselineEntry, setExpandedBaselineEntry] = useState<
    string | null
  >(null);
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
  const timeCompareRequestId = useRef(0);
  const [expandedTimeCompareEntry, setExpandedTimeCompareEntry] = useState<
    string | null
  >(null);
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
  const [tenantCompareReloadNonce, setTenantCompareReloadNonce] = useState(0);
  const [expandedTenantCompareEntry, setExpandedTenantCompareEntry] = useState<
    string | null
  >(null);

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
    if (
      (segment === "baselines" && !baselinesAvailable) ||
      (segment === "compare" && !compareAvailable)
    ) {
      setSegment("timeline");
    }
  }, [baselinesAvailable, compareAvailable, segment]);

  useEffect(() => {
    timeCompareRequestId.current += 1;
    setTimeCompare(null);
    setTimeCompareError(null);
    setTimeCompareLoading(false);
    setExpandedTimeCompareEntry(null);
    setTenantCompare(null);
    setTenantCompareError(null);
    setExpandedTenantCompareEntry(null);
  }, [activeTenant?.id]);

  useEffect(() => {
    setTenantCompareId((current) =>
      current && otherTenants.some((tenant) => tenant.id === current)
        ? current
        : (otherTenants[0]?.id ?? ""),
    );
  }, [otherTenants]);

  useEffect(() => {
    const api = window.openAdminOS;
    if (segment !== "timeline") {
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
        "Change history is unavailable in this build. The desktop bridge does not expose the drift timeline methods.",
      );
      setStatus(null);
      setTimeline(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setLoadAnnouncement("Loading change history.");

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
    dateRange,
    debouncedQuery,
    limit,
    reloadNonce,
    segment,
    selectedResource,
  ]);

  useEffect(() => {
    const api = window.openAdminOS;
    if (segment !== "baselines" || !baselinesAvailable) {
      setBaselineLoading(false);
      return;
    }
    if (!activeTenant) {
      setBaselines(null);
      setBaselineDrift(null);
      setBaselineError(null);
      setBaselineNoActive(false);
      setBaselineLoading(false);
      return;
    }
    if (!api?.listDriftBaselines) {
      setBaselineLoading(false);
      return;
    }
    const listDriftBaselines = api.listDriftBaselines;

    let cancelled = false;
    setBaselineLoading(true);
    setBaselineError(null);
    setBaselineLoadAnnouncement("Loading baselines…");

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
          setExpandedBaselineEntry(null);
          setBaselineLoadAnnouncement("No active baseline.");
          return;
        }
        if (!api.getDriftBaselineDrift) {
          throw new Error(
            "Baseline drift is unavailable in this build. The desktop bridge does not expose the drift evaluation method.",
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
          setBaselineLoadAnnouncement(
            nextDrift.entries.length === 1
              ? "Showing 1 baseline drift entry."
              : `Showing ${nextDrift.entries.length} baseline drift entries.`,
          );
        } catch (caught) {
          if (cancelled) return;
          if (isNoActiveBaselineError(caught)) {
            setBaselineDrift(null);
            setBaselineNoActive(true);
            setExpandedBaselineEntry(null);
            setBaselineLoadAnnouncement("No active baseline.");
            return;
          }
          throw caught;
        }
      } catch (caught) {
        if (cancelled) return;
        setBaselineError(
          caught instanceof Error ? caught.message : String(caught),
        );
        setBaselineLoadAnnouncement("Baselines could not be loaded.");
      } finally {
        if (!cancelled) setBaselineLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeTenant, baselineReloadNonce, baselinesAvailable, segment]);

  useEffect(() => {
    const api = window.openAdminOS;
    if (
      segment !== "compare" ||
      compareMode !== "tenant" ||
      !compareAvailable
    ) {
      setTenantCompareLoading(false);
      return;
    }
    if (!activeTenant || !tenantCompareId) {
      setTenantCompare(null);
      setTenantCompareError(null);
      setTenantCompareLoading(false);
      return;
    }
    if (!api?.getDriftTenantCompare) {
      setTenantCompare(null);
      setTenantCompareError(
        "Tenant comparison is unavailable in this build. The desktop bridge does not expose the tenant comparison method.",
      );
      setTenantCompareAnnouncement("Tenant comparison could not be loaded.");
      setTenantCompareLoading(false);
      return;
    }
    const getDriftTenantCompare = api.getDriftTenantCompare;

    let cancelled = false;
    setTenantCompareLoading(true);
    setTenantCompareError(null);
    setTenantCompare(null);
    setExpandedTenantCompareEntry(null);
    setTenantCompareAnnouncement("Comparing tenant configuration.");

    void getDriftTenantCompare({
      tenantIdA: activeTenant.id,
      tenantIdB: tenantCompareId,
      limit: INITIAL_LIMIT,
      includeAssignments,
    })
      .then((result) => {
        if (cancelled) return;
        setTenantCompare(result);
        setTenantCompareAnnouncement(
          result.entries.length === 1
            ? "Showing 1 tenant comparison entry."
            : `Showing ${result.entries.length} tenant comparison entries.`,
        );
      })
      .catch((caught) => {
        if (cancelled) return;
        setTenantCompareError(
          caught instanceof Error ? caught.message : String(caught),
        );
        setTenantCompareAnnouncement("Tenant comparison could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setTenantCompareLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeTenant,
    compareAvailable,
    compareMode,
    includeAssignments,
    segment,
    tenantCompareId,
    tenantCompareReloadNonce,
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
          current &&
          nextWorkspaces.some((workspace) => workspace.id === current)
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
    if (
      selectedEntry &&
      timeline &&
      !timeline.entries.some((entry) => entry.id === selectedEntry.id)
    ) {
      setSelectedEntry(null);
    }
  }, [selectedEntry, timeline]);

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

  const visibleEntries = useMemo(() => {
    const entries = timeline?.entries ?? [];
    return entries.filter((entry) => {
      if (selectedResource !== "all" && entry.resource !== selectedResource) {
        return false;
      }
      return true;
    });
  }, [selectedResource, timeline]);

  const groupedEntries = useMemo(
    () => groupEntriesByDay(visibleEntries),
    [visibleEntries],
  );
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
  const retiredBaselines = tenantBaselines.filter(
    (baseline) => baseline.status === "retired",
  );
  const selectedCompareTenant = otherTenants.find(
    (tenant) => tenant.id === tenantCompareId,
  );
  const timeCompareValidation = compareDateValidation(
    timeCompareFrom,
    timeCompareTo,
  );

  const handleResourceChange = (value: string) => {
    setSelectedResource(
      value === "all" ? "all" : (value as GraphCacheResourceKind),
    );
    setLimit(INITIAL_LIMIT);
    setSelectedEntry(null);
  };

  const handleDateRangeChange = (value: string) => {
    setDateRange(value as DateRangeValue);
    setLimit(INITIAL_LIMIT);
    setSelectedEntry(null);
  };

  const handleTimeCompare = async () => {
    const api = window.openAdminOS;
    if (!activeTenant || timeCompareValidation) return;
    if (!api?.getDriftTimeCompare) {
      setTimeCompareError(
        "Time comparison is unavailable in this build. The desktop bridge does not expose the time comparison method.",
      );
      return;
    }

    const requestId = timeCompareRequestId.current + 1;
    timeCompareRequestId.current = requestId;
    setTimeCompareLoading(true);
    setTimeCompareError(null);
    setTimeCompare(null);
    setExpandedTimeCompareEntry(null);
    setTimeCompareAnnouncement("Comparing configuration over time.");
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

  const handleTimeCompareDateChange = (field: "from" | "to", value: string) => {
    if (field === "from") setTimeCompareFrom(value);
    else setTimeCompareTo(value);
    setTimeCompare(null);
    setTimeCompareError(null);
    setExpandedTimeCompareEntry(null);
    setTimeCompareAnnouncement("");
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
          throw new Error(
            "Baseline creation is unavailable in this build. The desktop bridge does not expose the create method.",
          );
        }
        const created = await api.createDriftBaseline({
          tenantId: activeTenant.id,
          name,
        });
        setBaselines((current) => [
          created,
          ...(current ?? []).filter((baseline) => baseline.id !== created.id),
        ]);
        setBaselineDrift(null);
        setBaselineNoActive(false);
        setBaselineError(null);
        setExpandedBaselineEntry(null);
        setBaselineNameMode(null);
        setBaselineLoading(true);
        setBaselineLoadAnnouncement("Evaluating the new baseline…");

        if (!api.getDriftBaselineDrift) {
          setBaselineError(
            "Baseline drift is unavailable in this build. The desktop bridge does not expose the drift evaluation method.",
          );
          setBaselineLoading(false);
          return;
        }
        try {
          const nextDrift = await api.getDriftBaselineDrift({
            tenantId: activeTenant.id,
            baselineId: created.id,
          });
          setBaselineDrift(nextDrift);
          setBaselines((current) =>
            (current ?? []).map((baseline) =>
              baseline.id === nextDrift.baseline.id
                ? nextDrift.baseline
                : baseline,
            ),
          );
          setBaselineLoadAnnouncement(
            nextDrift.entries.length === 1
              ? "Showing 1 baseline drift entry."
              : `Showing ${nextDrift.entries.length} baseline drift entries.`,
          );
        } catch (caught) {
          if (isNoActiveBaselineError(caught)) {
            setBaselineDrift(null);
            setBaselineNoActive(true);
            setBaselineLoadAnnouncement("No active baseline.");
          } else {
            setBaselineError(
              caught instanceof Error ? caught.message : String(caught),
            );
            setBaselineLoadAnnouncement("Baseline drift could not be loaded.");
          }
        } finally {
          setBaselineLoading(false);
        }
        return;
      }

      if (!activeBaseline) {
        throw new Error("No active baseline exists to rename.");
      }
      if (!api?.renameDriftBaseline) {
        throw new Error(
          "Baseline rename is unavailable in this build. The desktop bridge does not expose the rename method.",
        );
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

  const closeRetireBaselineModal = () => {
    if (retireBaselineBusy) return;
    setRetireBaselineOpen(false);
    setRetireBaselineError(null);
  };

  const handleRetireBaseline = async () => {
    const api = window.openAdminOS;
    if (!activeTenant || !activeBaseline) return;
    setRetireBaselineBusy(true);
    setRetireBaselineError(null);
    try {
      if (!api?.retireDriftBaseline) {
        throw new Error(
          "Baseline retirement is unavailable in this build. The desktop bridge does not expose the retire method.",
        );
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
      setExpandedBaselineEntry(null);
      setBaselineLoadAnnouncement("No active baseline.");
      setRetireBaselineOpen(false);
    } catch (caught) {
      setRetireBaselineError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setRetireBaselineBusy(false);
    }
  };

  const closeBaselineRollbackModal = () => {
    if (baselineRollbackBusy) return;
    setBaselineRollbackOpen(false);
    setBaselineRollbackError(null);
  };

  const handleBaselineRollback = async () => {
    const startBaselineRollback = window.openAdminOS?.startBaselineRollback;
    if (!activeTenant) return;

    setBaselineRollbackBusy(true);
    setBaselineRollbackError(null);
    try {
      if (!startBaselineRollback) {
        throw new Error(
          "Baseline rollback is unavailable in this build. The desktop bridge does not expose the rollback method.",
        );
      }
      const run = await startBaselineRollback({ tenantId: activeTenant.id });
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

  return (
    <>
      <PageHeader
        title="Changes"
        subtitle={
          activeTenant
            ? segment === "baselines" && baselinesAvailable
              ? `Named configuration baselines for ${activeTenant.displayName}. Drift is evaluated from local tracked versions.`
              : segment === "compare" && compareAvailable
                ? `Compare retained configuration for ${activeTenant.displayName}. Results use local tracked versions.`
                : `Tenant drift timeline for ${activeTenant.displayName}. Entries are computed from local cache snapshots.`
            : "Connect a Microsoft 365 tenant before reviewing change history."
        }
      />
      <PageBody>
        <div role="status" aria-live="polite" className="sr-only">
          {segment === "baselines" && baselinesAvailable
            ? baselineLoading
              ? "Loading baselines…"
              : baselineLoadAnnouncement
            : segment === "compare" && compareAvailable
              ? compareMode === "time"
                ? timeCompareLoading
                  ? "Comparing configuration over time."
                  : timeCompareAnnouncement
                : tenantCompareLoading
                  ? "Comparing tenant configuration."
                  : tenantCompareAnnouncement
              : loading
                ? "Loading change history."
                : loadAnnouncement}
        </div>

        <ChangesSegmentControl
          segment={segment}
          showBaselines={baselinesAvailable}
          showCompare={compareAvailable}
          onChange={setSegment}
        />

        {!activeTenant ? (
          <NoTenantState
            onConnect={() =>
              requireTenant(
                createPendingIntent({
                  kind: "view-changes",
                  returnTo: "/changes",
                }),
              )
            }
          />
        ) : segment === "baselines" && baselinesAvailable ? (
          <BaselinesSegment
            loading={baselineLoading}
            error={baselineError}
            activeBaseline={activeBaseline}
            drift={tenantBaselineDrift}
            retiredBaselines={retiredBaselines}
            expandedEntry={expandedBaselineEntry}
            onToggleEntry={(entry) => {
              const key = baselineDriftEntryKey(entry);
              setExpandedBaselineEntry((current) =>
                current === key ? null : key,
              );
            }}
            onCreate={openCreateBaseline}
            onRename={openRenameBaseline}
            onRetire={() => {
              setRetireBaselineError(null);
              setRetireBaselineOpen(true);
            }}
            onRollback={
              baselineRollbackAvailable
                ? () => {
                    setBaselineRollbackError(null);
                    setBaselineRollbackOpen(true);
                  }
                : undefined
            }
            onRetry={() => {
              setBaselineError(null);
              setBaselineReloadNonce((current) => current + 1);
            }}
          />
        ) : segment === "compare" && compareAvailable ? (
          <CompareSegment
            mode={compareMode}
            onModeChange={setCompareMode}
            timeFrom={timeCompareFrom}
            timeTo={timeCompareTo}
            timeValidation={timeCompareValidation}
            timeLoading={timeCompareLoading}
            timeError={timeCompareError}
            timeResult={timeCompare}
            expandedTimeEntry={expandedTimeCompareEntry}
            onTimeFromChange={(value) =>
              handleTimeCompareDateChange("from", value)
            }
            onTimeToChange={(value) => handleTimeCompareDateChange("to", value)}
            onRunTimeCompare={() => void handleTimeCompare()}
            onToggleTimeEntry={(entry) => {
              const key = baselineDriftEntryKey(entry);
              setExpandedTimeCompareEntry((current) =>
                current === key ? null : key,
              );
            }}
            tenants={otherTenants}
            activeTenant={activeTenant}
            selectedTenant={selectedCompareTenant}
            selectedTenantId={tenantCompareId}
            includeAssignments={includeAssignments}
            tenantLoading={tenantCompareLoading}
            tenantError={tenantCompareError}
            tenantResult={tenantCompare}
            expandedTenantEntry={expandedTenantCompareEntry}
            onTenantChange={setTenantCompareId}
            onIncludeAssignmentsChange={setIncludeAssignments}
            onToggleTenantEntry={(entry, index) => {
              const key = tenantCompareEntryKey(entry, index);
              setExpandedTenantCompareEntry((current) =>
                current === key ? null : key,
              );
            }}
            onRetryTenant={() =>
              setTenantCompareReloadNonce((current) => current + 1)
            }
          />
        ) : (
          <div className="space-y-4">
            {error ? (
              <InlineState
                tone="danger"
                title="Change history unavailable"
                message={`${error} Try again after the desktop bridge and local cache are ready.`}
                action={
                  <Button
                    size="sm"
                    variant="secondary"
                    leadingIcon={<IconRefresh size={12} />}
                    onClick={() => {
                      setError(null);
                      setReloadNonce((current) => current + 1);
                    }}
                  >
                    Retry
                  </Button>
                }
              />
            ) : null}
            {notice ? (
              <InlineState tone="success" title="Done" message={notice} />
            ) : null}
            {status?.resources.some((resource) => resource.pageLimitReached) ? (
              <InlineState
                tone="info"
                title="Change coverage is capped"
                message="At least one Graph collection exceeded the local 1,000-row cache limit. Objects outside the cached window are not inferred as removed."
              />
            ) : null}
            {timeline?.historyTruncated ? (
              <InlineState
                tone="info"
                title="Older history is not included"
                message="This view searched the newest 5,000 snapshots per resource. Narrow the resource or date range to search older retained history."
              />
            ) : null}

            <FiltersRow
              resources={status?.resources ?? []}
              selectedResource={selectedResource}
              onResourceChange={handleResourceChange}
              dateRange={dateRange}
              onDateRangeChange={handleDateRangeChange}
              query={query}
              onQueryChange={setQuery}
              disabled={loading && !timeline}
            />

            {noBaselineYet ? (
              <NoBaselineState onOpenSettings={() => navigate("/settings")} />
            ) : baselineOnly ? (
              <BaselineOnlyState baselineDate={baselineDate} />
            ) : (
              <div className="grid min-h-[520px] gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
                <TimelinePanel
                  loading={loading}
                  groups={groupedEntries}
                  hasAnyEntries={(timeline?.entries.length ?? 0) > 0}
                  hasMore={Boolean(timeline?.hasMore)}
                  selectedEntry={selectedEntry}
                  onSelectEntry={setSelectedEntry}
                  onLoadMore={() => {
                    setLoadAnnouncement("Loading more change history entries.");
                    setLimit((current) => current + LOAD_MORE_STEP);
                  }}
                />
                <DetailPane
                  entry={selectedEntry}
                  detail={detail}
                  history={history}
                  loading={detailLoading}
                  error={detailError}
                  markdown={selectedMarkdown}
                  workspaces={workspaces}
                  onCopy={() => void handleCopy()}
                  onOpenPin={() => setPinOpen(true)}
                />
              </div>
            )}
          </div>
        )}
      </PageBody>

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
        onClose={closeRetireBaselineModal}
        onConfirm={() => void handleRetireBaseline()}
      />
      <BaselineRollbackModal
        open={baselineRollbackOpen}
        entryCount={tenantBaselineDrift?.entries.length ?? 0}
        error={baselineRollbackError}
        busy={baselineRollbackBusy}
        onClose={closeBaselineRollbackModal}
        onConfirm={() => void handleBaselineRollback()}
      />
    </>
  );
}

type DriftTimelineStatus = {
  tenantId: string;
  resources: DriftResourceStatus[];
};

function ChangesSegmentControl({
  segment,
  showBaselines,
  showCompare,
  onChange,
}: {
  segment: ChangesSegment;
  showBaselines: boolean;
  showCompare: boolean;
  onChange: (segment: ChangesSegment) => void;
}) {
  if (!showBaselines && !showCompare) return null;
  const segments: ChangesSegment[] = [
    "timeline",
    ...(showBaselines ? (["baselines"] as const) : []),
    ...(showCompare ? (["compare"] as const) : []),
  ];
  return (
    <div
      role="group"
      aria-label="Changes view"
      className="mb-6 flex flex-wrap items-center gap-1.5"
    >
      {segments.map((value) => {
        const active = segment === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(value)}
            className={`rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors ${focusRingClass} ${
              active
                ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/30"
                : "bg-transparent text-[var(--color-text-soft)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
            }`}
          >
            {value === "timeline"
              ? "Timeline"
              : value === "baselines"
                ? "Baselines"
                : "Compare"}
          </button>
        );
      })}
    </div>
  );
}

function CompareSegment({
  mode,
  onModeChange,
  timeFrom,
  timeTo,
  timeValidation,
  timeLoading,
  timeError,
  timeResult,
  expandedTimeEntry,
  onTimeFromChange,
  onTimeToChange,
  onRunTimeCompare,
  onToggleTimeEntry,
  tenants,
  activeTenant,
  selectedTenant,
  selectedTenantId,
  includeAssignments,
  tenantLoading,
  tenantError,
  tenantResult,
  expandedTenantEntry,
  onTenantChange,
  onIncludeAssignmentsChange,
  onToggleTenantEntry,
  onRetryTenant,
}: {
  mode: CompareMode;
  onModeChange: (mode: CompareMode) => void;
  timeFrom: string;
  timeTo: string;
  timeValidation: string | null;
  timeLoading: boolean;
  timeError: string | null;
  timeResult: DriftTimeCompareResult | null;
  expandedTimeEntry: string | null;
  onTimeFromChange: (value: string) => void;
  onTimeToChange: (value: string) => void;
  onRunTimeCompare: () => void;
  onToggleTimeEntry: (entry: DriftBaselineDriftEntry) => void;
  tenants: { id: string; displayName: string }[];
  activeTenant: { id: string; displayName: string };
  selectedTenant?: { id: string; displayName: string };
  selectedTenantId: string;
  includeAssignments: boolean;
  tenantLoading: boolean;
  tenantError: string | null;
  tenantResult: DriftTenantCompareResult | null;
  expandedTenantEntry: string | null;
  onTenantChange: (tenantId: string) => void;
  onIncludeAssignmentsChange: (include: boolean) => void;
  onToggleTenantEntry: (entry: DriftTenantCompareEntry, index: number) => void;
  onRetryTenant: () => void;
}) {
  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border-soft)] px-4 py-3">
          <div>
            <h2 className="text-[12px] font-semibold text-[var(--color-text)]">
              Comparison mode
            </h2>
            <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
              Compare retained configuration from the local cache
            </div>
          </div>
          <div
            role="group"
            aria-label="Comparison mode"
            className="inline-flex rounded-lg bg-[var(--color-bg-raised)] p-1 ring-1 ring-[var(--color-border-soft)]"
          >
            {(["time", "tenant"] satisfies CompareMode[]).map((value) => {
              const active = mode === value;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onModeChange(value)}
                  className={`rounded-md px-3 py-1.5 text-[11.5px] font-medium transition-colors ${focusRingClass} ${
                    active
                      ? "bg-[var(--color-surface)] text-[var(--color-text)] ring-1 ring-[var(--color-border)]"
                      : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                  }`}
                >
                  {value === "time" ? "Over time" : "Between tenants"}
                </button>
              );
            })}
          </div>
        </div>

        {mode === "time" ? (
          <div className="flex flex-wrap items-end gap-3 px-4 py-4">
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
            {timeValidation ? (
              <div
                id="compare-date-validation"
                role="alert"
                className="w-full text-[11.5px] text-[var(--color-danger)]"
              >
                {timeValidation}
              </div>
            ) : null}
          </div>
        ) : tenants.length === 0 ? null : (
          <div className="grid gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
            <div>
              <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                Tenant A
              </div>
              <div className="mt-2 flex h-10 items-center rounded-lg bg-[var(--color-bg-raised)] px-3 text-[13px] text-[var(--color-text)] ring-1 ring-[var(--color-border-soft)]">
                {activeTenant.displayName}
              </div>
            </div>
            <label htmlFor="compare-tenant-b" className="block">
              <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                Tenant B
              </span>
              <select
                id="compare-tenant-b"
                name="compare-tenant-b"
                aria-label="Tenant B"
                value={selectedTenantId}
                disabled={tenantLoading}
                onChange={(event) => onTenantChange(event.target.value)}
                className={`mt-2 h-10 w-full rounded-lg bg-[var(--color-bg-raised)] px-3 text-[13px] text-[var(--color-text)] outline-none ring-1 ring-[var(--color-border-soft)] disabled:opacity-60 ${focusRingClass}`}
              >
                {tenants.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>
                    {tenant.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-h-10 items-start gap-2 rounded-lg bg-[var(--color-bg-raised)] px-3 py-2 ring-1 ring-[var(--color-border-soft)]">
              <input
                type="checkbox"
                name="include-assignments"
                aria-label="Include assignments"
                autoComplete="off"
                checked={includeAssignments}
                disabled={tenantLoading}
                onChange={(event) =>
                  onIncludeAssignmentsChange(event.target.checked)
                }
                className={`mt-0.5 h-4 w-4 accent-[var(--color-accent)] ${focusRingClass}`}
              />
              <span>
                <span className="block text-[12px] font-medium text-[var(--color-text)]">
                  Include assignments
                </span>
                <span className="mt-0.5 block max-w-[330px] text-[10.5px] leading-4 text-[var(--color-text-muted)]">
                  Assignments target tenant-specific groups and are excluded by
                  default.
                </span>
              </span>
            </label>
          </div>
        )}
      </Card>

      {mode === "time" ? (
        <TimeCompareResults
          loading={timeLoading}
          error={timeError}
          result={timeResult}
          expandedEntry={expandedTimeEntry}
          onRetry={onRunTimeCompare}
          onToggleEntry={onToggleTimeEntry}
        />
      ) : tenants.length === 0 ? (
        <SecondTenantRequiredState />
      ) : (
        <TenantCompareResults
          loading={tenantLoading}
          error={tenantError}
          result={tenantResult}
          tenantA={activeTenant}
          tenantB={selectedTenant}
          expandedEntry={expandedTenantEntry}
          onRetry={onRetryTenant}
          onToggleEntry={onToggleTenantEntry}
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
      <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </span>
      <input
        id={id}
        name={id}
        type="date"
        value={value}
        disabled={disabled}
        aria-invalid={invalid}
        aria-describedby={invalid ? "compare-date-validation" : undefined}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        className={`mt-2 h-10 rounded-lg bg-[var(--color-bg-raised)] px-3 text-[13px] text-[var(--color-text)] outline-none ring-1 ring-[var(--color-border-soft)] disabled:opacity-60 ${focusRingClass}`}
      />
    </label>
  );
}

function TimeCompareResults({
  loading,
  error,
  result,
  expandedEntry,
  onRetry,
  onToggleEntry,
}: {
  loading: boolean;
  error: string | null;
  result: DriftTimeCompareResult | null;
  expandedEntry: string | null;
  onRetry: () => void;
  onToggleEntry: (entry: DriftBaselineDriftEntry) => void;
}) {
  if (loading)
    return <CompareLoadingState label="Comparing configuration over time" />;
  if (error) {
    return (
      <InlineState
        tone="danger"
        title="Time comparison unavailable"
        message={`${error} Adjust the date window or retry after the local cache is ready.`}
        action={
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<IconRefresh size={12} />}
            onClick={onRetry}
          >
            Retry
          </Button>
        }
      />
    );
  }
  if (!result) {
    return (
      <Card className="px-5 py-8 text-center">
        <div className="text-[13px] font-medium text-[var(--color-text)]">
          No comparison run
        </div>
        <div className="mt-1 text-[12px] text-[var(--color-text-muted)]">
          Choose a date window, then run the comparison.
        </div>
      </Card>
    );
  }

  const resources = result.resources.filter(
    (resource) => resource.added + resource.removed + resource.modified > 0,
  );
  const empty = resources.length === 0 && result.entries.length === 0;
  return (
    <div className="space-y-4">
      {result.retentionLimited ? (
        <InlineState
          tone="info"
          title="Retention-limited window"
          message="Retention has pruned history older than part of this window. The before side may be incomplete."
        />
      ) : null}
      {empty ? (
        <Card className="px-5 py-12 text-center">
          <div className="text-[13px] font-medium text-[var(--color-text)]">
            No tracked configuration changed in this window.
          </div>
        </Card>
      ) : (
        <>
          {resources.length > 0 ? (
            <TimeCompareResourceSummary resources={resources} />
          ) : null}
          <TimeCompareEntries
            result={result}
            expandedEntry={expandedEntry}
            onToggleEntry={onToggleEntry}
          />
        </>
      )}
    </div>
  );
}

function TimeCompareResourceSummary({
  resources,
}: {
  resources: DriftTimeCompareResult["resources"];
}) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-[var(--color-border-soft)] px-5 py-3">
        <h2 className="text-[12px] font-semibold text-[var(--color-text)]">
          Changes by resource
        </h2>
        <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
          Resources with tracked changes in this window
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[540px] text-left text-[12px]">
          <thead className="bg-[var(--color-bg-raised)] text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Resource
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Added
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Removed
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Modified
              </th>
            </tr>
          </thead>
          <tbody>
            {resources.map((resource) => (
              <tr
                key={resource.resource}
                aria-label={`${resource.resourceLabel}: ${resource.added} added, ${resource.removed} removed, ${resource.modified} modified`}
                className="border-t border-[var(--color-border-soft)]"
              >
                <th
                  scope="row"
                  className="px-3 py-2.5 font-medium text-[var(--color-text-soft)]"
                >
                  {resource.resourceLabel}
                </th>
                <td className="px-3 py-2.5 text-right font-mono text-[var(--color-success)]">
                  {resource.added.toLocaleString()}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-[var(--color-danger)]">
                  {resource.removed.toLocaleString()}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-[var(--color-accent)]">
                  {resource.modified.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function TimeCompareEntries({
  result,
  expandedEntry,
  onToggleEntry,
}: {
  result: DriftTimeCompareResult;
  expandedEntry: string | null;
  onToggleEntry: (entry: DriftBaselineDriftEntry) => void;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border-soft)] px-5 py-3">
        <div>
          <h2 className="text-[12px] font-semibold text-[var(--color-text)]">
            Changed objects
          </h2>
          <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
            {result.entries.length.toLocaleString()} objects changed in this
            window
          </div>
        </div>
        <span className="text-[11px] text-[var(--color-text-muted)]">
          {formatDateTime(result.evaluatedAt)}
        </span>
      </div>
      {result.entries.length === 0 ? (
        <div className="px-5 py-10 text-center text-[13px] font-medium text-[var(--color-text)]">
          No tracked configuration changed in this window.
        </div>
      ) : (
        <div className="divide-y divide-[var(--color-border-soft)]">
          {result.entries.map((entry, index) => {
            const key = baselineDriftEntryKey(entry);
            const expanded = expandedEntry === key;
            const detailId = `time-compare-detail-${index}`;
            const name = entry.displayName ?? entry.graphId;
            return (
              <div key={key}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={detailId}
                  aria-label={`${expanded ? "Collapse" : "Expand"} time comparison details for ${name}`}
                  onClick={() => onToggleEntry(entry)}
                  className={`grid w-full gap-3 px-5 py-3 text-left transition-colors hover:bg-[var(--color-surface-hover)] sm:grid-cols-[minmax(0,1fr)_auto] ${focusRingClass}`}
                >
                  <span className="min-w-0">
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <ChangeKindChip kind={entry.changeKind} />
                      <span className="truncate text-[13px] font-medium text-[var(--color-text)]">
                        {name}
                      </span>
                    </span>
                    <span className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
                      <span>{entry.resourceLabel}</span>
                      <span
                        aria-hidden="true"
                        className="text-[var(--color-text-faint)]"
                      >
                        ·
                      </span>
                      <span className="truncate font-mono">
                        {entry.graphId}
                      </span>
                    </span>
                  </span>
                  <span className="flex items-center justify-end gap-3 self-center text-[11px] text-[var(--color-text-muted)]">
                    <span>{formatFieldCount(entry.fieldChangeCount)}</span>
                    <IconChevronDown
                      size={13}
                      aria-hidden="true"
                      className={`transition-transform ${expanded ? "rotate-180" : ""}`}
                    />
                  </span>
                </button>
                {expanded ? (
                  <div
                    id={detailId}
                    className="space-y-3 border-t border-[var(--color-border-soft)] bg-[var(--color-bg)] p-4"
                  >
                    {entry.truncated ? <CompareTruncationNotice /> : null}
                    <FieldChangesTable changes={entry.changes} />
                  </div>
                ) : null}
              </div>
            );
          })}
          {result.hasMore ? <CompareHasMoreNotice /> : null}
        </div>
      )}
    </Card>
  );
}

function TenantCompareResults({
  loading,
  error,
  result,
  tenantA,
  tenantB,
  expandedEntry,
  onRetry,
  onToggleEntry,
}: {
  loading: boolean;
  error: string | null;
  result: DriftTenantCompareResult | null;
  tenantA: { id: string; displayName: string };
  tenantB?: { id: string; displayName: string };
  expandedEntry: string | null;
  onRetry: () => void;
  onToggleEntry: (entry: DriftTenantCompareEntry, index: number) => void;
}) {
  if (loading)
    return <CompareLoadingState label="Comparing tenant configuration" />;
  if (error) {
    return (
      <InlineState
        tone="danger"
        title="Tenant comparison unavailable"
        message={`${error} Retry after both tenant caches are ready.`}
        action={
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<IconRefresh size={12} />}
            onClick={onRetry}
          >
            Retry
          </Button>
        }
      />
    );
  }
  if (!result || !tenantB) return null;

  if (!result.tenantAHasData || !result.tenantBHasData) {
    return (
      <div className="space-y-4">
        {!result.tenantAHasData ? (
          <NoCapturedConfigurationState tenantName={tenantA.displayName} />
        ) : null}
        {!result.tenantBHasData ? (
          <NoCapturedConfigurationState tenantName={tenantB.displayName} />
        ) : null}
      </div>
    );
  }

  const resources = result.resources.filter(
    (resource) =>
      resource.matchedSame +
        resource.different +
        resource.onlyInA +
        resource.onlyInB +
        resource.ambiguous >
      0,
  );
  return (
    <div className="space-y-4">
      {resources.length > 0 ? (
        <TenantCompareResourceSummary resources={resources} />
      ) : null}
      <TenantCompareEntries
        result={result}
        tenantA={tenantA}
        tenantB={tenantB}
        expandedEntry={expandedEntry}
        onToggleEntry={onToggleEntry}
      />
    </div>
  );
}

function TenantCompareResourceSummary({
  resources,
}: {
  resources: DriftTenantCompareResult["resources"];
}) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-[var(--color-border-soft)] px-5 py-3">
        <h2 className="text-[12px] font-semibold text-[var(--color-text)]">
          Comparison by resource
        </h2>
        <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
          Unique display names are matched across tenant caches
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] text-left text-[12px]">
          <thead className="bg-[var(--color-bg-raised)] text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
            <tr>
              <th scope="col" className="w-[34%] px-4 py-2 font-medium">
                Resource
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Buckets
              </th>
            </tr>
          </thead>
          <tbody>
            {resources.map((resource) => (
              <tr
                key={resource.resource}
                aria-label={tenantResourceSummaryLabel(resource)}
                className="border-t border-[var(--color-border-soft)]"
              >
                <th
                  scope="row"
                  className="px-4 py-3 align-top font-medium text-[var(--color-text-soft)]"
                >
                  {resource.resourceLabel}
                </th>
                <td className="px-4 py-3 tabular-nums">
                  <div className="flex flex-wrap gap-2">
                    {resource.matchedSame > 0 ? (
                      <Pill tone="success">
                        {resource.matchedSame.toLocaleString()} same
                      </Pill>
                    ) : null}
                    {resource.different > 0 ? (
                      <Pill tone="warning">
                        {resource.different.toLocaleString()} different
                      </Pill>
                    ) : null}
                    {resource.onlyInA > 0 ? (
                      <Pill tone="default">
                        {resource.onlyInA.toLocaleString()} only in A
                      </Pill>
                    ) : null}
                    {resource.onlyInB > 0 ? (
                      <Pill tone="info">
                        {resource.onlyInB.toLocaleString()} only in B
                      </Pill>
                    ) : null}
                    {resource.ambiguous > 0 ? (
                      <Pill tone="warning">
                        {resource.ambiguous.toLocaleString()} ambiguous
                      </Pill>
                    ) : null}
                  </div>
                  {resource.ambiguous > 0 ? (
                    <div className="mt-2 text-[11px] text-[var(--color-text-muted)]">
                      {ambiguousObjectNote(resource.ambiguous)}
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function TenantCompareEntries({
  result,
  tenantA,
  tenantB,
  expandedEntry,
  onToggleEntry,
}: {
  result: DriftTenantCompareResult;
  tenantA: { displayName: string };
  tenantB: { displayName: string };
  expandedEntry: string | null;
  onToggleEntry: (entry: DriftTenantCompareEntry, index: number) => void;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border-soft)] px-5 py-3">
        <div>
          <h2 className="text-[12px] font-semibold text-[var(--color-text)]">
            Configuration differences
          </h2>
          <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
            {tenantA.displayName} compared with {tenantB.displayName}
          </div>
        </div>
        <span className="text-[11px] text-[var(--color-text-muted)]">
          {formatDateTime(result.evaluatedAt)}
        </span>
      </div>
      {result.entries.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <div className="text-[13px] font-medium text-[var(--color-text)]">
            No configuration differences between these tenants.
          </div>
        </div>
      ) : (
        <div className="divide-y divide-[var(--color-border-soft)]">
          {result.entries.map((entry, index) => {
            const key = tenantCompareEntryKey(entry, index);
            const expandable = entry.bucket === "different";
            const expanded = expandable && expandedEntry === key;
            const detailId = `tenant-compare-detail-${index}`;
            const rowContent = (
              <>
                <span className="min-w-0">
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <TenantCompareBucketPill bucket={entry.bucket} />
                    <span className="truncate text-[13px] font-medium text-[var(--color-text)]">
                      {entry.displayName}
                    </span>
                  </span>
                  <span className="mt-1 block text-[11px] text-[var(--color-text-muted)]">
                    {entry.resourceLabel}
                  </span>
                </span>
                <span className="flex items-center justify-end gap-3 self-center text-[11px] text-[var(--color-text-muted)]">
                  {expandable ? (
                    <>
                      <span>{formatFieldCount(entry.fieldChangeCount)}</span>
                      <IconChevronDown
                        size={13}
                        aria-hidden="true"
                        className={`transition-transform ${expanded ? "rotate-180" : ""}`}
                      />
                    </>
                  ) : null}
                </span>
              </>
            );
            return (
              <div key={key}>
                {expandable ? (
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={detailId}
                    aria-label={`${expanded ? "Collapse" : "Expand"} tenant comparison details for ${entry.displayName}`}
                    onClick={() => onToggleEntry(entry, index)}
                    className={`grid w-full gap-3 px-5 py-3 text-left transition-colors hover:bg-[var(--color-surface-hover)] sm:grid-cols-[minmax(0,1fr)_auto] ${focusRingClass}`}
                  >
                    {rowContent}
                  </button>
                ) : (
                  <div className="grid w-full gap-3 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                    {rowContent}
                  </div>
                )}
                {expanded ? (
                  <div
                    id={detailId}
                    className="space-y-3 border-t border-[var(--color-border-soft)] bg-[var(--color-bg)] p-4"
                  >
                    {entry.truncated ? <CompareTruncationNotice /> : null}
                    <FieldChangesTable changes={entry.changes} />
                  </div>
                ) : null}
              </div>
            );
          })}
          {result.hasMore ? <CompareHasMoreNotice /> : null}
        </div>
      )}
    </Card>
  );
}

function TenantCompareBucketPill({
  bucket,
}: {
  bucket: DriftTenantCompareEntry["bucket"];
}) {
  if (bucket === "different") return <Pill tone="warning">Different</Pill>;
  if (bucket === "only-in-b") return <Pill tone="info">Only in B</Pill>;
  return <Pill tone="default">Only in A</Pill>;
}

function CompareLoadingState({ label }: { label: string }) {
  return (
    <div className="space-y-3" aria-label={label}>
      <Card className="h-32 animate-pulse bg-[var(--color-bg-raised)]">
        <span className="sr-only">{label}</span>
      </Card>
      <Card className="h-48 animate-pulse bg-[var(--color-bg-raised)]">
        <span className="sr-only">Loading comparison entries</span>
      </Card>
    </div>
  );
}

function CompareTruncationNotice() {
  return (
    <div className="rounded-lg bg-[var(--color-warning-soft)] px-3 py-2 text-[12px] leading-5 text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
      Raw before/after bodies exceeded the local display cap. The field list
      below is complete.
    </div>
  );
}

function CompareHasMoreNotice() {
  return (
    <div className="px-5 py-3 text-center text-[11px] text-[var(--color-text-muted)]">
      This comparison contains more entries than the local display limit.
    </div>
  );
}

function SecondTenantRequiredState() {
  return (
    <Card className="px-6 py-14 text-center">
      <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-lg bg-[var(--color-bg-raised)] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
        <IconChanges size={18} />
      </div>
      <h2 className="mt-4 text-[15px] font-semibold text-[var(--color-text)]">
        Connect a second tenant to compare configurations.
      </h2>
    </Card>
  );
}

function NoCapturedConfigurationState({ tenantName }: { tenantName: string }) {
  return (
    <Card className="px-6 py-10 text-center">
      <div className="text-[13px] font-medium text-[var(--color-text)]">
        No captured configuration for {tenantName}. Refresh its cache first.
      </div>
    </Card>
  );
}

function BaselinesSegment({
  loading,
  error,
  activeBaseline,
  drift,
  retiredBaselines,
  expandedEntry,
  onToggleEntry,
  onCreate,
  onRename,
  onRetire,
  onRollback,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  activeBaseline?: DriftBaseline;
  drift: DriftBaselineDriftResult | null;
  retiredBaselines: DriftBaseline[];
  expandedEntry: string | null;
  onToggleEntry: (entry: DriftBaselineDriftEntry) => void;
  onCreate: () => void;
  onRename: () => void;
  onRetire: () => void;
  onRollback?: () => void;
  onRetry: () => void;
}) {
  if (loading && !activeBaseline && retiredBaselines.length === 0 && !error) {
    return (
      <div className="space-y-4" aria-label="Loading baselines">
        <Card className="h-52 animate-pulse bg-[var(--color-bg-raised)]">
          <span className="sr-only">Loading active baseline</span>
        </Card>
        <Card className="h-44 animate-pulse bg-[var(--color-bg-raised)]">
          <span className="sr-only">Loading baseline drift</span>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error ? (
        <InlineState
          tone="danger"
          title="Baselines unavailable"
          message={`${error} Try again after the desktop bridge and local cache are ready.`}
          action={
            <Button
              size="sm"
              variant="secondary"
              leadingIcon={<IconRefresh size={12} />}
              onClick={onRetry}
            >
              Retry
            </Button>
          }
        />
      ) : null}

      {activeBaseline ? (
        <ActiveBaselineCard
          baseline={activeBaseline}
          drift={drift}
          loading={loading}
          onRename={onRename}
          onRetire={onRetire}
        />
      ) : error ? null : (
        <NoActiveBaselineState onCreate={onCreate} />
      )}

      {activeBaseline && drift ? (
        <BaselineDriftEntries
          drift={drift}
          expandedEntry={expandedEntry}
          onToggleEntry={onToggleEntry}
          onRollback={onRollback}
        />
      ) : null}

      <RetiredBaselinesList baselines={retiredBaselines} />
    </div>
  );
}

function ActiveBaselineCard({
  baseline,
  drift,
  loading,
  onRename,
  onRetire,
}: {
  baseline: DriftBaseline;
  drift: DriftBaselineDriftResult | null;
  loading: boolean;
  onRename: () => void;
  onRetire: () => void;
}) {
  const resourceLabels = baseline.resources.map((resource) =>
    baselineResourceLabel(resource, drift),
  );
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--color-border-soft)] px-5 py-4">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="truncate text-[15px] font-semibold text-[var(--color-text)]">
              {baseline.name}
            </h2>
            <Pill tone="success">Active baseline</Pill>
          </div>
          <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
            {drift
              ? `Evaluated ${formatDateTime(drift.evaluatedAt)}`
              : loading
                ? "Evaluating drift…"
                : "Drift evaluation unavailable"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onRename}>
            Rename
          </Button>
          <Button size="sm" variant="danger" onClick={onRetire}>
            Retire
          </Button>
        </div>
      </div>

      <div className="grid gap-px bg-[var(--color-border-soft)] sm:grid-cols-3">
        <BaselineMetric
          label="Created"
          value={formatDateTime(baseline.createdAt)}
        />
        <BaselineMetric
          label="Pinned objects"
          value={baseline.pinnedObjectCount.toLocaleString()}
        />
        <BaselineMetric
          label="Resources covered"
          value={`${baseline.resources.length.toLocaleString()} covered`}
          detail={resourceLabels.join(", ") || "No resources recorded"}
        />
      </div>

      <div className="border-t border-[var(--color-border-soft)] px-5 py-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[12px] font-semibold text-[var(--color-text)]">
              Drift by resource
            </h3>
            <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
              Object changes against the pinned versions
            </div>
          </div>
          {loading ? (
            <Pill tone="default">
              <span className="h-2 w-2 animate-spin rounded-full border border-current border-t-transparent" />
              Loading…
            </Pill>
          ) : null}
        </div>
        {drift && drift.resources.length > 0 ? (
          <div className="overflow-x-auto rounded-lg ring-1 ring-[var(--color-border-soft)]">
            <table className="w-full min-w-[540px] text-left text-[12px]">
              <thead className="bg-[var(--color-bg-raised)] text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Resource
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Added
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Removed
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Modified
                  </th>
                </tr>
              </thead>
              <tbody>
                {drift.resources.map((resource) => (
                  <tr
                    key={resource.resource}
                    aria-label={`${resource.resourceLabel}: ${resource.added} added, ${resource.removed} removed, ${resource.modified} modified`}
                    className="border-t border-[var(--color-border-soft)]"
                  >
                    <th
                      scope="row"
                      className="px-3 py-2.5 font-medium text-[var(--color-text-soft)]"
                    >
                      {resource.resourceLabel}
                    </th>
                    <td className="px-3 py-2.5 text-right font-mono text-[var(--color-success)]">
                      {resource.added.toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-[var(--color-danger)]">
                      {resource.removed.toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-[var(--color-accent)]">
                      {resource.modified.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-lg bg-[var(--color-bg-raised)] px-3 py-3 text-[12px] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
            {loading
              ? "Evaluating drift against the pinned versions…"
              : drift
                ? "No resource drift counts were returned."
                : "Drift counts are not available."}
          </div>
        )}
      </div>
    </Card>
  );
}

function BaselineMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="min-w-0 bg-[var(--color-surface)] px-5 py-3">
      <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </div>
      <div className="mt-1 text-[12px] font-medium text-[var(--color-text)]">
        {value}
      </div>
      {detail ? (
        <div
          className="mt-0.5 truncate text-[10.5px] text-[var(--color-text-muted)]"
          title={detail}
        >
          {detail}
        </div>
      ) : null}
    </div>
  );
}

function BaselineDriftEntries({
  drift,
  expandedEntry,
  onToggleEntry,
  onRollback,
}: {
  drift: DriftBaselineDriftResult;
  expandedEntry: string | null;
  onToggleEntry: (entry: DriftBaselineDriftEntry) => void;
  onRollback?: () => void;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border-soft)] px-5 py-3">
        <div>
          <h2 className="text-[12px] font-semibold text-[var(--color-text)]">
            Drift entries
          </h2>
          <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
            {drift.entries.length.toLocaleString()} objects differ from the
            baseline
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-[11px] text-[var(--color-text-muted)]">
            {formatDateTime(drift.evaluatedAt)}
          </span>
          {onRollback && drift.entries.length > 0 ? (
            <Button size="sm" variant="primary" onClick={onRollback}>
              Roll back drift
            </Button>
          ) : null}
        </div>
      </div>

      {drift.entries.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <div className="text-[13px] font-medium text-[var(--color-text)]">
            No baseline drift detected
          </div>
          <div className="mt-1 text-[12px] text-[var(--color-text-muted)]">
            The latest tracked versions match this baseline.
          </div>
        </div>
      ) : (
        <div className="divide-y divide-[var(--color-border-soft)]">
          {drift.entries.map((entry, index) => {
            const key = baselineDriftEntryKey(entry);
            const expanded = expandedEntry === key;
            const detailId = `baseline-drift-detail-${index}`;
            const name = entry.displayName ?? entry.graphId;
            return (
              <div key={key}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={detailId}
                  aria-label={`${expanded ? "Collapse" : "Expand"} baseline drift details for ${name}`}
                  onClick={() => onToggleEntry(entry)}
                  className={`grid w-full gap-3 px-5 py-3 text-left transition-colors hover:bg-[var(--color-surface-hover)] sm:grid-cols-[minmax(0,1fr)_auto] ${focusRingClass}`}
                >
                  <span className="min-w-0">
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <ChangeKindChip kind={entry.changeKind} />
                      <span className="truncate text-[13px] font-medium text-[var(--color-text)]">
                        {name}
                      </span>
                    </span>
                    <span className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
                      <span>{entry.resourceLabel}</span>
                      <span
                        aria-hidden="true"
                        className="text-[var(--color-text-faint)]"
                      >
                        ·
                      </span>
                      <span className="truncate font-mono">
                        {entry.graphId}
                      </span>
                    </span>
                  </span>
                  <span className="flex items-center justify-end gap-3 self-center text-[11px] text-[var(--color-text-muted)]">
                    <span>{formatFieldCount(entry.fieldChangeCount)}</span>
                    <IconChevronDown
                      size={13}
                      aria-hidden="true"
                      className={`transition-transform ${expanded ? "rotate-180" : ""}`}
                    />
                  </span>
                </button>
                {expanded ? (
                  <div
                    id={detailId}
                    className="space-y-3 border-t border-[var(--color-border-soft)] bg-[var(--color-bg)] p-4"
                  >
                    {entry.truncated ? (
                      <div className="rounded-lg bg-[var(--color-warning-soft)] px-3 py-2 text-[12px] leading-5 text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
                        Raw before/after bodies exceeded the local display cap.
                        The field list below is complete.
                      </div>
                    ) : null}
                    <FieldChangesTable changes={entry.changes} />
                  </div>
                ) : null}
              </div>
            );
          })}
          {drift.hasMore ? (
            <div className="px-5 py-3 text-center text-[11px] text-[var(--color-text-muted)]">
              This evaluation contains more drift entries than the local display
              limit.
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function NoActiveBaselineState({ onCreate }: { onCreate: () => void }) {
  return (
    <Card className="px-6 py-14 text-center">
      <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-lg bg-[var(--color-bg-raised)] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
        <IconClock size={18} />
      </div>
      <h2 className="mt-4 text-[15px] font-semibold text-[var(--color-text)]">
        No active baseline
      </h2>
      <p className="mx-auto mt-1 max-w-[560px] text-[13px] leading-6 text-[var(--color-text-muted)]">
        A baseline is a pinned copy of this tenant&apos;s configuration. Drift
        is measured against it.
      </p>
      <Button
        className="mt-5"
        variant="primary"
        leadingIcon={<IconPlus size={12} />}
        onClick={onCreate}
      >
        Create baseline
      </Button>
    </Card>
  );
}

function RetiredBaselinesList({ baselines }: { baselines: DriftBaseline[] }) {
  if (baselines.length === 0) return null;
  return (
    <section aria-labelledby="retired-baselines-heading">
      <h2
        id="retired-baselines-heading"
        className="mb-2 px-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]"
      >
        Retired baselines
      </h2>
      <Card className="divide-y divide-[var(--color-border-soft)] overflow-hidden">
        {baselines.map((baseline) => (
          <div
            key={baseline.id}
            className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:gap-6"
          >
            <div className="min-w-0 truncate text-[12.5px] font-medium text-[var(--color-text-soft)]">
              {baseline.name}
            </div>
            <div className="text-[11px] text-[var(--color-text-muted)]">
              Created {formatDateTime(baseline.createdAt)}
            </div>
            <div className="text-[11px] text-[var(--color-text-muted)]">
              {baseline.retiredAt
                ? `Retired ${formatDateTime(baseline.retiredAt)}`
                : "Retired date unavailable"}
            </div>
          </div>
        ))}
      </Card>
    </section>
  );
}

function FiltersRow({
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
    <div className="flex flex-wrap items-center gap-2">
      <label
        htmlFor="changes-resource-filter"
        className="inline-flex h-9 items-center gap-2 rounded-lg bg-[var(--color-surface)] px-3 text-[12px] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]"
      >
        <span>Resource</span>
        <select
          id="changes-resource-filter"
          name="changes-resource-filter"
          aria-label="Resource"
          value={selectedResource}
          disabled={disabled}
          onChange={(event) => onResourceChange(event.target.value)}
          className={`h-7 min-w-[190px] bg-transparent text-[var(--color-text)] outline-none disabled:opacity-60 ${focusRingClass}`}
        >
          <option value="all">All tracked resources</option>
          {resources.map((resource) => (
            <option key={resource.resource} value={resource.resource}>
              {resource.resourceLabel}
            </option>
          ))}
        </select>
      </label>

      <label
        htmlFor="changes-date-range"
        className="inline-flex h-9 items-center gap-2 rounded-lg bg-[var(--color-surface)] px-3 text-[12px] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]"
      >
        <span>Range</span>
        <select
          id="changes-date-range"
          name="changes-date-range"
          aria-label="Date range"
          value={dateRange}
          disabled={disabled}
          onChange={(event) => onDateRangeChange(event.target.value)}
          className={`h-7 min-w-[110px] bg-transparent text-[var(--color-text)] outline-none disabled:opacity-60 ${focusRingClass}`}
        >
          {DATE_RANGES.map((range) => (
            <option key={range.value} value={range.value}>
              {range.label}
            </option>
          ))}
        </select>
      </label>

      <div className="relative min-w-[240px] flex-1 sm:flex-none">
        <IconSearch
          size={14}
          aria-hidden="true"
          className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
        />
        <label htmlFor="changes-display-name-filter" className="sr-only">
          Filter by display name
        </label>
        <input
          id="changes-display-name-filter"
          name="changes-display-name-filter"
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Filter by display name"
          autoComplete="off"
          className="h-9 w-full rounded-lg bg-[var(--color-surface)] pl-9 pr-3 text-[13px] text-[var(--color-text)] ring-1 ring-[var(--color-border-soft)] placeholder:text-[var(--color-text-placeholder)] focus:outline-none focus:ring-[var(--color-accent)]/50"
        />
      </div>
    </div>
  );
}

function TimelinePanel({
  loading,
  groups,
  hasAnyEntries,
  hasMore,
  selectedEntry,
  onSelectEntry,
  onLoadMore,
}: {
  loading: boolean;
  groups: EntryDayGroup[];
  hasAnyEntries: boolean;
  hasMore: boolean;
  selectedEntry: DriftTimelineEntry | null;
  onSelectEntry: (entry: DriftTimelineEntry) => void;
  onLoadMore: () => void;
}) {
  return (
    <Card className="min-w-0 overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border-soft)] px-4 py-3">
        <div>
          <div className="text-[12px] font-semibold text-[var(--color-text)]">
            Timeline
          </div>
          <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
            Newest local snapshot changes first
          </div>
        </div>
        {loading ? (
          <Pill tone="default">
            <span className="h-2 w-2 animate-spin rounded-full border border-current border-t-transparent" />
            Loading
          </Pill>
        ) : null}
      </div>

      {loading && groups.length === 0 ? (
        <div className="space-y-2 p-4">
          {Array.from({ length: 5 }).map((_, index) => (
            <div
              key={index}
              className="h-16 animate-pulse rounded-lg bg-[var(--color-bg-raised)] ring-1 ring-[var(--color-border-soft)]"
            />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <div className="px-5 py-12 text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--color-bg-raised)] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
            <IconSearch size={17} />
          </div>
          <div className="mt-3 text-[13px] font-medium text-[var(--color-text)]">
            No changes match these filters.
          </div>
          <div className="mt-1 text-[12px] text-[var(--color-text-muted)]">
            Widen the date range, clear the display-name filter, or choose
            another resource.
          </div>
        </div>
      ) : (
        <div className="divide-y divide-[var(--color-border-soft)]">
          {groups.map((group) => (
            <section
              key={group.key}
              aria-labelledby={`changes-day-${group.key}`}
            >
              <div
                id={`changes-day-${group.key}`}
                className="bg-[var(--color-bg)] px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]"
              >
                {group.label}
              </div>
              <div className="divide-y divide-[var(--color-border-soft)]">
                {group.entries.map((entry) => (
                  <TimelineRow
                    key={entry.id}
                    entry={entry}
                    selected={selectedEntry?.id === entry.id}
                    onClick={() => onSelectEntry(entry)}
                  />
                ))}
              </div>
            </section>
          ))}
          {hasMore ? (
            <div className="flex justify-center px-4 py-4">
              <Button
                size="sm"
                variant="secondary"
                leadingIcon={<IconChevronDown size={12} />}
                onClick={onLoadMore}
              >
                Load more
              </Button>
            </div>
          ) : hasAnyEntries ? (
            <div className="px-4 py-3 text-center text-[11px] text-[var(--color-text-muted)]">
              End of local change history for this filter.
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function TimelineRow({
  entry,
  selected,
  onClick,
}: {
  entry: DriftTimelineEntry;
  selected: boolean;
  onClick: () => void;
}) {
  const isBaseline = entry.changeKind === "baseline";
  const objectName = displayNameForEntry(entry);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={selected}
      aria-label={
        isBaseline
          ? `Open baseline details for ${entry.resourceLabel}`
          : `Open change details for ${objectName}`
      }
      className={`grid w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-hover)] ${focusRingClass} ${
        selected ? "bg-[var(--color-accent-soft)]/40" : ""
      }`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ChangeKindChip kind={entry.changeKind} />
        <span className="truncate text-[12px] text-[var(--color-text-soft)]">
          {entry.resourceLabel}
        </span>
        <span aria-hidden="true" className="text-[var(--color-text-faint)]">
          ·
        </span>
        <span className="font-mono text-[10.5px] text-[var(--color-text-muted)]">
          {formatShortDateTime(entry.capturedAt)}
        </span>
        {entry.timestampOnly ? (
          <Pill tone="default" className="text-[10.5px]">
            Timestamp-only
          </Pill>
        ) : null}
      </div>

      {isBaseline ? (
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-[var(--color-text)]">
            Baseline captured: {(entry.rowCount ?? 0).toLocaleString()} objects
            tracked
          </div>
          <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
            Future snapshots compare against this local baseline.
          </div>
        </div>
      ) : (
        <div className="grid min-w-0 gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(160px,0.7fr)]">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-[var(--color-text)]">
              {objectName}
            </div>
            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
              {entry.graphId ? (
                <span className="truncate font-mono">{entry.graphId}</span>
              ) : null}
              {entry.changeKind === "modified" ? (
                <>
                  <span
                    aria-hidden="true"
                    className="text-[var(--color-text-faint)]"
                  >
                    ·
                  </span>
                  <span>
                    {entry.fieldChangeCount.toLocaleString()} fields changed
                  </span>
                </>
              ) : null}
            </div>
          </div>
          <AttributionInline attribution={entry.attribution} />
        </div>
      )}
    </button>
  );
}

function DetailPane({
  entry,
  detail,
  history,
  loading,
  error,
  markdown,
  workspaces,
  onCopy,
  onOpenPin,
}: {
  entry: DriftTimelineEntry | null;
  detail: DriftEntryDetail | null;
  history: DriftObjectHistoryResult | null;
  loading: boolean;
  error: string | null;
  markdown: string;
  workspaces: WorkspaceSummary[];
  onCopy: () => void;
  onOpenPin: () => void;
}) {
  if (!entry) {
    return (
      <Card className="flex min-h-[360px] items-center justify-center p-8 text-center">
        <div>
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--color-bg-raised)] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
            <IconChanges size={18} />
          </div>
          <div className="mt-3 text-[13px] font-medium text-[var(--color-text)]">
            Select a change
          </div>
          <div className="mt-1 text-[12px] leading-5 text-[var(--color-text-muted)]">
            Field-level diffs, attribution, and object history open here.
          </div>
        </div>
      </Card>
    );
  }

  const attribution = detail?.attribution ?? entry.attribution;
  const objectName = displayNameForEntry(entry);
  const canCopy = entry.changeKind === "baseline" || Boolean(detail);
  const canPin = canCopy && markdown.trim().length > 0;

  return (
    <OutputPane
      title={objectName}
      subtitle={`${entry.resourceLabel} · ${formatDateTime(entry.capturedAt)}`}
      badge={<ChangeKindChip kind={entry.changeKind} />}
      actions={
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="ghost"
            leadingIcon={<IconCopy size={12} />}
            disabled={!canCopy}
            onClick={onCopy}
          >
            Copy
          </Button>
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<IconHardDrive size={12} />}
            disabled={!canPin}
            title={
              workspaces.length === 0
                ? "Create a workspace before pinning evidence."
                : undefined
            }
            onClick={onOpenPin}
          >
            Pin to Workspace
          </Button>
        </div>
      }
      className="min-w-0 self-start"
    >
      {entry.changeKind === "baseline" ? (
        <div className="space-y-3 p-4">
          <OutputPaneSection
            title="Baseline"
            collapsible={false}
            bodyClassName="p-3"
          >
            <div className="rounded-lg bg-[var(--color-bg-raised)] px-3 py-2 text-[12px] leading-5 text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
              Baseline captured: {(entry.rowCount ?? 0).toLocaleString()}{" "}
              objects tracked. This is the reference point for later drift
              detection, not a list of additions.
            </div>
          </OutputPaneSection>
        </div>
      ) : loading ? (
        <div className="space-y-3 p-4">
          <div className="h-24 animate-pulse rounded-lg bg-[var(--color-bg)] ring-1 ring-[var(--color-border-soft)]" />
          <div className="h-44 animate-pulse rounded-lg bg-[var(--color-bg)] ring-1 ring-[var(--color-border-soft)]" />
        </div>
      ) : error ? (
        <div className="p-4">
          <InlineState
            tone="danger"
            title="Change detail unavailable"
            message={`${error} The timeline row is still local; reload the detail after the cache settles.`}
          />
        </div>
      ) : detail ? (
        <div className="space-y-3 p-4">
          <AttributionBlock attribution={attribution} />
          {detail.truncated ? (
            <div className="rounded-lg bg-[var(--color-warning-soft)] px-3 py-2 text-[12px] leading-5 text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
              Raw before/after bodies exceeded the local display cap. The field
              list below is complete.
            </div>
          ) : null}
          <FieldChangesTable changes={detail.changes} />
          {history && history.versions.length > 1 ? (
            <OutputPaneSection
              title={`History (${history.versions.length} versions)`}
              defaultCollapsed
            >
              <div className="space-y-2">
                {history.versions.map((version) => (
                  <div
                    key={`${version.snapshotId}:${version.version}`}
                    className="rounded-md bg-[var(--color-bg-raised)] px-3 py-2 ring-1 ring-[var(--color-border-soft)]"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-mono text-[11px] text-[var(--color-text)]">
                        v{version.version}
                      </span>
                      <span className="text-[11px] text-[var(--color-text-muted)]">
                        {formatDateTime(version.capturedAt)}
                      </span>
                    </div>
                    <div className="mt-1 truncate font-mono text-[10.5px] text-[var(--color-text-muted)]">
                      {version.contentHash}
                    </div>
                    {version.removedAt ? (
                      <div className="mt-1 text-[10.5px] text-[var(--color-danger)]">
                        Removed {formatDateTime(version.removedAt)}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </OutputPaneSection>
          ) : null}
        </div>
      ) : (
        <div className="p-4 text-[12px] text-[var(--color-text-muted)]">
          Select a non-baseline change to inspect field-level differences.
        </div>
      )}
    </OutputPane>
  );
}

function FieldChangesTable({ changes }: { changes: DriftFieldChange[] }) {
  return (
    <OutputPaneSection
      title="Field changes"
      subtitle={`${changes.length.toLocaleString()} fields`}
      collapsible={false}
      bodyClassName="p-0"
    >
      {changes.length === 0 ? (
        <div className="px-3 py-3 text-[12px] text-[var(--color-text-muted)]">
          No field-level changes were recorded for this entry.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-[620px] w-full text-left text-[12px]">
            <thead className="bg-[var(--color-bg-raised)] text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
              <tr>
                <th scope="col" className="w-[28%] px-3 py-2 font-medium">
                  Path
                </th>
                <th scope="col" className="w-[31%] px-3 py-2 font-medium">
                  Before
                </th>
                <th
                  scope="col"
                  className="w-[10%] px-3 py-2 text-center font-medium"
                >
                  →
                </th>
                <th scope="col" className="w-[31%] px-3 py-2 font-medium">
                  After
                </th>
              </tr>
            </thead>
            <tbody>
              {changes.map((change) => (
                <tr
                  key={`${change.path}:${change.kind}`}
                  className="border-t border-[var(--color-border-soft)]"
                >
                  <td className="px-3 py-2 align-top font-mono text-[11px] text-[var(--color-accent)]">
                    {change.path}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <LongValue value={change.before} tone="before" />
                  </td>
                  <td className="px-3 py-2 text-center align-top text-[var(--color-text-muted)]">
                    →
                  </td>
                  <td className="px-3 py-2 align-top">
                    <LongValue value={change.after} tone="after" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </OutputPaneSection>
  );
}

function LongValue({
  value,
  tone,
}: {
  value: unknown;
  tone: "before" | "after";
}) {
  const [expanded, setExpanded] = useState(false);
  const text = valueToText(value);
  const long = text.length > 180 || text.includes("\n");
  const shown = long && !expanded ? `${text.slice(0, 180)}…` : text;
  const borderLeftColor =
    tone === "before" ? "var(--color-danger)" : "var(--color-success)";

  return (
    <div
      className="rounded-md border-l-2 bg-[var(--color-bg)] px-2 py-1.5 ring-1 ring-[var(--color-border-soft)]"
      style={{ borderLeftColor }}
    >
      <pre className="whitespace-pre-wrap break-words font-mono text-[10.5px] leading-5 text-[var(--color-text-soft)]">
        {shown}
      </pre>
      {long ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          className={`mt-1 rounded text-[10.5px] font-medium text-[var(--color-accent)] hover:text-[var(--color-text)] ${focusRingClass}`}
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      ) : null}
    </div>
  );
}

function AttributionBlock({ attribution }: { attribution?: DriftAttribution }) {
  return (
    <OutputPaneSection title="Attribution" collapsible={false}>
      <div className="grid gap-2 sm:grid-cols-2">
        <AttributeTile
          label="Actor"
          value={
            attribution?.status === "matched"
              ? actorLabel(attribution)
              : "actor unknown"
          }
          muted={attribution?.status !== "matched"}
        />
        <AttributeTile
          label="Activity"
          value={attribution?.activity ?? "No audit activity attached"}
          muted={!attribution?.activity}
        />
        <AttributeTile
          label="Source"
          value={sourceLabel(attribution?.source)}
          muted={!attribution?.source}
        />
        <AttributeTile
          label="When"
          value={
            attribution?.activityDateTime
              ? formatDateTime(attribution.activityDateTime)
              : "No audit timestamp"
          }
          muted={!attribution?.activityDateTime}
        />
      </div>
      {attribution?.alsoMatched ? (
        <div className="mt-2 text-[11px] text-[var(--color-text-muted)]">
          Also matched {attribution.alsoMatched.toLocaleString()} more audit
          events.
        </div>
      ) : null}
      {attribution?.reason === "audit-cache-stale" ? (
        <div className="mt-2 text-[11px] text-[var(--color-text-muted)]">
          Refresh audit data to attribute this change.
        </div>
      ) : null}
    </OutputPaneSection>
  );
}

function AttributeTile({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="rounded-md bg-[var(--color-bg-raised)] px-3 py-2 ring-1 ring-[var(--color-border-soft)]">
      <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </div>
      <div
        className={`mt-0.5 break-words text-[12px] ${
          muted ? "text-[var(--color-text-muted)]" : "text-[var(--color-text)]"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function AttributionInline({
  attribution,
}: {
  attribution?: DriftAttribution;
}) {
  if (attribution?.status === "matched") {
    return (
      <div className="min-w-0 text-[11px] leading-5 text-[var(--color-text-soft)]">
        <span className="block truncate">{actorLabel(attribution)}</span>
        {attribution.activity ? (
          <span className="block truncate text-[var(--color-text-muted)]">
            {attribution.activity}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="min-w-0 text-[11px] leading-5 text-[var(--color-text-muted)]">
      <span className="block">actor unknown</span>
      {attribution?.reason === "audit-cache-stale" ? (
        <span className="block truncate">refresh audit data to attribute</span>
      ) : null}
    </div>
  );
}

function ChangeKindChip({ kind }: { kind: DriftTimelineChangeKind }) {
  const config = changeKindConfig(kind);
  return (
    <Pill tone={config.tone}>
      {config.icon}
      {config.label}
    </Pill>
  );
}

function InlineState({
  tone,
  title,
  message,
  action,
}: {
  tone: "danger" | "success" | "info";
  title: string;
  message: string;
  action?: ReactNode;
}) {
  const palette =
    tone === "danger"
      ? "bg-[var(--color-danger-soft)] text-[var(--color-danger)] ring-[var(--color-danger)]/30"
      : tone === "success"
        ? "bg-[var(--color-success-soft)] text-[var(--color-success)] ring-[var(--color-success)]/30"
        : "bg-[var(--color-bg-raised)] text-[var(--color-text-soft)] ring-[var(--color-border-soft)]";
  const icon =
    tone === "danger" ? (
      <IconWarning size={14} />
    ) : tone === "success" ? (
      <StatusDot tone="success" />
    ) : (
      <StatusDot tone="info" />
    );
  return (
    <div
      className={`flex items-start justify-between gap-3 rounded-lg px-3 py-2 ring-1 ${palette}`}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-0.5 shrink-0">{icon}</span>
        <div className="min-w-0">
          <div className="text-[12px] font-medium">{title}</div>
          <div className="mt-0.5 text-[11.5px] leading-5 text-[var(--color-text-soft)]">
            {message}
          </div>
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

function NoTenantState({ onConnect }: { onConnect: () => void }) {
  return (
    <Card className="max-w-[640px] p-6">
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-danger-soft)] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
          <IconWarning size={18} />
        </div>
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-[var(--color-text)]">
            No tenant connected
          </div>
          <div className="mt-1 text-[13px] leading-6 text-[var(--color-text-muted)]">
            Change history is tenant-scoped. Connect a Microsoft 365 tenant
            before reviewing drift snapshots.
          </div>
          <Button className="mt-4" variant="primary" onClick={onConnect}>
            Connect tenant
          </Button>
        </div>
      </div>
    </Card>
  );
}

function NoBaselineState({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <Card className="max-w-[720px] p-6">
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-bg-raised)] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
          <IconClock size={18} />
        </div>
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-[var(--color-text)]">
            No change history yet
          </div>
          <div className="mt-1 text-[13px] leading-6 text-[var(--color-text-muted)]">
            Drift tracking starts with your first cache refresh, history appears
            after the second.
          </div>
          <Button
            className="mt-4"
            variant="secondary"
            leadingIcon={<IconRefresh size={12} />}
            onClick={onOpenSettings}
          >
            Open cache settings
          </Button>
        </div>
      </div>
    </Card>
  );
}

function BaselineOnlyState({ baselineDate }: { baselineDate?: string }) {
  return (
    <Card className="max-w-[720px] p-6">
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-success-soft)] text-[var(--color-success)] ring-1 ring-[var(--color-success)]/25">
          <StatusDot tone="success" />
        </div>
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-[var(--color-text)]">
            Baseline captured
          </div>
          <div className="mt-1 text-[13px] leading-6 text-[var(--color-text-muted)]">
            No configuration changes detected
            {baselineDate ? ` since ${formatDateTime(baselineDate)}` : ""}.
          </div>
        </div>
      </div>
    </Card>
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
  const errorId = "baseline-name-error";
  const hintId = "baseline-name-hint";
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
        <div>
          <label
            htmlFor="baseline-name"
            className="block text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]"
          >
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
            aria-describedby={error ? `${hintId} ${errorId}` : hintId}
            disabled={busy}
            onChange={(event) => onNameChange(event.target.value)}
            className="mt-2 h-10 w-full rounded-lg bg-[var(--color-bg-raised)] px-3 text-[13px] text-[var(--color-text)] outline-none ring-1 ring-[var(--color-border-soft)] placeholder:text-[var(--color-text-placeholder)] focus:ring-[var(--color-accent)] disabled:opacity-60"
          />
          <span
            id={hintId}
            className="mt-1.5 block text-[11px] text-[var(--color-text-muted)]"
          >
            Use 1 to 80 characters. Leading and trailing spaces are removed.
          </span>
        </div>

        {error ? (
          <div
            id={errorId}
            role="alert"
            className="rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-[12px] leading-5 text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30"
          >
            <div>{error}</div>
            {isRefreshCacheRequired(error) ? (
              <div className="mt-1 text-[var(--color-text-soft)]">
                Refresh cache in Settings, then try again.
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={onClose}
          >
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
      <ModalHeader
        title="Retire baseline"
        subtitle={baseline?.name ?? "Active baseline"}
        onClose={onClose}
      />
      <div className="space-y-4 p-6">
        <p className="text-[13px] leading-6 text-[var(--color-text-soft)]">
          Retiring keeps history but stops drift evaluation and pruning
          protection.
        </p>
        {error ? (
          <div
            role="alert"
            className="rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-[12px] leading-5 text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30"
          >
            {error}
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy || !baseline}
            onClick={onConfirm}
          >
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
  error,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  entryCount: number;
  error: string | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} size="md">
      <ModalHeader
        title="Roll back baseline drift"
        subtitle="Pre-flight review"
        onClose={onClose}
      />
      <div className="space-y-4 p-6">
        <p className="text-[13px] leading-6 text-[var(--color-text-soft)]">
          This builds a rollback plan for the drifted objects below. Nothing is
          applied until you review the plan and type the confirmation phrase on
          the run page.
        </p>
        <div className="rounded-lg bg-[var(--color-bg-raised)] px-3 py-2 text-[12px] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
          {entryCount.toLocaleString()} drifted{" "}
          {entryCount === 1 ? "entry" : "entries"}{" "}
          {entryCount === 1 ? "is" : "are"} included in this plan.
        </div>
        {error ? (
          <div
            role="alert"
            className="rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-[12px] leading-5 text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30"
          >
            {error}
          </div>
        ) : null}
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
      <ModalHeader
        title="Pin change to workspace"
        subtitle="Creates tenant-scoped evidence from this local drift diff"
        badge={<Pill tone="accent">Workspace evidence</Pill>}
        onClose={onClose}
      />
      <div className="space-y-4 p-6">
        {workspaces.length === 0 ? (
          <div className="rounded-lg bg-[var(--color-bg-raised)] px-4 py-3 text-[12px] leading-5 text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
            No active workspaces exist for this tenant. Create a workspace
            first, then pin this change as evidence.
          </div>
        ) : (
          <label htmlFor="pin-change-workspace" className="block">
            <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              Workspace
            </span>
            <select
              id="pin-change-workspace"
              name="pin-change-workspace"
              value={selectedWorkspaceId}
              onChange={(event) => onWorkspaceChange(event.target.value)}
              className="mt-2 h-9 w-full rounded-md bg-[var(--color-bg-raised)] px-2 text-[12.5px] text-[var(--color-text)] outline-none ring-1 ring-[var(--color-border-soft)] focus:ring-[var(--color-accent)]"
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="max-h-44 overflow-y-auto rounded-lg bg-[var(--color-bg)] p-3 font-mono text-[10.5px] leading-5 text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
          {markdown.slice(0, 900)}
          {markdown.length > 900 ? "\n…" : ""}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {workspaces.length === 0 ? (
            <Button variant="secondary" onClick={onOpenWorkspaces}>
              Open Workspaces
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={!selectedWorkspaceId}
              onClick={onConfirm}
            >
              Pin change
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

interface EntryDayGroup {
  key: string;
  label: string;
  entries: DriftTimelineEntry[];
}

function groupEntriesByDay(entries: DriftTimelineEntry[]): EntryDayGroup[] {
  const groups = new Map<string, EntryDayGroup>();
  for (const entry of entries) {
    const date = new Date(entry.capturedAt);
    const key = Number.isNaN(date.getTime())
      ? "unknown"
      : `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    const existing = groups.get(key);
    if (existing) {
      existing.entries.push(entry);
      continue;
    }
    groups.set(key, {
      key,
      label: Number.isNaN(date.getTime())
        ? "Unknown date"
        : date.toLocaleDateString(undefined, {
            weekday: "long",
            month: "short",
            day: "numeric",
            year: "numeric",
          }),
      entries: [entry],
    });
  }
  return [...groups.values()];
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

function tenantCompareEntryKey(
  entry: DriftTenantCompareEntry,
  index: number,
): string {
  return `${entry.resource}:${entry.displayName}:${entry.bucket}:${index}`;
}

function tenantResourceSummaryLabel(
  resource: DriftTenantCompareResult["resources"][number],
): string {
  return `${resource.resourceLabel}: ${resource.matchedSame} matched same, ${resource.different} different, ${resource.onlyInA} only in A, ${resource.onlyInB} only in B, ${resource.ambiguous} ambiguous`;
}

function ambiguousObjectNote(count: number): string {
  return count === 1
    ? "1 object shares a display name and was not matched."
    : `${count.toLocaleString()} objects share a display name and were not matched.`;
}

function dateRangeBounds(value: DateRangeValue): {
  from?: string;
  to?: string;
} {
  const range = DATE_RANGES.find((entry) => entry.value === value);
  if (!range?.ms) return {};
  const to = new Date();
  return {
    from: new Date(to.getTime() - range.ms).toISOString(),
    to: to.toISOString(),
  };
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
  tone: "default" | "accent" | "success" | "danger";
  icon: ReactNode;
} {
  if (kind === "added") {
    return { label: "Added", tone: "success", icon: <IconPlus size={10} /> };
  }
  if (kind === "removed") {
    return { label: "Removed", tone: "danger", icon: <IconClose size={10} /> };
  }
  if (kind === "modified") {
    return {
      label: "Modified",
      tone: "accent",
      icon: <IconChanges size={10} />,
    };
  }
  return { label: "Baseline", tone: "default", icon: <IconClock size={10} /> };
}

function displayNameForEntry(entry: DriftTimelineEntry): string {
  return entry.displayName ?? entry.graphId ?? entry.resourceLabel;
}

function actorLabel(attribution: DriftAttribution): string {
  return (
    attribution.actor?.userPrincipalName ??
    attribution.actor?.appDisplayName ??
    attribution.actor?.actorType ??
    "actor recorded"
  );
}

function sourceLabel(source?: DriftAttribution["source"]): string {
  if (source === "intuneAudit") return "Intune audit";
  if (source === "directoryAudit") return "Directory audit";
  return "No audit source";
}

function baselineResourceLabel(
  resource: GraphCacheResourceKind,
  drift: DriftBaselineDriftResult | null,
): string {
  const label = drift?.resources.find(
    (entry) => entry.resource === resource,
  )?.resourceLabel;
  if (label) return label;
  const spaced = resource.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}

function baselineDriftEntryKey(entry: DriftBaselineDriftEntry): string {
  return `${entry.resource}:${entry.graphId}:${entry.changeKind}`;
}

function formatFieldCount(count: number): string {
  return count === 1
    ? "1 field changed"
    : `${count.toLocaleString()} fields changed`;
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
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
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
      attribution?.status === "matched"
        ? actorLabel(attribution)
        : "actor unknown"
    }`,
  );
  if (attribution?.activity) lines.push(`- Activity: ${attribution.activity}`);
  if (attribution?.source)
    lines.push(`- Source: ${sourceLabel(attribution.source)}`);
  if (attribution?.alsoMatched) {
    lines.push(`- Also matched: ${attribution.alsoMatched} more audit events`);
  }
  if (attribution?.reason === "audit-cache-stale") {
    lines.push(
      "- Attribution hint: refresh audit data to attribute this change",
    );
  }
  if (entry.timestampOnly) lines.push("- Timestamp-only change: yes");
  if (detail?.truncated) {
    lines.push(
      "- Display note: raw before/after bodies exceeded the local display cap; field list is complete",
    );
  }
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
