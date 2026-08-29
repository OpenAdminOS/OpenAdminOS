import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import Fleet from "./Fleet";
import {
  createMockAppState,
  makeMockBridge,
  mockTenant,
  renderRoute,
} from "../test/test-utils";
import type {
  FleetDriftStatusResult,
  TenantGroup,
  TenantRecord,
} from "../shared/openAdminOS";

const secondTenant: TenantRecord = {
  id: "tenant-2",
  displayName: "Fabrikam Europe",
  username: "admin@fabrikam.example",
  homeAccountId: "home-account-2",
  addedAt: "2026-08-01T08:00:00.000Z",
  lastUsedAt: "2026-08-29T08:00:00.000Z",
  entraTier: "p2",
};

const fleetStatus: FleetDriftStatusResult = {
  evaluatedAt: "2026-08-29T08:24:00.000Z",
  tenants: [
    {
      tenantId: mockTenant.id,
      tenantName: mockTenant.displayName,
      baseline: {
        id: "baseline-1",
        name: "Production standard",
        createdAt: "2026-08-18T08:00:00.000Z",
      },
      drift: {
        added: 2,
        removed: 1,
        modified: 3,
        evaluatedAt: "2026-08-29T08:24:00.000Z",
      },
      lastCaptureAt: "2026-08-29T08:12:00.000Z",
      trackedObjectCount: 48,
    },
    {
      tenantId: secondTenant.id,
      tenantName: secondTenant.displayName,
      lastCaptureAt: "2026-08-28T08:00:00.000Z",
      trackedObjectCount: 0,
    },
  ],
};

const fleetState = createMockAppState({
  tenants: [mockTenant, secondTenant],
  activeTenantId: mockTenant.id,
});

describe("Fleet", () => {
  it("renders tenant drift rows and the no-baseline state", async () => {
    const getFleetDriftStatus = vi.fn(async () => fleetStatus);
    renderRoute(<Fleet />, {
      path: "/fleet",
      route: "/fleet",
      bridge: makeMockBridge(
        {
          getFleetDriftStatus,
          listMultiTenantAgentBatches: vi.fn(async () => []),
        },
        fleetState,
      ),
    });

    const table = await screen.findByRole("table", {
      name: "Tenant fleet drift status",
    });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);

    const contosoRow = within(table)
      .getByText(mockTenant.displayName)
      .closest("tr");
    expect(contosoRow).not.toBeNull();
    expect(within(contosoRow!).getByText("Production standard")).toBeInTheDocument();
    expect(within(contosoRow!).getByText("+2")).toBeInTheDocument();
    expect(within(contosoRow!).getByText("-1")).toBeInTheDocument();
    expect(within(contosoRow!).getByText("~3")).toBeInTheDocument();
    expect(within(contosoRow!).getByText("48")).toBeInTheDocument();

    const fabrikamRow = within(table)
      .getByText(secondTenant.displayName)
      .closest("tr");
    expect(fabrikamRow).not.toBeNull();
    expect(within(fabrikamRow!).getByText("No baseline")).toBeInTheDocument();
    expect(within(fabrikamRow!).getByText("Not evaluated")).toBeInTheDocument();
    expect(getFleetDriftStatus).toHaveBeenCalledWith({});
  });

  it("refetches fleet status with the selected tenant group", async () => {
    const user = userEvent.setup();
    const groups: TenantGroup[] = [
      {
        id: "group-eu",
        name: "EU tenants",
        tenantIds: [secondTenant.id],
        createdAt: "2026-08-01T08:00:00.000Z",
        updatedAt: "2026-08-29T08:00:00.000Z",
      },
    ];
    const getFleetDriftStatus = vi.fn(async () => fleetStatus);
    renderRoute(<Fleet />, {
      path: "/fleet",
      route: "/fleet",
      bridge: makeMockBridge(
        {
          getFleetDriftStatus,
          listTenantGroups: vi.fn(async () => groups),
          listMultiTenantAgentBatches: vi.fn(async () => []),
        },
        fleetState,
      ),
    });

    const groupFilter = await screen.findByRole("combobox", {
      name: "Tenant group",
    });
    await waitFor(() =>
      expect(within(groupFilter).getByRole("option", { name: "EU tenants" })).toBeInTheDocument(),
    );
    await user.selectOptions(groupFilter, "group-eu");

    await waitFor(() =>
      expect(getFleetDriftStatus).toHaveBeenCalledWith({ groupId: "group-eu" }),
    );
  });
});
