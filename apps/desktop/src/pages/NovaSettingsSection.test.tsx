import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { NovaSettingsSection } from "./NovaSettingsSection";
import { createMockAppState, makeMockBridge, renderWithAppState } from "../test/test-utils";
import { useAppState } from "../state";
import type { AppState, ConnectorSummary, EffectiveNovaProfile, NovaProfileView, NovaRecordsRequest, NovaRecordsView } from "../shared/openAdminOS";

/** A view as the main process returns it: stamped for the active organization, with send states resolved. */
function view(effective: Partial<EffectiveNovaProfile> = {}, rest: Partial<NovaProfileView> = {}): NovaProfileView {
  const sends = effective.connectorSends ?? {};
  return {
    effective: {
      organizationId: "org-a",
      connectorSendStates: Object.fromEntries(["outlook", "teams", "slack", "whatsapp-web", "discord", "signal"].map((id) => [id, { allowed: sends[id] ?? true, locked: false }])),
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

  it("shows organization instructions read-only while the IT department locks the instructions, and the profile limits", async () => {
    setup(view({ instructions: "IT text.", instructionsSource: "policy", locked: { voiceMode: false, instructions: true, capabilities: { webSearch: false, startAgents: false, navigation: false }, connectorSends: false, memory: false } }));
    const addendum = await screen.findByLabelText(/^Nova instructions for /);
    expect(addendum).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: /^Save for / })).not.toBeInTheDocument();
    expect(screen.getByText(/instructions for one organization are not used/)).toBeInTheDocument();
    expect(screen.getByText(/A small on-device model, such as Apple Intelligence, gets a shortened version/)).toBeInTheDocument();
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

  it("shows why a follow-up was skipped for its provider, from the stored reason, with the generic text as fallback", async () => {
    setupRecords({
      tenantId: "tenant-a",
      organizationId: "org-a",
      notes: [],
      followUps: [
        { id: "p1", tenantId: "tenant-a", question: "Check policy", providerId: "codex", dueAt: "2026-11-12T09:00:00.000Z", status: "skipped-provider", createdAt: "2026-11-12T08:00:00.000Z", finishedAt: "2026-11-12T09:00:30.000Z", reason: "Your IT department no longer allows this provider or model. Nothing was asked." },
        { id: "p2", tenantId: "tenant-a", question: "Check endpoint", providerId: "ollama", dueAt: "2026-11-12T09:00:00.000Z", status: "skipped-provider", createdAt: "2026-11-12T08:00:00.000Z", finishedAt: "2026-11-12T09:00:30.000Z", reason: "The provider now runs somewhere else than when this follow-up was set, for example off this device. Nothing was asked." },
        { id: "p3", tenantId: "tenant-a", question: "Check model", providerId: "ollama", dueAt: "2026-11-12T09:00:00.000Z", status: "skipped-provider", createdAt: "2026-11-12T08:00:00.000Z", finishedAt: "2026-11-12T09:00:30.000Z" },
      ],
    });
    const list = await screen.findByRole("list", { name: "Nova follow-ups" });
    expect(within(list).getByText(/Not run: Your IT department no longer allows this provider or model\. Nothing was asked\./)).toBeInTheDocument();
    expect(within(list).getByText(/Not run: The provider now runs somewhere else than when this follow-up was set/)).toBeInTheDocument();
    expect(within(list).getByText(/Not run: the agent provider or model changed after it was set\./)).toBeInTheDocument();
  });
});

describe("Settings, Nova, across an organization switch", () => {
  type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void };
  function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void, reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  function Switcher() {
    const { setActiveOrganization } = useAppState();
    return <button type="button" onClick={() => void setActiveOrganization("org-b")}>Switch to Contoso</button>;
  }

  function setupSwitch() {
    let appState: AppState = createMockAppState({
      organizations: [
        { id: "org-a", name: "Northwind", createdAt: "", connections: { microsoft365: { tenantId: "tenant-a" } } },
        { id: "org-b", name: "Contoso", createdAt: "", connections: { microsoft365: { tenantId: "tenant-b" } } },
      ],
      activeOrganizationId: "org-a",
      activeTenantId: "tenant-a",
    });
    const profileReads: Array<{ organizationId?: string; reply: Deferred<NovaProfileView> }> = [];
    const recordReads: Array<{ organizationId?: string; reply: Deferred<NovaRecordsView> }> = [];
    const novaProfile = vi.fn((request: Parameters<NonNullable<typeof window.openAdminOS>["novaProfile"]>[0]) => {
      const reply = deferred<NovaProfileView>();
      profileReads.push({ organizationId: appState.activeOrganizationId, reply });
      void request;
      return reply.promise;
    });
    const novaRecords = vi.fn(() => {
      const reply = deferred<NovaRecordsView>();
      recordReads.push({ organizationId: appState.activeOrganizationId, reply });
      return reply.promise;
    });
    const bridge = makeMockBridge({
      novaProfile,
      novaRecords,
      listConnectors: vi.fn(async () => []),
      getAppState: vi.fn(async () => appState),
      setActiveOrganization: vi.fn(async (id: string | null) => {
        appState = { ...appState, activeOrganizationId: id ?? undefined, activeTenantId: id === "org-b" ? "tenant-b" : "tenant-a" };
        return appState;
      }),
    }, appState);
    renderWithAppState(<><Switcher /><NovaSettingsSection /></>, { bridge });
    /** Answers every open read, as the main process would for the organization active at the call. */
    const answer = async (organizationId: string, profile: NovaProfileView | Error, records: NovaRecordsView | Error) => {
      await waitFor(() => expect(profileReads.some((read) => read.organizationId === organizationId)).toBe(true));
      await waitFor(() => expect(recordReads.some((read) => read.organizationId === organizationId)).toBe(true));
      const stamped = profile instanceof Error ? profile : { ...profile, effective: { ...profile.effective, organizationId } };
      for (const read of profileReads.splice(0).filter((entry) => entry.organizationId === organizationId)) stamped instanceof Error ? read.reply.reject(stamped) : read.reply.resolve(stamped);
      for (const read of recordReads.splice(0).filter((entry) => entry.organizationId === organizationId)) records instanceof Error ? read.reply.reject(records) : read.reply.resolve(records);
    };
    return { novaProfile, profileReads, recordReads, answer };
  }

  const recordsFor = (organizationId: string, text: string): NovaRecordsView => ({
    tenantId: organizationId === "org-a" ? "tenant-a" : "tenant-b",
    organizationId,
    notes: [{ id: `n-${organizationId}`, tenantId: "t", organizationId, text, reviewState: "confirmed", source: "user-said", createdAt: "2026-11-12T10:00:00.000Z", reviewedAt: "2026-11-12T10:01:00.000Z" }],
    followUps: [],
  });

  it("shows and saves nothing of the previous organization while the new one loads, and ignores its late replies", async () => {
    const { novaProfile, recordReads, answer } = setupSwitch();
    const user = userEvent.setup();
    await answer("org-a", view({ addendum: "Northwind rules." }), recordsFor("org-a", "Northwind kiosks are in Berlin"));
    const box = await screen.findByLabelText("Nova instructions for Northwind");
    await user.type(box, " Draft for Northwind.");
    expect(await screen.findByText("Northwind kiosks are in Berlin")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Switch to Contoso" }));
    expect(await screen.findByText("Loading nova instructions for Contoso.")).toBeInTheDocument();
    expect(screen.getByText("Loading notes for Contoso.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Nova instructions for Contoso")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save for Contoso" })).toBeNull();
    expect(screen.queryByText("Northwind kiosks are in Berlin")).toBeNull();
    expect(screen.queryByDisplayValue(/Draft for Northwind/)).toBeNull();

    await answer("org-b", view({ addendum: "" }), recordsFor("org-b", "Contoso laptops are in Munich"));
    const contoso = await screen.findByLabelText("Nova instructions for Contoso");
    expect(contoso).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save for Contoso" })).toBeDisabled();
    expect(await screen.findByText("Contoso laptops are in Munich")).toBeInTheDocument();
    expect(recordReads.length).toBe(0);
    expect(novaProfile.mock.calls.every(([request]) => request.action === "get")).toBe(true);
  });

  it("ignores a reply that arrives for the previous organization after the switch", async () => {
    const { profileReads, recordReads, answer } = setupSwitch();
    const user = userEvent.setup();
    await waitFor(() => expect(recordReads.some((read) => read.organizationId === "org-a")).toBe(true));
    const late = recordReads.filter((read) => read.organizationId === "org-a");
    const lateProfile = profileReads.filter((read) => read.organizationId === "org-a");
    await user.click(screen.getByRole("button", { name: "Switch to Contoso" }));
    await answer("org-b", view({ addendum: "Contoso rules." }), recordsFor("org-b", "Contoso laptops are in Munich"));
    expect(await screen.findByText("Contoso laptops are in Munich")).toBeInTheDocument();
    for (const read of lateProfile) read.reply.resolve(view({ addendum: "Northwind rules." }));
    for (const read of late) read.reply.resolve(recordsFor("org-a", "Late Northwind note"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("Late Northwind note")).toBeNull();
    expect(screen.getByLabelText("Nova instructions for Contoso")).toHaveValue("Contoso rules.");
  });

  it("shows a records reply stamped for another organization as a failed read with a retry, not as loading", async () => {
    const { answer } = setupSwitch();
    const user = userEvent.setup();
    await answer("org-a", view({ addendum: "Northwind rules." }), recordsFor("org-a", "Northwind kiosks are in Berlin"));
    await user.click(screen.getByRole("button", { name: "Switch to Contoso" }));
    // The main process answered for the previous organization.
    await answer("org-b", view({ addendum: "" }), recordsFor("org-a", "Northwind kiosks are in Berlin"));
    expect(await screen.findByText(/Notes for Contoso could not be loaded: The notes and follow-ups returned were for another organization\./)).toBeInTheDocument();
    expect(screen.queryByText("Loading notes for Contoso.")).toBeNull();
    expect(screen.queryByText("Northwind kiosks are in Berlin")).toBeNull();
    await user.click(screen.getAllByRole("button", { name: "Try again" })[0]!);
    await answer("org-b", view({ addendum: "" }), recordsFor("org-b", "Contoso laptops are in Munich"));
    expect(await screen.findByText("Contoso laptops are in Munich")).toBeInTheDocument();
  });

  it("shows a failed read for the new organization with a retry, not the previous organization's data", async () => {
    const { answer } = setupSwitch();
    const user = userEvent.setup();
    await answer("org-a", view({ addendum: "Northwind rules." }), recordsFor("org-a", "Northwind kiosks are in Berlin"));
    expect(await screen.findByLabelText("Nova instructions for Northwind")).toHaveValue("Northwind rules.");

    await user.click(screen.getByRole("button", { name: "Switch to Contoso" }));
    await answer(
      "org-b",
      new Error("Error invoking remote method 'openadminos:nova-profile': Error: state.json is locked."),
      new Error("Error invoking remote method 'openadminos:nova-records': NovaMemoryError: Nova notes and follow-ups are unavailable."),
    );
    expect(await screen.findByText(/Nova instructions for Contoso could not be loaded: state\.json is locked\./)).toBeInTheDocument();
    expect(screen.getByText(/Notes for Contoso could not be loaded: Nova notes and follow-ups are unavailable\./)).toBeInTheDocument();
    expect(screen.queryByText("Northwind kiosks are in Berlin")).toBeNull();
    expect(screen.queryByDisplayValue("Northwind rules.")).toBeNull();

    await user.click(screen.getAllByRole("button", { name: "Try again" })[0]!);
    await answer("org-b", view({ addendum: "Contoso rules." }), recordsFor("org-b", "Contoso laptops are in Munich"));
    expect(await screen.findByLabelText("Nova instructions for Contoso")).toHaveValue("Contoso rules.");
    expect(await screen.findByText("Contoso laptops are in Munich")).toBeInTheDocument();
  });
});

describe("Settings, Nova, kept current", () => {
  function organizations() {
    return createMockAppState({
      organizations: [{ id: "org-a", name: "Northwind", createdAt: "", connections: { microsoft365: { tenantId: "tenant-a" } } }],
      activeOrganizationId: "org-a",
    });
  }

  it("keeps unsaved instructions when another switch is saved", async () => {
    const novaProfile = vi.fn(async (request: Parameters<NonNullable<typeof window.openAdminOS>["novaProfile"]>[0]) =>
      request.action === "save" ? view({ capabilities: { webSearch: true, startAgents: false, navigation: true } }) : view());
    const bridge = makeMockBridge({ novaProfile, listConnectors: vi.fn(async () => []) }, organizations());
    renderWithAppState(<NovaSettingsSection />, { bridge });
    const user = userEvent.setup();
    const box = await screen.findByLabelText("Nova standing instructions");
    await user.type(box, "Unsaved draft.");
    await user.click(screen.getByRole("switch", { name: /Start agents/ }));
    await waitFor(() => expect(novaProfile).toHaveBeenCalledWith({ action: "save", patch: { capabilities: { startAgents: false } } }));
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(box).toHaveValue("Unsaved draft.");
  });

  it("shows a follow-up answered while the page stays open", async () => {
    const listeners: Array<(info: { reason: string }) => void> = [];
    const pending = { tenantId: "tenant-a", organizationId: "org-a", notes: [], followUps: [{ id: "f1", tenantId: "tenant-a", question: "Check compliance", providerId: "ollama" as const, dueAt: "2026-11-12T11:00:00.000Z", status: "pending" as const, createdAt: "2026-11-12T10:00:00.000Z" }] };
    const answered = { ...pending, followUps: [{ ...pending.followUps[0]!, status: "completed" as const, conversationId: "conv-1", finishedAt: "2026-11-12T11:00:20.000Z" }] };
    const novaRecords = vi.fn(async () => pending as NovaRecordsView);
    const bridge = makeMockBridge({
      novaProfile: vi.fn(async () => view()),
      novaRecords,
      listConnectors: vi.fn(async () => []),
      onAppStateChanged: vi.fn((next: (info: { reason: string }) => void) => { listeners.push(next); return () => undefined; }),
    }, organizations());
    renderWithAppState(<NovaSettingsSection />, { bridge });
    const list = await screen.findByRole("list", { name: "Nova follow-ups" });
    expect(within(list).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    novaRecords.mockResolvedValue(answered as NovaRecordsView);
    for (const listener of listeners) listener({ reason: "nova-records-changed" });
    expect(await within(list).findByRole("link", { name: "Open in Chat" })).toHaveAttribute("href", "/chat/conv-1");
    expect(within(list).queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("says when the messaging connectors cannot be read instead of saying none are set up", async () => {
    let readable = false;
    const listConnectors = vi.fn(async () => {
      if (!readable) throw new Error("Error invoking remote method 'openadminos:list-connectors': Error: connectors.json is locked.");
      return [slack];
    });
    const bridge = makeMockBridge({ novaProfile: vi.fn(async () => view()), listConnectors }, organizations());
    renderWithAppState(<NovaSettingsSection />, { bridge });
    expect(await screen.findByText(/messaging connectors could not be read.*connectors\.json is locked/)).toBeInTheDocument();
    expect(screen.queryByText(/No messaging connectors are set up/)).toBeNull();
    readable = true;
    await userEvent.setup().click(screen.getAllByRole("button", { name: "Try again" })[0]!);
    expect(await screen.findByRole("switch", { name: /Send through Slack/ })).toBeInTheDocument();
  });

  it("shows Slack sending as the IT policy sets it, not as the saved switch", async () => {
    const bridge = makeMockBridge({
      novaProfile: vi.fn(async () => view({ connectorSends: { slack: false }, connectorSendStates: { slack: { allowed: true, locked: true } } })),
      listConnectors: vi.fn(async () => [slack]),
    }, organizations());
    renderWithAppState(<NovaSettingsSection />, { bridge });
    const toggle = await screen.findByRole("switch", { name: /Send through Slack/ });
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
  });
});

describe("Settings, Nova, a save in flight across an organization switch", () => {
  it("does not show the previous organization's save result under the new one", async () => {
    let appState: AppState = createMockAppState({
      organizations: [
        { id: "org-a", name: "Northwind", createdAt: "", connections: { microsoft365: { tenantId: "tenant-a" } } },
        { id: "org-b", name: "Contoso", createdAt: "", connections: { microsoft365: { tenantId: "tenant-b" } } },
      ],
      activeOrganizationId: "org-a",
      activeTenantId: "tenant-a",
    });
    let finishSave!: (value: NovaProfileView) => void;
    const novaProfile = vi.fn((request: Parameters<NonNullable<typeof window.openAdminOS>["novaProfile"]>[0]) => {
      if (request.action === "save") return new Promise<NovaProfileView>((resolve) => { finishSave = resolve; });
      return Promise.resolve({ ...view({ addendum: "" }), effective: { ...view().effective, organizationId: appState.activeOrganizationId } });
    });
    const bridge = makeMockBridge({
      novaProfile,
      listConnectors: vi.fn(async () => []),
      getAppState: vi.fn(async () => appState),
      setActiveOrganization: vi.fn(async (id: string | null) => {
        appState = { ...appState, activeOrganizationId: id ?? undefined, activeTenantId: id === "org-b" ? "tenant-b" : "tenant-a" };
        return appState;
      }),
    }, appState);
    function Switcher() {
      const { setActiveOrganization } = useAppState();
      return <button type="button" onClick={() => void setActiveOrganization("org-b")}>Switch to Contoso</button>;
    }
    renderWithAppState(<><Switcher /><NovaSettingsSection /></>, { bridge });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Nova instructions for Northwind"), "Northwind rules.");
    await user.click(screen.getByRole("button", { name: "Save for Northwind" }));
    await waitFor(() => expect(finishSave).toBeTypeOf("function"));
    await user.click(screen.getByRole("button", { name: "Switch to Contoso" }));
    expect(await screen.findByLabelText("Nova instructions for Contoso")).toHaveValue("");
    await act(async () => finishSave(view({ addendum: "Northwind rules." })));
    expect(screen.queryByText("Saved for Northwind.")).toBeNull();
    expect(screen.getByLabelText("Nova instructions for Contoso")).toHaveValue("");
  });
});
