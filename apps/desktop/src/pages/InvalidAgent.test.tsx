import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import Agents from "./Agents";
import { createMockAgent, createMockAppState, makeMockBridge, renderRoute } from "../test/test-utils";
import type { InvalidAgentManifest } from "../shared/openAdminOS";

const REASON =
  "descriptor.services: [entra] does not cover DeviceManagementManagedDevices.Read.All; these scopes belong to intune";
const SOURCE = "descriptor:\n  id: wrong-services\n  services:\n    - entra\n";

const invalidEntry: InvalidAgentManifest = {
  id: "wrong-services",
  folder: "wrong-services",
  registryPath: "/Users/admin/agents/wrong-services",
  manifestPath: "/Users/admin/agents/wrong-services/manifest.yaml",
  reason: REASON,
  source: "user",
  sourceText: SOURCE,
};

const broken = createMockAgent({
  id: "wrong-services",
  slug: "wrong-services",
  name: "Wrong services",
  mode: "read",
  scopes: ["DeviceManagementManagedDevices.Read.All"],
  services: ["entra"],
  registryPath: invalidEntry.registryPath,
  manifestError: REASON,
});
const healthy = createMockAgent({
  id: "devices",
  slug: "devices",
  name: "Inactive devices",
  mode: "read",
  scopes: ["DeviceManagementManagedDevices.Read.All"],
  services: ["intune"],
});

function state() {
  return createMockAppState({ installedAgents: [broken, healthy], invalidAgents: [invalidEntry] });
}

describe("an agent with an invalid manifest", () => {
  it("is listed as unavailable with the reason and cannot run", async () => {
    renderRoute(<Agents />, { path: "/agents", route: "/agents", bridge: makeMockBridge({}, state()) });

    const list = await screen.findByLabelText("Installed agents");
    const rowOf = (name: string) => within(list).getByText(name).closest(".calm-list-row") as HTMLElement;
    const brokenRow = rowOf("Wrong services");
    expect(within(brokenRow).getByText(`Unavailable. The manifest is invalid. ${REASON}`)).toBeInTheDocument();
    expect(within(brokenRow).getByRole("button", { name: "Run" })).toBeDisabled();
    expect(within(rowOf("Inactive devices")).getByRole("button", { name: "Run" })).toBeEnabled();
  });

  it("shows the invalid manifest in the hub with Edit manifest", async () => {
    const user = userEvent.setup();
    const validateAgentDraft = vi.fn(async () => ({ yamlSource: SOURCE, validationErrors: [REASON] }));
    renderRoute(<Agents />, {
      path: "/agents",
      route: "/agents?source=hub",
      bridge: makeMockBridge({ validateAgentDraft }, state()),
    });

    const row = await screen.findByLabelText("wrong-services unavailable");
    expect(within(row).getByText("Unavailable")).toBeInTheDocument();
    expect(within(row).getByText(`Manifest is invalid. ${REASON}`)).toBeInTheDocument();
    expect(within(row).getByText(invalidEntry.manifestPath)).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "Edit manifest" }));
    expect(validateAgentDraft).toHaveBeenCalledWith(SOURCE, "wrong-services");
    expect(await screen.findByDisplayValue(/id: wrong-services/)).toBeInTheDocument();
  });

  it("shows the designed notice on the agent page and keeps Run disabled", async () => {
    const user = userEvent.setup();
    renderRoute(<Agents />, { path: "/agents/:slug", route: "/agents/wrong-services", bridge: makeMockBridge({}, state()) });

    const notice = await screen.findByRole("alert", { name: "Wrong services manifest is invalid" });
    expect(within(notice).getByText("Wrong services cannot run or be scheduled until its manifest passes validation.")).toBeInTheDocument();
    expect(within(notice).getByText(REASON)).toBeInTheDocument();
    expect(within(notice).getByText(invalidEntry.manifestPath)).toBeInTheDocument();
    expect(within(notice).getByRole("button", { name: "Edit manifest" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run agent" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Choose provider or model for this run" })).toBeDisabled();
    await user.click(within(notice).getByRole("button", { name: "Uninstall" }));
    expect(await screen.findByRole("dialog", { name: /Uninstall agent/ })).toBeInTheDocument();
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
  });
});
