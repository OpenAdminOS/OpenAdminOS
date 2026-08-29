import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import IntuneChat, { createHostedBatchProviderConsent } from "./IntuneChat";
import {
  createMockAgent,
  createMockAppState,
  makeMockBridge,
  mockProviders,
  renderRoute,
} from "../test/test-utils";
import type {
  GraphCacheStatus,
  IntuneChatConversation,
  IntuneChatMessage,
  OpenAdminOSApi,
  SendIntuneChatMessageResult,
} from "../shared/openAdminOS";
import { CHAT_COPY, deriveTrustCopy } from "../copy";

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

    const composer = await screen.findByPlaceholderText(
      "Ask about devices, users, apps, policies, or sign-ins. Connect a tenant when you send.",
    );
    await user.click(
      screen.getByRole("button", {
        name: "Which managed devices have not synced in the last 7 days?",
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

    const composer = await screen.findByPlaceholderText(
      "Ask about devices, users, apps, policies, or sign-ins. Connect a tenant when you send.",
    );
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

    const composer = await screen.findByPlaceholderText(CHAT_COPY.composerPlaceholder);
    await screen.findByText("Retrieved tenant context is sent to the selected hosted provider.");

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
          role: "assistant",
          content: "",
          createdAt,
          status: "streaming",
          providerId: appState.activeProviderId,
          ...(activeModel ? { model: activeModel } : {}),
        };
        const assistantMessage: IntuneChatMessage = {
          ...streamingAssistantMessage,
          content: "Mock answer about stale device sync.",
          status: "completed",
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

    const composer = await screen.findByPlaceholderText(CHAT_COPY.composerPlaceholder);
    await user.type(composer, "Which managed devices have not synced in 45 days?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Related agent · Find inactive devices")).toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Reviews Intune-managed device inactivity by sync age, compliance, OS, ownership, and enrollment signals with review-first cleanup guidance.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open agent →" })).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", {
        name: "Dismiss related agent Find inactive devices",
      }),
    );

    expect(screen.queryByText("Related agent · Find inactive devices")).not.toBeInTheDocument();
  });
});

describe("IntuneChat conversation routes", () => {
  it("uses a readable overlay drawer instead of a numbered mini-rail at constrained widths", async () => {
    const user = userEvent.setup();
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

    const historyButton = await screen.findByRole("button", { name: "Show chat history" });
    expect(screen.queryByRole("searchbox", { name: "Search conversations" })).not.toBeInTheDocument();
    expect(screen.queryByText("01")).not.toBeInTheDocument();

    await user.click(historyButton);
    const search = await screen.findByRole("searchbox", { name: "Search conversations" });
    await waitFor(() => expect(search).toHaveFocus());
    expect(screen.getByText("Windows compliance gaps")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Show chat history" })).toHaveFocus(),
    );
    expect(screen.queryByRole("searchbox", { name: "Search conversations" })).not.toBeInTheDocument();
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

    expect(
      (await screen.findAllByText("Review stale device evidence")).length,
    ).toBeGreaterThan(0);
    await waitFor(() => {
      expect(bridge.getIntuneChatMessages).toHaveBeenCalledWith("conversation-route-1");
    });
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
    expect(screen.getByPlaceholderText(CHAT_COPY.composerPlaceholder)).toBeDisabled();
  });

  it("filters the rail without changing the URL-owned open conversation", async () => {
    const user = userEvent.setup();
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
    bridge.searchIntuneChatConversations = vi.fn(async () => [matchingConversation]);
    bridge.getIntuneChatMessages = vi.fn(async () => []);

    renderRoute(<IntuneChat />, {
      path: "/chat/:conversationId?",
      route: "/chat/conversation-active",
      bridge,
    });

    const search = await screen.findByRole("searchbox", { name: "Search conversations" });
    await user.type(search, "other");
    await waitFor(() => {
      expect(bridge.searchIntuneChatConversations).toHaveBeenCalledWith("other");
    });
    expect(screen.getAllByText("Active device review").length).toBeGreaterThan(0);
    expect(bridge.getIntuneChatMessages).not.toHaveBeenCalledWith("conversation-match");
  });
});
