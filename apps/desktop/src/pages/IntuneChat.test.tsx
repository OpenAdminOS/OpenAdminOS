import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router";

import IntuneChat, { createHostedBatchProviderConsent } from "./IntuneChat";
import Agents from "./Agents";
import { AppShell } from "../components/AppShell";
import { DataBoundaryProvider } from "../state";
import {
  createAwaitingConfirmationRun,
  createMockAgent,
  createMockAppState,
  createMockMcpServers,
  makeMockBridge,
  mockProviders,
  renderRoute,
  renderWithAppState,
} from "../test/test-utils";
import type {
  IntuneChatStep,
  IntuneChatStreamEvent,
  GraphCacheStatus,
  IntuneChatConversation,
  IntuneChatMessage,
  OpenAdminOSApi,
  SendIntuneChatMessageResult,
  WorkspaceDetail,
} from "../shared/openAdminOS";
import { partIdsFor, requestedScopes } from "../shared/openAdminOS";
import { CHAT_COPY, FIRST_RUN_CHAT_COPY, NOT_CONNECTED_COPY, PROVIDER_DETECTION_COPY } from "../copy";
import { PILOT_COPY } from "../shared/pilot-mode";

const LOCAL_NO_TENANT = "Local model. Nothing connected. Nothing leaves this device.";

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

describe("IntuneChat guest exploration", () => {
  it("replaces free text with prepared prompt chips in pilot mode", async () => {
    const user = userEvent.setup();
    const pilotTenant = {
      id: "openadminos-sample-tenant",
      kind: "sample" as const,
      displayName: "Contoso (pilot)",
      username: "admin@contoso-sample.invalid",
      homeAccountId: "openadminos-sample-account",
      addedAt: "2026-10-26T12:00:00.000Z",
    };
    const state = createMockAppState({
      tenants: [pilotTenant],
      activeTenantId: pilotTenant.id,
      installedAgents: [
        {
          ...createMockAgent(),
          id: "find-inactive-devices",
          slug: "find-inactive-devices",
          name: "Find inactive devices",
        },
      ],
    });
    const prompt = "Which managed devices have not synced in the last 7 days?";
    const conversation: IntuneChatConversation = {
      id: "conversation-pilot",
      title: prompt,
      createdAt: "2026-10-26T12:00:00.000Z",
      updatedAt: "2026-10-26T12:00:00.000Z",
      tenantId: pilotTenant.id,
      scopeKind: "single-tenant",
    };
    const messages: IntuneChatMessage[] = [
      { id: "user-1", conversationId: conversation.id, role: "user", content: prompt, status: "completed", createdAt: "2026-10-26T12:00:00.000Z" },
      { id: "assistant-1", conversationId: conversation.id, role: "assistant", content: "17 of 119 managed devices have not checked in.", status: "completed", createdAt: "2026-10-26T12:00:01.000Z" },
    ];
    const bridge = makeMockBridge(
      {
        streamIntuneChatMessage: vi.fn(async () => ({
          conversation,
          userMessage: messages[0]!,
          assistantMessage: messages[1]!,
          cacheStatus: { tenantId: pilotTenant.id, resources: [] },
        })),
        listIntuneChatConversations: vi.fn(async () => [conversation]),
        getIntuneChatMessages: vi.fn(async () => messages),
      },
      state,
    );
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: "/chat", bridge });

    const composer = await screen.findByRole("textbox", { name: "Ask about your Microsoft 365 tenant" });
    expect(composer).toBeDisabled();
    expect(composer).toHaveAttribute("placeholder", PILOT_COPY.composerExplanation);
    const chips = within(screen.getByRole("group", { name: "Prepared prompts" })).getAllByRole("button");
    expect(chips).toHaveLength(6);
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();

    await user.click(chips[0]!);
    await waitFor(() => expect(bridge.streamIntuneChatMessage).toHaveBeenCalledOnce());
    expect(vi.mocked(bridge.streamIntuneChatMessage).mock.calls[0]![0]).toMatchObject({ content: prompt });
    const followUps = await screen.findByRole("group", { name: "Follow-up prompts" });
    expect(within(followUps).getByRole("button", { name: "Which devices are both stale and noncompliant" })).toBeInTheDocument();
    expect(within(followUps).getByRole("button", { name: "Which devices are stale in Intune but still active in Entra" })).toBeInTheDocument();
    expect(within(followUps).getByRole("button", { name: "Try the agent: Find inactive devices" })).toBeInTheDocument();
    expect(screen.getByText(PILOT_COPY.answerScope)).toBeInTheDocument();
  });

  it("shows the new conversation title as text, not an empty rename field", async () => {
    renderRoute(<IntuneChat />, {
      path: "/chat/:conversationId?",
      route: "/chat",
      bridge: makeMockBridge({}, createMockAppState()),
    });

    expect(await screen.findByRole("heading", { name: "Contoso IT" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Conversation title" })).not.toBeInTheDocument();
  });

});

describe("IntuneChat with nothing connected (SPEC.md 4a, 2026-11-08)", () => {
  const DEVICE_QUESTION = "Which devices have not synced in 30 days?";
  const guestState = (overrides: Parameters<typeof createMockAppState>[0] = {}) =>
    createMockAppState({ tenants: [], activeTenantId: undefined, mcpServers: createMockMcpServers(), ...overrides });
  const guestConversation: IntuneChatConversation = {
    id: "conversation-guest", title: DEVICE_QUESTION, createdAt: "2026-11-08T09:00:00.000Z", updatedAt: "2026-11-08T09:00:01.000Z", scopeKind: "single-tenant",
  };
  const cardMessages: IntuneChatMessage[] = [
    { id: "user-g", conversationId: guestConversation.id, role: "user", content: DEVICE_QUESTION, status: "completed", createdAt: guestConversation.createdAt },
    {
      id: "assistant-g", conversationId: guestConversation.id, role: "assistant", status: "completed", createdAt: guestConversation.updatedAt, questionKind: "tenant",
      content: "This needs Intune. Nothing is connected, so no tenant data was read. Connect Intune to answer it. Your question is kept.",
      notConnected: { reason: "no-tenant", partIds: ["intune.devices"] },
    },
  ];
  const cardBridge = (overrides: Partial<OpenAdminOSApi> = {}, state = guestState()) =>
    makeMockBridge(
      {
        listIntuneChatConversations: vi.fn(async () => [guestConversation]),
        getIntuneChatMessages: vi.fn(async () => cardMessages),
        ...overrides,
      },
      state,
    );

  it("opens with two columns of starters and reference suggestions, the destination once, and no setup dialog", async () => {
    const bridge = makeMockBridge({}, guestState());
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: "/chat", bridge });

    expect(await screen.findByRole("heading", { name: FIRST_RUN_CHAT_COPY.homeTitle })).toBeInTheDocument();
    // The model line is gone; the composer's model menu and the line under it say it (design round, C).
    expect(screen.queryByText(/^Answering with/)).toBeNull();
    const starters = within(screen.getByRole("group", { name: FIRST_RUN_CHAT_COPY.startersLabel }));
    expect(starters.getByRole("heading", { name: "Works now" })).toBeInTheDocument();
    const needs = starters.getByRole("heading", { name: /Needs Intune/ }).closest("section")!;
    expect(within(needs).getAllByRole("button").length).toBeGreaterThan(0);
    expect(starters.queryByText("Needs Entra")).toBeNull();
    expect(screen.getByText("Questions go to learn.microsoft.com")).toBeInTheDocument();
    expect(screen.getByText("Questions go to www.kqlsearch.com")).toBeInTheDocument();
    expect(screen.queryByText("Questions go to www.intuneautomation.com")).toBeNull();
    expect(screen.getByText(/4 more in the/)).toBeInTheDocument();
    expect(screen.getByText(LOCAL_NO_TENANT)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: CHAT_COPY.composerLabel })).toHaveAttribute("placeholder", FIRST_RUN_CHAT_COPY.placeholderNoTenant);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(bridge.installMcpServer).not.toHaveBeenCalled();
  });

  it("adds a reference only through the Marketplace install review", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge({}, guestState());
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: "/chat", bridge });

    await user.click(await screen.findByRole("button", { name: "Add Microsoft Learn" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/I understand that words from my question can be sent to learn\.microsoft\.com/)).toBeInTheDocument();
    expect(bridge.installMcpServer).not.toHaveBeenCalled();
  });

  it("sends a docs starter at once with no tenant, no setup dialog and no hosted confirmation", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge({}, guestState());
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: "/chat", bridge });

    await user.click(await screen.findByRole("button", { name: /Write a KQL query for failed sign-ins/ }));
    await waitFor(() => expect(bridge.streamIntuneChatMessage).toHaveBeenCalledOnce());
    const input = vi.mocked(bridge.streamIntuneChatMessage).mock.calls[0]![0];
    expect(input).toMatchObject({ content: FIRST_RUN_CHAT_COPY.worksNowStarters[0] });
    expect(input.hostedProviderConsent).toBeUndefined();
    expect(screen.queryByRole("heading", { name: "Connect a Microsoft 365 tenant" })).not.toBeInTheDocument();
    expect(bridge.connectTenant).not.toHaveBeenCalled();
  });

  it("shows the not-connected card with the part, its exact permissions and the sign-in scopes", async () => {
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: `/chat/${guestConversation.id}`, bridge: cardBridge() });

    expect(await screen.findByRole("heading", { name: "This needs Intune" })).toBeInTheDocument();
    expect(screen.getByText(DEVICE_QUESTION)).toBeInTheDocument();
    // The permissions sit in a quieter disclosure, grouped by part (design round, E).
    expect(screen.getByText(/^\d+ read-only Microsoft Graph permissions$/).closest("details")).not.toHaveAttribute("open");
    const permissions = within(screen.getByRole("list", { name: "Permissions", hidden: true }));
    expect(permissions.getByText("Devices and configuration")).toBeInTheDocument();
    const listed = permissions.getAllByText(/\./).map((node) => node.textContent ?? "").join(", ") + ", " + (permissions.getByText(/openid/).textContent ?? "");
    for (const scope of ["DeviceManagementManagedDevices.Read.All", "DeviceManagementConfiguration.Read.All", "Device.Read.All", "openid", "profile", "offline_access", "User.Read"]) {
      expect(listed).toContain(scope);
    }
    expect(screen.queryByText(/Other Intune parts/)).toBeNull();
    // Actions in weight order: Connect, own registration, Ask an admin.
    const actions = screen.getAllByRole("button").filter((button) => ["Connect Intune", NOT_CONNECTED_COPY.ownRegistration, NOT_CONNECTED_COPY.askAdmin].includes(button.textContent ?? ""));
    expect(actions.map((button) => button.textContent)).toEqual(["Connect Intune", NOT_CONNECTED_COPY.ownRegistration, NOT_CONNECTED_COPY.askAdmin]);
    expect(screen.getByText(NOT_CONNECTED_COPY.fine)).toBeInTheDocument();
  });

  it("connects with the part preselected and the app choice open, then asks again only when chosen", async () => {
    const user = userEvent.setup();
    const connectTenant = vi.fn(async () => createMockAppState());
    const bridge = cardBridge({ connectTenant });
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: `/chat/${guestConversation.id}`, bridge });

    await user.click(await screen.findByRole("button", { name: "Connect Intune" }));
    expect(await screen.findByRole("heading", { name: "Connect a Microsoft 365 tenant" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "OpenAdminOS app" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Your own app registration" })).not.toBeChecked();
    await user.click(screen.getByRole("radio", { name: "OpenAdminOS app" }));
    await user.click(await screen.findByRole("button", { name: /Approve \d+ read scopes and continue to Microsoft/ }));
    await waitFor(() => expect(connectTenant).toHaveBeenCalledWith({ partIds: ["intune.devices"] }));
    await user.click(await screen.findByRole("button", { name: "Done" }));

    expect(await screen.findByText("Intune connected for Contoso IT")).toBeInTheDocument();
    expect(bridge.streamIntuneChatMessage).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: NOT_CONNECTED_COPY.askAgain }));
    await waitFor(() => expect(bridge.streamIntuneChatMessage).toHaveBeenCalledOnce());
    expect(vi.mocked(bridge.streamIntuneChatMessage).mock.calls[0]![0]).toMatchObject({ content: DEVICE_QUESTION, conversationId: guestConversation.id });
  });

  it("opens the own registration path from the card", async () => {
    const user = userEvent.setup();
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: `/chat/${guestConversation.id}`, bridge: cardBridge() });

    await user.click(await screen.findByRole("button", { name: NOT_CONNECTED_COPY.ownRegistration }));
    expect(await screen.findByRole("radio", { name: "Your own app registration" })).toBeChecked();
  });

  it("copies a message with the admin consent link for the listed permissions", async () => {
    const user = userEvent.setup();
    const bridge = cardBridge();
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: `/chat/${guestConversation.id}`, bridge });

    await user.click(await screen.findByRole("button", { name: NOT_CONNECTED_COPY.askAdmin }));
    await waitFor(() => expect(bridge.writeClipboardText).toHaveBeenCalledOnce());
    const message = vi.mocked(bridge.writeClipboardText).mock.calls[0]![0] as string;
    const link = message.match(/https:\/\/login\.microsoftonline\.com\/\S+/)?.[0];
    expect(link).toBeDefined();
    const url = new URL(link!);
    expect(url.pathname).toBe("/organizations/v2.0/adminconsent");
    expect(url.searchParams.get("client_id")).toBe("d1de0a94-f67a-421d-8804-a235955ffd69");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(expect.arrayContaining([
      "openid", "profile", "offline_access", "https://graph.microsoft.com/User.Read", "https://graph.microsoft.com/DeviceManagementManagedDevices.Read.All",
    ]));
    expect(message).toMatch(/Cloud Application Administrator/);
    expect(message).not.toMatch(/ - | – | — /);
  });

  it("shows the scan's choice list with no model, never preselects a hosted tool, and keeps the draft on Send", async () => {
    const user = userEvent.setup();
    const providers = mockProviders.map((provider) => (provider.id === "ollama" ? { ...provider, status: "not-installed" as const } : provider));
    const bridge = makeMockBridge({}, guestState({ providers }));
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: "/chat", bridge });

    expect(await screen.findByRole("heading", { name: FIRST_RUN_CHAT_COPY.modelChoiceTitle })).toBeInTheDocument();
    // The same list as the first-launch scan (design round, B): local first, hosted rows say where prompts go.
    const group = screen.getByRole("radiogroup", { name: FIRST_RUN_CHAT_COPY.modelChoiceTitle });
    expect(within(group).getByRole("radio", { name: /^Ollama/ })).toBeChecked();
    expect(within(group).getByRole("radio", { name: /^Codex/ })).not.toBeChecked();
    expect(within(group).getByText("Prompts leave this device through Codex; location set by your account")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Get OpenAdmin 8B" })).toBeInTheDocument();
    expect(bridge.setActiveProvider).not.toHaveBeenCalled();
    const composer = screen.getByRole("combobox", { name: CHAT_COPY.composerLabel });
    expect(composer).toHaveAttribute("placeholder", FIRST_RUN_CHAT_COPY.placeholderNoModel);
    await user.type(composer, "Explain Autopatch rings");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(FIRST_RUN_CHAT_COPY.noModelSendNotice)).toBeInTheDocument();
    expect(composer).toHaveValue("Explain Autopatch rings");
    expect(bridge.streamIntuneChatMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(within(group).getByRole("radio", { name: /^Codex/ }));
    await user.click(screen.getByRole("button", { name: "Use Codex" }));
    await waitFor(() => expect(bridge.setActiveProvider).toHaveBeenCalledWith("openai"));
  });

  it("offers no sample data in the model choice (maintainer decision, 2026-11-09)", async () => {
    const providers = mockProviders.map((provider) => (provider.id === "ollama" ? { ...provider, status: "not-installed" as const } : provider));
    const bridge = makeMockBridge({}, guestState({ providers }));
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: "/chat", bridge });

    expect(await screen.findByRole("heading", { name: FIRST_RUN_CHAT_COPY.modelChoiceTitle })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sample data/i })).toBeNull();
  });

  it("offers starters for what was connected, one line per service (mockup 32, section B)", async () => {
    const user = userEvent.setup();
    const base = createMockAppState();
    const tenant = { ...base.tenants[0]!, grantedScopes: requestedScopes(partIdsFor(["defender"])).map((scope) => `graph:${scope.name}`) };
    const bridge = makeMockBridge({}, createMockAppState({ tenants: [tenant], activeTenantId: tenant.id }));
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: "/chat", bridge });

    expect(await screen.findByText(CHAT_COPY.askAbout("Defender"))).toBeInTheDocument();
    expect(screen.queryByText(CHAT_COPY.askAbout("Intune"))).toBeNull();
    expect(screen.queryByText("Try")).toBeNull();
    const defender = document.querySelector<HTMLElement>("[data-starters='defender']")!;
    await user.click(within(defender).getAllByRole("button")[0]!);
    expect(screen.getByRole("combobox", { name: CHAT_COPY.composerLabel })).toHaveValue("Which high severity incidents are still open?");
  });

  it("cancels the inline confirmation with Escape, keeps the question and returns to the composer (design round, D)", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge({}, guestState({ activeProviderId: "openai", activeModelByProviderId: { openai: "gpt-5" } }));
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: "/chat", bridge });
    const composer = await screen.findByRole("combobox", { name: CHAT_COPY.composerLabel });
    await user.type(composer, "Explain Autopatch rings");
    await user.click(screen.getByRole("button", { name: "Send" }));
    const dialog = await screen.findByRole("dialog", { name: "Send this question through Codex?" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Send through Codex" })).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Send this question through Codex?" })).toBeNull();
    await waitFor(() => expect(composer).toHaveFocus());
    expect(composer).toHaveValue("Explain Autopatch rings");
    expect(bridge.streamIntuneChatMessage).not.toHaveBeenCalled();
  });

  it("asks for a no-tenant hosted confirmation inline, naming the provider, where prompts go and what is sent", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge({}, guestState({ activeProviderId: "openai", activeModelByProviderId: { openai: "gpt-5" } }));
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: "/chat", bridge });

    expect(await screen.findByRole("note")).toHaveTextContent(
      "Prompts leave this device through Codex; location set by your account. Nothing is connected, so no tenant data is sent.",
    );
    await user.type(screen.getByRole("combobox", { name: CHAT_COPY.composerLabel }), "Explain Autopatch rings");
    await user.click(screen.getByRole("button", { name: "Send" }));
    // Inline above the composer, so the typed question stays visible (design round, D).
    const dialog = await screen.findByRole("dialog", { name: "Send this question through Codex?" });
    expect(dialog).toHaveAttribute("aria-modal", "false");
    expect(screen.getByRole("combobox", { name: CHAT_COPY.composerLabel })).toHaveValue("Explain Autopatch rings");
    expect(within(dialog).getByText("Codex answers with your existing sign-in. Nothing is connected, so no tenant data is included.")).toBeInTheDocument();
    const goesTo = within(dialog).getByText("Codex · location set by your account", { exact: false });
    // The detail says what the location depends on (maintainer decision, 2026-11-09).
    expect(within(dialog).getByText(/^Codex sends prompts to OpenAI, or to the endpoint its configuration selects\./)).toBeInTheDocument();
    expect(goesTo.tagName).toBe("DD");
    expect(within(dialog).getByText("Your question and this conversation")).toBeInTheDocument();
    expect(within(dialog).getByText("Chat history")).toBeInTheDocument();
    expect(bridge.streamIntuneChatMessage).not.toHaveBeenCalled();
    // The remembered decision is per provider and model, and the label names the model (Muse round 2, Q).
    expect(within(dialog).getByRole("checkbox", { name: "Do not ask again for questions without a tenant on gpt-5" })).not.toBeChecked();
    expect(within(dialog).getByText("Model").nextElementSibling).toHaveTextContent("gpt-5");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Send through Codex" })).toHaveFocus());

    await user.click(within(dialog).getByRole("button", { name: "Send through Codex" }));
    await waitFor(() => expect(bridge.streamIntuneChatMessage).toHaveBeenCalledOnce());
    const consent = vi.mocked(bridge.streamIntuneChatMessage).mock.calls[0]![0].hostedProviderConsent;
    expect(consent).toMatchObject({ noTenant: true, providerId: "openai", model: "gpt-5" });
    expect(consent).not.toHaveProperty("tenantId");
  });

  it("sends a question blocked on the device without the hosted confirmation (review round 1, finding 9)", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge(
      { previewIntuneChatSend: vi.fn(async () => ({ reachesModel: false })) },
      guestState({ activeProviderId: "openai", activeModelByProviderId: { openai: "gpt-5" } }),
    );
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: "/chat", bridge });
    await user.type(await screen.findByRole("combobox", { name: CHAT_COPY.composerLabel }), DEVICE_QUESTION);
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(bridge.streamIntuneChatMessage).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog", { name: "Send this question through Codex?" })).not.toBeInTheDocument();
    expect(vi.mocked(bridge.streamIntuneChatMessage).mock.calls[0]![0].hostedProviderConsent).toBeUndefined();
  });

  it("asks again after a model change when the no-tenant decision was remembered for another model (finding 10)", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("openadminos:intune-chat-hosted-consent:v2:no-tenant:openai:gpt-4", "true");
    try {
      const bridge = makeMockBridge({}, guestState({ activeProviderId: "openai", activeModelByProviderId: { openai: "gpt-5" } }));
      renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: "/chat", bridge });
      await user.type(await screen.findByRole("combobox", { name: CHAT_COPY.composerLabel }), "Explain Autopatch rings");
      await user.click(screen.getByRole("button", { name: "Send" }));
      expect(await screen.findByRole("dialog", { name: "Send this question through Codex?" })).toBeInTheDocument();
      expect(bridge.streamIntuneChatMessage).not.toHaveBeenCalled();
    } finally {
      window.localStorage.removeItem("openadminos:intune-chat-hosted-consent:v2:no-tenant:openai:gpt-4");
    }
  });

  it("asks again with the tenant-bound confirmation once a tenant is connected, even after remembering the no-tenant one", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("openadminos:intune-chat-hosted-consent:v2:no-tenant:openai:gpt-5", "true");
    try {
      const bridge = makeMockBridge({}, createMockAppState({ activeProviderId: "openai", activeModelByProviderId: { openai: "gpt-5" } }));
      renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: "/chat", bridge });
      await user.type(await screen.findByRole("combobox", { name: CHAT_COPY.composerLabel }), "Which Windows devices are stale?");
      await user.click(screen.getByRole("button", { name: "Send" }));
      const dialog = await screen.findByRole("dialog", { name: "Send this question through Codex?" });
      expect(within(dialog).getByText(/Selected cached data from .+ is included\./)).toBeInTheDocument();
      expect(bridge.streamIntuneChatMessage).not.toHaveBeenCalled();
    } finally {
      window.localStorage.removeItem("openadminos:intune-chat-hosted-consent:v2:no-tenant:openai:gpt-5");
    }
  });
});

describe("IntuneChat new conversation routing", () => {
  it("never flashes 'Conversation not found' while the first message is sending", async () => {
    const user = userEvent.setup();
    const newConversation: IntuneChatConversation = {
      id: "conversation-new",
      title: "Which Windows devices are stale?",
      createdAt: "2026-08-31T12:00:00.000Z",
      updatedAt: "2026-08-31T12:00:00.000Z",
      tenantId: "tenant-1",
      scopeKind: "single-tenant",
    };
    // Reproduces the real sequence: the host emits "started" with a
    // conversation the sidebar list has not returned yet, and the route
    // moves to it. The list stays stale on purpose, so the route can only
    // stay valid if the conversation is seeded into local state.
    const bridge = makeMockBridge(
      {
        listIntuneChatConversations: vi.fn(async () => []),
        streamIntuneChatMessage: vi.fn(async (input, onEvent) => {
          const result = {
            conversation: newConversation,
            userMessage: {
              id: "message-user-new",
              conversationId: newConversation.id,
              role: "user" as const,
              content: input.content,
              status: "completed" as const,
              createdAt: newConversation.createdAt,
            },
            assistantMessage: {
              id: "message-assistant-new",
              conversationId: newConversation.id,
              role: "assistant" as const,
              content: "",
              status: "pending" as const,
              createdAt: newConversation.createdAt,
            },
            cacheStatus: { tenantId: "tenant-1", resources: [] },
          };
          onEvent({ type: "started", ...result });
          return result as never;
        }),
      },
      createMockAppState(),
    );

    renderRoute(<IntuneChat />, {
      path: "/chat/:conversationId?",
      route: "/chat",
      bridge,
    });

    const composer = await screen.findByRole("combobox", {
      name: "Ask about your Microsoft 365 tenant",
    });
    await user.type(composer, "Which Windows devices are stale?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(bridge.streamIntuneChatMessage).toHaveBeenCalled(),
    );
    await waitFor(() =>
      expect(screen.queryByText("Conversation not found")).not.toBeInTheDocument(),
    );
  });
});

const PILOT_TENANT = {
  id: "openadminos-sample-tenant",
  kind: "sample" as const,
  displayName: "Contoso (pilot)",
  username: "admin@contoso-sample.invalid",
  homeAccountId: "openadminos-sample-account",
  addedAt: "2026-10-26T12:00:00.000Z",
};

/** A bridge whose stream emits started and completed, like the host. */
function streamingBridge(state: ReturnType<typeof createMockAppState>) {
  const tenantId = state.activeTenantId;
  const conversation: IntuneChatConversation = {
    id: "conversation-scroll",
    title: "Which managed devices have not synced in the last 7 days?",
    createdAt: "2026-10-26T12:00:00.000Z",
    updatedAt: "2026-10-26T12:00:00.000Z",
    tenantId,
    scopeKind: "single-tenant",
  };
  let saved: IntuneChatMessage[] = [];
  return makeMockBridge(
    {
      listIntuneChatConversations: vi.fn(async () => (saved.length ? [conversation] : [])),
      getIntuneChatMessages: vi.fn(async () => saved),
      streamIntuneChatMessage: vi.fn<OpenAdminOSApi["streamIntuneChatMessage"]>(async (input, onEvent) => {
        const userMessage: IntuneChatMessage = {
          id: "user-scroll",
          conversationId: conversation.id,
          role: "user",
          content: input.content,
          status: "completed",
          createdAt: conversation.createdAt,
        };
        const assistantMessage: IntuneChatMessage = {
          id: "assistant-scroll",
          conversationId: conversation.id,
          role: "assistant",
          content: "17 of 119 managed devices have not checked in.\n\n| Device | Last sync |\n| --- | --- |\n| CTS-MB-0180 | 2026-04-01 |",
          status: "completed",
          createdAt: "2026-10-26T12:00:01.000Z",
        };
        const cacheStatus: GraphCacheStatus = { tenantId, resources: [] };
        onEvent({ type: "started", conversation, userMessage, assistantMessage: { ...assistantMessage, content: "", status: "streaming" }, cacheStatus } as never);
        saved = [userMessage, assistantMessage];
        const result: SendIntuneChatMessageResult = { conversation, userMessage, assistantMessage, cacheStatus };
        onEvent({ type: "completed", result });
        return result;
      }),
    },
    state,
  );
}

function spyOnMessageScrollIntoView() {
  const anchored: Array<{ messageId: string | undefined; options: unknown }> = [];
  const spy = vi
    .spyOn(HTMLElement.prototype, "scrollIntoView")
    .mockImplementation(function (this: HTMLElement, options?: boolean | ScrollIntoViewOptions) {
      if (this.dataset.messageId) anchored.push({ messageId: this.dataset.messageId, options });
    });
  return { anchored, restore: () => spy.mockRestore() };
}

describe("IntuneChat answer scroll", () => {
  it("keeps the prompt at the top when a pilot answer arrives", async () => {
    const user = userEvent.setup();
    const scroll = spyOnMessageScrollIntoView();
    try {
      const bridge = streamingBridge(
        createMockAppState({ tenants: [PILOT_TENANT], activeTenantId: PILOT_TENANT.id }),
      );
      renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: "/chat", bridge });

      const chips = within(await screen.findByRole("group", { name: "Prepared prompts" })).getAllByRole("button");
      await user.click(chips[0]!);
      await screen.findByText(/17 of 119 managed devices have not checked in/);

      await waitFor(() =>
        expect(scroll.anchored).toContainEqual({
          messageId: "user-scroll",
          options: expect.objectContaining({ block: "start" }),
        }),
      );
    } finally {
      scroll.restore();
    }
  });

  it("keeps following the latest output in production", async () => {
    const user = userEvent.setup();
    const scroll = spyOnMessageScrollIntoView();
    try {
      const bridge = streamingBridge(createMockAppState());
      renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: "/chat", bridge });

      const composer = await screen.findByRole("combobox", { name: "Ask about your Microsoft 365 tenant" });
      await user.type(composer, "Which managed devices have not synced in the last 7 days?");
      await user.click(screen.getByRole("button", { name: "Send" }));
      await screen.findByText(/17 of 119 managed devices have not checked in/);

      expect(scroll.anchored).toEqual([]);
    } finally {
      scroll.restore();
    }
  });
});

describe("IntuneChat automatic provider notice", () => {
  const notice = PROVIDER_DETECTION_COPY.autoSelectedNotice("LM Studio");

  it("shows once after a local provider was selected automatically, until dismissed", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge(
      {},
      createMockAppState({
        activeProviderId: "lm-studio",
        providers: mockProviders.map((provider) =>
          provider.id === "lm-studio"
            ? { ...provider, status: "connected" as const, models: ["qwen2.5-7b-instruct"] }
            : provider,
        ),
        providerAutoSelectNotice: { providerId: "lm-studio", providerName: "LM Studio" },
      }),
    );
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: "/chat", bridge });

    expect(await screen.findByText(notice)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: PROVIDER_DETECTION_COPY.autoSelectedNoticeDismiss }));
    await waitFor(() => expect(bridge.dismissProviderAutoSelectNotice).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByText(notice)).not.toBeInTheDocument());
  });

  it("never shows in pilot mode", async () => {
    const bridge = makeMockBridge(
      {},
      createMockAppState({
        tenants: [PILOT_TENANT],
        activeTenantId: PILOT_TENANT.id,
        providerAutoSelectNotice: { providerId: "lm-studio", providerName: "LM Studio" },
      }),
    );
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: "/chat", bridge });

    await screen.findByRole("group", { name: "Prepared prompts" });
    expect(screen.queryByText(notice)).not.toBeInTheDocument();
  });
});

describe("IntuneChat shell conversation actions", () => {
  it("keeps the active transcript streaming when another conversation is pinned", async () => {
    const user = userEvent.setup();
    const activeConversation: IntuneChatConversation = {
      id: "conversation-active",
      title: "Active investigation",
      createdAt: "2026-10-10T08:00:00.000Z",
      updatedAt: "2026-10-10T10:00:00.000Z",
      tenantId: "tenant-1",
      scopeKind: "single-tenant",
    };
    const otherConversation: IntuneChatConversation = {
      ...activeConversation,
      id: "conversation-other",
      title: "Other investigation",
      updatedAt: "2026-10-10T09:00:00.000Z",
    };
    const bridge = makeMockBridge({
      listIntuneChatConversations: vi.fn(async () => [
        activeConversation,
        otherConversation,
      ]),
      streamIntuneChatMessage: vi.fn(
        async () => await new Promise<never>(() => undefined),
      ),
    });

    renderWithAppState(
      <Routes>
        <Route
          path="/chat/:conversationId?"
          element={
            <AppShell>
              <IntuneChat />
              <LocationProbe />
            </AppShell>
          }
        />
      </Routes>,
      { route: `/chat/${activeConversation.id}`, bridge },
    );

    const composer = await screen.findByRole("combobox", {
      name: "Ask about your Microsoft 365 tenant",
    });
    await user.type(composer, "Continue checking stale devices");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(bridge.streamIntuneChatMessage).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", {
        name: `More actions for ${otherConversation.title}`,
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Pin" }));

    await waitFor(() =>
      expect(bridge.setIntuneChatConversationPinned).toHaveBeenCalledWith(
        otherConversation.id,
        true,
      ),
    );
    expect(screen.getByTestId("location")).toHaveTextContent(
      `/chat/${activeConversation.id}`,
    );
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

    // Stop cancels only this conversation's stream, by the id the send
    // was started with.
    const streamOptions = vi.mocked(bridge.streamIntuneChatMessage).mock.calls[0]?.[2];
    expect(streamOptions?.streamId).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(bridge.cancelIntuneChatStream).toHaveBeenCalledWith(streamOptions?.streamId),
    );
  });
});

describe("IntuneChat tenant briefing", () => {
  it("shows real confirmation work and opens its existing review route", async () => {
    const user = userEvent.setup();
    const run = createAwaitingConfirmationRun({
      id: "run-review-1",
      tenantId: "tenant-1",
      agentSlug: "device-offboard",
    });
    const bridge = makeMockBridge(
      {},
      createMockAppState({ runs: [run] }),
    );

    renderWithAppState(
      <Routes>
        <Route path="/chat/:conversationId?" element={<><IntuneChat /><LocationProbe /></>} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      { route: "/chat", bridge },
    );

    expect(await screen.findByRole("heading", { name: "Needs you" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /ready for review.*Review/i }));
    expect(screen.getByTestId("location")).toHaveTextContent("/runs/run-review-1");
  });
});

describe("IntuneChat agent picker", () => {
  it("keeps saved queries reachable with keyboard selection", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge({
      listSavedMultiTenantQueries: vi.fn(async () => [
        {
          id: "query-1",
          title: "Stale device review",
          prompt: "Compare stale devices across connected tenants",
          resourceHints: ["managedDevices" as const],
          defaultScope: { kind: "all" as const },
          order: 0,
          createdAt: "2026-08-06T10:00:00.000Z",
          updatedAt: "2026-08-06T10:00:00.000Z",
        },
      ]),
    });

    renderRoute(<IntuneChat />, {
      path: "/chat/:conversationId?",
      route: "/chat",
      bridge,
    });

    const composer = await screen.findByRole("combobox", {
      name: "Ask about your Microsoft 365 tenant",
    });
    await user.type(composer, "/");
    expect(await screen.findByRole("listbox", { name: "Agents and saved queries" })).toBeInTheDocument();
    expect(screen.getByText("Saved queries")).toBeInTheDocument();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(composer).toHaveValue("Compare stale devices across connected tenants");
    expect(composer).toHaveFocus();
  });

  it("routes write agents to confirmation without starting a run", async () => {
    const user = userEvent.setup();
    const writeAgent = createMockAgent();
    const bridge = makeMockBridge(
      {},
      createMockAppState({ installedAgents: [writeAgent] }),
    );

    renderWithAppState(
      <Routes>
        <Route path="/chat/:conversationId?" element={<><IntuneChat /><LocationProbe /></>} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      { route: "/chat", bridge },
    );

    await user.click(await screen.findByRole("button", { name: "Run an agent" }));
    await user.click(await screen.findByRole("option", { name: /Device Offboard/ }));
    expect(screen.getByRole("combobox", { name: "Ask about your Microsoft 365 tenant" })).toHaveValue("/Device Offboard ");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/agents/device-offboard/confirm");
    });
    expect(bridge.startRun).not.toHaveBeenCalled();
  });

  it("starts read-only agents through the existing run flow", async () => {
    const user = userEvent.setup();
    const readAgent = createMockAgent({
      id: "inactive-devices",
      slug: "inactive-devices",
      name: "Inactive Devices",
      mode: "read",
      scopes: ["DeviceManagementManagedDevices.Read.All"],
    });
    const bridge = makeMockBridge(
      {},
      createMockAppState({ installedAgents: [readAgent] }),
    );

    renderWithAppState(
      <Routes>
        <Route path="/chat/:conversationId?" element={<><IntuneChat /><LocationProbe /></>} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      { route: "/chat", bridge },
    );

    await user.click(await screen.findByRole("button", { name: "Run an agent" }));
    await user.click(await screen.findByRole("option", { name: /Inactive Devices/ }));
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(bridge.startRun).toHaveBeenCalledWith("inactive-devices", undefined));
    expect(screen.getByTestId("location")).toHaveTextContent("/runs/run-new-1");
  });

  it("matches the longest installed agent name case-insensitively", async () => {
    const user = userEvent.setup();
    const deviceAgent = createMockAgent({
      id: "device",
      slug: "device",
      name: "Device",
      mode: "read",
    });
    const deviceAuditAgent = createMockAgent({
      id: "device-audit",
      slug: "device-audit",
      name: "Device Audit",
      mode: "read",
    });
    const bridge = makeMockBridge(
      {},
      createMockAppState({ installedAgents: [deviceAgent, deviceAuditAgent] }),
    );

    renderWithAppState(
      <Routes>
        <Route path="/chat/:conversationId?" element={<><IntuneChat /><LocationProbe /></>} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>,
      { route: "/chat", bridge },
    );

    const composer = await screen.findByRole("combobox", {
      name: "Ask about your Microsoft 365 tenant",
    });
    await user.type(composer, "/DEVICE AUDIT");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(bridge.startRun).toHaveBeenCalledWith("device-audit", undefined),
    );
    expect(bridge.startRun).not.toHaveBeenCalledWith("device", undefined);
  });

  it("keeps trailing agent instructions in the composer and explains recovery", async () => {
    const user = userEvent.setup();
    const readAgent = createMockAgent({
      id: "device-audit",
      slug: "device-audit",
      name: "Device Audit",
      mode: "read",
    });
    const bridge = makeMockBridge(
      {},
      createMockAppState({ installedAgents: [readAgent] }),
    );

    renderRoute(<IntuneChat />, {
      path: "/chat/:conversationId?",
      route: "/chat",
      bridge,
    });

    const composer = await screen.findByRole("combobox", {
      name: "Ask about your Microsoft 365 tenant",
    });
    const command = "/Device Audit\ncheck stale devices";
    await user.type(composer, command);
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(bridge.startRun).not.toHaveBeenCalled();
    expect(composer).toHaveValue(command);
    expect(
      screen.getByText(/Device Audit runs without extra instructions.*send again/),
    ).toBeInTheDocument();
  });
});

describe("IntuneChat hosted-provider disclosure", () => {
  const sentence = "Prompts and tenant data leave this device through Codex; location set by your account.";
  const CODEX_LOCATION_DETAIL = "Codex sends prompts to OpenAI, or to the endpoint its configuration selects. Processing follows your workspace's data residency setting.";
  const conversation: IntuneChatConversation = {
    id: "conversation-hosted", title: "Stale devices", createdAt: "2026-11-04T09:00:00.000Z", updatedAt: "2026-11-04T09:01:00.000Z", tenantId: "tenant-1", scopeKind: "single-tenant",
  };
  const answered = (model: string) => vi.fn(async () => [
    { id: "q-h", conversationId: conversation.id, role: "user" as const, content: "Which devices are stale?", status: "completed" as const, createdAt: conversation.createdAt },
    { id: "a-h", conversationId: conversation.id, role: "assistant" as const, content: "Two devices are stale.", status: "completed" as const, createdAt: conversation.updatedAt, providerId: "openai" as const, model },
  ]);

  it("folds the sentence into an icon once the conversation sent with this model, keeping it reachable by keyboard and screen reader", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge(
      { listIntuneChatConversations: vi.fn(async () => [conversation]), getIntuneChatMessages: answered("gpt-5") },
      createMockAppState({ activeProviderId: "openai", activeModelByProviderId: { openai: "gpt-5" } }),
    );
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId", route: "/chat/conversation-hosted", bridge });
    expect(await screen.findByText("Two devices are stale.")).toBeInTheDocument();
    const icon = screen.getByRole("button", { name: "Where data goes" });
    // The tooltip adds what the location depends on; the line under the composer stays short.
    expect(icon).toHaveAccessibleDescription(`${sentence} ${CODEX_LOCATION_DETAIL}`);
    expect(icon).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("note")).toBeNull();
    // The status strip pill is unchanged; the composer icon opens the full sentence on demand.
    await user.click(icon);
    expect(icon).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("note")).toHaveTextContent(sentence);
    await user.click(icon);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("shows the sentence in full again after switching the model", async () => {
    const bridge = makeMockBridge(
      { listIntuneChatConversations: vi.fn(async () => [conversation]), getIntuneChatMessages: answered("gpt-4.1") },
      createMockAppState({ activeProviderId: "openai", activeModelByProviderId: { openai: "gpt-5" } }),
    );
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId", route: "/chat/conversation-hosted", bridge });
    expect(await screen.findByText("Two devices are stale.")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(sentence);
    expect(screen.getByRole("button", { name: "Where data goes" })).toHaveAttribute("aria-expanded", "true");
  });
  it("adds the MCP disclosure to the hosted sentence and the shield tooltip when MCP servers are on", async () => {
    const bridge = makeMockBridge(
      { listIntuneChatConversations: vi.fn(async () => [conversation]), getIntuneChatMessages: answered("gpt-5") },
      createMockAppState({
        activeProviderId: "openai", activeModelByProviderId: { openai: "gpt-5" },
        mcpServers: createMockMcpServers({ "microsoft-learn": { installed: true, enabled: true } }),
      }),
    );
    renderRoute(<DataBoundaryProvider><IntuneChat /></DataBoundaryProvider>, { path: "/chat/:conversationId", route: "/chat/conversation-hosted", bridge });
    expect(await screen.findByText("Two devices are stale.")).toBeInTheDocument();
    const full = `${sentence} MCP queries are written from your current question only, never from Graph or cache data. Words from that question can be sent to learn.microsoft.com. A filter blocks known tenant names, IDs, email addresses and IP addresses, but cannot guarantee it catches every private detail.`;
    // The shield carries the full text and opens the same line.
    const icon = screen.getByRole("button", { name: "Where data goes" });
    expect(icon).toHaveAccessibleDescription(full.replace(sentence, `${sentence} ${CODEX_LOCATION_DETAIL}`));
    await userEvent.setup().click(icon);
    expect(screen.getByRole("note")).toHaveTextContent(full);
  });
});

describe("IntuneChat hosted-provider consent", () => {
  it("shows consent copy and waits for explicit confirmation before sending tenant context", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge(
      {},
      createMockAppState({
        activeProviderId: "openai",
        activeModelByProviderId: { openai: "gpt-5" },
      }),
    );

    renderRoute(<IntuneChat />, {
      path: "/chat/:conversationId?",
      route: "/chat",
      bridge,
    });

    const composer = await screen.findByRole("combobox", {
      name: "Ask about your Microsoft 365 tenant",
    });
    expect(document.querySelector("header")?.textContent ?? "").not.toContain("OpenAI");
    // A new conversation shows the hosted sentence in full under the composer.
    expect(await screen.findByRole("note")).toHaveTextContent(
      "Prompts and tenant data leave this device through Codex; location set by your account.",
    );

    await user.type(composer, "Which Windows devices are stale?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const dialog = await screen.findByRole("dialog", { name: "Send this question through Codex?" });
    expect(within(dialog).getByText("Codex answers with your existing sign-in. Selected cached data from Contoso IT is included.")).toBeInTheDocument();
    expect(within(dialog).getByText("Codex · location set by your account", { exact: false })).toBeInTheDocument();
    expect(within(dialog).getByText("Your question, this conversation and selected cached data from Contoso IT")).toBeInTheDocument();
    // The tenant-bound acknowledgement is bound to the model too, so it names it (PR #175 onboarding round review, 5).
    expect(within(dialog).getByText("Model").nextElementSibling).toHaveTextContent("gpt-5");
    expect(within(dialog).getByRole("checkbox", { name: "Do not ask again for Contoso IT with Codex on gpt-5" })).not.toBeChecked();
    expect(bridge.streamIntuneChatMessage).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Send through Codex" }));

    await waitFor(() => {
      expect(bridge.streamIntuneChatMessage).toHaveBeenCalledTimes(1);
    });
    const sent = vi.mocked(bridge.streamIntuneChatMessage).mock.calls[0]?.[0];
    expect(sent).toEqual(
      expect.objectContaining({
        content: "Which Windows devices are stale?",
        hostedProviderConsent: expect.objectContaining({
          tenantId: "tenant-1",
          providerId: "openai",
        }),
      }),
    );
    expect(sent?.hostedProviderConsent).not.toHaveProperty("remember");
  });

  it("names the enabled MCP hosts in what leaves this device", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge(
      {},
      createMockAppState({
        activeProviderId: "openai",
        activeModelByProviderId: { openai: "gpt-5" },
        mcpServers: createMockMcpServers({ "microsoft-learn": { installed: true, enabled: true }, "kql-search": { installed: true, enabled: false } }),
      }),
    );
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: "/chat", bridge });
    const composer = await screen.findByRole("combobox", { name: "Ask about your Microsoft 365 tenant" });
    await user.type(composer, "How long is the Intune compliance grace period?");
    await user.click(screen.getByRole("button", { name: "Send" }));
    const detail = (await screen.findByRole("dialog", { name: "Send this question through Codex?" })).textContent ?? "";
    expect(detail).toContain("MCP queries are written from your current question only, never from Graph or cache data. Words from that question can be sent to learn.microsoft.com.");
    expect(detail).not.toContain("kqlsearch");
    expect(bridge.streamIntuneChatMessage).not.toHaveBeenCalled();
  });

  it("names the second-wave hosts in what leaves this device and in the composer line", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge(
      {},
      createMockAppState({
        activeProviderId: "openai",
        activeModelByProviderId: { openai: "gpt-5" },
        mcpServers: createMockMcpServers({
          "release-communications": { installed: true, enabled: true },
          windowsforum: { installed: true, enabled: true },
          "endoflife-ai": { installed: true, enabled: true },
        }),
      }),
    );
    renderRoute(<DataBoundaryProvider><IntuneChat /></DataBoundaryProvider>, { path: "/chat/:conversationId?", route: "/chat", bridge });
    const hosts = "www.microsoft.com, mcp.windowsforum.com and mcp.endoflife.ai";
    expect((await screen.findAllByText(new RegExp(`Words from that question can be sent to ${hosts.replace(/\./g, "\\.")}\\.`))).length).toBeGreaterThan(0);
    const composer = await screen.findByRole("combobox", { name: "Ask about your Microsoft 365 tenant" });
    await user.type(composer, "When does Windows Server 2016 reach end of support?");
    await user.click(screen.getByRole("button", { name: "Send" }));
    const dialog = await screen.findByRole("dialog", { name: "Send this question through Codex?" });
    expect(dialog.textContent ?? "").toContain(`Words from that question can be sent to ${hosts}.`);
    expect(bridge.streamIntuneChatMessage).not.toHaveBeenCalled();
  });

  it("names no MCP host in the confirmation when no server is enabled", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge({}, createMockAppState({ activeProviderId: "openai", activeModelByProviderId: { openai: "gpt-5" } }));
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: "/chat", bridge });
    const composer = await screen.findByRole("combobox", { name: "Ask about your Microsoft 365 tenant" });
    await user.type(composer, "Which Windows devices are stale?");
    await user.click(screen.getByRole("button", { name: "Send" }));
    const dialog = await screen.findByRole("dialog", { name: "Send this question through Codex?" });
    expect(dialog.textContent ?? "").not.toContain("MCP queries");
  });

  it("uses the mocked hosted provider state", () => {
    expect(mockProviders.find((provider) => provider.id === "openai")?.isLocal).toBe(false);
  });

  it("records batch consent as one response only without inventing remembered consent", () => {
    const consent = createHostedBatchProviderConsent(
      {
        id: "preflight-1",
        prompt: "Compare stale devices",
        tenantScope: { kind: "all" },
        resolvedTenantIds: ["tenant-1", "tenant-2"],
        resolvedGroups: [],
        resources: [],
        tenants: [],
        providerId: "openai",
        providerName: "OpenAI",
        providerIsLocal: false,
        model: "gpt-5",
        canRun: true,
        generatedAt: "2026-08-06T13:59:00.000Z",
      },
      "2026-08-06T14:00:00.000Z",
    );

    expect(consent).toEqual({
      tenantIds: ["tenant-1", "tenant-2"],
      providerId: "openai",
      acknowledgedAt: "2026-08-06T14:00:00.000Z",
    });
    expect(consent).not.toHaveProperty("remember");
  });
});

describe("IntuneChat trust presentation", () => {
  it("keeps provider status out of the header and shows one local boundary footnote", async () => {
    renderRoute(<IntuneChat />, {
      path: "/chat/:conversationId?",
      route: "/chat",
      bridge: makeMockBridge(),
    });

    await screen.findByRole("combobox", { name: "Ask about your Microsoft 365 tenant" });
    expect(document.querySelector("header")?.textContent ?? "").not.toContain("Ollama");
    expect(screen.queryByText("Local provider")).not.toBeInTheDocument();
    expect(screen.getByText("Local model. Tenant data stays on this device.")).toBeInTheDocument();
  });

  it("names the MCP hosts in the local boundary footnote when MCP servers are on", async () => {
    renderRoute(
      <DataBoundaryProvider><IntuneChat /></DataBoundaryProvider>,
      {
        path: "/chat/:conversationId?",
        route: "/chat",
        bridge: makeMockBridge({}, createMockAppState({
          mcpServers: createMockMcpServers({ "microsoft-learn": { installed: true, enabled: true }, "kql-search": { installed: true, enabled: true } }),
        })),
      },
    );
    await screen.findByRole("combobox", { name: "Ask about your Microsoft 365 tenant" });
    // With MCP tools on, the local line keeps the claim for the model and the tenant data only.
    expect(screen.getByText(/^Local model\. Graph and cache data stay on this device\./)).toHaveTextContent(
      "Local model. Graph and cache data stay on this device. MCP queries are written from your current question only, never from Graph or cache data. Words from that question can be sent to learn.microsoft.com and www.kqlsearch.com. A filter blocks known tenant names, IDs, email addresses and IP addresses, but cannot guarantee it catches every private detail.",
    );
    expect(screen.queryByText(/Tenant data stays on this device/)).not.toBeInTheDocument();
  });

  it("activates the provider when picking another provider's model", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge();
    renderRoute(<IntuneChat />, {
      path: "/chat/:conversationId?",
      route: "/chat",
      bridge,
    });

    await screen.findByRole("combobox", { name: "Ask about your Microsoft 365 tenant" });
    await user.click(screen.getByLabelText(/Model:/));
    await user.click(await screen.findByRole("menuitemradio", { name: /gpt-5/ }));

    await waitFor(() => {
      expect(bridge.setActiveProvider).toHaveBeenCalledWith("openai");
      expect(bridge.setActiveModel).toHaveBeenCalledWith("openai", "gpt-5");
    });
  });

  it("re-persists the provider when picking the displayed provider's model", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge();
    renderRoute(<IntuneChat />, {
      path: "/chat/:conversationId?",
      route: "/chat",
      bridge,
    });

    await screen.findByRole("combobox", { name: "Ask about your Microsoft 365 tenant" });
    await user.click(screen.getByLabelText(/Model:/));
    await user.click(await screen.findByRole("menuitemradio", { name: /llama3\.1/ }));

    await waitFor(() => {
      expect(bridge.setActiveProvider).toHaveBeenCalledWith("ollama");
      expect(bridge.setActiveModel).toHaveBeenCalledWith("ollama", "llama3.1");
    });
  });

  it("shows a setup action when no model is ready", async () => {
    const providers = mockProviders.map((provider) =>
      provider.id === "ollama"
        ? { ...provider, status: "not-installed" as const, models: [] }
        : provider,
    );
    renderRoute(<IntuneChat />, {
      path: "/chat/:conversationId?",
      route: "/chat",
      bridge: makeMockBridge({}, createMockAppState({ providers })),
    });

    expect(await screen.findByText("No model selected.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set up a model" })).toBeInTheDocument();
  });

  it.each([900, 1100])("keeps Send in the normal composer flow at %dpx", async (width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: query.includes("max-width: 1100px"),
          media: query,
          onchange: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(() => false),
        }) as MediaQueryList,
    );

    renderRoute(<IntuneChat />, {
      path: "/chat/:conversationId?",
      route: "/chat",
      bridge: makeMockBridge(),
    });

    const send = await screen.findByRole("button", { name: "Send" });
    expect(send.closest(".intune-chat-composer")).toBeInTheDocument();
    expect(send.closest(".fixed")).toBeNull();
    matchMedia.mockRestore();
  });
});

describe("IntuneChat related agent hint", () => {
  it("shows a dismissible related-agent hint after the assistant answer completes", async () => {
    const user = userEvent.setup();
    const inactiveDevicesAgent = createMockAgent({
      slug: "find-inactive-devices",
      name: "Find inactive devices",
      description:
        "Reviews Intune-managed device inactivity by sync age, compliance, OS, ownership, and enrollment signals with review-first cleanup guidance.",
      mode: "read",
      category: "devices",
      scopes: ["DeviceManagementManagedDevices.Read.All"],
    });
    const appState = createMockAppState({
      installedAgents: [inactiveDevicesAgent],
    });
    const bridge = makeMockBridge({}, appState);
    const cacheStatus: GraphCacheStatus = {
      tenantId: appState.activeTenantId,
      resources: [],
    };
    let savedConversation: IntuneChatConversation | null = null;
    let savedMessages: IntuneChatMessage[] = [];

    bridge.listIntuneChatConversations = vi.fn(async () =>
      savedConversation ? [savedConversation] : [],
    );
    bridge.getIntuneChatMessages = vi.fn(async () => savedMessages);
    bridge.streamIntuneChatMessage = vi.fn<OpenAdminOSApi["streamIntuneChatMessage"]>(
      async (input, onEvent) => {
        const createdAt = "2026-07-05T10:00:00.000Z";
        const conversation: IntuneChatConversation = {
          id: "conversation-1",
          title: input.content,
          createdAt,
          updatedAt: createdAt,
          tenantId: appState.activeTenantId,
          scopeKind: "single-tenant",
        };
        const userMessage: IntuneChatMessage = {
          id: "message-user-1",
          conversationId: conversation.id,
          role: "user",
          content: input.content,
          createdAt,
          status: "completed",
        };
        const activeModel = appState.activeModelByProviderId?.[appState.activeProviderId];
        const streamingAssistantMessage: IntuneChatMessage = {
          id: "message-assistant-1",
          conversationId: conversation.id,
          role: "assistant" as const,
          content: "",
          createdAt,
          status: "streaming",
          providerId: appState.activeProviderId,
          ...(activeModel ? { model: activeModel } : {}),
        };
        const assistantMessage: IntuneChatMessage = {
          ...streamingAssistantMessage,
          content: "Mock answer about stale device sync.",
          status: "completed" as const,
          agentSuggestions: [
            {
              agentSlug: inactiveDevicesAgent.slug,
              agentName: inactiveDevicesAgent.name,
              reason: inactiveDevicesAgent.description,
              confidence: 0.92,
              mode: inactiveDevicesAgent.mode,
              scopes: inactiveDevicesAgent.scopes,
            },
          ],
        };
        const result: SendIntuneChatMessageResult = {
          conversation,
          userMessage,
          assistantMessage,
          cacheStatus,
        };
        savedConversation = conversation;
        savedMessages = [userMessage, assistantMessage];
        onEvent({
          type: "started",
          conversation,
          userMessage,
          assistantMessage: streamingAssistantMessage,
          cacheStatus,
        });
        onEvent({ type: "completed", result });
        return result;
      },
    );

    renderRoute(<IntuneChat />, {
      path: "/chat/:conversationId?",
      route: "/chat",
      bridge,
    });

    const composer = await screen.findByRole("combobox", {
      name: "Ask about your Microsoft 365 tenant",
    });
    await user.type(composer, "Which managed devices have not synced in 45 days?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Find inactive devices")).toBeInTheDocument();
    expect(screen.getAllByText("Find inactive devices")).toHaveLength(1);
    expect(
      screen.getByText(
        "Reviews Intune-managed device inactivity by sync age, compliance, OS, ownership, and enrollment signals with review-first cleanup guidance.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run agent" })).toBeInTheDocument();
    // Mode badge and scopes are visible on the collapsed card, without
    // opening Details.
    expect(screen.getByText("Read agent")).toBeInTheDocument();
    expect(screen.getByText("DeviceManagementManagedDevices.Read.All")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Dismiss suggested agent" }),
    );

    expect(screen.queryByText("Find inactive devices")).not.toBeInTheDocument();
  });
});

describe("IntuneChat conversation routes", () => {
  it("does not render a second Chat navigation column at constrained widths", async () => {
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: query.includes("max-width: 1100px"),
          media: query,
          onchange: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(() => false),
        }) as MediaQueryList,
    );
    const conversation: IntuneChatConversation = {
      id: "conversation-drawer-1",
      title: "Windows compliance gaps",
      createdAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:05:00.000Z",
      tenantId: "tenant-1",
      scopeKind: "single-tenant",
    };
    const bridge = makeMockBridge();
    bridge.listIntuneChatConversations = vi.fn(async () => [conversation]);
    bridge.getIntuneChatMessages = vi.fn(async () => []);

    renderRoute(<IntuneChat />, {
      path: "/chat/:conversationId?",
      route: "/chat",
      bridge,
    });

    await screen.findByRole("heading", { name: "Contoso IT" });
    expect(screen.queryByRole("button", { name: "Show chat panel" })).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "Search conversations" })).not.toBeInTheDocument();
    expect(screen.queryByText("01")).not.toBeInTheDocument();
    matchMedia.mockRestore();
  });

  it("restores a persisted conversation from its URL", async () => {
    const conversation: IntuneChatConversation = {
      id: "conversation-route-1",
      title: "Review stale device evidence",
      createdAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:05:00.000Z",
      tenantId: "tenant-1",
      scopeKind: "single-tenant",
    };
    const bridge = makeMockBridge();
    bridge.listIntuneChatConversations = vi.fn(async () => [conversation]);
    bridge.getIntuneChatMessages = vi.fn(async () => []);

    renderRoute(<IntuneChat />, {
      path: "/chat/:conversationId",
      route: "/chat/conversation-route-1",
      bridge,
    });

    await waitFor(() => {
      expect(bridge.getIntuneChatMessages).toHaveBeenCalledWith("conversation-route-1");
    });
    expect(screen.getByPlaceholderText("Ask a follow-up, or type / to run an agent")).toBeInTheDocument();
  });

  it("hides the legacy trailing agent sentence in stored answers", async () => {
    const conversation: IntuneChatConversation = {
      id: "conversation-legacy-1",
      title: "Stale devices",
      createdAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:05:00.000Z",
      tenantId: "tenant-1",
      scopeKind: "single-tenant",
    };
    const bridge = makeMockBridge();
    bridge.listIntuneChatConversations = vi.fn(async () => [conversation]);
    bridge.getIntuneChatMessages = vi.fn(async () => [
      {
        id: "legacy-assistant-1",
        conversationId: conversation.id,
        role: "assistant" as const,
        content: "WIN-01 has not synced in 40 days.\n\nDetected matching agent: Find inactive devices.",
        createdAt: "2026-08-06T10:01:00.000Z",
        status: "completed" as const,
      },
    ]);

    renderRoute(<IntuneChat />, {
      path: "/chat/:conversationId",
      route: "/chat/conversation-legacy-1",
      bridge,
    });

    expect(await screen.findByText(/WIN-01 has not synced in 40 days/)).toBeInTheDocument();
    expect(screen.queryByText(/Detected matching agent/)).not.toBeInTheDocument();
  });

  it("shows the host of each MCP tool call in What ran", async () => {
    const user = userEvent.setup();
    const conversation: IntuneChatConversation = {
      id: "conversation-mcp-1",
      title: "Grace period",
      createdAt: "2026-11-03T10:00:00.000Z",
      updatedAt: "2026-11-03T10:05:00.000Z",
      tenantId: "tenant-1",
      scopeKind: "single-tenant",
    };
    const bridge = makeMockBridge();
    bridge.listIntuneChatConversations = vi.fn(async () => [conversation]);
    bridge.getIntuneChatMessages = vi.fn(async () => [
      {
        id: "mcp-assistant-1",
        conversationId: conversation.id,
        role: "assistant" as const,
        content: "The grace period is set per noncompliance action.",
        createdAt: "2026-11-03T10:01:00.000Z",
        status: "completed" as const,
        toolTrace: [{
          id: "tool-1",
          tool: "mcp__microsoft-learn__microsoft_docs_search" as const,
          params: { query: "Intune compliance grace period" },
          resultSummary: "Microsoft Learn answered from learn.microsoft.com · 2,400 characters",
          mcpSource: { serverId: "microsoft-learn", serverName: "Microsoft Learn", host: "learn.microsoft.com", tool: "microsoft_docs_search" },
          durationMs: 820,
          createdAt: "2026-11-03T10:00:30.000Z",
          completedAt: "2026-11-03T10:00:31.000Z",
        }],
      },
    ]);

    renderRoute(<IntuneChat />, { path: "/chat/:conversationId", route: "/chat/conversation-mcp-1", bridge });

    await user.click(await screen.findByRole("button", { name: "How the answer was made" }));
    await user.click(screen.getByRole("button", { name: /What ran/ }));
    expect(screen.getByText("MCP tool · Microsoft Learn at learn.microsoft.com · third-party content, not tenant evidence")).toBeInTheDocument();
  });

  it("shows a recovery state for a deleted or unknown conversation URL", async () => {
    const bridge = makeMockBridge();
    bridge.listIntuneChatConversations = vi.fn(async () => []);
    bridge.getIntuneChatMessages = vi.fn(async () => []);

    renderRoute(<IntuneChat />, {
      path: "/chat/:conversationId",
      route: "/chat/deleted-conversation",
      bridge,
    });

    expect(
      await screen.findByRole("heading", { name: "Conversation not found" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start a new conversation" }),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Ask a follow-up, or type / to run an agent")).toBeDisabled();
  });

  it("keeps the URL-owned conversation open without a local history rail", async () => {
    const activeConversation: IntuneChatConversation = {
      id: "conversation-active",
      title: "Active device review",
      createdAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:05:00.000Z",
      tenantId: "tenant-1",
      scopeKind: "single-tenant",
    };
    const matchingConversation: IntuneChatConversation = {
      ...activeConversation,
      id: "conversation-match",
      title: "Other matching review",
    };
    const bridge = makeMockBridge();
    bridge.listIntuneChatConversations = vi.fn(async () => [
      activeConversation,
      matchingConversation,
    ]);
    bridge.getIntuneChatMessages = vi.fn(async () => []);

    renderRoute(<IntuneChat />, {
      path: "/chat/:conversationId?",
      route: "/chat/conversation-active",
      bridge,
    });

    await waitFor(() => {
      expect(bridge.getIntuneChatMessages).toHaveBeenCalledWith("conversation-active");
    });
    expect(screen.queryByRole("searchbox", { name: "Search conversations" })).not.toBeInTheDocument();
    expect(bridge.getIntuneChatMessages).not.toHaveBeenCalledWith("conversation-match");
  });

  it("renames the open conversation inline with F2 and Enter", async () => {
    const user = userEvent.setup();
    let conversation: IntuneChatConversation = {
      id: "conversation-rename",
      title: "Original title",
      createdAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:05:00.000Z",
      tenantId: "tenant-1",
      scopeKind: "single-tenant",
    };
    const bridge = makeMockBridge();
    bridge.listIntuneChatConversations = vi.fn(async () => [conversation]);
    bridge.getIntuneChatMessages = vi.fn(async () => []);
    bridge.renameIntuneChatConversation = vi.fn(async (_id, title) => {
      conversation = { ...conversation, title };
      return conversation;
    });

    renderRoute(<IntuneChat />, {
      path: "/chat/:conversationId",
      route: "/chat/conversation-rename",
      bridge,
    });

    await waitFor(() => expect(bridge.getIntuneChatMessages).toHaveBeenCalledWith("conversation-rename"));
    await waitFor(() => expect(bridge.listIntuneChatConversations).toHaveBeenCalled());
    await user.keyboard("{F2}");
    const titleInput = await screen.findByRole("textbox", { name: "Conversation title" });
    await user.clear(titleInput);
    await user.type(titleInput, "Renamed title");
    expect(titleInput).toHaveValue("Renamed title");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(bridge.renameIntuneChatConversation).toHaveBeenCalledWith(
        "conversation-rename",
        "Renamed title",
      ),
    );
  });

  it("renders an addressable Workspace detail inside Chat", async () => {
    const workspace: WorkspaceDetail = {
      id: "workspace-1",
      tenantId: "tenant-1",
      tenantName: "Contoso IT",
      title: "Stale device review",
      status: "active",
      evidenceCount: 0,
      conversationCount: 0,
      runCount: 0,
      noteCount: 0,
      createdAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:05:00.000Z",
      evidence: [],
      notes: [],
      links: [],
      instructions: "Keep device evidence tenant-scoped.",
    };
    const bridge = makeMockBridge({
      listWorkspaces: vi.fn(async () => [workspace]),
      getWorkspace: vi.fn(async () => workspace),
    });

    renderRoute(<IntuneChat />, {
      path: "/chat/workspaces/:workspaceId",
      route: "/chat/workspaces/workspace-1",
      bridge,
    });

    expect(await screen.findByText("Pinned evidence")).toBeInTheDocument();
    expect(screen.getAllByText("Stale device review").length).toBeGreaterThan(0);
    expect(screen.queryByRole("radio", { name: "Workspaces" })).not.toBeInTheDocument();
  });

  it("shows an engine notice next to the answer without expanding details", async () => {
    const conversation: IntuneChatConversation = {
      id: "conversation-notice",
      title: "Review devices",
      createdAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:05:00.000Z",
      tenantId: "tenant-1",
      scopeKind: "single-tenant",
    };
    const notice = "Deterministic retrieval: tiny-2b does not support investigative mode.";
    const bridge = makeMockBridge({
      listIntuneChatConversations: vi.fn(async () => [conversation]),
      getIntuneChatMessages: vi.fn(async () => [
        {
          id: "answer-1",
          conversationId: conversation.id,
          role: "assistant" as const,
          content: "Two devices need review.",
          status: "completed" as const,
          createdAt: conversation.updatedAt,
          engineNotice: notice,
        },
      ]),
    });
    const user = userEvent.setup();

    renderRoute(<IntuneChat />, {
      path: "/chat/:conversationId",
      route: "/chat/conversation-notice",
      bridge,
    });

    expect(await screen.findByText("Two devices need review.")).toBeInTheDocument();
    expect(screen.getByText(notice)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "How the answer was made" }));
    expect(screen.getByText(notice)).toBeVisible();
  });

  describe("answer steps and follow-ups", () => {
    const followUp = "Check our 5 macOS devices for Defender in Intune";
    const setup = () => {
      const conversation: IntuneChatConversation = {
        id: "conversation-follow", title: "Defender for macOS", createdAt: "2026-11-04T09:00:00.000Z",
        updatedAt: "2026-11-04T09:01:00.000Z", tenantId: "tenant-1", scopeKind: "single-tenant",
      };
      const bridge = makeMockBridge({
        listIntuneChatConversations: vi.fn(async () => [conversation]),
        getIntuneChatMessages: vi.fn(async () => [
          { id: "q-1", conversationId: conversation.id, role: "user" as const, content: "What does Microsoft Learn say about Defender for macOS?", status: "completed" as const, createdAt: conversation.createdAt },
          {
            id: "a-1", conversationId: conversation.id, role: "assistant" as const, status: "completed" as const, createdAt: conversation.updatedAt,
            content: "Defender for Endpoint on macOS needs full disk access [1].",
            questionKind: "docs" as const,
            followUps: [followUp, "Which Macs miss the system extension profile?"],
            tenantFollowUps: [followUp],
            documentationSources: [{ citation: 1, kind: "mcp" as const, title: "Microsoft Defender for Endpoint on Mac", url: "https://learn.microsoft.com/mac", serverName: "Microsoft Learn", host: "learn.microsoft.com" }],
            steps: [{ id: "s1", kind: "plan" as const, title: "Read the question", status: "completed" as const, origin: "device" as const, originLabel: "On device", startedAt: "", durationMs: 1 }],
          },
        ]),
      });
      renderRoute(<IntuneChat />, { path: "/chat/:conversationId", route: "/chat/conversation-follow", bridge });
      return bridge;
    };

    it("shows the follow-up as ghost text that Tab fills, and sends nothing", async () => {
      const user = userEvent.setup();
      const bridge = setup();
      const composer = await screen.findByLabelText(CHAT_COPY.composerLabel);
      await waitFor(() => expect(composer).toHaveAttribute("placeholder", followUp));
      expect(screen.getByText(`Suggestion: ${followUp}, press Tab to use it, Escape to dismiss`)).toBeInTheDocument();
      expect(composer).toHaveAccessibleDescription(`Suggestion: ${followUp}, press Tab to use it, Escape to dismiss`);
      composer.focus();
      await user.keyboard("{Tab}");
      expect(composer).toHaveValue(followUp);
      expect(composer).toHaveFocus();
      // With text in the composer, Tab moves focus as usual.
      await user.keyboard("{Tab}");
      expect(composer).not.toHaveFocus();
      expect(composer).toHaveValue(followUp);
      expect(bridge.streamIntuneChatMessage).not.toHaveBeenCalled();
      expect(bridge.sendIntuneChatMessage).not.toHaveBeenCalled();
    });

    it("hides the ghost text on Escape or typing, and fills the composer from the one follow-up chip", async () => {
      const user = userEvent.setup();
      const bridge = setup();
      const composer = await screen.findByLabelText(CHAT_COPY.composerLabel);
      await waitFor(() => expect(composer).toHaveAttribute("placeholder", followUp));
      composer.focus();
      await user.keyboard("{Escape}");
      expect(composer).not.toHaveAttribute("placeholder", followUp);
      expect(screen.queryByText(/press Tab to use it/)).toBeNull();

      // One quiet chip: the first follow-up, tagged because the docs answer's follow-up reads tenant data.
      expect(screen.queryByRole("button", { name: "Which Macs miss the system extension profile?" })).toBeNull();
      await user.click(screen.getByRole("button", { name: new RegExp(`^${followUp},\\s*Uses tenant data$`) }));
      expect(composer).toHaveValue(followUp);
      expect(bridge.streamIntuneChatMessage).not.toHaveBeenCalled();
    });

    it("shows no tenant above a docs answer, names Microsoft Learn once in the step summary, and keeps how it was made there", async () => {
      const user = userEvent.setup();
      setup();
      expect(await screen.findByText(/needs full disk access/)).toBeInTheDocument();
      const log = screen.getByRole("log", { name: "Conversation" });
      // No tenant chip: the answer never touched the tenant.
      expect(within(log).queryByText("Contoso IT")).toBeNull();
      expect(within(log).getByRole("button", { name: /1 step/ })).toHaveTextContent("Microsoft Learn · Tenant not used");
      const answer = within(log).getAllByRole("article").at(-1)!;
      expect(within(answer).getAllByText(/Microsoft Learn/).filter((node) => !node.closest("[role=tooltip]"))).toHaveLength(1);
      expect(within(log).queryByText("Tenant data")).toBeNull();
      expect(within(log).queryByText("How I checked")).toBeNull();
      expect(within(log).queryByText(/data from/)).toBeNull();
      await user.click(within(log).getByRole("button", { name: /1 step/ }));
      expect(within(log).getByRole("list", { name: "Steps" })).toBeInTheDocument();
    });

    it("keeps the tenant chip on a mixed answer, with documentation and tenant blocks labelled", async () => {
      const conversation: IntuneChatConversation = {
        id: "conversation-mixed", title: "Macs and Defender", createdAt: "2026-11-04T09:00:00.000Z", updatedAt: "2026-11-04T09:01:00.000Z", tenantId: "tenant-1", scopeKind: "single-tenant",
      };
      const bridge = makeMockBridge({
        listIntuneChatConversations: vi.fn(async () => [conversation]),
        getIntuneChatMessages: vi.fn(async () => [{
          id: "a-mixed", conversationId: conversation.id, role: "assistant" as const, status: "completed" as const, createdAt: conversation.updatedAt,
          content: "Defender needs full disk access [1].\n\n2 of your 5 Macs are noncompliant.",
          questionKind: "mixed" as const,
          documentationSources: [{ citation: 1, kind: "mcp" as const, title: "Microsoft Defender for Endpoint on Mac", url: "https://learn.microsoft.com/mac", serverName: "Microsoft Learn", host: "learn.microsoft.com" }],
          toolTrace: [{ id: "t1", tool: "query_cache" as const, params: {}, resultSummary: "", durationMs: 1, createdAt: "", completedAt: "" }],
          steps: [{ id: "s1", kind: "tool" as const, title: "Queried cached data", status: "completed" as const, origin: "device" as const, originLabel: "On device", startedAt: "", durationMs: 1 }],
        }]),
      });
      renderRoute(<IntuneChat />, { path: "/chat/:conversationId", route: "/chat/conversation-mixed", bridge });
      expect(await screen.findByText(/are noncompliant/)).toBeInTheDocument();
      const log = screen.getByRole("log", { name: "Conversation" });
      expect(within(log).getByText("Contoso IT")).toBeInTheDocument();
      expect(within(log).getByRole("region", { name: "Microsoft Learn" })).toBeInTheDocument();
      expect(within(log).getByRole("region", { name: "Your tenant" })).toBeInTheDocument();
      expect(within(log).getByRole("button", { name: /1 step/ })).not.toHaveTextContent("Tenant not used");
    });

    it("lists consulted local index passages of an uncited answer the same way after a reload", async () => {
      const conversation: IntuneChatConversation = {
        id: "conversation-uncited", title: "Compliance grace period", createdAt: "2026-11-04T09:00:00.000Z", updatedAt: "2026-11-04T09:01:00.000Z", tenantId: "tenant-1", scopeKind: "single-tenant",
      };
      const stored: IntuneChatMessage[] = [{
        id: "a-uncited", conversationId: conversation.id, role: "assistant", status: "completed", createdAt: conversation.updatedAt,
        content: "A device is marked noncompliant once the grace period ends.",
        questionKind: "docs",
        documentationSources: [
          { citation: 1, kind: "docs-index", title: "Compliance policies", file: "intune/compliance.md", indexVersion: "2026-08-26" },
          { citation: 2, kind: "mcp", title: "Compliance grace period", url: "https://learn.microsoft.com/intune/grace", serverName: "Microsoft Learn", host: "learn.microsoft.com" },
        ],
        steps: [{ id: "s1", kind: "plan", title: "Read the question", status: "completed", origin: "device", originLabel: "On device", startedAt: "", durationMs: 1 }],
      }];
      const bridge = makeMockBridge({
        listIntuneChatConversations: vi.fn(async () => [conversation]),
        getIntuneChatMessages: vi.fn(async () => structuredClone(stored)),
      });
      const consultedRows = async () => {
        await screen.findByText(/grace period ends/);
        const consulted = within(screen.getByRole("log", { name: "Conversation" })).getByRole("region", { name: "Consulted" });
        return {
          heading: within(consulted).getByRole("heading").textContent,
          rows: within(consulted).getAllByRole("listitem").map((row) => row.textContent),
          links: within(consulted).queryAllByRole("link").map((link) => link.getAttribute("href")),
        };
      };
      const first = renderRoute(<IntuneChat />, { path: "/chat/:conversationId", route: "/chat/conversation-uncited", bridge });
      const before = await consultedRows();
      expect(before).toEqual({
        heading: "Consulted · learn.microsoft.com, not verified by OpenAdminOS · Local docs index on this device",
        rows: ["Compliance policiesLocal docs index, Aug 26, 2026", "Compliance grace periodlearn.microsoft.com"],
        links: ["https://learn.microsoft.com/intune/grace"],
      });
      first.unmount();
      renderRoute(<IntuneChat />, { path: "/chat/:conversationId", route: "/chat/conversation-uncited", bridge });
      expect(await consultedRows()).toEqual(before);
    });

    it("streams each step live, then folds them into the summary line", async () => {
      const user = userEvent.setup();
      const conversation: IntuneChatConversation = {
        id: "conversation-live", title: "Defender", createdAt: "2026-11-04T09:00:00.000Z", updatedAt: "2026-11-04T09:00:00.000Z", tenantId: "tenant-1", scopeKind: "single-tenant",
      };
      let release: () => void = () => {};
      const step = (overrides: Partial<IntuneChatStep>): IntuneChatStep => ({ id: "s", kind: "plan", title: "Read the question", status: "completed", origin: "device", originLabel: "On device", startedAt: "", durationMs: 1, ...overrides });
      const plan = step({ id: "s1", detail: "Documentation question. Sources: Microsoft Learn. Your tenant is not checked." });
      const asking = step({ id: "s2", kind: "mcp", title: "Asking Microsoft Learn", status: "active", origin: "third-party", originLabel: "learn.microsoft.com", sent: "Defender for Endpoint on macOS", durationMs: undefined });
      const writing = step({ id: "s3", kind: "answer", title: "Working on the answer", status: "active", origin: "model", originLabel: "OpenAI", durationMs: undefined });
      let saved: IntuneChatMessage[] = [];
      const bridge = makeMockBridge({
        listIntuneChatConversations: vi.fn(async () => (saved.length ? [conversation] : [])),
        getIntuneChatMessages: vi.fn(async () => saved),
        streamIntuneChatMessage: vi.fn<OpenAdminOSApi["streamIntuneChatMessage"]>(async (input, onEvent) => {
          const userMessage: IntuneChatMessage = { id: "u-live", conversationId: conversation.id, role: "user", content: input.content, status: "completed", createdAt: conversation.createdAt };
          const pending: IntuneChatMessage = { id: "a-live", conversationId: conversation.id, role: "assistant", content: "", status: "streaming", createdAt: conversation.createdAt };
          const cacheStatus = { tenantId: "tenant-1", resources: [] };
          onEvent({ type: "started", conversation, userMessage, assistantMessage: pending, cacheStatus });
          onEvent({ type: "status", conversationId: conversation.id, message: "Asking Microsoft Learn.", stage: "running-tools" });
          onEvent({ type: "steps", conversationId: conversation.id, assistantMessageId: "a-live", steps: [plan, asking, writing] });
          await new Promise<void>((resolve) => { release = resolve; });
          const done = [plan, { ...asking, title: "Asked Microsoft Learn", status: "completed" as const, durationMs: 1200 }, { ...writing, title: "Wrote the answer", status: "completed" as const, durationMs: 3400 }];
          const result = { conversation, userMessage, assistantMessage: { ...pending, status: "completed" as const, content: "Defender needs full disk access.", steps: done }, cacheStatus };
          saved = [userMessage, result.assistantMessage];
          onEvent({ type: "completed", result });
          return result;
        }),
      });
      renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: "/chat", bridge });
      const composer = await screen.findByLabelText(CHAT_COPY.composerLabel);
      await user.type(composer, "What does Microsoft Learn say about Defender for macOS?");
      await user.click(screen.getByRole("button", { name: "Send" }));
      const timeline = await screen.findByRole("list", { name: "Steps" });
      const rows = within(timeline).getAllByRole("listitem");
      expect(rows.map((row) => row.textContent)).toEqual([
        expect.stringContaining("Read the question"),
        expect.stringContaining("Asking Microsoft Learn"),
        expect.stringContaining("Working on the answer"),
      ]);
      expect(rows[1]).toHaveTextContent("Defender for Endpoint on macOS");
      expect(rows[1]).toHaveAttribute("aria-current", "step");
      release();
      // The progress line stays briefly after the answer, then the summary replaces the live timeline.
      const summary = await screen.findByRole("button", { name: /3 steps/ }, { timeout: 4000 });
      expect(summary).toHaveAttribute("aria-expanded", "false");
      expect(screen.getByRole("button", { name: "Sent: search text to learn.microsoft.com, answer context to OpenAI" })).toHaveAttribute("aria-expanded", "false");
    });

    it("stops offering the ghost text once the admin types", async () => {
      const user = userEvent.setup();
      setup();
      const composer = await screen.findByLabelText(CHAT_COPY.composerLabel);
      await waitFor(() => expect(composer).toHaveAttribute("placeholder", followUp));
      await user.type(composer, "W");
      await user.clear(composer);
      expect(composer).not.toHaveAttribute("placeholder", followUp);
    });
  });

  it("shows Scroll to latest in its own row above the composer, outside the conversation, only away from the bottom", async () => {
    const user = userEvent.setup();
    const conversation: IntuneChatConversation = {
      id: "conversation-scroll", title: "Long answer", createdAt: "2026-11-04T09:00:00.000Z", updatedAt: "2026-11-04T09:01:00.000Z", tenantId: "tenant-1", scopeKind: "single-tenant",
    };
    const bridge = makeMockBridge({
      listIntuneChatConversations: vi.fn(async () => [conversation]),
      getIntuneChatMessages: vi.fn(async () => [{ id: "a-long", conversationId: conversation.id, role: "assistant" as const, status: "completed" as const, createdAt: conversation.updatedAt, content: "A long answer." }]),
    });
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId", route: "/chat/conversation-scroll", bridge });
    expect(await screen.findByText("A long answer.")).toBeInTheDocument();
    const log = screen.getByRole("log", { name: "Conversation" });
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 600 });
    log.scrollTop = 1380;
    fireEvent.scroll(log);
    expect(screen.queryByRole("button", { name: "Scroll to latest" })).toBeNull();
    log.scrollTop = 400;
    fireEvent.scroll(log);
    const button = screen.getByRole("button", { name: "Scroll to latest" });
    expect(log).not.toContainElement(button);
    const row = screen.getByTestId("scroll-to-latest-row");
    expect(row.className).not.toMatch(/\babsolute\b/);
    // Above the composer in the same column.
    expect(row.compareDocumentPosition(screen.getByLabelText(CHAT_COPY.composerLabel)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(button);
    expect(screen.queryByRole("button", { name: "Scroll to latest" })).toBeNull();
  });

  it("exposes the transcript as a log and focuses the composer on open", async () => {
    const conversation: IntuneChatConversation = {
      id: "conversation-log",
      title: "Review devices",
      createdAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:05:00.000Z",
      tenantId: "tenant-1",
      scopeKind: "single-tenant",
    };
    const bridge = makeMockBridge({
      listIntuneChatConversations: vi.fn(async () => [conversation]),
      getIntuneChatMessages: vi.fn(async () => []),
    });
    renderRoute(<IntuneChat />, {
      path: "/chat/:conversationId",
      route: "/chat/conversation-log",
      bridge,
    });

    expect(await screen.findByRole("log", { name: "Conversation" })).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Ask about your Microsoft 365 tenant" }),
    ).toHaveFocus();
  });

  it("renders recovery actions for a non-send error and reloads on request", async () => {
    let groupCalls = 0;
    const bridge = makeMockBridge({
      listTenantGroups: vi.fn(async () => {
        groupCalls += 1;
        if (groupCalls === 1) throw new Error("Tenant groups are unavailable.");
        return [];
      }),
    });
    const user = userEvent.setup();

    renderRoute(<IntuneChat />, {
      path: "/chat/:conversationId?",
      route: "/chat",
      bridge,
    });

    expect(await screen.findByText("The requested action could not be completed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload chat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Settings" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reload chat" }));
    await vi.waitFor(() => expect(groupCalls).toBeGreaterThan(1));
    await vi.waitFor(() =>
      expect(screen.queryByText("The requested action could not be completed.")).not.toBeInTheDocument(),
    );
  });

  it("lets a non-send error be dismissed in place", async () => {
    const bridge = makeMockBridge({
      listTenantGroups: vi.fn(async () => {
        throw new Error("Tenant groups are unavailable.");
      }),
    });
    const user = userEvent.setup();

    renderRoute(<IntuneChat />, {
      path: "/chat/:conversationId?",
      route: "/chat",
      bridge,
    });

    expect(await screen.findByText("The requested action could not be completed.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(screen.queryByText("The requested action could not be completed.")).not.toBeInTheDocument();
  });

  it("shows the oldest source age in the answer header, not the newest", async () => {
    const conversation: IntuneChatConversation = {
      id: "conversation-sources",
      title: "Review devices",
      createdAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:05:00.000Z",
      tenantId: "tenant-1",
      scopeKind: "single-tenant",
    };
    const now = Date.now();
    const bridge = makeMockBridge({
      listIntuneChatConversations: vi.fn(async () => [conversation]),
      getIntuneChatMessages: vi.fn(async () => [
        {
          id: "answer-1",
          conversationId: conversation.id,
          role: "assistant" as const,
          content: "Eight devices are noncompliant.",
          status: "completed" as const,
          createdAt: conversation.updatedAt,
          sources: [
            {
              resource: "managedDevices" as const,
              label: "Managed devices",
              rows: 9,
              source: "cache" as const,
              refreshedAt: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
            },
            {
              resource: "users" as const,
              label: "Users",
              rows: 4,
              source: "live" as const,
              refreshedAt: new Date(now - 30 * 1000).toISOString(),
            },
          ],
        },
      ]),
    });

    const user = userEvent.setup();
    renderRoute(<IntuneChat />, {
      path: "/chat/:conversationId",
      route: "/chat/conversation-sources",
      bridge,
    });

    expect(await screen.findByText("Eight devices are noncompliant.")).toBeInTheDocument();
    expect(screen.getByText(/oldest data from 3 hours ago/)).toBeInTheDocument();
    expect(screen.queryByText(/data from just now/)).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Sources" })).not.toBeInTheDocument();
    expect(screen.queryByText("· 9 rows")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "How the answer was made" }));
    expect(screen.getByText("Sources")).toBeVisible();
  });
});

it("routes a suggested write-agent dry run through the dry-run preflight", async () => {
  const user = userEvent.setup();
  const conversation = { id: "dry-chat", title: "Dry run", tenantId: "tenant-1", scopeKind: "single-tenant" as const,
    createdAt: "2026-10-31T12:00:00Z", updatedAt: "2026-10-31T12:00:00Z" };
  const agent = createMockAgent();
  const bridge = makeMockBridge({
    listIntuneChatConversations: vi.fn(async () => [conversation]),
    getIntuneChatMessages: vi.fn(async () => [{ id: "dry-message", conversationId: conversation.id, role: "assistant" as const,
      content: "Review this installed workflow.", status: "completed" as const, createdAt: conversation.createdAt,
      agentSuggestions: [{ agentSlug: agent.slug, agentName: agent.name, mode: "write" as const, reason: "Requested change", confidence: 1, scopes: agent.scopes }] }]),
  });
  function StateProbe() { const location = useLocation(); return <output data-testid="dry-location">{JSON.stringify({ path: location.pathname, state: location.state })}</output>; }
  renderWithAppState(<Routes><Route path="/chat/:conversationId" element={<IntuneChat />} /><Route path="/agents/:slug/confirm" element={<><Agents startRunOnOpen /><StateProbe /></>} /></Routes>, { route: "/chat/dry-chat", bridge });
  await user.click(await screen.findByRole("button", { name: "Dry run" }));
  expect(screen.getByTestId("dry-location")).toHaveTextContent("/agents/device-offboard/confirm");
  expect(bridge.startRun).not.toHaveBeenCalled();
  expect(await screen.findByRole("heading", { name: "Review dry run" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Start dry run" }));
  await waitFor(() => expect(bridge.startRun).toHaveBeenCalledWith("device-offboard", { dryRun: true }));
});

/**
 * The event sequence of a streamed docs answer, as the host sends it
 * (recorded from the app store): the first step at once, status lines,
 * the step list several times, one MCP call, then the answer.
 */
function liveRunFixture() {
  const conversation: IntuneChatConversation = {
    id: "chat-live-run", title: "how does defender onboarding for macos work?", createdAt: "2026-11-04T10:49:54.264Z",
    updatedAt: "2026-11-04T10:49:54.264Z", tenantId: "tenant-1", scopeKind: "single-tenant",
  };
  const userMessage: IntuneChatMessage = { id: "u-live-run", conversationId: conversation.id, role: "user", content: conversation.title, status: "completed", createdAt: conversation.createdAt };
  const pending: IntuneChatMessage = { id: "a-live-run", conversationId: conversation.id, role: "assistant", content: "", status: "streaming", createdAt: conversation.createdAt, providerId: "openai" };
  const step = (overrides: Partial<IntuneChatStep>): IntuneChatStep => ({ id: "step-1", kind: "plan", title: "Reading the question", status: "active", origin: "device", originLabel: "On device", startedAt: "2026-11-04T10:49:54.275Z", ...overrides });
  const plan = step({});
  const planDone = step({ title: "Read the question", status: "completed", durationMs: 40, detail: "Sources available: Microsoft Learn. The model classifies the question." });
  const working = step({ id: "step-2", kind: "answer", title: "Working", origin: "model", originLabel: "OpenAI Codex", detail: "gpt-6-sol" });
  const chose = { ...working, title: "Chose to ask Microsoft Learn", status: "completed" as const, durationMs: 9300, detail: "gpt-6-sol · Classified as a docs question. Sources: Microsoft Learn. Your tenant is not checked." };
  const asking = step({ id: "step-3", kind: "mcp", title: "Asking Microsoft Learn", origin: "third-party", originLabel: "learn.microsoft.com", detail: "microsoft_docs_search", sent: "Defender for Endpoint onboarding on macOS" });
  const asked = { ...asking, title: "Asked Microsoft Learn", status: "completed" as const, durationMs: 1200, detail: "microsoft_docs_search · 10 results" };
  const working2 = step({ id: "step-4", kind: "answer", title: "Working", origin: "model", originLabel: "OpenAI Codex", detail: "gpt-6-sol" });
  const answered = { ...working2, title: "Wrote the answer", status: "completed" as const, durationMs: 15400 };
  const base = { conversationId: conversation.id, assistantMessageId: pending.id };
  const status = (message: string): IntuneChatStreamEvent => ({ type: "status", conversationId: conversation.id, message, stage: "running-tools" });
  const finalText = "Onboarding has three parts [1].";
  const result: SendIntuneChatMessageResult = {
    conversation, userMessage,
    assistantMessage: { ...pending, status: "completed", content: finalText, steps: [planDone, chose, asked, answered] },
    cacheStatus: { tenantId: "tenant-1", resources: [] },
  };
  const events: IntuneChatStreamEvent[] = [
    { type: "started", conversation, userMessage, assistantMessage: pending, cacheStatus: result.cacheStatus },
    { type: "steps", ...base, steps: [plan] },
    status("Checking cached tenant data."),
    status("Investigative mode started."),
    { type: "steps", ...base, steps: [planDone, working] },
    { type: "steps", ...base, steps: [planDone, chose] },
    { type: "steps", ...base, steps: [planDone, chose, asking] },
    status("Asking Microsoft Learn at learn.microsoft.com: microsoft_docs_search."),
    { type: "steps", ...base, steps: [planDone, chose, asked] },
    status("Microsoft Learn answered from learn.microsoft.com · 12,000 characters · shortened"),
    { type: "steps", ...base, steps: [planDone, chose, asked, working2] },
    { type: "steps", ...base, steps: [planDone, chose, asked, answered] },
    status("Model response started."),
    { type: "delta", ...base, delta: finalText, content: finalText, providerId: "openai" },
    { type: "completed", result },
  ];
  return { conversation, userMessage, result, events, finalText };
}

/** The text after the tenant on the pending scope line. */
const scopeLine = (log: HTMLElement) => log.querySelector(".chat-scope-shimmer")?.textContent;

describe("IntuneChat live run", () => {
  it("names only the current step on the scope line, never a tool result", async () => {
    const user = userEvent.setup();
    const { conversation, userMessage, result, events } = liveRunFixture();
    let emit: (event: IntuneChatStreamEvent) => void = () => {};
    let finish: () => void = () => {};
    const bridge = makeMockBridge({
      streamIntuneChatMessage: vi.fn<OpenAdminOSApi["streamIntuneChatMessage"]>(async (_input, onEvent) => {
        emit = onEvent;
        await new Promise<void>((resolve) => { finish = resolve; });
        return result;
      }),
      getIntuneChatMessages: vi.fn(async () => [userMessage, result.assistantMessage]),
      listIntuneChatConversations: vi.fn(async () => [conversation]),
    });
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: "/chat", bridge });
    await user.type(await screen.findByLabelText(CHAT_COPY.composerLabel), conversation.title);
    await user.click(screen.getByRole("button", { name: "Send" }));
    const log = await screen.findByRole("log", { name: "Conversation" });
    const seen: Array<string | null | undefined> = [scopeLine(log)];
    for (const event of events.slice(0, -2)) {
      act(() => emit(event));
      seen.push(scopeLine(log));
    }
    expect(new Set(seen)).toEqual(new Set(["Reading the question", "Working", "Chose to ask Microsoft Learn", "Asking Microsoft Learn", "Asked Microsoft Learn", "Wrote the answer"]));
    expect(within(log).queryByText(/12,000 characters|answered from learn\.microsoft\.com|Investigative mode started/)).toBeNull();
    act(() => emit(events.at(-2)!));
    act(() => emit(events.at(-1)!));
    finish();
  });

  it("never rearranges visible steps when a tool step arrives while a model step runs", async () => {
    const user = userEvent.setup();
    const { conversation, userMessage, result, events } = liveRunFixture();
    let emit: (event: IntuneChatStreamEvent) => void = () => {};
    let finish: () => void = () => {};
    const bridge = makeMockBridge({
      streamIntuneChatMessage: vi.fn<OpenAdminOSApi["streamIntuneChatMessage"]>(async (_input, onEvent) => {
        emit = onEvent;
        await new Promise<void>((resolve) => { finish = resolve; });
        return result;
      }),
      getIntuneChatMessages: vi.fn(async () => [userMessage, result.assistantMessage]),
      listIntuneChatConversations: vi.fn(async () => [conversation]),
    });
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: "/chat", bridge });
    await user.type(await screen.findByLabelText(CHAT_COPY.composerLabel), conversation.title);
    await user.click(screen.getByRole("button", { name: "Send" }));
    const log = await screen.findByRole("log", { name: "Conversation" });
    const rows = () => within(within(log).getByRole("list", { name: "Steps" })).getAllByRole("listitem").map((row) => row.textContent ?? "");
    const base = { conversationId: conversation.id, assistantMessageId: "a-live-run" };
    const plan: IntuneChatStep = { id: "step-1", kind: "plan", title: "Read the question", status: "completed", origin: "device", originLabel: "On device", startedAt: "", durationMs: 40 };
    const working: IntuneChatStep = { id: "step-2", kind: "answer", title: "Working", status: "active", origin: "model", originLabel: "OpenAI Codex", startedAt: "" };
    const asking: IntuneChatStep = { id: "step-3", kind: "mcp", title: "Asking Microsoft Learn", status: "active", origin: "third-party", originLabel: "learn.microsoft.com", startedAt: "", sent: "Defender for macOS" };
    act(() => emit(events[0]!));
    act(() => emit({ type: "steps", ...base, steps: [plan, working] }));
    expect(rows()).toEqual([expect.stringContaining("Read the question"), expect.stringContaining("Working")]);
    // A list that puts the new step above the running one, as an older host did.
    act(() => emit({ type: "steps", ...base, steps: [plan, asking, working] }));
    expect(rows()).toEqual([expect.stringContaining("Read the question"), expect.stringContaining("Working"), expect.stringContaining("Asking Microsoft Learn")]);
    act(() => emit({ type: "steps", ...base, steps: [plan, { ...asking, title: "Asked Microsoft Learn", status: "completed" }, { ...working, title: "Chose to ask Microsoft Learn", status: "completed" }] }));
    expect(rows()).toEqual([expect.stringContaining("Read the question"), expect.stringContaining("Chose to ask Microsoft Learn"), expect.stringContaining("Asked Microsoft Learn")]);
    act(() => emit(events.at(-1)!));
    finish();
  });

  it("shows the scope line and the steps from the moment of sending until the answer, never an empty answer area", async () => {
    const user = userEvent.setup();
    const { conversation, userMessage, result, events } = liveRunFixture();
    let emit: (event: IntuneChatStreamEvent) => void = () => {};
    let finish: () => void = () => {};
    const bridge = makeMockBridge({
      streamIntuneChatMessage: vi.fn<OpenAdminOSApi["streamIntuneChatMessage"]>(async (_input, onEvent) => {
        emit = onEvent;
        await new Promise<void>((resolve) => { finish = resolve; });
        return result;
      }),
      getIntuneChatMessages: vi.fn(async () => [userMessage, result.assistantMessage]),
      listIntuneChatConversations: vi.fn(async () => [conversation]),
    });
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: "/chat", bridge });
    const composer = await screen.findByLabelText(CHAT_COPY.composerLabel);
    await user.type(composer, conversation.title);
    await user.click(screen.getByRole("button", { name: "Send" }));
    const log = await screen.findByRole("log", { name: "Conversation" });
    const answerArea = () => {
      const steps = within(log).getByRole("list", { name: "Steps" });
      expect(within(log).getByText("Contoso IT")).toBeInTheDocument();
      return within(steps).getAllByRole("listitem").map((row) => row.textContent ?? "");
    };
    // Before the host has started the run, and after it started but sent no step yet.
    expect(answerArea()).toEqual([expect.stringContaining("Reading the question")]);
    expect(scopeLine(log)).toBe("Reading the question");
    act(() => emit(events[0]!));
    expect(answerArea()).toEqual([expect.stringContaining("Reading the question")]);
    for (const event of events.slice(1, -2)) {
      act(() => emit(event));
      expect(answerArea().length).toBeGreaterThan(0);
    }
    expect(answerArea()).toEqual([
      expect.stringContaining("Read the question"),
      expect.stringContaining("Chose to ask Microsoft Learn"),
      expect.stringContaining("Asked Microsoft Learn"),
      expect.stringContaining("Wrote the answer"),
    ]);
    act(() => emit(events.at(-2)!));
    expect(answerArea()).toHaveLength(4);
    act(() => emit(events.at(-1)!));
    finish();
    expect(await screen.findByRole("button", { name: /4 steps/ }, { timeout: 4000 })).toBeInTheDocument();
  });

  it("stays on the page the admin opened when a run finishes after they left Chat", async () => {
    const user = userEvent.setup();
    const { conversation, userMessage, result, events } = liveRunFixture();
    let saved: IntuneChatMessage[] = [];
    let listed: IntuneChatConversation[] = [];
    let emit: (event: IntuneChatStreamEvent) => void = () => {};
    let finish: () => void = () => {};
    const bridge = makeMockBridge({
      listIntuneChatConversations: vi.fn(async () => listed),
      getIntuneChatMessages: vi.fn(async () => saved),
      streamIntuneChatMessage: vi.fn<OpenAdminOSApi["streamIntuneChatMessage"]>(async (_input, onEvent) => {
        emit = onEvent;
        saved = [userMessage];
        listed = [conversation];
        await new Promise<void>((resolve) => { finish = resolve; });
        saved = [userMessage, result.assistantMessage];
        return result;
      }),
    });
    renderWithAppState(
      <Routes>
        <Route path="/chat/:conversationId?" element={<AppShell><IntuneChat /><LocationProbe /></AppShell>} />
        <Route path="/marketplace" element={<AppShell><LocationProbe /></AppShell>} />
      </Routes>,
      { route: "/chat", bridge },
    );
    await user.type(await screen.findByLabelText(CHAT_COPY.composerLabel), conversation.title);
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(bridge.streamIntuneChatMessage).toHaveBeenCalledOnce());
    act(() => events.slice(0, 5).forEach((event) => emit(event)));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/chat/${conversation.id}`));

    await user.click(screen.getByRole("link", { name: "Marketplace" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/marketplace"));
    act(() => events.slice(5).forEach((event) => emit(event)));
    await act(async () => {
      finish();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.getByTestId("location")).toHaveTextContent("/marketplace");
    // The sidebar still lists the conversation.
    expect(await screen.findByTitle(conversation.title)).toBeInTheDocument();
  });

  it("keeps the scope line and the live steps after Chat is opened again during the run", async () => {
    const user = userEvent.setup();
    const { conversation, userMessage, result, events } = liveRunFixture();
    let saved: IntuneChatMessage[] = [];
    let listed: IntuneChatConversation[] = [];
    let emit: (event: IntuneChatStreamEvent) => void = () => {};
    let finish: () => void = () => {};
    const bridge = makeMockBridge({
      listIntuneChatConversations: vi.fn(async () => listed),
      getIntuneChatMessages: vi.fn(async () => saved),
      streamIntuneChatMessage: vi.fn<OpenAdminOSApi["streamIntuneChatMessage"]>(async (_input, onEvent) => {
        emit = onEvent;
        // The host saves the question first; the answer is saved when it is done.
        saved = [userMessage];
        listed = [conversation];
        await new Promise<void>((resolve) => { finish = resolve; });
        saved = [userMessage, result.assistantMessage];
        return result;
      }),
    });
    renderWithAppState(
      <Routes>
        <Route path="/chat/:conversationId?" element={<AppShell><IntuneChat /></AppShell>} />
        <Route path="/marketplace" element={<AppShell><LocationProbe /></AppShell>} />
      </Routes>,
      { route: "/chat", bridge },
    );
    const composer = await screen.findByLabelText(CHAT_COPY.composerLabel);
    await user.type(composer, conversation.title);
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(bridge.streamIntuneChatMessage).toHaveBeenCalledOnce());
    act(() => events.slice(0, 5).forEach((event) => emit(event)));
    await waitFor(() => expect(scopeLine(screen.getByRole("log", { name: "Conversation" }))).toBe("Working"));

    // The admin opens another page and comes back while the answer runs.
    await user.click(screen.getByRole("link", { name: "Marketplace" }));
    expect(await screen.findByTestId("location")).toHaveTextContent("/marketplace");
    await user.click(await screen.findByTitle(conversation.title));

    const log = await screen.findByRole("log", { name: "Conversation" });
    await waitFor(() => expect(scopeLine(log)).toBe("Working"));
    expect(within(log).getByText("Contoso IT")).toBeInTheDocument();
    const timeline = within(log).getByRole("list", { name: "Steps" });
    expect(within(timeline).getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      expect.stringContaining("Read the question"),
      expect.stringContaining("Working"),
    ]);
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

    // Later events reach the page that is showing the conversation now.
    act(() => events.slice(5, 9).forEach((event) => emit(event)));
    expect(await within(within(log).getByRole("list", { name: "Steps" })).findByText("Asked Microsoft Learn")).toBeInTheDocument();
    act(() => events.slice(9).forEach((event) => emit(event)));
    finish();
    expect(await within(log).findByText(/Onboarding has three parts/, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /4 steps/ }, { timeout: 4000 })).toBeInTheDocument();
  });
});
