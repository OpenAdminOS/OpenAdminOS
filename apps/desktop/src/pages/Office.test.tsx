import { screen, within } from "@testing-library/react";
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
      screen.getByRole("link", { name: "Review proposed changes →" }),
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
  it("preserves provider-default assignments when editing", async () => {
    const state = createMockAppState({
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
  });
});
