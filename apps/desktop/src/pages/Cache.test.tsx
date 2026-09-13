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
  await screen.findByRole("button", { name: "Preload all 2 resources" });
  await user.type(
    screen.getByRole("textbox", { name: "Find a resource" }),
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
