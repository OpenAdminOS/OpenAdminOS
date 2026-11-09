import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";

import Connections from "../pages/Connections";
import Marketplace from "../pages/Marketplace";
import { agentNameForRun } from "../pages/Runs";
import {
  splashtopConnectionSummary,
  type AppState,
  type RunRecord,
  type SplashtopConnectionSummary,
} from "../shared/openAdminOS";
import { createMockAppState, createMockMcpServers, makeMockBridge, renderRoute } from "../test/test-utils";

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function stateWith(connection?: SplashtopConnectionSummary): AppState {
  const state = createMockAppState();
  return { ...state, ...(connection ? { splashtopConnections: [connection] } : {}) };
}

function organizationId(state: AppState): string {
  return `org-${state.tenants[0]!.id}`;
}

function connected(state: AppState): SplashtopConnectionSummary {
  return splashtopConnectionSummary(organizationId(state), {
    region: "eu",
    teamId: 11125,
    account: "admin@contoso.example",
    connectedAt: "2026-11-09T10:00:00.000Z",
    tokenSetAt: "2026-11-09T10:00:00.000Z",
    lastCheckedAt: "2026-11-09T10:00:00.000Z",
    tokenScopes: ["team_computers", "inventory", "logs"],
  });
}

function renderConnections(state: AppState, overrides: Parameters<typeof makeMockBridge>[0] = {}, route = "/connections") {
  const bridge = makeMockBridge(overrides, state);
  renderRoute(
    <Routes>
      <Route path="/connections" element={<Connections />} />
      <Route path="/runs/:runId" element={<LocationProbe />} />
    </Routes>,
    { path: "*", route, bridge },
  );
  return bridge;
}

describe("Splashtop on Connections", () => {
  it("connects with the region and token, and names the host the token goes to", async () => {
    const user = userEvent.setup();
    const state = stateWith();
    const connectSplashtop = vi.fn(async () => connected(state));
    renderConnections(state, { connectSplashtop });
    const row = await screen.findByRole("region", { name: "Splashtop" });
    // The real logo through ServiceMark, dashed while not connected.
    expect(row.querySelector('.svc-mark[data-service="splashtop"][data-off="true"] [data-service-logo="splashtop"][data-kind="logo"]')).not.toBeNull();
    await user.click(within(row).getByRole("button", { name: "Connect Splashtop" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Splashtop Enterprise");
    expect(dialog).toHaveTextContent("Team Owner or Super Admin");
    expect(dialog).toHaveTextContent("sent only to webapi.splashtop.com over HTTPS");
    await user.click(within(dialog).getByRole("radio", { name: /EU/ }));
    expect(dialog).toHaveTextContent("sent only to webapi.splashtop.eu over HTTPS");
    expect(within(dialog).getByRole("button", { name: "Check and connect" })).toBeDisabled();
    const token = within(dialog).getByLabelText("API token");
    expect(token).toHaveAttribute("type", "password");
    await user.type(token, "secret-token-123456");
    await user.click(within(dialog).getByRole("button", { name: "Check and connect" }));
    await waitFor(() => expect(connectSplashtop).toHaveBeenCalledWith({ organizationId: organizationId(state), region: "eu", token: "secret-token-123456" }));
  });

  it("shows the host's designed error and keeps the dialog open", async () => {
    const user = userEvent.setup();
    const connectSplashtop = vi.fn(async () => {
      throw new Error("Error invoking remote method 'openadminos:connect-splashtop': SplashtopApiError: Splashtop did not accept the API token (HTTP 401) at webapi.splashtop.com. The token may be revoked or expired, or it was created in another region: a token works only on its own region's host. Check the region, or create a new token in my.splashtop.com and use Rotate token.");
    });
    renderConnections(stateWith(), { connectSplashtop });
    await user.click(await screen.findByRole("button", { name: "Connect Splashtop" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("API token"), "secret-token-123456");
    await user.click(within(dialog).getByRole("button", { name: "Check and connect" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Splashtop was not changed. Splashtop did not accept the API token (HTTP 401) at webapi.splashtop.com.");
    expect(alert).toHaveTextContent("another region");
    expect(alert).not.toHaveTextContent("Error invoking");
  });

  it("opens the connect step from the Marketplace link", async () => {
    renderConnections(stateWith(), {}, "/connections?connect=splashtop");
    expect(await screen.findByRole("dialog")).toHaveTextContent("Splashtop Open API for");
  });

  it("shows the connection, its parts, and Test, Rotate token and Disconnect", async () => {
    const user = userEvent.setup();
    const state = stateWith();
    const connection = connected(state);
    const testSplashtop = vi.fn(async () => connection);
    const disconnectSplashtop = vi.fn(async () => undefined);
    renderConnections({ ...state, splashtopConnections: [connection] }, { testSplashtop, disconnectSplashtop });
    const row = await screen.findByRole("region", { name: "Splashtop" });
    expect(row).toHaveTextContent("webapi.splashtop.eu, team 11125, admin@contoso.example");
    const parts = within(row).getByRole("list", { name: "Splashtop parts" });
    expect(parts).toHaveTextContent(/Users and groups\s*· Not reached by this token/);
    await user.click(within(row).getByRole("button", { name: "Manage Splashtop" }));
    await user.click(screen.getByRole("menuitem", { name: "Test" }));
    await waitFor(() => expect(testSplashtop).toHaveBeenCalledWith(connection.organizationId));
    await user.click(within(row).getByRole("button", { name: "Manage Splashtop" }));
    await user.click(screen.getByRole("menuitem", { name: "Disconnect" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Nothing is sent to Splashtop");
    await user.click(within(dialog).getByRole("button", { name: "Disconnect Splashtop" }));
    await waitFor(() => expect(disconnectSplashtop).toHaveBeenCalledWith(connection.organizationId));
  });

  it("plans a change from targets Splashtop lists and opens the plan in Runs", async () => {
    const user = userEvent.setup();
    const state = stateWith();
    const connection = connected(state);
    const listSplashtopChangeTargets = vi.fn(async () => [
      { id: 101, label: "DESK-01", detail: "desk-01 · online" },
      { id: 102, label: "DESK-02", detail: "desk-02 · offline" },
    ]);
    const prepareSplashtopChange = vi.fn(async () => ({ id: "run_splashtop", status: "awaiting-confirmation" }) as RunRecord);
    renderConnections({ ...state, splashtopConnections: [connection] }, { listSplashtopChangeTargets, prepareSplashtopChange });
    await user.click(await screen.findByRole("button", { name: "Manage Splashtop" }));
    await user.click(screen.getByRole("menuitem", { name: "Plan a change" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Nothing changes until you confirm the plan in Runs");
    await within(dialog).findByText("DESK-02");
    expect(listSplashtopChangeTargets).toHaveBeenCalledWith(connection.organizationId, "reboot-computers");
    expect(within(dialog).getByRole("button", { name: "Prepare plan" })).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", { name: /DESK-02/ }));
    await user.click(within(dialog).getByRole("button", { name: "Prepare plan" }));
    await waitFor(() => expect(prepareSplashtopChange).toHaveBeenCalledWith({
      organizationId: connection.organizationId,
      kind: "reboot-computers",
      targetIds: [102],
      rebootOption: "normal_reboot",
    }));
    expect(await screen.findByTestId("location")).toHaveTextContent("/runs/run_splashtop");
  });

  it("asks for a valid new name before a rename can be planned", async () => {
    const user = userEvent.setup();
    const state = stateWith();
    const connection = connected(state);
    const listSplashtopChangeTargets = vi.fn(async () => [{ id: 101, label: "DESK-01" }]);
    const prepareSplashtopChange = vi.fn(async () => ({ id: "run_rename" }) as RunRecord);
    renderConnections({ ...state, splashtopConnections: [connection] }, { listSplashtopChangeTargets, prepareSplashtopChange });
    await user.click(await screen.findByRole("button", { name: "Manage Splashtop" }));
    await user.click(screen.getByRole("menuitem", { name: "Plan a change" }));
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Change" }), "rename-computers");
    await user.click(await within(dialog).findByRole("checkbox", { name: /DESK-01/ }));
    const name = within(dialog).getByRole("textbox", { name: "New name for DESK-01" });
    await user.type(name, "bad:name");
    expect(within(dialog).getByRole("button", { name: "Prepare plan" })).toBeDisabled();
    expect(dialog).toHaveTextContent("cannot contain");
    await user.clear(name);
    await user.type(name, "FRONT-DESK");
    await user.click(within(dialog).getByRole("button", { name: "Prepare plan" }));
    await waitFor(() => expect(prepareSplashtopChange).toHaveBeenCalledWith({
      organizationId: connection.organizationId,
      kind: "rename-computers",
      targetIds: [101],
      names: { "101": "FRONT-DESK" },
    }));
  });
});

describe("Splashtop in the Marketplace", () => {
  it("lists Splashtop as a connection that opens the Connections connect step, not as Coming soon", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge({}, createMockAppState({ mcpServers: createMockMcpServers(), installedAgents: [] }));
    renderRoute(
      <Routes>
        <Route path="/marketplace" element={<Marketplace />} />
        <Route path="/connections" element={<LocationProbe />} />
      </Routes>,
      { path: "*", route: "/marketplace?kind=mcp", bridge },
    );
    const card = await screen.findByRole("button", { name: /^Splashtop, connection by Splashtop/ });
    expect(card).toHaveTextContent("Built in");
    expect(card.querySelector('.svc-mark[data-service="splashtop"] [data-service-logo="splashtop"][data-kind="logo"]')).not.toBeNull();
    expect(card).toHaveTextContent("webapi.splashtop.com, .eu or .nr");
    expect(document.body.textContent).not.toMatch(/Coming soon/);
    await user.click(card);
    expect(await screen.findByTestId("location")).toHaveTextContent("/connections?connect=splashtop");
  });
});

describe("Splashtop runs", () => {
  it("are named as a Splashtop change in run history", () => {
    expect(agentNameForRun({ origin: "splashtop-change", agentSlug: "splashtop-change" } as RunRecord, [])).toBe("Splashtop change");
  });
});
