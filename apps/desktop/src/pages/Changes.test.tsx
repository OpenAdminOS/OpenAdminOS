import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

import Changes from "./Changes";
import {
  createMockAppState,
  createAwaitingConfirmationRun,
  makeMockBridge,
  mockTenant,
  renderRoute,
  renderWithAppState,
} from "../test/test-utils";
import type {
  DriftBaseline,
  DriftBaselineDriftResult,
  DriftEntryDetail,
  GraphCacheStatus,
  DriftObjectHistoryResult,
  DriftStatus,
  DriftTenantCompareInput,
  DriftTenantCompareResult,
  DriftTimeCompareResult,
  DriftTimelineEntry,
  DriftTimelineInput,
  DriftTimelineResult,
  TenantRecord,
} from "../shared/openAdminOS";

const baselineCapturedAt = "2026-07-01T08:00:00.000Z";
const modifiedAt = "2026-07-05T09:30:00.000Z";

const activeNamedBaseline: DriftBaseline = {
  id: "baseline-1",
  tenantId: "tenant-1",
  name: "Quarterly control plane",
  status: "active",
  createdAt: baselineCapturedAt,
  pinnedObjectCount: 18,
  resources: ["deviceConfigurations", "configurationPolicies"],
};

const namedBaselineDrift: DriftBaselineDriftResult = {
  tenantId: "tenant-1",
  baseline: activeNamedBaseline,
  evaluatedAt: modifiedAt,
  resources: [
    {
      resource: "deviceConfigurations",
      resourceLabel: "Device configurations",
      added: 1,
      removed: 0,
      modified: 2,
    },
    {
      resource: "configurationPolicies",
      resourceLabel: "Configuration policies",
      added: 0,
      removed: 1,
      modified: 0,
    },
  ],
  entries: [
    {
      resource: "deviceConfigurations",
      resourceLabel: "Device configurations",
      graphId: "policy-1",
      displayName: "Device restriction policy",
      changeKind: "modified",
      fieldChangeCount: 1,
      truncated: true,
      changes: [
        {
          path: "settings.passwordRequired",
          kind: "changed",
          before: false,
          after: true,
        },
      ],
    },
  ],
  hasMore: false,
  limit: 100,
};

const driftStatus: DriftStatus = {
  tenantId: "tenant-1",
  resources: [
    {
      resource: "deviceConfigurations",
      resourceLabel: "Device configurations",
      baselineCaptured: true,
      baselineCapturedAt,
      lastSnapshotAt: modifiedAt,
      snapshotCount: 2,
      totalTrackedVersions: 3,
      currentObjectCount: 2,
    },
    {
      resource: "configurationPolicies",
      resourceLabel: "Configuration policies",
      baselineCaptured: true,
      baselineCapturedAt,
      lastSnapshotAt: modifiedAt,
      snapshotCount: 2,
      totalTrackedVersions: 2,
      currentObjectCount: 1,
    },
  ],
};

const modifiedEntry: DriftTimelineEntry = {
  id: "snapshot-2:deviceConfigurations:policy-1:modified",
  snapshotId: "snapshot-2",
  capturedAt: modifiedAt,
  resource: "deviceConfigurations",
  resourceLabel: "Device configurations",
  changeKind: "modified",
  fieldChangeCount: 2,
  timestampOnly: false,
  graphId: "policy-1",
  displayName: "Device restriction policy",
  attribution: {
    status: "matched",
    actor: {
      userPrincipalName: "admin@contoso.example",
      actorType: "user",
    },
    activity: "Update device configuration",
    activityDateTime: "2026-07-05T09:21:00.000Z",
    source: "intuneAudit",
    alsoMatched: 2,
  },
};

const unknownActorEntry: DriftTimelineEntry = {
  id: "snapshot-2:configurationPolicies:policy-2:modified",
  snapshotId: "snapshot-2",
  capturedAt: "2026-07-05T09:15:00.000Z",
  resource: "configurationPolicies",
  resourceLabel: "Configuration policies",
  changeKind: "modified",
  fieldChangeCount: 1,
  timestampOnly: true,
  graphId: "policy-2",
  displayName: "Conditional Access baseline",
  attribution: {
    status: "unknown",
    reason: "audit-cache-stale",
  },
};

const timeCompareResult: DriftTimeCompareResult = {
  tenantId: "tenant-1",
  from: "2026-07-01T00:00:00.000Z",
  to: "2026-07-08T00:00:00.000Z",
  evaluatedAt: "2026-07-08T00:01:00.000Z",
  resources: namedBaselineDrift.resources,
  entries: namedBaselineDrift.entries,
  hasMore: false,
  limit: 100,
  retentionLimited: true,
};

const secondTenant: TenantRecord = {
  ...mockTenant,
  id: "tenant-2",
  displayName: "Fabrikam IT",
  username: "admin@fabrikam.example",
  homeAccountId: "home-account-2",
};

const tenantCompareResult: DriftTenantCompareResult = {
  tenantIdA: "tenant-1",
  tenantIdB: "tenant-2",
  evaluatedAt: "2026-07-08T00:01:00.000Z",
  includeAssignments: false,
  tenantAHasData: true,
  tenantBHasData: true,
  resources: [
    {
      resource: "deviceConfigurations",
      resourceLabel: "Device configurations",
      matchedSame: 4,
      different: 2,
      onlyInA: 1,
      onlyInB: 3,
      ambiguous: 2,
    },
  ],
  entries: [
    {
      resource: "deviceConfigurations",
      resourceLabel: "Device configurations",
      displayName: "Device restriction policy",
      bucket: "different",
      fieldChangeCount: 1,
      changes: [
        {
          path: "settings.passwordRequired",
          kind: "changed",
          before: false,
          after: true,
        },
      ],
    },
    {
      resource: "deviceConfigurations",
      resourceLabel: "Device configurations",
      displayName: "Contoso kiosk policy",
      bucket: "only-in-a",
      fieldChangeCount: 0,
      changes: [],
    },
  ],
  hasMore: false,
  limit: 100,
};

describe("Changes page", () => {
  it("opens URL-addressable baseline and compare views", async () => {
    const baselineBridge = makeTimelineBridge([], {
      listDriftBaselines: vi.fn(async () => [activeNamedBaseline]),
      getDriftBaselineDrift: vi.fn(async () => namedBaselineDrift),
      getDriftTimeCompare: vi.fn(async () => timeCompareResult),
    });

    const baselineRender = renderRoute(<Changes />, {
      path: "/changes",
      route: "/changes?view=baselines",
      bridge: baselineBridge,
    });
    expect(
      await screen.findByRole("tab", { name: "Baselines" }),
    ).toHaveAttribute("aria-selected", "true");
    baselineRender.unmount();

    renderRoute(<Changes />, {
      path: "/changes",
      route: "/changes?view=compare",
      bridge: baselineBridge,
    });
    expect(await screen.findByRole("tab", { name: "Compare" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("button", { name: "Run compare" })).toBeInTheDocument();
  });

  it("opens the all-tenant scope from the URL", async () => {
    const appState = createMockAppState({
      tenants: [mockTenant, secondTenant],
      activeTenantId: mockTenant.id,
    });

    renderRoute(<Changes />, {
      path: "/changes",
      route: "/changes?scope=all",
      bridge: makeTimelineBridge(
        [],
        {
          getFleetDriftStatus: vi.fn(async () => ({
            evaluatedAt: modifiedAt,
            tenants: [
              {
                tenantId: mockTenant.id,
                tenantName: mockTenant.displayName,
                lastCaptureAt: modifiedAt,
                trackedObjectCount: 18,
              },
              {
                tenantId: secondTenant.id,
                tenantName: secondTenant.displayName,
                lastCaptureAt: modifiedAt,
                trackedObjectCount: 12,
              },
            ],
          })),
          listMultiTenantAgentBatches: vi.fn(async () => []),
        },
        appState,
      ),
    });

    expect(await screen.findByRole("radio", { name: "All tenants" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      await screen.findByRole("table", { name: "Tenant fleet drift status" }),
    ).toBeInTheDocument();
  });

  it("refreshes and cancels the active tenant cache from the header", async () => {
    const user = userEvent.setup();
    const refreshedStatus: GraphCacheStatus = {
      tenantId: mockTenant.id,
      resources: [
        {
          resource: "deviceConfigurations",
          label: "Device configurations",
          rows: 18,
          refreshedAt: modifiedAt,
          scopeSet: ["DeviceManagementConfiguration.Read.All"],
        },
      ],
    };
    const runningStatus: GraphCacheStatus = {
      ...refreshedStatus,
      preload: {
        tenantId: mockTenant.id,
        status: "running",
        total: 2,
        completed: 1,
        active: ["configurationPolicies"],
        results: [],
      },
    };
    const cancelledStatus: GraphCacheStatus = {
      ...refreshedStatus,
      preload: {
        ...runningStatus.preload!,
        status: "cancelled",
        active: [],
      },
    };
    const getGraphCacheStatus = vi
      .fn()
      .mockResolvedValueOnce(refreshedStatus)
      .mockResolvedValueOnce(runningStatus)
      .mockResolvedValue(cancelledStatus);
    const startGraphCachePreload = vi.fn(async () => undefined);
    const cancelGraphCachePreload = vi.fn(async () => undefined);
    const getDriftTimeline = vi.fn(
      async (input: DriftTimelineInput): Promise<DriftTimelineResult> => ({
        tenantId: mockTenant.id,
        entries: [],
        hasMore: false,
        limit: input.limit ?? 100,
      }),
    );

    renderRoute(<Changes />, {
      path: "/changes",
      route: "/changes",
      bridge: makeTimelineBridge([], {
        getGraphCacheStatus,
        startGraphCachePreload,
        cancelGraphCachePreload,
        getDriftTimeline,
      }),
    });

    await screen.findByText(/Updated /);
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(startGraphCachePreload).toHaveBeenCalledWith({
        tenantId: mockTenant.id,
        resources: ["deviceConfigurations"],
      });
    });
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(cancelGraphCachePreload).toHaveBeenCalledWith(mockTenant.id);
    await waitFor(() => expect(getDriftTimeline).toHaveBeenCalledTimes(2));
  });

  it("renders the baseline-only empty state from DriftStatus", async () => {
    const bridge = makeMockBridge({
      getDriftStatus: vi.fn(async () => driftStatus),
      getDriftTimeline: vi.fn(async (): Promise<DriftTimelineResult> => ({
        tenantId: "tenant-1",
        entries: [
          {
            id: "snapshot-1:baseline",
            snapshotId: "snapshot-1",
            capturedAt: baselineCapturedAt,
            resource: "deviceConfigurations",
            resourceLabel: "Device configurations",
            changeKind: "baseline",
            fieldChangeCount: 0,
            timestampOnly: false,
            rowCount: 12,
          },
        ],
        hasMore: false,
        limit: 100,
      })),
    });

    renderRoute(<Changes />, {
      path: "/changes",
      route: "/changes",
      bridge,
    });

    expect(await screen.findByText("Baseline captured")).toBeInTheDocument();
    expect(
      screen.getByText(/No configuration changes detected since/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: "Baselines" }),
    ).not.toBeInTheDocument();
  });

  it("shows the baseline empty state and creates a named baseline", async () => {
    const user = userEvent.setup();
    let storedBaselines: DriftBaseline[] = [];
    const listDriftBaselines = vi.fn(async () => storedBaselines);
    const createDriftBaseline = vi.fn(async ({ name }: { name: string }) => {
      const created = { ...activeNamedBaseline, name };
      storedBaselines = [created];
      return created;
    });
    const getDriftBaselineDrift = vi.fn(async () => ({
      ...namedBaselineDrift,
      baseline: storedBaselines[0] ?? activeNamedBaseline,
      entries: [],
    }));

    renderRoute(<Changes />, {
      path: "/changes",
      route: "/changes",
      bridge: makeTimelineBridge([], {
        listDriftBaselines,
        createDriftBaseline,
        getDriftBaselineDrift,
      }),
    });

    await user.click(await screen.findByRole("tab", { name: "Baselines" }));
    expect(
      await screen.findByText(
        /Create a baseline to pin the tenant's current tracked configuration/i,
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create baseline" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Create baseline",
    });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Baseline name" }),
      "  Monthly control plane  ",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Create baseline" }),
    );

    await waitFor(() => {
      expect(createDriftBaseline).toHaveBeenCalledWith({
        tenantId: "tenant-1",
        name: "Monthly control plane",
      });
    });
    expect(
      await screen.findByText("Monthly control plane"),
    ).toBeInTheDocument();
  });

  it("renders baseline resource counts and expands a field diff", async () => {
    const user = userEvent.setup();
    const getDriftBaselineDrift = vi.fn(async () => namedBaselineDrift);

    renderRoute(<Changes />, {
      path: "/changes",
      route: "/changes",
      bridge: makeTimelineBridge([], {
        listDriftBaselines: vi.fn(async () => [activeNamedBaseline]),
        getDriftBaselineDrift,
      }),
    });

    await user.click(await screen.findByRole("tab", { name: "Baselines" }));
    expect(
      await screen.findByRole("row", {
        name: "Device configurations 1 0 2",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("row", {
        name: "Configuration policies 0 1 0",
      }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByText("Device restriction policy").closest("tr")!,
    );
    expect(
      await screen.findByText("settings.passwordRequired"),
    ).toBeInTheDocument();
    expect(screen.getByText("false")).toBeInTheDocument();
    expect(screen.getByText("true")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Raw before and after bodies exceeded the local display cap/i,
      ),
    ).toBeInTheDocument();
    expect(getDriftBaselineDrift).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      baselineId: "baseline-1",
    });
  });

  it("builds a whole-drift rollback plan and opens the run route", async () => {
    const user = userEvent.setup();
    const startBaselineRollback = vi.fn(async () =>
      createAwaitingConfirmationRun({
        id: "rollback-run-1",
        agentSlug: "baseline-rollback",
        origin: "baseline-rollback",
        rollback: {
          baselineId: activeNamedBaseline.id,
          requiredScopes: ["DeviceManagementConfiguration.ReadWrite.All"],
          manualCount: 0,
        },
      }),
    );
    const bridge = makeTimelineBridge([], {
      listDriftBaselines: vi.fn(async () => [activeNamedBaseline]),
      getDriftBaselineDrift: vi.fn(async () => namedBaselineDrift),
      startBaselineRollback,
    });

    renderWithAppState(
      <Routes>
        <Route path="/changes" element={<Changes />} />
        <Route path="/runs/:id" element={<div>Rollback run route</div>} />
      </Routes>,
      { route: "/changes", bridge },
    );

    await user.click(await screen.findByRole("tab", { name: "Baselines" }));
    await user.click(
      await screen.findByRole("button", { name: "Roll back drift" }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Roll back baseline drift",
    });
    expect(dialog).toHaveTextContent(
      "This builds a rollback plan for all drifted objects. Nothing is applied until you review the plan and type the confirmation phrase on the run page.",
    );
    expect(dialog).toHaveTextContent("1 drifted entry included.");

    await user.click(
      within(dialog).getByRole("button", { name: "Build rollback plan" }),
    );

    await waitFor(() => {
      expect(startBaselineRollback).toHaveBeenCalledWith({
        tenantId: "tenant-1",
      });
    });
    expect(await screen.findByText("Rollback run route")).toBeInTheDocument();
  });

  it("shows a no-automatable-actions rollback error inside the pre-flight modal", async () => {
    const user = userEvent.setup();
    const message =
      "No drifted objects can be rolled back automatically. Review the manual items in the drift detail.";
    const startBaselineRollback = vi.fn(async () => {
      throw new Error(message);
    });

    renderRoute(<Changes />, {
      path: "/changes",
      route: "/changes",
      bridge: makeTimelineBridge([], {
        listDriftBaselines: vi.fn(async () => [activeNamedBaseline]),
        getDriftBaselineDrift: vi.fn(async () => namedBaselineDrift),
        startBaselineRollback,
      }),
    });

    await user.click(await screen.findByRole("tab", { name: "Baselines" }));
    await user.click(
      await screen.findByRole("button", { name: "Roll back drift" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Roll back baseline drift",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Build rollback plan" }),
    );

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(message);
    expect(startBaselineRollback).toHaveBeenCalledWith({
      tenantId: "tenant-1",
    });
  });

  it("retires the active baseline and returns to the empty state", async () => {
    const user = userEvent.setup();
    const retiredBaseline: DriftBaseline = {
      ...activeNamedBaseline,
      status: "retired",
      retiredAt: modifiedAt,
    };
    const retireDriftBaseline = vi.fn(async () => retiredBaseline);

    renderRoute(<Changes />, {
      path: "/changes",
      route: "/changes",
      bridge: makeTimelineBridge([], {
        listDriftBaselines: vi.fn(async () => [activeNamedBaseline]),
        getDriftBaselineDrift: vi.fn(async () => namedBaselineDrift),
        retireDriftBaseline,
      }),
    });

    await user.click(await screen.findByRole("tab", { name: "Baselines" }));
    await screen.findByText("Quarterly control plane");
    await user.click(
      screen.getByRole("button", { name: "Actions for Quarterly control plane" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Retire" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Retire baseline",
    });
    expect(
      within(dialog).getByText(
        "Retiring keeps history but stops drift evaluation and pruning protection.",
      ),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Retire baseline" }),
    );

    await waitFor(() => {
      expect(retireDriftBaseline).toHaveBeenCalledWith({
        tenantId: "tenant-1",
        baselineId: "baseline-1",
      });
    });
    expect(
      await screen.findByRole("heading", { name: "No active baseline" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Retired")).toBeInTheDocument();
  });

  it("treats a no-active-baseline drift rejection as the empty state", async () => {
    const user = userEvent.setup();

    renderRoute(<Changes />, {
      path: "/changes",
      route: "/changes",
      bridge: makeTimelineBridge([], {
        listDriftBaselines: vi.fn(async () => [activeNamedBaseline]),
        getDriftBaselineDrift: vi.fn(async () => {
          throw new Error("No active baseline exists for this tenant.");
        }),
      }),
    });

    await user.click(await screen.findByRole("tab", { name: "Baselines" }));
    expect(
      await screen.findByRole("heading", { name: "No active baseline" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Baselines unavailable")).not.toBeInTheDocument();
  });

  it("renders over-time counts, retention context, and an expandable field diff", async () => {
    const user = userEvent.setup();
    const getDriftTimeCompare = vi.fn(async () => timeCompareResult);

    renderRoute(<Changes />, {
      path: "/changes",
      route: "/changes",
      bridge: makeTimelineBridge([], { getDriftTimeCompare }),
    });

    await user.click(await screen.findByRole("tab", { name: "Compare" }));
    await user.click(screen.getByRole("button", { name: "Run compare" }));

    expect(
      await screen.findByRole("row", {
        name: "Device configurations 1 0 2",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Retention pruned part of this window, so the earlier side may be incomplete.",
      ),
    ).toBeInTheDocument();

    await user.click(
      screen.getByText("Device restriction policy").closest("tr")!,
    );
    expect(
      await screen.findByText("settings.passwordRequired"),
    ).toBeInTheDocument();
    expect(screen.getByText("false")).toBeInTheDocument();
    expect(screen.getByText("true")).toBeInTheDocument();
    expect(getDriftTimeCompare).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        limit: 100,
      }),
    );
  });

  it("validates an inverted time range without calling the compare API", async () => {
    const user = userEvent.setup();
    const getDriftTimeCompare = vi.fn(async () => timeCompareResult);

    renderRoute(<Changes />, {
      path: "/changes",
      route: "/changes",
      bridge: makeTimelineBridge([], { getDriftTimeCompare }),
    });

    await user.click(await screen.findByRole("tab", { name: "Compare" }));
    const from = screen.getByLabelText("From");
    const to = screen.getByLabelText("To");
    await user.clear(from);
    await user.type(from, "2026-08-10");
    await user.clear(to);
    await user.type(to, "2026-08-01");

    expect(
      screen.getByText("From date must be earlier than the to date."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run compare" })).toBeDisabled();
    expect(getDriftTimeCompare).not.toHaveBeenCalled();
  });

  it("renders tenant buckets and re-runs when assignments are included", async () => {
    const user = userEvent.setup();
    const getDriftTenantCompare = vi.fn(
      async (
        input: DriftTenantCompareInput,
      ): Promise<DriftTenantCompareResult> => ({
        ...tenantCompareResult,
        includeAssignments: input.includeAssignments ?? false,
      }),
    );
    const appState = createMockAppState({
      tenants: [mockTenant, secondTenant],
      activeTenantId: mockTenant.id,
    });

    renderRoute(<Changes />, {
      path: "/changes",
      route: "/changes",
      bridge: makeTimelineBridge(
        [],
        {
          getDriftTimeCompare: vi.fn(async () => timeCompareResult),
          getDriftTenantCompare,
        },
        appState,
      ),
    });

    await user.click(await screen.findByRole("tab", { name: "Compare" }));
    await user.click(screen.getByRole("radio", { name: "Between tenants" }));
    await user.click(screen.getByRole("button", { name: "Run compare" }));

    expect(
      await screen.findByRole("row", {
        name: "Device configurations 4 2 1 3 2",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Objects with duplicate display names are marked ambiguous and are not matched.",
      ),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("checkbox", { name: "Include assignments" }),
    );
    await user.click(screen.getByRole("button", { name: "Run compare" }));
    await waitFor(() => {
      expect(getDriftTenantCompare).toHaveBeenLastCalledWith({
        tenantIdA: "tenant-1",
        tenantIdB: "tenant-2",
        limit: 100,
        includeAssignments: true,
      });
    });
  });

  it("shows the second-tenant state when only one tenant is connected", async () => {
    const user = userEvent.setup();
    const getDriftTenantCompare = vi.fn();

    renderRoute(<Changes />, {
      path: "/changes",
      route: "/changes",
      bridge: makeTimelineBridge([], {
        getDriftTimeCompare: vi.fn(async () => timeCompareResult),
        getDriftTenantCompare,
      }),
    });

    await user.click(await screen.findByRole("tab", { name: "Compare" }));
    await user.click(screen.getByRole("radio", { name: "Between tenants" }));

    expect(
      screen.getByRole("heading", {
        name: "Connect a second tenant",
      }),
    ).toBeInTheDocument();
    expect(getDriftTenantCompare).not.toHaveBeenCalled();
  });

  it("renders a timeline with matched and unknown attribution", async () => {
    renderRoute(<Changes />, {
      path: "/changes",
      route: "/changes",
      bridge: makeTimelineBridge([modifiedEntry, unknownActorEntry]),
    });

    expect(
      await screen.findByText("Device restriction policy"),
    ).toBeInTheDocument();
    expect(screen.getByText("admin@contoso.example")).toBeInTheDocument();
    expect(screen.getByText("Conditional Access baseline")).toBeInTheDocument();
    expect(screen.getByText(/actor unknown/i)).toBeInTheDocument();
    expect(
      screen.getByText(/refresh audit data to attribute/i),
    ).toBeInTheDocument();
  });

  it("opens the detail pane and shows field changes", async () => {
    const user = userEvent.setup();
    const getDriftEntryDetail = vi.fn(async (): Promise<DriftEntryDetail> => ({
      summary: "Two fields changed.",
      changes: [
        {
          path: "assignments[0].target.groupId",
          kind: "changed",
          before: "group-old",
          after: "group-new",
        },
        {
          path: "settings.passwordRequired",
          kind: "changed",
          before: false,
          after: true,
        },
      ],
      attribution: modifiedEntry.attribution,
    }));
    const getDriftObjectHistory = vi.fn(
      async (): Promise<DriftObjectHistoryResult> => ({
        tenantId: "tenant-1",
        resource: "deviceConfigurations",
        graphId: "policy-1",
        versions: [
          {
            version: 1,
            snapshotId: "snapshot-1",
            capturedAt: baselineCapturedAt,
            contentHash: "hash-old",
          },
          {
            version: 2,
            snapshotId: "snapshot-2",
            capturedAt: modifiedAt,
            contentHash: "hash-new",
          },
        ],
      }),
    );

    renderRoute(<Changes />, {
      path: "/changes",
      route: "/changes",
      bridge: makeTimelineBridge([modifiedEntry], {
        getDriftEntryDetail,
        getDriftObjectHistory,
      }),
    });

    await user.click(
      (await screen.findByText("Device restriction policy")).closest("tr")!,
    );

    expect(await screen.findByText("Field changes")).toBeInTheDocument();
    expect(
      screen.getByText("assignments[0].target.groupId"),
    ).toBeInTheDocument();
    expect(screen.getByText("group-old")).toBeInTheDocument();
    expect(screen.getByText("group-new")).toBeInTheDocument();
    expect(screen.getByText("settings.passwordRequired")).toBeInTheDocument();
    expect(screen.getByText("History (2)")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Pin change to workspace" }),
    );
    const pinDialog = await screen.findByRole("dialog", {
      name: "Pin change to workspace",
    });
    expect(
      within(pinDialog).getByRole("button", { name: "Open Workspaces" }),
    ).toBeInTheDocument();
    expect(getDriftEntryDetail).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      snapshotId: "snapshot-2",
      resource: "deviceConfigurations",
      graphId: "policy-1",
    });
  });

  it("filters by resource through the drift timeline input", async () => {
    const user = userEvent.setup();
    const getDriftTimeline = vi.fn(
      async (input: DriftTimelineInput): Promise<DriftTimelineResult> => ({
        tenantId: "tenant-1",
        entries:
          input.resources?.[0] === "configurationPolicies"
            ? [unknownActorEntry]
            : [modifiedEntry, unknownActorEntry],
        hasMore: false,
        limit: input.limit ?? 100,
      }),
    );

    renderRoute(<Changes />, {
      path: "/changes",
      route: "/changes",
      bridge: makeTimelineBridge([modifiedEntry, unknownActorEntry], {
        getDriftTimeline,
      }),
    });

    expect(
      await screen.findByText("Device restriction policy"),
    ).toBeInTheDocument();

    await user.selectOptions(
      screen.getByLabelText("Resource"),
      "configurationPolicies",
    );

    await waitFor(() => {
      expect(getDriftTimeline).toHaveBeenLastCalledWith(
        expect.objectContaining({
          tenantId: "tenant-1",
          resources: ["configurationPolicies"],
        }),
      );
    });
    expect(
      await screen.findByText("Conditional Access baseline"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Device restriction policy"),
    ).not.toBeInTheDocument();

    expect(
      screen.getByText("Conditional Access baseline").closest("tr"),
    ).toHaveAttribute("tabindex", "0");
  });
});

function makeTimelineBridge(
  entries: DriftTimelineEntry[],
  overrides: Parameters<typeof makeMockBridge>[0] = {},
  appState = createMockAppState(),
) {
  return makeMockBridge(
    {
      getDriftStatus: vi.fn(async () => driftStatus),
      getDriftTimeline: vi.fn(
        async (input: DriftTimelineInput): Promise<DriftTimelineResult> => ({
          tenantId: "tenant-1",
          entries,
          hasMore: false,
          limit: input.limit ?? 100,
        }),
      ),
      getDriftEntryDetail: vi.fn(async () => ({
        summary: "No detail fixture configured.",
        changes: [],
      })),
      getDriftObjectHistory: vi.fn(
        async (): Promise<DriftObjectHistoryResult> => ({
          tenantId: "tenant-1",
          resource: "deviceConfigurations",
          graphId: "policy-1",
          versions: [],
        }),
      ),
      ...overrides,
    },
    appState,
  );
}
