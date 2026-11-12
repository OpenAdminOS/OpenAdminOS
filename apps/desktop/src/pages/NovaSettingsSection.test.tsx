import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { NovaSettingsSection } from "./NovaSettingsSection";
import { createMockAppState, makeMockBridge, renderWithAppState } from "../test/test-utils";
import type { ConnectorSummary, EffectiveNovaProfile, NovaProfileView, NovaRecordsRequest, NovaRecordsView } from "../shared/openAdminOS";

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
    await user.type(await screen.findByLabelText("Nova instructions for Northwind"), "Kiosks are shared.");
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

describe("Settings, Nova, notes and follow-ups", () => {
  function setupRecords(initial: NovaRecordsView, profile = view()) {
    let current = initial;
    const novaRecords = vi.fn(async (request: NovaRecordsRequest) => {
      if (request.action === "note-confirm") current = { ...current, notes: current.notes.map((note) => note.id === request.id ? { ...note, reviewState: "confirmed" as const, reviewedAt: "2026-11-12T10:05:00.000Z" } : note) };
      if (request.action === "note-forget") current = { ...current, notes: current.notes.filter((note) => note.id !== request.id) };
      if (request.action === "note-edit") current = { ...current, notes: current.notes.map((note) => note.id === request.id ? { ...note, text: request.text, reviewState: "edited" as const } : note) };
      if (request.action === "follow-up-cancel") current = { ...current, followUps: current.followUps.map((entry) => entry.id === request.id ? { ...entry, status: "cancelled" as const } : entry) };
      return current;
    });
    const novaProfile = vi.fn(async () => profile);
    const bridge = makeMockBridge({ novaProfile, novaRecords, listConnectors: vi.fn(async () => []) }, createMockAppState({
      organizations: [{ id: "org-a", name: "Northwind", createdAt: "", connections: { microsoft365: { tenantId: "tenant-a" } } }],
      activeOrganizationId: "org-a",
    }));
    renderWithAppState(<NovaSettingsSection />, { bridge });
    return { novaRecords, novaProfile };
  }

  const note = (id: string, text: string, reviewState: "proposed" | "confirmed" = "proposed") => ({
    id, tenantId: "tenant-a", organizationId: "org-a", text, reviewState, source: "nova-proposed" as const,
    createdAt: "2026-11-12T10:00:00.000Z", ...(reviewState === "proposed" ? { expiresAt: "2026-12-12T10:00:00.000Z" } : { reviewedAt: "2026-11-12T10:01:00.000Z" }),
  });

  it("confirms, edits and forgets notes, and shows which wait for review", async () => {
    const { novaRecords } = setupRecords({ tenantId: "tenant-a", organizationId: "org-a", notes: [note("n1", "Kiosks are in Berlin"), note("n2", "We use Autopilot", "confirmed")], followUps: [] });
    const user = userEvent.setup();
    const list = await screen.findByRole("list", { name: "Nova notes" });
    expect(within(list).getByText(/Waiting for review · worded by Nova/)).toBeInTheDocument();
    expect(within(list).getByText(/removed 2026-12-12 10:00 UTC unless confirmed/)).toBeInTheDocument();
    await user.click(within(list).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(novaRecords).toHaveBeenCalledWith({ action: "note-confirm", id: "n1" }));
    expect(await screen.findByText("Note confirmed.")).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: "Confirm" })).toBeNull();
    await user.click(within(list).getAllByRole("button", { name: "Edit" })[1]!);
    const box = screen.getByLabelText("Note");
    await user.clear(box);
    await user.type(box, "We use Autopilot for laptops");
    await user.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(novaRecords).toHaveBeenCalledWith({ action: "note-edit", id: "n2", text: "We use Autopilot for laptops" }));
    await user.click(within(screen.getByRole("list", { name: "Nova notes" })).getAllByRole("button", { name: "Forget" })[0]!);
    await waitFor(() => expect(novaRecords).toHaveBeenCalledWith({ action: "note-forget", id: "n1" }));
  });

  it("pauses notes from the switch, and shows notes set off by IT as read-only", async () => {
    const { novaProfile } = setupRecords({ notes: [], followUps: [] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: /Use notes/ }));
    await waitFor(() => expect(novaProfile).toHaveBeenCalledWith({ action: "save", patch: { memoryPaused: true } }));
  });

  it("disables the notes switch when the IT policy turns notes off", async () => {
    setupRecords({ notes: [], followUps: [] }, view({ memoryEnabled: false, locked: { voiceMode: false, instructions: false, capabilities: { webSearch: false, startAgents: false, navigation: false }, connectorSends: false, memory: true } }));
    expect(await screen.findByRole("switch", { name: /Use notes/ })).toBeDisabled();
    expect(screen.getByText(/Your IT department turned Nova notes off/)).toBeInTheDocument();
  });

  it("lists follow-ups with their state, links an answer, and cancels a pending one", async () => {
    const { novaRecords } = setupRecords({
      tenantId: "tenant-a",
      organizationId: "org-a",
      notes: [],
      followUps: [
        { id: "f1", tenantId: "tenant-a", question: "Check compliance", providerId: "ollama", model: "llama3", dueAt: "2026-11-12T11:00:00.000Z", status: "pending", createdAt: "2026-11-12T10:00:00.000Z" },
        { id: "f2", tenantId: "tenant-a", question: "Check apps", providerId: "ollama", dueAt: "2026-11-12T09:00:00.000Z", status: "skipped-organization", createdAt: "2026-11-12T08:00:00.000Z", finishedAt: "2026-11-12T09:00:30.000Z" },
        { id: "f3", tenantId: "tenant-a", question: "Check encryption", providerId: "ollama", dueAt: "2026-11-12T08:00:00.000Z", status: "completed", createdAt: "2026-11-12T07:00:00.000Z", conversationId: "conv-9" },
      ],
    });
    const user = userEvent.setup();
    const list = await screen.findByRole("list", { name: "Nova follow-ups" });
    expect(within(list).getByText(/Due 2026-11-12 11:00 UTC · ollama · llama3/)).toBeInTheDocument();
    expect(within(list).getByText(/Not run: the organization it was set in was not active or not connected/)).toBeInTheDocument();
    expect(within(list).getByRole("link", { name: "Open in Chat" })).toHaveAttribute("href", "/chat/conv-9");
    await user.click(within(list).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(novaRecords).toHaveBeenCalledWith({ action: "follow-up-cancel", id: "f1" }));
  });
});
