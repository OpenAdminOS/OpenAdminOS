import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import Cache from "./Cache";
import { makeMockBridge, renderRoute } from "../test/test-utils";
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
      resources: [{ resource: "users", label: "Users", rows: 101, scopeSet: [] }],
    })),
    browseGraphCache: vi.fn(async ({ offset, search }) => ({
      offset,
      total: search ? 0 : 101,
      rows: search ? [] : Array.from({ length: offset ? 1 : 100 }, (_, index) => {
        const id = String(offset + index + 1);
        return { id, name: `Sample ${id}`, user: null, data: { displayName: `Sample ${id}` } };
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
  await user.click(screen.getByRole("button", { name: "View JSON" }));
  expect(screen.getByRole("region", { name: "Cached row JSON" })).toHaveTextContent('"displayName": "Sample 101"');
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
