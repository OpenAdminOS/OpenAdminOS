import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { EnterpriseStatus, EnterpriseUiBodyView } from "@openadminos/agent-sdk";

import { createMockAgent, makeMockBridge, renderRoute, renderWithAppState } from "../test/test-utils";
import { AgentScheduleCard } from "./AgentScheduleCard";
import { EnterpriseSettingsSections } from "./EnterpriseSettingsSections";
import { EnterpriseUiBody, ModuleUiBoundary } from "./EnterpriseUi";

type Invoke = (name: string, input?: unknown) => Promise<unknown>;

const EVERY_ELEMENT: EnterpriseUiBodyView = {
  elements: [
    { type: "status", label: "Office mini PC", value: "Paired", tone: "success" },
    { type: "text", text: "Schedules keep running while the laptop is off." },
    { type: "notice", tone: "warning", title: "Sync stopped", message: "A row is missing from the audit chain.", recovery: "Pair the sandbox again." },
    { type: "field", id: "address", label: "Address", kind: "code", placeholder: "100.64.0.10:7443", maxLength: 64 },
    { type: "field", id: "name", label: "Name", kind: "text", value: "Lab" },
    { type: "select", id: "organization", label: "Organization", options: [{ value: "org-1", label: "Contoso" }, { value: "org-2", label: "Fabrikam" }] },
    { type: "button", id: "pair", label: "Pair", kind: "primary", action: "sandboxes.pair" },
    { type: "list", rows: [{ label: "find-inactive-devices", status: { value: "Assigned", tone: "neutral" } }, { label: "compliance-overview" }] },
  ],
};

function renderBody(body: EnterpriseUiBodyView, invokeEnterpriseUi?: Invoke) {
  return renderRoute(<EnterpriseUiBody sectionId="sandboxes" body={body} revision={1} />, {
    path: "*",
    route: "/settings",
    bridge: makeMockBridge(invokeEnterpriseUi ? { invokeEnterpriseUi } : {}),
  });
}

describe("declarative team features UI", () => {
  it("draws every element type with plain text and accessible labels", async () => {
    renderBody(EVERY_ELEMENT);
    expect(await screen.findByText("Office mini PC")).toBeInTheDocument();
    expect(screen.getByText("Paired")).toBeInTheDocument();
    expect(screen.getByText("Schedules keep running while the laptop is off.")).toBeInTheDocument();
    // A notice that is part of a body is a status, not an alert.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Sync stopped").closest("[role='status']")).toHaveTextContent("Pair the sandbox again.");
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

  it("draws nothing for an element type outside the closed set, and a plain line for an empty body or list", async () => {
    const { unmount } = renderBody({ elements: [{ type: "html", html: "<b>x</b>" } as never, { type: "text", text: "Kept." }, { type: "list", rows: [] }] });
    expect(await screen.findByText("Kept.")).toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull();
    expect(screen.getByText("No entries.")).toBeInTheDocument();
    unmount();
    renderBody({ elements: [] });
    expect(await screen.findByText("Nothing to show yet.")).toBeInTheDocument();
  });

  it("sends the section's values with a button, says Working while it runs, and shows the notice it returns", async () => {
    const user = userEvent.setup();
    let answer!: (value: unknown) => void;
    const invokeEnterpriseUi = vi.fn<Invoke>(() => new Promise((resolve) => (answer = resolve)));
    renderBody(EVERY_ELEMENT, invokeEnterpriseUi);
    await user.type(await screen.findByLabelText("Address"), "100.64.0.10:7443");
    await user.selectOptions(screen.getByLabelText("Organization"), "org-2");
    await user.click(screen.getByRole("button", { name: "Pair" }));
    expect(await screen.findByRole("button", { name: "Working" })).toBeDisabled();
    expect(invokeEnterpriseUi).toHaveBeenCalledWith("sandboxes.pair", {
      kind: "button",
      sectionId: "sandboxes",
      buttonId: "pair",
      values: { address: "100.64.0.10:7443", name: "Lab", organization: "org-2" },
    });
    await act(async () => {
      answer({ notice: { type: "notice", tone: "success", title: "Paired", message: "The sandbox is paired with this desktop." } });
    });
    expect(await screen.findByText("The sandbox is paired with this desktop.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pair" })).toBeEnabled();
  });

  it("shows a failed or unreadable answer as a danger alert with the reason", async () => {
    const user = userEvent.setup();
    const invokeEnterpriseUi = vi
      .fn<Invoke>()
      .mockRejectedValueOnce(new Error("Error invoking remote method 'openadminos-enterprise-ui:sandboxes.pair': EnterpriseHostError: This button is not in the section any more, or calls another action."))
      .mockResolvedValueOnce({ script: "x" })
      .mockResolvedValueOnce({ body: { elements: [{ type: "iframe" }] } });
    renderBody(EVERY_ELEMENT, invokeEnterpriseUi);
    await user.click(await screen.findByRole("button", { name: "Pair" }));
    const failed = await screen.findByRole("alert");
    expect(failed).toHaveTextContent("This button is not in the section any more, or calls another action.");
    expect(failed).toHaveTextContent(/Try again/);
    await user.click(screen.getByRole("button", { name: "Pair" }));
    expect(await screen.findByText(/answered in a form this app does not draw/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pair" }));
    await waitFor(() => expect(invokeEnterpriseUi).toHaveBeenCalledTimes(3));
    expect(await screen.findByText(/answered in a form this app does not draw/)).toBeInTheDocument();
  });

  it("asks before a danger button, names the team features module, and sends the typed phrase", async () => {
    const user = userEvent.setup();
    const invokeEnterpriseUi = vi.fn<Invoke>(async () => ({ notice: { type: "notice", tone: "success", title: "Unpaired", message: "The sandbox is unpaired." } }));
    renderBody(
      { elements: [{ type: "button", id: "unpair", label: "Unpair", kind: "danger", action: "sandboxes.unpair", confirm: { title: "Unpair Office mini PC", message: "Assigned schedules stop on the sandbox.", typedPhrase: "UNPAIR 1 SANDBOX" } }] },
      invokeEnterpriseUi,
    );
    await user.click(await screen.findByRole("button", { name: "Unpair" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Provided by the team features module");
    expect(dialog).toHaveTextContent("It does not approve a change to your tenant");
    expect(dialog).toHaveTextContent("Assigned schedules stop on the sandbox.");
    const confirm = within(dialog).getByRole("button", { name: "Unpair" });
    expect(confirm).toBeDisabled();
    const phrase = within(dialog).getByLabelText("Type UNPAIR 1 SANDBOX to confirm");
    await user.type(phrase, "unpair 1 sandbox");
    expect(confirm).toBeDisabled();
    await user.clear(phrase);
    await user.type(phrase, "UNPAIR 1 SANDBOX");
    expect(invokeEnterpriseUi).not.toHaveBeenCalled();
    await user.click(confirm);
    await waitFor(() =>
      expect(invokeEnterpriseUi).toHaveBeenCalledWith("sandboxes.unpair", { kind: "button", sectionId: "sandboxes", buttonId: "unpair", values: {}, confirmedPhrase: "UNPAIR 1 SANDBOX" }),
    );
    expect(await screen.findByText("The sandbox is unpaired.")).toBeInTheDocument();
  });

  it("does nothing when a confirmation is cancelled", async () => {
    const user = userEvent.setup();
    const invokeEnterpriseUi = vi.fn<Invoke>();
    renderBody({ elements: [{ type: "button", id: "sync", label: "Sync now", kind: "secondary", action: "sandboxes.sync", confirm: { title: "Sync now", message: "Read the sandbox's runs now." } }] }, invokeEnterpriseUi);
    await user.click(await screen.findByRole("button", { name: "Sync now" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(invokeEnterpriseUi).not.toHaveBeenCalled();
  });

  it("shows a designed notice when module UI cannot be drawn", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const Broken = () => {
      throw new Error("not drawable");
    };
    try {
      render(
        <ModuleUiBoundary>
          <Broken />
        </ModuleUiBoundary>,
      );
      expect(screen.getByText("This team features section could not be drawn")).toBeInTheDocument();
      expect(screen.getByText(/Restart OpenAdminOS/)).toBeInTheDocument();
    } finally {
      quiet.mockRestore();
    }
  });
});

describe("team features bodies in Settings", () => {
  it("keeps an action's notice when its reply body arrives as a new revision", async () => {
    const user = userEvent.setup();
    const section = (revision: number, body: EnterpriseUiBodyView) => ({ id: "sandboxes", title: "Sandboxes", description: "Machines you run.", revision, body });
    let status: EnterpriseStatus = {
      active: true,
      label: "Team features on",
      settingsSections: [section(1, { elements: [{ type: "button", id: "pair", label: "Pair", kind: "primary", action: "sandboxes.pair" }] })],
    };
    let changed: (() => void) | undefined;
    const invokeEnterpriseUi = vi.fn<Invoke>(async () => {
      // The host stores the reply body as the next revision and tells the window.
      status = { active: true, label: "Team features on", settingsSections: [section(2, { elements: [{ type: "status", label: "Office mini PC", value: "Paired", tone: "success" }] })] };
      changed?.();
      return {
        body: { elements: [{ type: "status", label: "Office mini PC", value: "Paired", tone: "success" }] },
        notice: { type: "notice", tone: "success", title: "Paired", message: "The sandbox is paired with this desktop." },
      };
    });
    renderRoute(<EnterpriseSettingsSections query="" />, {
      path: "*",
      route: "/settings",
      bridge: makeMockBridge({
        getEnterpriseStatus: async () => status,
        onEnterpriseStatusChanged: (listener) => {
          changed = listener;
          return () => undefined;
        },
        invokeEnterpriseUi,
      }),
    });
    await user.click(await screen.findByRole("button", { name: "Pair" }));
    expect(await screen.findByText("Office mini PC")).toBeInTheDocument();
    expect(await screen.findByText("The sandbox is paired with this desktop.")).toBeInTheDocument();
  });

  it("draws the host's body by revision, keeps typed values that still fit, and closes a confirmation on a push", async () => {
    const user = userEvent.setup();
    const section = (revision: number, body: EnterpriseUiBodyView) => ({ id: "sandboxes", title: "Sandboxes", description: "Machines you run.", revision, body });
    const form: EnterpriseUiBodyView = {
      elements: [
        { type: "field", id: "address", label: "Address", kind: "code", maxLength: 64 },
        { type: "button", id: "unpair", label: "Unpair", kind: "danger", action: "sandboxes.unpair", confirm: { title: "Unpair", message: "Unpair it?" } },
      ],
    };
    let status: EnterpriseStatus = { active: true, label: "Team features on", settingsSections: [section(1, form)] };
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
    await user.type(await screen.findByLabelText("Address"), "100.64.0.10:7443");
    await user.click(screen.getByRole("button", { name: "Unpair" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    status = { active: true, label: "Team features on", settingsSections: [section(2, { elements: [{ type: "status", label: "Office mini PC", value: "Paired", tone: "success" }, ...form.elements] })] };
    await act(async () => {
      changed?.();
    });
    expect(await screen.findByText("Office mini PC")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByLabelText("Address")).toHaveValue("100.64.0.10:7443");

    status = { active: true, label: "Team features on", settingsSections: [section(3, { elements: [{ type: "text", text: "No sandbox is paired." }] })] };
    await act(async () => {
      changed?.();
    });
    expect(await screen.findByText("No sandbox is paired.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Address")).toBeNull();
  });
});

describe("schedule card: where it runs", () => {
  const agent = createMockAgent();
  const statusWith = (current?: Record<string, string>): EnterpriseStatus => ({
    active: true,
    label: "Team features on",
    settingsSections: [],
    scheduleTargets: {
      action: "sandboxes.schedule",
      targets: [
        { id: "mini-pc", label: "Office mini PC", detail: "Local model llama3.1:8b" },
        { id: "lab", label: "Lab sandbox", disabledReason: "Sync is stopped for this sandbox." },
      ],
      ...(current ? { current } : {}),
    },
  });

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

  it("claims a move only when the module reports it, and changes nothing here itself", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    let status = statusWith();
    let changed: (() => void) | undefined;
    const invokeEnterpriseUi = vi.fn<Invoke>(async () => {
      status = statusWith({ [agent.id]: "mini-pc" });
      changed?.();
      return { notice: { type: "notice", tone: "success", title: "Saved", message: "The schedule now runs on Office mini PC." } };
    });
    const bridge = makeMockBridge({
      getEnterpriseStatus: async () => status,
      onEnterpriseStatusChanged: (listener) => {
        changed = listener;
        return () => undefined;
      },
      invokeEnterpriseUi,
    });
    renderWithAppState(<AgentScheduleCard agent={createMockAgent({ id: agent.id, schedule: { enabled: false, intervalSeconds: 3600 } })} onChange={onChange} />, { bridge });
    expect(await screen.findByText("Where it runs")).toBeInTheDocument();
    expect(screen.getByText(/provided by the team features module/)).toBeInTheDocument();
    expect(screen.getAllByText("Team features")).toHaveLength(2);
    expect(screen.getByRole("radio", { name: /This computer/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Lab sandbox/ })).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: /Office mini PC/ }));
    await waitFor(() => expect(invokeEnterpriseUi).toHaveBeenCalledWith("sandboxes.schedule", { kind: "schedule", agentId: agent.id, targetId: "mini-pc", intervalSeconds: 3600 }));
    expect(await screen.findByText("The schedule now runs on Office mini PC.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Office mini PC/ })).toBeChecked());
    // The main process turned the schedule here off; the card does not write it itself.
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("switch", { name: /Automatic runs/ })).toBeDisabled();
    expect(screen.getByText("This schedule runs on Office mini PC. Its interval is set there.")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "24h" })).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "Custom" }));
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });

  it("shows no two place conflict once the main process turned the schedule here off", async () => {
    const onChange = vi.fn();
    const before = createMockAgent({ id: agent.id, schedule: { organizationId: "org-contoso", enabled: true, intervalSeconds: 3600 } });
    const bridge = makeMockBridge({ getEnterpriseStatus: async () => statusWith({ [agent.id]: "mini-pc" }) });
    const { rerender } = renderWithAppState(<AgentScheduleCard agent={before} onChange={onChange} />, { bridge });
    expect(await screen.findByText("Turned on here and on Office mini PC")).toBeInTheDocument();
    // The app state the main process announced after its write: the schedule here is off.
    rerender(<AgentScheduleCard agent={{ ...before, schedule: { ...before.schedule!, enabled: false } }} onChange={onChange} />);
    await waitFor(() => expect(screen.queryByText("Turned on here and on Office mini PC")).toBeNull());
    expect(screen.getByRole("switch", { name: /Automatic runs/ })).not.toBeChecked();
    expect(screen.getByText("This schedule runs on Office mini PC. Its interval is set there.")).toBeInTheDocument();
  });

  it("offers module places only once a schedule exists here, then moves it away and back", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    let status = statusWith();
    let changed: (() => void) | undefined;
    const invokeEnterpriseUi = vi.fn<Invoke>(async (_name, input) => {
      const targetId = (input as { targetId: string }).targetId;
      status = statusWith({ [agent.id]: targetId });
      changed?.();
      return { notice: { type: "notice", tone: "success", title: "Saved", message: targetId === "mini-pc" ? "The schedule now runs on Office mini PC." : "The schedule now runs here." } };
    });
    const bridge = makeMockBridge({
      getEnterpriseStatus: async () => status,
      onEnterpriseStatusChanged: (listener) => {
        changed = listener;
        return () => undefined;
      },
      invokeEnterpriseUi,
    });
    const card = (schedule?: { enabled: boolean }) => (
      <AgentScheduleCard agent={createMockAgent({ id: agent.id, ...(schedule ? { schedule: { organizationId: "org-contoso", intervalSeconds: 3600, ...schedule } } : {}) })} onChange={onChange} />
    );
    const { rerender } = renderWithAppState(card(), { bridge });

    // No schedule here: module places cannot be chosen, and say why.
    const miniPc = await screen.findByRole("radio", { name: /Office mini PC/ });
    expect(miniPc).toBeDisabled();
    expect(screen.getAllByText("Turn on Automatic runs first; a schedule can move only once it exists here.").length).toBeGreaterThan(0);
    expect(invokeEnterpriseUi).not.toHaveBeenCalled();

    // Turn on Automatic runs; the app state then carries the schedule.
    await user.click(screen.getByRole("switch", { name: /Automatic runs/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, intervalSeconds: 3600 })));
    rerender(card({ enabled: true }));
    expect(screen.getByRole("radio", { name: /Office mini PC/ })).toBeEnabled();

    // Move away: the main process turns the schedule here off.
    await user.click(screen.getByRole("radio", { name: /Office mini PC/ }));
    expect(await screen.findByText("The schedule now runs on Office mini PC.")).toBeInTheDocument();
    rerender(card({ enabled: false }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Office mini PC/ })).toBeChecked());
    expect(screen.getByRole("switch", { name: /Automatic runs/ })).toBeDisabled();

    // Move back: the main process turns it on again here.
    await user.click(screen.getByRole("radio", { name: /This computer/ }));
    expect(await screen.findByText("The schedule now runs here.")).toBeInTheDocument();
    rerender(card({ enabled: true }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /This computer/ })).toBeChecked());
    expect(screen.getByRole("switch", { name: /Automatic runs/ })).toBeChecked();
    expect(invokeEnterpriseUi.mock.calls.map(([, input]) => (input as { targetId: string }).targetId)).toEqual(["mini-pc", "this-computer"]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("moves back with no schedule here, and the switch can then be turned on", async () => {
    const user = userEvent.setup();
    let status = statusWith({ [agent.id]: "mini-pc" });
    let changed: (() => void) | undefined;
    const invokeEnterpriseUi = vi.fn<Invoke>(async () => {
      status = statusWith({ [agent.id]: "this-computer" });
      changed?.();
      return { notice: { type: "notice", tone: "neutral", title: "Moved back", message: "Moved back. Turn on Automatic runs to schedule it here." } };
    });
    const bridge = makeMockBridge({
      getEnterpriseStatus: async () => status,
      onEnterpriseStatusChanged: (listener) => {
        changed = listener;
        return () => undefined;
      },
      invokeEnterpriseUi,
    });
    renderWithAppState(<AgentScheduleCard agent={agent} onChange={vi.fn()} />, { bridge });
    expect(await screen.findByRole("radio", { name: /Office mini PC/ })).toBeChecked();
    expect(screen.getByRole("switch", { name: /Automatic runs/ })).toBeDisabled();
    const thisComputer = screen.getByRole("radio", { name: /This computer/ });
    expect(thisComputer).toBeEnabled();
    await user.click(thisComputer);
    expect(await screen.findByText("Moved back. Turn on Automatic runs to schedule it here.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("radio", { name: /This computer/ })).toBeChecked());
    expect(screen.getByRole("switch", { name: /Automatic runs/ })).toBeEnabled();
  });

  it("after a reinstall with the schedule elsewhere, offers only This computer and says why", async () => {
    const bridge = makeMockBridge({ getEnterpriseStatus: async () => statusWith({ [agent.id]: "mini-pc" }) });
    renderWithAppState(<AgentScheduleCard agent={createMockAgent({ id: agent.id })} onChange={vi.fn()} />, { bridge });
    const miniPc = await screen.findByRole("radio", { name: /Office mini PC/ });
    expect(miniPc).toBeChecked();
    expect(screen.getByRole("radio", { name: /This computer/ })).toBeEnabled();
    expect(screen.queryByText(/Turned on here and on/)).toBeNull();
    expect(screen.getByText("This schedule runs on Office mini PC. Its interval is set there.")).toBeInTheDocument();
    // Each disabled place names its reason for assistive technology.
    const lab = screen.getByRole("radio", { name: /Lab sandbox/ });
    expect(lab).toBeDisabled();
    const reason = document.getElementById(lab.getAttribute("aria-describedby") ?? "");
    expect(reason).toHaveTextContent("Turn on Automatic runs first; a schedule can move only once it exists here.");
  });

  it("holds the card's own controls while a move runs, and sends the saved interval", async () => {
    const user = userEvent.setup();
    let answer!: (value: unknown) => void;
    const invokeEnterpriseUi = vi.fn<Invoke>(() => new Promise((resolve) => (answer = resolve)));
    const bridge = makeMockBridge({ getEnterpriseStatus: async () => statusWith(), invokeEnterpriseUi });
    renderWithAppState(<AgentScheduleCard agent={createMockAgent({ id: agent.id, schedule: { organizationId: "org-contoso", enabled: true, intervalSeconds: 7200 } })} onChange={vi.fn()} />, { bridge });
    expect(await screen.findByRole("switch", { name: /Automatic runs/ })).toBeEnabled();
    // An unsaved draft interval is not what moves.
    await user.click(screen.getByRole("radio", { name: "24h" }));
    await user.click(screen.getByRole("radio", { name: /Office mini PC/ }));
    await waitFor(() => expect(invokeEnterpriseUi).toHaveBeenCalledWith("sandboxes.schedule", { kind: "schedule", agentId: agent.id, targetId: "mini-pc", intervalSeconds: 7200 }));
    expect(screen.getByRole("switch", { name: /Automatic runs/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "4h" })).toBeDisabled();
    // The unsaved 24h draft cannot be saved while the move runs.
    expect(screen.getByRole("button", { name: "Save interval" })).toBeDisabled();
    await act(async () => {
      answer({ notice: { type: "notice", tone: "danger", title: "Not moved", message: "The sandbox did not answer.", recovery: "Check the sandbox, then try again." } });
    });
    expect(await screen.findByText("The sandbox did not answer.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Automatic runs/ })).toBeEnabled();
  });

  it("shows a schedule running here and elsewhere as a danger state, and turns the one here off in place", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const scheduled = createMockAgent({ id: agent.id, schedule: { organizationId: "org-contoso", enabled: true, intervalSeconds: 7200, notifyOnChangeOnly: true } });
    const bridge = makeMockBridge({ getEnterpriseStatus: async () => statusWith({ [agent.id]: "mini-pc" }) });
    renderWithAppState(<AgentScheduleCard agent={scheduled} onChange={onChange} />, { bridge });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Turned on here and on Office mini PC");
    await user.click(within(alert).getByRole("button", { name: "Turn off here" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org-contoso", enabled: false, intervalSeconds: 7200, notifyOnChangeOnly: true })));
  });

  it("keeps the reported place on a refusal or a reply that does not move it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const invokeEnterpriseUi = vi
      .fn<Invoke>()
      .mockResolvedValueOnce({ notice: { type: "notice", tone: "danger", title: "Not moved", message: "The sandbox did not answer.", recovery: "Check that the sandbox runs, then try again." } })
      .mockResolvedValueOnce({ body: { elements: [] } });
    const bridge = makeMockBridge({ getEnterpriseStatus: async () => statusWith({ [agent.id]: "mini-pc" }), invokeEnterpriseUi });
    renderWithAppState(<AgentScheduleCard agent={agent} onChange={onChange} />, { bridge });
    expect(await screen.findByRole("radio", { name: /Office mini PC/ })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: /This computer/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The sandbox did not answer.");
    expect(screen.getByRole("radio", { name: /Office mini PC/ })).toBeChecked();
    // A reply that claims nothing changes nothing here: the place stays what the module reports.
    await user.click(screen.getByRole("radio", { name: /This computer/ }));
    await waitFor(() => expect(invokeEnterpriseUi).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("radio", { name: /Office mini PC/ })).toBeChecked();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("marks a look-alike place as the module's and never shows a foreign place as this computer", async () => {
    const bridge = makeMockBridge({
      getEnterpriseStatus: async () => ({
        active: true,
        label: "Team features on",
        settingsSections: [],
        scheduleTargets: { action: "sandboxes.schedule", targets: [{ id: "lookalike", label: "This c\u043emputer" }], current: { [agent.id]: "lookalike" } },
      }),
    });
    renderWithAppState(<AgentScheduleCard agent={agent} onChange={vi.fn()} />, { bridge });
    const lookalike = await screen.findByRole("radio", { name: /This c\u043emputer/ });
    expect(lookalike).toBeChecked();
    expect(lookalike.closest("label")).toHaveTextContent("Team features");
    expect(screen.getByRole("radio", { name: /^This computer/ })).not.toBeChecked();
  });
});
