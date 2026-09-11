import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Office from "./Office";
import {
  createMockAppState,
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
  it("creates an assignment from installed agents and requires hosted consent", async () => {
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
      await screen.findByRole("button", { name: "Add persona" }),
    );
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("button", { name: "Save persona" })).toBeDisabled();
    await user.click(
      dialog.getByRole("checkbox", { name: /compliance-overview/ }),
    );
    await user.click(dialog.getByRole("checkbox", { name: /Device Offboard/ }));
    await user.selectOptions(dialog.getByLabelText("Provider"), "openai");
    const consent = dialog.getByRole("checkbox", {
      name: /I approve sending context/,
    });
    expect(consent).not.toBeChecked();
    await user.click(consent);
    await user.click(dialog.getByRole("button", { name: "Save persona" }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        providerId: "openai",
        confirmHosted: true,
        agentSlugs: ["device-offboard"],
      }),
    );
  });
  it("applies the initial role and retains missing workflows after renaming a partial Chief", async () => {
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
    renderRoute(<Office />, {
      route: "/office",
      path: "/office",
      bridge: makeMockBridge({ saveOfficePersona: vi.fn() }, state),
    });
    await user.click(
      await screen.findByRole("button", { name: "Add persona" }),
    );
    const dialog = within(screen.getByRole("dialog"));
    expect(
      dialog.getByRole("checkbox", { name: /Compliance overview/ }),
    ).toBeChecked();
    expect(dialog.getByLabelText("Schedule")).toHaveValue("60");
    expect(dialog.getByLabelText("Avatar")).toHaveValue("fox");
    expect(
      dialog.getByLabelText("Metric field in workflow result"),
    ).toHaveValue("counts.noncompliant");
    await user.click(dialog.getByRole("button", { name: "Chief of Staff" }));
    await user.clear(dialog.getByLabelText("Name"));
    await user.type(dialog.getByLabelText("Name"), "My chief");
    expect(
      dialog.getByRole("checkbox", { name: /team-evidence-review/ }),
    ).toBeChecked();
    expect(dialog.getByRole("button", { name: "Save persona" })).toBeDisabled();
    expect(
      dialog.getByRole("button", { name: "Chief of Staff" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("reviews and retries installation inside the draft, then saves the complete role", async () => {
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
    const installedState = { ...state, installedAgents: [workflow] };
    const install = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Registry signature could not be verified"),
      )
      .mockResolvedValueOnce(installedState);
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
      await screen.findByRole("button", { name: "Add persona" }),
    );
    const draft = within(
      screen.getByRole("dialog", { name: "Create persona" }),
    );
    await user.click(draft.getByRole("button", { name: "Research Bot" }));
    await user.clear(draft.getByLabelText("Name"));
    await user.type(draft.getByLabelText("Name"), "Research draft");
    await user.type(
      draft.getByLabelText("Standing instructions"),
      "Explain missing evidence.",
    );
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
    expect(draft.getByLabelText("Name")).toHaveValue("Research draft");
    await user.click(review.getByRole("button", { name: "Confirm install" }));
    await user.click(
      await review.findByRole("button", { name: "Return to persona" }),
    );
    expect(draft.getByLabelText("Standing instructions")).toHaveValue(
      "Explain missing evidence.",
    );
    await user.click(draft.getByRole("button", { name: "Save persona" }));
    expect(install).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Research draft",
        agentSlugs: ["team-evidence-review"],
        instructions: "Explain missing evidence.",
      }),
    );
  });

  it("opens tenant setup without discarding an unfinished assignment", async () => {
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
    // The normal fresh-install setup is dismissible.
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await user.click(
      await screen.findByRole("button", { name: "Add persona" }),
    );
    const draft = within(
      screen.getByRole("dialog", { name: "Create persona" }),
    );
    await user.clear(draft.getByLabelText("Name"));
    await user.type(draft.getByLabelText("Name"), "Pending tenant");
    await user.click(draft.getByRole("button", { name: "Connect tenant" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    await user.keyboard("{Escape}");
    expect(draft.getByLabelText("Name")).toHaveValue("Pending tenant");
    expect(draft.getByRole("button", { name: "Save persona" })).toBeDisabled();
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
    expect(
      within(
        screen.getByRole("region", { name: "Team action inbox" }),
      ).getByRole("link", { name: "Review proposed changes →" }),
    ).toHaveAttribute("href", "/runs/office-run");
    expect(
      screen.getByRole("button", { name: "Run assignment" }),
    ).toBeDisabled();
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
    await userEvent.click(dialog.getByRole("button", { name: "Save persona" }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ id: persona.id, model: undefined }),
    );
    expect(save.mock.calls[0]?.[0].assessment).toBeUndefined();
    expect(save.mock.calls[0]?.[0].planning).toBeUndefined();
  });
});
