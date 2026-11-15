import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { EnterpriseStatus, EnterpriseUiBodyView } from "@openadminos/agent-sdk";

import { createMockAgent, makeMockBridge, renderRoute, renderWithAppState } from "../test/test-utils";
import { AgentScheduleCard } from "./AgentScheduleCard";
import { EnterpriseSettingsSections } from "./EnterpriseSettingsSections";
import { EnterpriseUiBody } from "./EnterpriseUi";

const EVERY_ELEMENT: EnterpriseUiBodyView = {
  elements: [
    { type: "status", label: "Office mini PC", value: "Paired", tone: "success" },
    { type: "text", text: "Schedules keep running while this computer is off." },
    { type: "notice", tone: "warning", title: "Sync stopped", message: "A row is missing from the audit chain.", recovery: "Pair the sandbox again." },
    { type: "field", id: "address", label: "Address", kind: "code", placeholder: "100.64.0.10:7443", maxLength: 64 },
    { type: "field", id: "name", label: "Name", kind: "text", value: "Lab" },
    { type: "select", id: "organization", label: "Organization", options: [{ value: "org-1", label: "Contoso" }, { value: "org-2", label: "Fabrikam" }] },
    { type: "button", id: "pair", label: "Pair", kind: "primary", action: "sandboxes.pair" },
    { type: "list", rows: [{ label: "find-inactive-devices", status: { value: "Assigned", tone: "neutral" } }, { label: "compliance-overview" }] },
  ],
};

function renderBody(body: EnterpriseUiBodyView, invokeEnterprise?: (name: string, input?: unknown) => Promise<unknown>) {
  return renderRoute(<EnterpriseUiBody sectionId="sandboxes" body={body} />, {
    path: "*",
    route: "/settings",
    bridge: makeMockBridge(invokeEnterprise ? { invokeEnterprise } : {}),
  });
}

describe("declarative team features UI", () => {
  it("draws every element type with plain text and accessible labels", async () => {
    renderBody(EVERY_ELEMENT);
    expect(await screen.findByText("Office mini PC")).toBeInTheDocument();
    expect(screen.getByText("Paired")).toBeInTheDocument();
    expect(screen.getByText("Schedules keep running while this computer is off.")).toBeInTheDocument();
    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("Sync stopped");
    expect(notice).toHaveTextContent("Pair the sandbox again.");
    const address = screen.getByLabelText("Address");
    expect(address).toHaveAttribute("maxLength", "64");
    expect(address).toHaveAttribute("placeholder", "100.64.0.10:7443");
    expect(address.className).toContain("font-mono");
    expect(screen.getByLabelText("Name")).toHaveValue("Lab");
    expect(screen.getByLabelText("Organization")).toHaveValue("org-1");
    expect(screen.getByRole("button", { name: "Pair" })).toBeInTheDocument();
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("Assigned")).toBeInTheDocument();
    expect(document.querySelector("a")).toBeNull();
  });

  it("draws nothing for an element type outside the closed set", async () => {
    renderBody({ elements: [{ type: "html", html: "<b>x</b>" } as never, { type: "text", text: "Kept." }] });
    expect(await screen.findByText("Kept.")).toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull();
  });

  it("sends the section's values with a button and swaps in the body it returns", async () => {
    const user = userEvent.setup();
    const invokeEnterprise = vi.fn(async () => ({
      body: { elements: [{ type: "status", label: "Office mini PC", value: "Paired", tone: "success" }] },
      notice: { type: "notice", tone: "success", title: "Paired", message: "The sandbox is paired with this desktop." },
    }));
    renderBody(EVERY_ELEMENT, invokeEnterprise);
    await user.type(await screen.findByLabelText("Address"), "100.64.0.10:7443");
    await user.selectOptions(screen.getByLabelText("Organization"), "org-2");
    await user.click(screen.getByRole("button", { name: "Pair" }));
    await waitFor(() =>
      expect(invokeEnterprise).toHaveBeenCalledWith("sandboxes.pair", {
        kind: "button",
        sectionId: "sandboxes",
        buttonId: "pair",
        values: { address: "100.64.0.10:7443", name: "Lab", organization: "org-2" },
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("The sandbox is paired with this desktop.");
    expect(screen.queryByLabelText("Address")).toBeNull();
  });

  it("shows a failed or unreadable answer as a notice with the reason", async () => {
    const user = userEvent.setup();
    const invokeEnterprise = vi
      .fn<(name: string, input?: unknown) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("Error invoking remote method 'openadminos-enterprise:sandboxes.pair': Error: The sandbox at 10.0.0.1:7443 did not answer."))
      .mockResolvedValueOnce({ script: "x" });
    renderBody(EVERY_ELEMENT, invokeEnterprise);
    await user.click(await screen.findByRole("button", { name: "Pair" }));
    const failed = await screen.findByText("The sandbox at 10.0.0.1:7443 did not answer.");
    expect(failed.closest("[data-tone]")).toHaveAttribute("data-tone", "danger");
    expect(screen.getAllByText(/Try again/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Pair" }));
    expect(await screen.findByText(/answered in a form this app does not draw/)).toBeInTheDocument();
  });

  it("asks before a danger button and needs the typed phrase exactly", async () => {
    const user = userEvent.setup();
    const invokeEnterprise = vi.fn(async () => ({ notice: { type: "notice", tone: "success", title: "Unpaired", message: "The sandbox is unpaired." } }));
    renderBody(
      { elements: [{ type: "button", id: "unpair", label: "Unpair", kind: "danger", action: "sandboxes.unpair", confirm: { title: "Unpair Office mini PC", message: "Assigned schedules stop on the sandbox.", typedPhrase: "UNPAIR 1 SANDBOX" } }] },
      invokeEnterprise,
    );
    await user.click(await screen.findByRole("button", { name: "Unpair" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Assigned schedules stop on the sandbox.");
    const confirm = within(dialog).getByRole("button", { name: "Unpair" });
    expect(confirm).toBeDisabled();
    const phrase = within(dialog).getByLabelText("Type UNPAIR 1 SANDBOX to confirm");
    await user.type(phrase, "unpair 1 sandbox");
    expect(confirm).toBeDisabled();
    await user.clear(phrase);
    await user.type(phrase, "UNPAIR 1 SANDBOX");
    expect(invokeEnterprise).not.toHaveBeenCalled();
    await user.click(confirm);
    await waitFor(() => expect(invokeEnterprise).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("The sandbox is unpaired.")).toBeInTheDocument();
  });

  it("does nothing when a confirmation is cancelled", async () => {
    const user = userEvent.setup();
    const invokeEnterprise = vi.fn();
    renderBody({ elements: [{ type: "button", id: "sync", label: "Sync now", kind: "secondary", action: "sandboxes.sync", confirm: { title: "Sync now", message: "Read the sandbox's runs now." } }] }, invokeEnterprise);
    await user.click(await screen.findByRole("button", { name: "Sync now" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(invokeEnterprise).not.toHaveBeenCalled();
  });
});

describe("team features bodies in Settings", () => {
  it("draws a section's body and follows a body the module pushes", async () => {
    let status: EnterpriseStatus = {
      active: true,
      label: "Team features on",
      settingsSections: [{ id: "sandboxes", title: "Sandboxes", description: "Machines you run.", body: { elements: [{ type: "text", text: "No sandbox is paired." }] } }],
    };
    let changed: (() => void) | undefined;
    renderRoute(<EnterpriseSettingsSections query="" />, {
      path: "*",
      route: "/settings",
      bridge: makeMockBridge({
        getEnterpriseStatus: async () => status,
        onEnterpriseStatusChanged: (listener) => {
          changed = listener;
          return () => undefined;
        },
      }),
    });
    expect(await screen.findByText("No sandbox is paired.")).toBeInTheDocument();
    status = { ...status, settingsSections: [{ id: "sandboxes", title: "Sandboxes", description: "Machines you run.", body: { elements: [{ type: "status", label: "Office mini PC", value: "Paired", tone: "success" }] } }] };
    await act(async () => {
      changed?.();
    });
    expect(await screen.findByText("Office mini PC")).toBeInTheDocument();
    expect(screen.queryByText("No sandbox is paired.")).toBeNull();
  });
});

describe("schedule card targets", () => {
  const agent = createMockAgent();

  it("is unchanged without a module", async () => {
    renderWithAppState(<AgentScheduleCard agent={agent} onChange={vi.fn()} />);
    expect(await screen.findByText(/About 720 runs per 30 days/)).toBeInTheDocument();
    expect(screen.queryByText("Where it runs")).toBeNull();
  });

  it("is unchanged when the module offers no place for this agent", async () => {
    const getEnterpriseStatus = vi.fn(async (): Promise<EnterpriseStatus> => ({
      active: true,
      label: "Team features on",
      settingsSections: [],
      scheduleTargets: { action: "sandboxes.schedule", targets: [{ id: "mini-pc", label: "Office mini PC", agentIds: ["another-agent"] }] },
    }));
    renderWithAppState(<AgentScheduleCard agent={agent} onChange={vi.fn()} />, { bridge: makeMockBridge({ getEnterpriseStatus }) });
    await waitFor(() => expect(getEnterpriseStatus).toHaveBeenCalled());
    expect(await screen.findByText(/About 720 runs per 30 days/)).toBeInTheDocument();
    expect(screen.queryByText("Where it runs")).toBeNull();
  });

  it("offers This computer and the module's places, and shows the notice a choice returns", async () => {
    const user = userEvent.setup();
    const invokeEnterprise = vi.fn(async () => ({ notice: { type: "notice", tone: "success", title: "Assigned", message: "The schedule runs on Office mini PC." } }));
    const bridge = makeMockBridge({
      getEnterpriseStatus: async () => ({
        active: true,
        label: "Team features on",
        settingsSections: [],
        scheduleTargets: {
          action: "sandboxes.schedule",
          targets: [
            { id: "mini-pc", label: "Office mini PC", detail: "Local model llama3.1:8b" },
            { id: "lab", label: "Lab sandbox", disabledReason: "Sync is stopped for this sandbox." },
          ],
        },
      }),
      invokeEnterprise,
    });
    renderWithAppState(<AgentScheduleCard agent={agent} onChange={vi.fn()} />, { bridge });
    expect(await screen.findByText("Where it runs")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /This computer/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Lab sandbox/ })).toBeDisabled();
    expect(screen.getByText("Sync is stopped for this sandbox.")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /Office mini PC/ }));
    await waitFor(() => expect(invokeEnterprise).toHaveBeenCalledWith("sandboxes.schedule", { kind: "schedule", agentId: agent.id, targetId: "mini-pc", intervalSeconds: 3600 }));
    expect(await screen.findByText("The schedule runs on Office mini PC.")).toBeInTheDocument();
  });

  it("shows a refused choice as a danger notice with the reason", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge({
      getEnterpriseStatus: async () => ({
        active: true,
        label: "Team features on",
        settingsSections: [],
        scheduleTargets: { action: "sandboxes.schedule", targets: [{ id: "mini-pc", label: "Office mini PC" }] },
      }),
      invokeEnterprise: async () => ({ notice: { type: "notice", tone: "danger", title: "Not assigned", message: "find-inactive-devices is not a bundled read-only agent.", recovery: "Choose a read-only agent." } }),
    });
    renderWithAppState(<AgentScheduleCard agent={agent} onChange={vi.fn()} />, { bridge });
    await user.click(await screen.findByRole("radio", { name: /Office mini PC/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("not a bundled read-only agent");
    expect(alert).toHaveTextContent("Choose a read-only agent.");
  });
});
