import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Office from "./Office";
import {
  createMockAppState,
  mockProviders,
  createMockAgent,
  createAwaitingConfirmationRun,
  makeMockBridge,
  renderRoute,
} from "../test/test-utils";
import type { OfficePersona } from "../shared/openAdminOS";
const persona: OfficePersona = {
  id: "persona-1",
  name: "Policy Watcher",
  responsibility: "Review changes",
  avatar: "robot",
  color: "amber",
  tenantId: "tenant-1",
  providerId: "ollama",
  agentSlugs: ["device-offboard"],
  intervalMinutes: null,
  maxMinutes: 30,
  enabled: true,
  createdAt: "2026-09-10T10:00:00Z",
  updatedAt: "2026-09-10T10:00:00Z",
};

describe("Office", () => {
  it("guides a custom assignment and requires hosted consent before saving", async () => {
    const user = userEvent.setup();
    const state = createMockAppState({
      installedAgents: [createMockAgent()],
      office: { personas: [], missions: [] },
    });
    const save = vi
      .fn()
      .mockResolvedValue({ personas: [persona], missions: [] });
    renderRoute(<Office />, {
      route: "/office",
      path: "/office",
      bridge: makeMockBridge({ saveOfficePersona: save }, state),
    });
    await user.click(
      await screen.findByRole("button", { name: "Add teammate" }),
    );
    const dialog = within(screen.getByRole("dialog", { name: "Add teammate" }));
    await user.click(dialog.getByRole("button", { name: /Custom role/ }));
    await user.type(
      dialog.getByLabelText(/^Responsibility/),
      "Review offboarding changes",
    );
    await user.click(dialog.getByRole("button", { name: "Continue" }));
    expect(dialog.getByRole("button", { name: "Continue" })).toBeDisabled();
    await user.click(dialog.getByRole("checkbox", { name: /Device Offboard/ }));
    await user.selectOptions(dialog.getByLabelText("Provider"), "openai");
    await user.click(dialog.getByRole("button", { name: "Continue" }));
    await user.click(dialog.getByRole("button", { name: "Continue" }));
    await user.click(dialog.getByRole("button", { name: "Add teammate" }));
    expect(save).not.toHaveBeenCalled();
    const consent = dialog.getByRole("checkbox", {
      name: /I approve sending context/,
    });
    expect(consent).not.toBeChecked();
    await user.click(consent);
    await user.click(dialog.getByRole("button", { name: "Add teammate" }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        providerId: "openai",
        confirmHosted: true,
        agentSlugs: ["device-offboard"],
      }),
    );
  });

  it("applies role defaults, preserves the draft going back, and blocks an incomplete renamed Chief", async () => {
    const user = userEvent.setup();
    const compliance = createMockAgent({
      id: "compliance-overview",
      slug: "compliance-overview",
      name: "Compliance overview",
      mode: "read",
    });
    const state = createMockAppState({
      installedAgents: [compliance],
      office: { personas: [], missions: [] },
    });
    const save = vi.fn();
    renderRoute(<Office />, {
      route: "/office",
      path: "/office",
      bridge: makeMockBridge({ saveOfficePersona: save }, state),
    });
    await user.click(
      await screen.findByRole("button", { name: "Add teammate" }),
    );
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByLabelText("Avatar")).toHaveValue("fox");
    await user.click(dialog.getByRole("button", { name: "Continue" }));
    expect(
      dialog.getByRole("checkbox", { name: /Compliance overview/ }),
    ).toBeChecked();
    await user.click(dialog.getByRole("button", { name: "Continue" }));
    expect(dialog.getByLabelText("Schedule")).toHaveValue("60");
    await user.click(
      dialog.getByText("Advanced instructions, handoffs and schedules"),
    );
    await user.click(dialog.getByText("Assessment and schedule options"));
    expect(
      dialog.getByLabelText("Metric field in workflow result"),
    ).toHaveValue("counts.noncompliant");
    await user.click(dialog.getByRole("button", { name: "Back" }));
    await user.click(dialog.getByRole("button", { name: "Back" }));
    await user.click(dialog.getByRole("button", { name: "Chief of Staff" }));
    await user.clear(dialog.getByLabelText("Name"));
    await user.type(dialog.getByLabelText("Name"), "My chief");
    await user.click(dialog.getByRole("button", { name: "Continue" }));
    expect(
      dialog.getByRole("checkbox", { name: /team-evidence-review/ }),
    ).toBeChecked();
    expect(dialog.getByRole("button", { name: "Continue" })).toBeDisabled();
    await user.click(dialog.getByRole("button", { name: "Back" }));
    expect(dialog.getByLabelText("Name")).toHaveValue("My chief");
    expect(save).not.toHaveBeenCalled();
  });

  it("reviews and retries signed installation inside the guided draft", async () => {
    const user = userEvent.setup();
    const workflow = createMockAgent({
      id: "team-evidence-review",
      slug: "team-evidence-review",
      name: "Team evidence review",
      mode: "read",
      scopes: [],
    });
    const state = createMockAppState({
      installedAgents: [],
      registryAgents: [{ ...workflow, registryId: workflow.slug }],
      office: { personas: [], missions: [] },
    });
    const install = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Registry signature could not be verified"),
      )
      .mockResolvedValueOnce({ ...state, installedAgents: [workflow] });
    const save = vi.fn().mockResolvedValue(state.office);
    renderRoute(<Office />, {
      route: "/office",
      path: "/office",
      bridge: makeMockBridge(
        { installAgent: install, saveOfficePersona: save },
        state,
      ),
    });
    await user.click(
      await screen.findByRole("button", { name: "Add teammate" }),
    );
    const draft = within(screen.getByRole("dialog", { name: "Add teammate" }));
    await user.click(draft.getByRole("button", { name: "Research Bot" }));
    await user.clear(draft.getByLabelText("Name"));
    await user.type(draft.getByLabelText("Name"), "Research draft");
    await user.click(draft.getByRole("button", { name: "Continue" }));
    await user.click(
      draft.getByRole("button", {
        name: "Review and install Team evidence review",
      }),
    );
    const review = within(
      screen.getByRole("dialog", { name: "Install Team evidence review" }),
    );
    expect(install).not.toHaveBeenCalled();
    await user.click(review.getByRole("button", { name: "Confirm install" }));
    expect(await review.findByRole("alert")).toHaveTextContent(
      "Registry signature could not be verified",
    );
    await user.click(review.getByRole("button", { name: "Confirm install" }));
    await user.click(
      await review.findByRole("button", { name: "Return to teammate" }),
    );
    await user.click(draft.getByRole("button", { name: "Continue" }));
    await user.click(
      draft.getByText("Advanced instructions, handoffs and schedules"),
    );
    await user.type(
      draft.getByLabelText("Standing instructions"),
      "Explain missing evidence.",
    );
    await user.click(draft.getByRole("button", { name: "Continue" }));
    expect(
      draft.getByRole("heading", { name: "Research draft" }),
    ).toBeInTheDocument();
    await user.click(draft.getByRole("button", { name: "Add teammate" }));
    expect(install).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Research draft",
        agentSlugs: ["team-evidence-review"],
        instructions: "Explain missing evidence.",
      }),
    );
  });

  it("uses the first-teammate entry point without losing the draft during tenant setup", async () => {
    const user = userEvent.setup();
    const state = createMockAppState({
      tenants: [],
      activeTenantId: undefined,
      installedAgents: [],
      office: { personas: [], missions: [] },
    });
    renderRoute(<Office />, {
      route: "/office",
      path: "/office",
      bridge: makeMockBridge({ saveOfficePersona: vi.fn() }, state),
    });
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await user.click(
      await screen.findByRole("button", { name: "Add your first teammate" }),
    );
    const draft = within(screen.getByRole("dialog", { name: "Add teammate" }));
    await user.clear(draft.getByLabelText("Name"));
    await user.type(draft.getByLabelText("Name"), "Pending tenant");
    await user.click(draft.getByRole("button", { name: "Continue" }));
    await user.click(draft.getByRole("button", { name: "Connect tenant" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    await user.keyboard("{Escape}");
    expect(draft.getByRole("button", { name: "Continue" })).toBeDisabled();
    await user.click(draft.getByRole("button", { name: "Back" }));
    expect(draft.getByLabelText("Name")).toHaveValue("Pending tenant");
  });

  it("keeps provider recovery actions inside the workspace step without submitting the draft", async () => {
    const user = userEvent.setup();
    const state = createMockAppState({
      providers: mockProviders.map((p) =>
        p.id === "ollama" ? { ...p, status: "not-installed" as const } : p,
      ),
      office: { personas: [], missions: [] },
    });
    const save = vi.fn();
    renderRoute(<Office />, {
      route: "/office",
      path: "/office",
      bridge: makeMockBridge({ saveOfficePersona: save }, state),
    });
    await user.click(
      await screen.findByRole("button", { name: "Add teammate" }),
    );
    const draft = within(screen.getByRole("dialog", { name: "Add teammate" }));
    await user.click(draft.getByRole("button", { name: "Continue" }));
    const recheck = draft.getByRole("button", { name: "Recheck" });
    expect(recheck).toHaveAttribute("type", "button");
    await user.click(recheck);
    expect(
      draft.getByRole("heading", { name: "Prepare workspace" }),
    ).toBeVisible();
    expect(save).not.toHaveBeenCalled();
    expect(draft.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows actual approval state and links to the existing write confirmation surface", async () => {
    const run = createAwaitingConfirmationRun({
      id: "office-run",
      office: { missionId: "mission-1", personaId: persona.id, step: 0 },
    });
    const state = createMockAppState({
      office: {
        personas: [persona],
        missions: [
          {
            id: "mission-1",
            personaId: persona.id,
            personaName: persona.name,
            tenantId: "tenant-1",
            providerId: "ollama",
            agentSlugs: persona.agentSlugs,
            runIds: [run.id],
            status: "running",
            trigger: "manual",
            startedAt: persona.createdAt,
            deadlineAt: "2026-09-10T10:30:00Z",
          },
        ],
      },
      runs: [run],
    });
    const stop = vi.fn().mockResolvedValue(state.office);
    renderRoute(<Office />, {
      route: "/office",
      path: "/office",
      bridge: makeMockBridge({ stopOfficePersona: stop }, state),
    });
    expect(
      await screen.findByRole("button", {
        name: "Policy Watcher, Needs approval",
      }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Review inbox" }));
    expect(
      within(
        screen.getByRole("region", { name: "Team action inbox" }),
      ).getByRole("link", { name: "Review proposed changes →" }),
    ).toHaveAttribute("href", "/runs/office-run");
    expect(
      screen.getByRole("button", { name: "Run assignment" }),
    ).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "List" }));
    expect(
      screen.getByRole("button", { name: "Policy Watcher, Needs approval" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stop & pause" }));
    expect(stop).toHaveBeenCalledWith(persona.id);
  });
  it("preserves an unsaved persona edit during a background refresh", async () => {
    const state = createMockAppState({
      office: { personas: [persona], missions: [] },
    });
    let finishRefresh: (() => void) | undefined;
    const getAppState = vi
      .fn()
      .mockResolvedValueOnce(state)
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finishRefresh = () => resolve(state);
          }),
      );
    renderRoute(<Office />, {
      route: "/office",
      path: "/office",
      bridge: makeMockBridge({ getAppState }, state),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const name = within(screen.getByRole("dialog")).getByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "Security Watcher");
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(name).toHaveValue("Security Watcher");
    await act(async () => {
      finishRefresh?.();
    });
    expect(
      within(screen.getByRole("dialog")).getByLabelText("Name"),
    ).toHaveValue("Security Watcher");
  });

  it("keeps skipped workflow labels and evidence attached to the workflow that actually ran", async () => {
    const chief = {
      ...persona,
      name: "Chief of Staff",
      agentSlugs: ["team-evidence-review", "team-script-draft"],
    };
    const run = createAwaitingConfirmationRun({
      id: "script-run",
      agentSlug: "team-script-draft",
      status: "completed",
      plan: undefined,
      office: { missionId: "mission-1", personaId: chief.id, step: 0 },
    });
    const state = createMockAppState({
      installedAgents: [
        createMockAgent({
          slug: "team-evidence-review",
          name: "Team evidence review",
          mode: "read",
        }),
        createMockAgent({
          slug: "team-script-draft",
          name: "Team PowerShell draft",
          mode: "read",
        }),
      ],
      runs: [run],
      office: {
        personas: [chief],
        missions: [
          {
            id: "mission-1",
            personaId: chief.id,
            personaName: chief.name,
            tenantId: chief.tenantId,
            providerId: chief.providerId,
            agentSlugs: ["team-script-draft"],
            skippedAgentSlugs: ["team-evidence-review"],
            runIds: [run.id],
            status: "completed",
            trigger: "manual",
            startedAt: chief.createdAt,
            deadlineAt: chief.createdAt,
          },
        ],
      },
    });
    const { container } = renderRoute(<Office />, {
      route: "/office",
      path: "/office",
      bridge: makeMockBridge({}, state),
    });
    await screen.findByRole("button", { name: "Edit" });
    const rows = container.querySelectorAll(".office-work-order li");
    expect(rows[0]).toHaveTextContent("Skipped by assignment plan");
    expect(
      within(rows[0] as HTMLElement).queryByRole("link"),
    ).not.toBeInTheDocument();
    expect(rows[1]).toHaveTextContent("completed");
    expect(
      within(rows[1] as HTMLElement).getByRole("link", {
        name: /View evidence/,
      }),
    ).toHaveAttribute("href", "/runs/script-run");
  });

  it("retains an explicit model when a connected provider does not enumerate models", async () => {
    const user = userEvent.setup();
    const state = createMockAppState({
      providers: mockProviders.map((p) =>
        p.id === "ollama" ? { ...p, models: [] } : p,
      ),
      installedAgents: [createMockAgent()],
      office: {
        personas: [{ ...persona, model: "configured-model" }],
        missions: [],
      },
    });
    const save = vi.fn().mockResolvedValue(state.office);
    renderRoute(<Office />, {
      route: "/office",
      path: "/office",
      bridge: makeMockBridge({ saveOfficePersona: save }, state),
    });
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const draft = within(screen.getByRole("dialog", { name: "Edit teammate" }));
    await user.selectOptions(draft.getByLabelText("Schedule"), "60");
    await user.click(draft.getByRole("button", { name: "Save teammate" }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "configured-model",
        intervalMinutes: 60,
      }),
    );
  });

  it("preserves provider-default assignments when editing", async () => {
    const state = createMockAppState({
      installedAgents: [createMockAgent()],
      activeModelByProviderId: { ollama: "llama3.1" },
      office: { personas: [persona], missions: [] },
    });
    const save = vi.fn().mockResolvedValue(state.office);
    renderRoute(<Office />, {
      route: "/office",
      path: "/office",
      bridge: makeMockBridge({ saveOfficePersona: save }, state),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByLabelText("Model")).toHaveValue("");
    await userEvent.click(
      dialog.getByRole("button", { name: "Save teammate" }),
    );
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ id: persona.id, model: undefined }),
    );
    expect(save.mock.calls[0]?.[0].assessment).toBeUndefined();
    expect(save.mock.calls[0]?.[0].planning).toBeUndefined();
  });
});

it("keeps fullscreen separate from concealment and gives nested dialogs Escape first", async () => {
  const user = userEvent.setup();
  const state = createMockAppState({
    office: { personas: [persona], missions: [] },
  });
  let nativeChanged: (active: boolean) => void = () => {};
  const setFullscreen = vi.fn(async (value: boolean) => value);
  renderRoute(<Office />, {
    route: "/office?view=list",
    path: "/office",
    bridge: makeMockBridge(
      {
        setOfficeFullscreen: setFullscreen,
        onOfficeFullscreenChanged: (cb) => {
          nativeChanged = cb;
          return () => {};
        },
      },
      state,
    ),
  });
  await user.click(await screen.findByRole("button", { name: "Full screen" }));
  expect(
    await screen.findByRole("button", { name: "Exit full screen" }),
  ).toBeInTheDocument();
  expect(document.documentElement).toHaveAttribute("data-team-fullscreen");
  expect(document.documentElement).not.toHaveAttribute(
    "data-team-presentation",
  );
  await user.click(screen.getByRole("button", { name: "Review inbox" }));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Exit full screen" }),
  ).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(
    await screen.findByRole("button", { name: "Full screen" }),
  ).toHaveFocus();
  expect(screen.getByRole("button", { name: "List" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await user.click(screen.getByRole("button", { name: "Full screen" }));
  act(() => nativeChanged(false));
  expect(document.documentElement).not.toHaveAttribute("data-team-fullscreen");
});
