import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { EnterpriseScheduleTargetsView, EnterpriseStatus, EnterpriseUiBodyView } from "@openadminos/agent-sdk";

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
        { id: "mini-pc", label: "Office mini PC", organizationId: "org-contoso", detail: "Local model llama3.1:8b" },
        { id: "lab", label: "Lab sandbox", organizationId: "org-contoso", disabledReason: "Sync is stopped for this sandbox." },
      ],
      ...(current ? { current } : {}),
    },
  });

  const withTargets = (extra: Partial<EnterpriseScheduleTargetsView>): EnterpriseStatus => {
    const base = statusWith();
    return base.active && base.scheduleTargets ? { ...base, scheduleTargets: { ...base.scheduleTargets, ...extra } } : base;
  };

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
      scheduleTargets: { action: "sandboxes.schedule", targets: [{ id: "mini-pc", label: "Office mini PC", organizationId: "org-contoso", agentIds: ["another-agent"] }] },
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
    renderWithAppState(<AgentScheduleCard agent={createMockAgent({ id: agent.id, schedule: { organizationId: "org-contoso", enabled: false, intervalSeconds: 3600 } })} onChange={onChange} />, { bridge });
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

  it("offers only the places paired for the schedule's organization", async () => {
    const bridge = makeMockBridge({
      getEnterpriseStatus: async () => ({
        active: true,
        label: "Team features on",
        settingsSections: [],
        scheduleTargets: {
          action: "sandboxes.schedule",
          targets: [
            { id: "contoso-pc", label: "Contoso mini PC", organizationId: "org-contoso" },
            { id: "fabrikam-pc", label: "Fabrikam mini PC", organizationId: "org-fabrikam" },
          ],
        },
      }),
    });
    const { rerender } = renderWithAppState(<AgentScheduleCard agent={createMockAgent({ id: agent.id, schedule: { organizationId: "org-contoso", enabled: true, intervalSeconds: 3600 } })} onChange={vi.fn()} />, { bridge });
    expect(await screen.findByRole("radio", { name: /Contoso mini PC/ })).toBeEnabled();
    expect(screen.queryByRole("radio", { name: /Fabrikam mini PC/ })).toBeNull();
    // A schedule without an organization cannot move: a place is paired for one.
    rerender(<AgentScheduleCard agent={createMockAgent({ id: agent.id, schedule: { enabled: true, intervalSeconds: 3600 } })} onChange={vi.fn()} />);
    const contoso = await screen.findByRole("radio", { name: /Contoso mini PC/ });
    expect(contoso).toBeDisabled();
    expect(document.getElementById(contoso.getAttribute("aria-describedby") ?? "")).toHaveTextContent("Assign this schedule to an organization first");
  });

  it("warns when a place also runs the agent from its own configuration, and does not offer moving back", async () => {
    const bridge = makeMockBridge({
      getEnterpriseStatus: async () => withTargets({ current: { [agent.id]: "mini-pc" }, alsoRunsOn: { [agent.id]: "mini-pc" } }),
    });
    renderWithAppState(<AgentScheduleCard agent={createMockAgent({ id: agent.id, schedule: { organizationId: "org-contoso", enabled: false, intervalSeconds: 3600 } })} onChange={vi.fn()} />, { bridge });
    expect(await screen.findByText(/The schedule here does not run while Office mini PC's own configuration runs it\./)).toBeInTheDocument();
    const thisComputer = screen.getByRole("radio", { name: /This computer/ });
    expect(thisComputer).toBeDisabled();
    expect(document.getElementById(thisComputer.getAttribute("aria-describedby") ?? "")).toHaveTextContent("Remove it from Office mini PC's own configuration first.");
  });

  it("shows an uncertain place with the module's recovery and holds every choice", async () => {
    const bridge = makeMockBridge({
      getEnterpriseStatus: async () =>
        withTargets({ uncertain: { [agent.id]: { targetId: "mini-pc", message: "The sandbox has not answered for 2 hours.", recovery: "Check that the sandbox runs, then sync." } } }),
    });
    renderWithAppState(<AgentScheduleCard agent={createMockAgent({ id: agent.id, schedule: { organizationId: "org-contoso", enabled: false, intervalSeconds: 3600 } })} onChange={vi.fn()} />, { bridge });
    expect(await screen.findByText("Not certain it runs on Office mini PC")).toBeInTheDocument();
    expect(screen.getByText("Check that the sandbox runs, then sync.")).toBeInTheDocument();
    // Treated as running there: the switch here is held and no place can be chosen.
    expect(screen.getByRole("radio", { name: /Office mini PC/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /This computer/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Office mini PC/ })).toBeDisabled();
    expect(screen.getByRole("switch", { name: /Automatic runs/ })).toBeDisabled();
  });

  it("keeps the row for an agent a place runs from its own configuration, in the module's real shape", async () => {
    // The agent is left out of agentIds and has no current entry; only alsoRunsOn names it.
    const bridge = makeMockBridge({
      getEnterpriseStatus: async (): Promise<EnterpriseStatus> => ({
        active: true,
        label: "Team features on",
        settingsSections: [],
        scheduleTargets: {
          action: "sandboxes.schedule",
          targets: [{ id: "mini-pc", label: "Office mini PC", organizationId: "org-contoso", agentIds: ["another-agent"] }],
          alsoRunsOn: { [agent.id]: "mini-pc" },
        },
      }),
    });
    renderWithAppState(<AgentScheduleCard agent={createMockAgent({ id: agent.id, schedule: { organizationId: "org-contoso", enabled: true, intervalSeconds: 3600 } })} onChange={vi.fn()} />, { bridge });
    expect(await screen.findByText("Where it runs")).toBeInTheDocument();
    expect(screen.getByText(/does not run while Office mini PC's own configuration runs it\. Remove it from Office mini PC's own configuration/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Office mini PC/ })).toBeDisabled();
  });

  it("keeps the row for an agent whose place is not certain, in the module's real shape", async () => {
    const bridge = makeMockBridge({
      getEnterpriseStatus: async (): Promise<EnterpriseStatus> => ({
        active: true,
        label: "Team features on",
        settingsSections: [],
        scheduleTargets: {
          action: "sandboxes.schedule",
          targets: [{ id: "mini-pc", label: "Office mini PC", organizationId: "org-contoso", agentIds: ["another-agent"] }],
          uncertain: { [agent.id]: { targetId: "mini-pc", message: "The sandbox has not answered.", recovery: "Check that it runs, then sync." } },
        },
      }),
    });
    renderWithAppState(<AgentScheduleCard agent={createMockAgent({ id: agent.id, schedule: { organizationId: "org-contoso", enabled: false, intervalSeconds: 3600 } })} onChange={vi.fn()} />, { bridge });
    expect(await screen.findByText("Not certain it runs on Office mini PC")).toBeInTheDocument();
    expect(screen.getByText("Check that it runs, then sync.")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Office mini PC/ })).toBeChecked();
  });

  it("says where a schedule was last known to run with team features off, and runs it here after typed confirmation", async () => {
    const user = userEvent.setup();
    let placements: Record<string, { targetId: string; label: string; organizationId: string; reason: "runs" }> = {
      [agent.id]: { targetId: "mini-pc", label: "Office mini PC", organizationId: "org-contoso", reason: "runs" },
    };
    const clearSchedulePlacement = vi.fn(async (agentId: string) => {
      const { [agentId]: _cleared, ...rest } = placements;
      placements = rest;
      return { placements };
    });
    const bridge = makeMockBridge({
      getEnterpriseStatus: async (): Promise<EnterpriseStatus> => ({ active: false }),
      getSchedulePlacements: async () => ({ placements }),
      clearSchedulePlacement,
    });
    renderWithAppState(<AgentScheduleCard agent={createMockAgent({ id: agent.id, schedule: { organizationId: "org-contoso", enabled: false, intervalSeconds: 3600 } })} onChange={vi.fn()} />, { bridge });
    expect(await screen.findByText("Last known to run on Office mini PC")).toBeInTheDocument();
    expect(screen.getByText("Team features are off, so it does not run here until you bring it back or remove it there.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Run it here" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Run it here" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Type RUN IT HERE to confirm"), "RUN IT HERE");
    await user.click(confirm);
    await waitFor(() => expect(clearSchedulePlacement).toHaveBeenCalledWith(agent.id));
    await waitFor(() => expect(screen.queryByText("Last known to run on Office mini PC")).toBeNull());
  });

  it("waits for the module without offering Run it here while team features are on", async () => {
    const bridge = makeMockBridge({
      getEnterpriseStatus: async (): Promise<EnterpriseStatus> => ({ active: true, label: "Team features on", settingsSections: [] }),
      getSchedulePlacements: async () => ({ placements: { [agent.id]: { targetId: "mini-pc", label: "Office mini PC", organizationId: "org-contoso", reason: "runs" as const } } }),
    });
    renderWithAppState(<AgentScheduleCard agent={agent} onChange={vi.fn()} />, { bridge });
    expect(
      await screen.findByText("Team features have not said where it runs yet, so it does not run here meanwhile. Open Settings, Sandboxes and use the step shown for that sandbox, or wait until it answers."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run it here" })).toBeNull();
  });

  it("says a kept place is no longer paired here, even while the module reports other places, and offers Run it here", async () => {
    const bridge = makeMockBridge({
      getEnterpriseStatus: async () => statusWith(),
      getSchedulePlacements: async () => ({ placements: { [agent.id]: { targetId: "old-pc", label: "Old mini PC", organizationId: "org-contoso", reason: "runs" as const, stale: true } } }),
    });
    renderWithAppState(<AgentScheduleCard agent={createMockAgent({ id: agent.id, schedule: { organizationId: "org-contoso", enabled: false, intervalSeconds: 3600 } })} onChange={vi.fn()} />, { bridge });
    expect(await screen.findByText("Last known to run on Old mini PC, which is no longer paired here.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run it here" })).toBeInTheDocument();
  });

  it("holds a schedule when the app cannot read where it last ran, and takes it back with Run it here", async () => {
    const user = userEvent.setup();
    const problem = { kind: "unreadable" as const, message: "The app cannot read where schedules last ran, so a schedule does not run here until it is taken back." };
    let released: string[] = [];
    const clearSchedulePlacement = vi.fn(async (agentId: string) => {
      released = [...released, agentId];
      return { placements: {}, problem, held: { released, reason: "unreadable" as const } };
    });
    const bridge = makeMockBridge({
      getEnterpriseStatus: async (): Promise<EnterpriseStatus> => ({ active: false }),
      getSchedulePlacements: async () => ({ placements: {}, problem, held: { released, reason: "unreadable" as const } }),
      clearSchedulePlacement,
    });
    renderWithAppState(<AgentScheduleCard agent={agent} onChange={vi.fn()} />, { bridge });
    expect(await screen.findByText("Where schedules last ran cannot be read")).toBeInTheDocument();
    // With team features off, the only step named is Run it here.
    const step = screen.getByText(/cannot read where this schedule last ran/);
    expect(step).toHaveTextContent("Choose Run it here once it no longer runs in another place.");
    expect(step).not.toHaveTextContent(/Where it runs|team features report/);
    await user.click(screen.getByRole("button", { name: "Run it here" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/cannot tell where this schedule last ran/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "Run it here" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Type RUN IT HERE to confirm"), "RUN IT HERE");
    await user.click(confirm);
    await waitFor(() => expect(clearSchedulePlacement).toHaveBeenCalledWith(agent.id));
    await waitFor(() => expect(screen.queryByText("Where schedules last ran cannot be read")).toBeNull());
  });

  it("says when the app could not save where schedules last ran", async () => {
    const bridge = makeMockBridge({
      getEnterpriseStatus: async (): Promise<EnterpriseStatus> => ({ active: false }),
      getSchedulePlacements: async () => ({
        placements: {},
        problem: { kind: "unwritable" as const, message: "The app could not save where schedules last ran, so after a restart they may not be held." },
      }),
    });
    renderWithAppState(<AgentScheduleCard agent={agent} onChange={vi.fn()} />, { bridge });
    expect(await screen.findByText("Where schedules last ran could not be saved")).toBeInTheDocument();
    expect(screen.queryByText("Where schedules last ran cannot be read")).toBeNull();
  });

  it("shows a kept place with its recovery when the module reports places but does not name this agent", async () => {
    const bridge = makeMockBridge({
      getEnterpriseStatus: async () => statusWith(),
      getSchedulePlacements: async () => ({ placements: { [agent.id]: { targetId: "mini-pc", label: "Office mini PC", organizationId: "org-contoso", reason: "runs" as const } } }),
    });
    renderWithAppState(<AgentScheduleCard agent={agent} onChange={vi.fn()} />, { bridge });
    expect(await screen.findByText("Last known to run on Office mini PC")).toBeInTheDocument();
    expect(screen.getByText(/Open Settings, Sandboxes and use the step shown for that sandbox/)).toBeInTheDocument();
  });

  it("shows a kept place the module leaves out as current, so This computer can be chosen to move it back", async () => {
    const user = userEvent.setup();
    const invokeEnterpriseUi = vi.fn<Invoke>(async () => ({ notice: { type: "notice", tone: "success", title: "Saved", message: "The schedule now runs here." } }));
    const bridge = makeMockBridge({
      getEnterpriseStatus: async () => statusWith(),
      getSchedulePlacements: async () => ({ placements: { [agent.id]: { targetId: "mini-pc", label: "Office mini PC", organizationId: "org-contoso", reason: "runs" as const } } }),
      invokeEnterpriseUi,
    });
    renderWithAppState(<AgentScheduleCard agent={agent} onChange={vi.fn()} />, { bridge });
    // The hold and its notice stay.
    expect(await screen.findByText("Last known to run on Office mini PC")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Office mini PC/ })).toBeChecked());
    const here = screen.getByRole("radio", { name: /This computer/ });
    expect(here).not.toBeChecked();
    expect(here).toBeEnabled();
    // Not shown as running in two places: the module did not report it there.
    expect(screen.queryByText(/Turned on here and on/)).toBeNull();
    await user.click(here);
    await waitFor(() =>
      expect(invokeEnterpriseUi).toHaveBeenCalledWith("sandboxes.schedule", { kind: "schedule", agentId: agent.id, targetId: "this-computer", intervalSeconds: expect.any(Number) }),
    );
  });

  it("offers waiting for team features on a held schedule only when a place it offers lists the agent", async () => {
    const held = { placements: {}, problem: { kind: "unreadable" as const, message: "x" }, held: { released: [], reason: "unreadable" as const } };
    const listed = makeMockBridge({
      getEnterpriseStatus: async () => withTargets({ targets: [{ id: "mini-pc", label: "Office mini PC", organizationId: "org-contoso", agentIds: [agent.id] }] }),
      getSchedulePlacements: async () => held,
    });
    const first = renderWithAppState(<AgentScheduleCard agent={agent} onChange={vi.fn()} />, { bridge: listed });
    expect(await screen.findByText(/or wait until team features report that it runs here/)).toBeInTheDocument();
    first.unmount();

    const unnamed = makeMockBridge({
      getEnterpriseStatus: async () => withTargets({ targets: [{ id: "mini-pc", label: "Office mini PC", organizationId: "org-contoso", agentIds: ["another-agent"] }] }),
      getSchedulePlacements: async () => held,
    });
    renderWithAppState(<AgentScheduleCard agent={agent} onChange={vi.fn()} />, { bridge: unnamed });
    const step = await screen.findByText(/cannot read where this schedule last ran/);
    expect(step).toHaveTextContent("Choose Run it here once it no longer runs in another place.");
    expect(step).not.toHaveTextContent(/team features report/);
  });

  it("titles a hold past the kept places apart, and shows why Run it here was refused", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge({
      getEnterpriseStatus: async (): Promise<EnterpriseStatus> => ({ active: false }),
      getSchedulePlacements: async () => ({ placements: {}, problem: { kind: "full" as const, message: "x" }, held: { released: [], reason: "full" as const } }),
      clearSchedulePlacement: async () => {
        throw new Error("Error invoking remote method 'openadminos:clear-schedule-placement': Error: The app can take back at most 2000 schedules while they are held, so this one still does not run here.");
      },
    });
    renderWithAppState(<AgentScheduleCard agent={agent} onChange={vi.fn()} />, { bridge });
    expect(await screen.findByText("Where some schedules last ran could not be kept")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Run it here" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Type RUN IT HERE to confirm"), "RUN IT HERE");
    await user.click(within(dialog).getByRole("button", { name: "Run it here" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/^The app can take back at most 2000 schedules while they are held, so this one still does not run here\.$/);
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
        scheduleTargets: { action: "sandboxes.schedule", targets: [{ id: "lookalike", label: "This c\u043emputer", organizationId: "org-contoso" }], current: { [agent.id]: "lookalike" } },
      }),
    });
    renderWithAppState(<AgentScheduleCard agent={agent} onChange={vi.fn()} />, { bridge });
    const lookalike = await screen.findByRole("radio", { name: /This c\u043emputer/ });
    expect(lookalike).toBeChecked();
    expect(lookalike.closest("label")).toHaveTextContent("Team features");
    expect(screen.getByRole("radio", { name: /^This computer/ })).not.toBeChecked();
  });
});
