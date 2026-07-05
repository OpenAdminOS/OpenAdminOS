import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import Changes from "./Changes";
import {
  createMockAppState,
  makeMockBridge,
  renderRoute,
} from "../test/test-utils";
import type {
  DriftEntryDetail,
  DriftObjectHistoryResult,
  DriftStatus,
  DriftTimelineEntry,
  DriftTimelineInput,
  DriftTimelineResult,
} from "../shared/openAdminOS";

const baselineCapturedAt = "2026-07-01T08:00:00.000Z";
const modifiedAt = "2026-07-05T09:30:00.000Z";

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

describe("Changes page", () => {
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
  });

  it("renders a timeline with matched and unknown attribution", async () => {
    renderRoute(<Changes />, {
      path: "/changes",
      route: "/changes",
      bridge: makeTimelineBridge([modifiedEntry, unknownActorEntry]),
    });

    expect(await screen.findByText("Device restriction policy")).toBeInTheDocument();
    expect(screen.getByText("admin@contoso.example")).toBeInTheDocument();
    expect(screen.getByText("Conditional Access baseline")).toBeInTheDocument();
    expect(screen.getByText("actor unknown")).toBeInTheDocument();
    expect(screen.getByText("refresh audit data to attribute")).toBeInTheDocument();
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
      await screen.findByRole("button", {
        name: /Open change details for Device restriction policy/i,
      }),
    );

    expect(await screen.findByText("Field changes")).toBeInTheDocument();
    expect(screen.getByText("assignments[0].target.groupId")).toBeInTheDocument();
    expect(screen.getByText("group-old")).toBeInTheDocument();
    expect(screen.getByText("group-new")).toBeInTheDocument();
    expect(screen.getByText("settings.passwordRequired")).toBeInTheDocument();
    expect(screen.getByText("History (2 versions)")).toBeInTheDocument();
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

    expect(await screen.findByText("Device restriction policy")).toBeInTheDocument();

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
    expect(await screen.findByText("Conditional Access baseline")).toBeInTheDocument();
    expect(screen.queryByText("Device restriction policy")).not.toBeInTheDocument();

    const timeline = screen.getByText("Timeline").closest("div");
    expect(timeline).not.toBeNull();
    expect(
      within(document.body).getByRole("button", {
        name: /Open change details for Conditional Access baseline/i,
      }),
    ).toBeInTheDocument();
  });
});

function makeTimelineBridge(
  entries: DriftTimelineEntry[],
  overrides: Parameters<typeof makeMockBridge>[0] = {},
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
    createMockAppState(),
  );
}
