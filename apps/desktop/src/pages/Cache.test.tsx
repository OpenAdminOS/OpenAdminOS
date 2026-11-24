import { useAppState } from "../state";
import { useLocation } from "react-router";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import Cache from "./Cache";
import { createMockAppState, makeMockBridge, renderRoute } from "../test/test-utils";
import type { GraphCacheStatus } from "../shared/openAdminOS";
it("selects all resources, keeps filtering separate, and sends a tenant-scoped preload", async () => {
  const status: GraphCacheStatus = {
    tenantId: "tenant-1",
    resources: [
      {
        resource: "managedDevices",
        label: "Managed devices",
        rows: 0,
        scopeSet: ["DeviceManagementManagedDevices.Read.All"],
      },
      {
        resource: "users",
        label: "Users",
        rows: 0,
        scopeSet: ["User.Read.All"],
      },
    ],
  };
  const bridge = makeMockBridge({
    getGraphCacheStatus: vi.fn(async () => status),
  });
  renderRoute(<Cache />, { bridge, route: "/cache", path: "/cache" });
  const user = userEvent.setup();
  await screen.findByRole("button", { name: "Preload all 2 resources" }, { timeout: 4000 });
  await user.click(screen.getByText("Show 2 resources"));
  await user.type(
    screen.getByRole("searchbox", { name: "Find a resource" }),
    "Managed",
  );
  await user.click(
    screen.getByRole("button", { name: "Preload all 2 resources" }),
  );
  await waitFor(() =>
    expect(bridge.startGraphCachePreload).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      resources: ["managedDevices", "users"],
    }),
  );
  await user.click(screen.getByRole("checkbox", { name: "Select all" }));
  expect(
    screen.getByRole("button", { name: "Preload 0 resources" }),
  ).toBeDisabled();
});

it("shows ungranted resources without selecting or refreshing them", async () => {
  const status: GraphCacheStatus = {
    tenantId: "tenant-1",
    resources: [
      {
        resource: "managedDevices",
        label: "Managed devices",
        rows: 0,
        scopeSet: ["DeviceManagementManagedDevices.Read.All"],
        notGrantedService: {
          serviceId: "intune",
          service: "Intune",
          partId: "intune.devices",
          part: "Intune devices and configuration",
          serviceMissing: false,
        },
      },
      {
        resource: "users",
        label: "Users",
        rows: 2,
        scopeSet: ["User.Read.All"],
        refreshedAt: "2026-10-27T10:00:00.000Z",
      },
    ],
  };
  const bridge = makeMockBridge({
    getGraphCacheStatus: vi.fn(async () => status),
  });
  renderRoute(<Cache />, { bridge, route: "/cache", path: "/cache" });
  const user = userEvent.setup();

  expect(await screen.findByRole("button", { name: "Preload all 1 resources" })).toBeInTheDocument();
  await user.click(screen.getByText("Show 2 resources"));
  expect(screen.getByText("Not connected")).toBeInTheDocument();
  expect(screen.getByText("Needs Intune devices and configuration")).toBeInTheDocument();
  expect(screen.queryByText("Refresh failed")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add Intune access" })).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "Managed devices" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Preload all 1 resources" }));
  await waitFor(() =>
    expect(bridge.startGraphCachePreload).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      resources: ["users"],
    }),
  );
});

it("opens cached rows from Data, pages through them, shows JSON, and handles an empty search", async () => {
  const bridge = makeMockBridge({
    getGraphCacheStatus: vi.fn(async (): Promise<GraphCacheStatus> => ({
      tenantId: "tenant-1",
      resources: [{ resource: "users", label: "Users", rows: 101, tenantTotal: 150, scopeSet: [] }],
    })),
    readGraphCacheRow: vi.fn(async () => ({ status: "ready" as const, json: '{"displayName": "Sample 101"}', truncated: false })),
    browseGraphCache: vi.fn(async ({ offset, search }) => ({
      offset,
      total: search ? 0 : 101,
      rows: search ? [] : Array.from({ length: offset ? 1 : 100 }, (_, index) => {
        const id = String(offset + index + 1);
        return { id, name: `Sample ${id}`, user: null };
      }),
    })),
  });
  renderRoute(<Cache />, { bridge, route: "/cache", path: "/cache" });
  const user = userEvent.setup();
  await user.click(await screen.findByText("Show 1 resources"));
  await user.click(screen.getByRole("link", { name: "Browse Users" }));
  expect(await screen.findByText("Rows 1 to 100 of 101")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Next" }));
  expect(await screen.findByText("Rows 101 to 101 of 101")).toBeInTheDocument();
  expect(screen.getByText("101 of 150 cached")).toBeInTheDocument();
  const detailsButton = screen.getByRole("button", { name: "View JSON for Sample 101" });
  await user.click(detailsButton);
  expect(screen.getByRole("heading", { name: "Sample 101" })).toHaveFocus();
  expect(await screen.findByText('{"displayName": "Sample 101"}')).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Close details" }));
  expect(detailsButton).toHaveFocus();
  await user.type(screen.getByRole("searchbox", { name: "Search cached rows" }), "missing");
  expect(await screen.findByText("No matching rows")).toBeInTheDocument();
  expect(bridge.browseGraphCache).toHaveBeenLastCalledWith({
    tenantId: "tenant-1", resource: "users", limit: 100, offset: 0, search: "missing",
  });
});

it("opens a resource with no cache from a direct link", async () => {
  const bridge = makeMockBridge({
    getGraphCacheStatus: vi.fn(async (): Promise<GraphCacheStatus> => ({
      tenantId: "tenant-1",
      resources: [{ resource: "groups", label: "Groups", rows: 0, scopeSet: [] }],
    })),
  });
  renderRoute(<Cache />, { bridge, route: "/cache?resource=groups", path: "/cache" });
  expect(await screen.findByText("No rows cached")).toBeInTheDocument();
  expect(screen.getByText("Refresh this resource in Data to load rows.")).toBeInTheDocument();
});

it("offers a retry after a local read failure and shows no partial badge for capped logs", async () => {
  const browse = vi.fn().mockRejectedValueOnce(new Error("Storage unavailable"))
    .mockResolvedValue({ offset: 0, total: 0, rows: [] });
  const bridge = makeMockBridge({
    getGraphCacheStatus: vi.fn(async (): Promise<GraphCacheStatus> => ({
      tenantId: "tenant-1",
      resources: [{ resource: "signIns", label: "Sign-ins", rows: 0, pageLimitReached: true, scopeSet: [] }],
    })),
    browseGraphCache: browse,
  });
  renderRoute(<Cache />, { bridge, route: "/cache?resource=signIns", path: "/cache" });
  expect(await screen.findByText("Local storage could not return the cached rows. Try reading them again.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("No rows cached")).toBeInTheDocument();
  expect(screen.queryByText("Partial cache")).not.toBeInTheDocument();
  expect(browse).toHaveBeenCalledTimes(2);
});

it("closes the browser and removes its query parameter when the organization changes", async () => {
  function Harness() {
    const { setActiveTenant } = useAppState();
    const location = useLocation();
    return <><button onClick={() => void setActiveTenant("tenant-2")}>Switch organization</button>
      <output>{location.pathname}{location.search}</output><Cache /></>;
  }
  const initial = createMockAppState();
  const bridge = makeMockBridge({
    getGraphCacheStatus: vi.fn(async (tenantId): Promise<GraphCacheStatus> => ({
      tenantId,
      resources: [{ resource: "users", label: "Users", rows: 0, scopeSet: [] }],
    })),
  }, { ...initial, tenants: [...initial.tenants, { ...initial.tenants[0]!, id: "tenant-2", displayName: "Other organization" }] });
  renderRoute(<Harness />, { bridge, route: "/cache?resource=users", path: "/cache" });
  expect(await screen.findByText(/Contoso IT · Cached on this device/)).toBeInTheDocument();
  await screen.findByText("No rows cached");
  fireEvent.click(screen.getByText("Switch organization"));
  expect(await screen.findByText("/cache")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(bridge.browseGraphCache).not.toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-2" }));
});
