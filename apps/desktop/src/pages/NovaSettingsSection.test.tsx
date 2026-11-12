import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { NovaSettingsSection } from "./NovaSettingsSection";
import { createMockAppState, makeMockBridge, renderWithAppState } from "../test/test-utils";
import type { ConnectorSummary, EffectiveNovaProfile, NovaProfileView } from "../shared/openAdminOS";

function view(effective: Partial<EffectiveNovaProfile> = {}, rest: Partial<NovaProfileView> = {}): NovaProfileView {
  return {
    effective: {
      voiceMode: "openai",
      allowedVoiceModes: ["openai", "local"],
      greetingName: "",
      instructions: "",
      instructionsSource: "none",
      addendum: "",
      capabilities: { webSearch: true, startAgents: true, navigation: true },
      connectorSends: {},
      memoryEnabled: true,
      memoryPaused: false,
      shortcuts: [],
      locked: { voiceMode: false, instructions: false, capabilities: { webSearch: false, startAgents: false, navigation: false }, connectorSends: false, memory: false },
      ...effective,
    },
    revisions: [],
    migratedFromLocalStorage: true,
    ...rest,
  };
}

const slack = { descriptor: { id: "slack", name: "Slack" }, status: "connected", config: {} } as unknown as ConnectorSummary;

function setup(initial: NovaProfileView, connectors: ConnectorSummary[] = []) {
  let current = initial;
  const novaProfile = vi.fn(async (request: Parameters<NonNullable<typeof window.openAdminOS>["novaProfile"]>[0]) => {
    if (request.action === "save" && request.patch.instructions !== undefined) current = view({ ...current.effective, instructions: request.patch.instructions, instructionsSource: "user" });
    if (request.action === "save" && request.patch.saveShortcut) current = view({ ...current.effective, shortcuts: [{ id: "s1", createdAt: "2026-11-12T08:00:00.000Z", ...request.patch.saveShortcut }] });
    return current;
  });
  const bridge = makeMockBridge({ novaProfile, listConnectors: vi.fn(async () => connectors) }, createMockAppState({
    organizations: [{ id: "org-a", name: "Northwind", createdAt: "", connections: { microsoft365: { tenantId: "tenant-a" } } }],
    activeOrganizationId: "org-a",
  }));
  renderWithAppState(<NovaSettingsSection />, { bridge });
  return { novaProfile, bridge };
}

describe("Settings, Nova", () => {
  it("saves standing instructions and refuses text over the limit", async () => {
    const { novaProfile } = setup(view());
    const user = userEvent.setup();
    const box = await screen.findByLabelText("Nova standing instructions");
    await user.type(box, "Answer in German.");
    expect(screen.getByText("17 of 4000")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save instructions" }));
    await waitFor(() => expect(novaProfile).toHaveBeenCalledWith({ action: "save", patch: { instructions: "Answer in German." } }));
    expect(await screen.findByText(/Nova uses them from the next conversation/)).toBeInTheDocument();
    await user.clear(box);
    await user.click(box);
    await user.paste("x".repeat(4001));
    expect(screen.getByRole("button", { name: "Save instructions" })).toBeDisabled();
  });

  it("shows instructions the IT department locked as read-only", async () => {
    setup(view({ instructions: "IT text.", instructionsSource: "policy", locked: { voiceMode: true, instructions: true, capabilities: { webSearch: true, startAgents: false, navigation: false }, connectorSends: false, memory: false }, allowedVoiceModes: ["local"], voiceMode: "local" }));
    const box = await screen.findByLabelText("Nova standing instructions");
    expect(box).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Save instructions" })).not.toBeInTheDocument();
    expect(screen.getAllByTestId("set-by-it").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole("switch", { name: /Web search/ })).toBeDisabled();
    const select = screen.getByLabelText("Nova voice provider");
    expect(within(select).queryByText(/OpenAI/)).not.toBeInTheDocument();
  });

  it("turns abilities and sends per connector on and off", async () => {
    const { novaProfile } = setup(view(), [slack]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: /Start agents/ }));
    expect(novaProfile).toHaveBeenCalledWith({ action: "save", patch: { capabilities: { startAgents: false } } });
    await user.click(screen.getByRole("switch", { name: /Send through Slack/ }));
    expect(novaProfile).toHaveBeenCalledWith({ action: "save", patch: { connectorSends: { slack: false } } });
  });

  it("saves the addendum for the active organization only", async () => {
    const { novaProfile } = setup(view());
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Nova notes for Northwind"), "Kiosks are shared.");
    await user.click(screen.getByRole("button", { name: "Save for Northwind" }));
    expect(novaProfile).toHaveBeenCalledWith({ action: "save", patch: { addendum: { organizationId: "org-a", text: "Kiosks are shared." } } });
  });

  it("restores a saved version", async () => {
    const { novaProfile } = setup(view({ instructions: "Now." }, { revisions: [{ id: "r2", at: "2026-11-12T09:00:00.000Z", scope: "user", text: "Now.", via: "settings" }, { id: "r1", at: "2026-11-11T09:00:00.000Z", scope: "user", text: "Before.", via: "nova-proposal" }] }));
    const user = userEvent.setup();
    const versions = await screen.findByRole("list", { name: "Instruction versions" });
    expect(within(versions).getByRole("button", { name: "Current" })).toBeDisabled();
    expect(within(versions).getByText(/confirmed on a Nova card/)).toBeInTheDocument();
    await user.click(within(versions).getByRole("button", { name: "Restore" }));
    expect(novaProfile).toHaveBeenCalledWith({ action: "revert", revisionId: "r1" });
  });

  it("adds a shortcut and shows why a non read-only one is refused", async () => {
    const { novaProfile } = setup(view());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add shortcut" }));
    const form = screen.getByRole("form", { name: "New shortcut" });
    await user.type(within(form).getByLabelText("Name"), "Morning check");
    await user.type(within(form).getByLabelText("Question"), "How many devices are noncompliant?");
    await user.click(within(form).getByRole("button", { name: "Add shortcut" }));
    expect(novaProfile).toHaveBeenCalledWith({ action: "save", patch: { saveShortcut: { name: "Morning check", prompt: "How many devices are noncompliant?" } } });
    expect(await screen.findByText("Morning check")).toBeInTheDocument();
    novaProfile.mockRejectedValueOnce(new Error("Error invoking remote method 'openadminos:nova-profile': NovaProfileError: A shortcut can only ask a read-only question."));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(within(screen.getByRole("form", { name: "Edit shortcut" })).getByRole("button", { name: "Save shortcut" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A shortcut can only ask a read-only question.");
  });
});
