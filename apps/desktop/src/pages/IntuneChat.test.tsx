import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router";

import IntuneChat, { createHostedBatchProviderConsent } from "./IntuneChat";
import { AppShell } from "../components/AppShell";
import {
  createAwaitingConfirmationRun,
  createMockAgent,
  createMockAppState,
  makeMockBridge,
  mockProviders,
  renderRoute,
  renderWithAppState,
} from "../test/test-utils";
import type {
  GraphCacheStatus,
  IntuneChatConversation,
  IntuneChatMessage,
  OpenAdminOSApi,
  SendIntuneChatMessageResult,
  WorkspaceDetail,
} from "../shared/openAdminOS";
import { deriveTrustCopy } from "../copy";

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

describe("IntuneChat guest exploration", () => {
  it("lets a user draft from a suggestion and asks for setup only on Send", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge(
      {},
      createMockAppState({ tenants: [], activeTenantId: undefined }),
    );

    renderRoute(<IntuneChat />, {
      path: "/chat/:conversationId?",
      route: "/chat",
      bridge,
    });

    const composer = await screen.findByRole("combobox", {
      name: "Ask about your Microsoft 365 tenant",
    });
    await user.click(
      screen.getByRole("button", {
        name: /managed devices have not synced in the las/,
      }),
    );
    expect(composer).toHaveValue(
      "Which managed devices have not synced in the last 7 days?",
    );
    expect(bridge.streamIntuneChatMessage).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(
      await screen.findByRole("heading", { name: "Connect a Microsoft 365 tenant" }),
    ).toBeInTheDocument();
    expect(bridge.connectTenant).not.toHaveBeenCalled();
    expect(composer).toHaveValue(
      "Which managed devices have not synced in the last 7 days?",
    );
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

  it("sends exactly once after the user explicitly resumes completed setup", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    const connectedState = createMockAppState();
    const bridge = makeMockBridge(
      { connectTenant: vi.fn(async () => connectedState) },
      emptyState,
    );

    renderRoute(<IntuneChat />, {
      path: "/chat/:conversationId?",
      route: "/chat",
      bridge,
    });

    // A fresh install auto-opens setup; this test covers the contextual
    // path, so dismiss the first-run dialog before drafting a question.
    await user.click(
      await screen.findByRole("button", { name: "Close" }),
    );

    const composer = await screen.findByRole("combobox", {
      name: "Ask about your Microsoft 365 tenant",
    });
    await user.type(composer, "Which Windows devices are stale?");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(
      await screen.findByRole("button", { name: "Approve and continue to Microsoft" }),
    );
    expect(
      await screen.findByRole("button", { name: "Send your question" }),
    ).toBeInTheDocument();
    expect(bridge.streamIntuneChatMessage).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Send your question" }));
    await waitFor(() => expect(bridge.streamIntuneChatMessage).toHaveBeenCalledOnce());
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
    await screen.findByText(
      "Prompts and tenant data go to OpenAI while this model is selected.",
    );

    await user.type(composer, "Which Windows devices are stale?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(
      await screen.findByRole("heading", {
        name: "Send tenant context to hosted provider",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        deriveTrustCopy({
          provider: { name: "OpenAI", isLocal: false },
          model: "gpt-5",
          scope: { tenantNames: ["Contoso IT"] },
        }).confirmBody,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("What leaves this device")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", {
        name: "Remember this decision for this tenant and provider on this device.",
      }),
    ).not.toBeChecked();
    expect(bridge.streamIntuneChatMessage).not.toHaveBeenCalled();

    const modalSendButton = screen.getAllByRole("button", { name: "Send" }).at(-1);
    expect(modalSendButton).toBeDefined();
    await user.click(modalSendButton!);

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
    await user.keyboard("{F2}");
    const titleInput = screen.getByRole("textbox", { name: "Conversation title" });
    await user.clear(titleInput);
    await user.type(titleInput, "Renamed title{Enter}");
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

  it("keeps an engine notice out of the answer until details are expanded", async () => {
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
    expect(screen.queryByText(notice)).not.toBeVisible();
    await user.click(screen.getByText("How I checked"));
    expect(screen.getByText(notice)).toBeVisible();
  });
});
