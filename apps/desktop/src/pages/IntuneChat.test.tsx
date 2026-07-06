import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import IntuneChat from "./IntuneChat";
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
      path: "/chat",
      route: "/chat",
      bridge,
    });

    const composer = await screen.findByPlaceholderText(
      "Ask about devices, users, policies, sign-ins, or an installed agent workflow.",
    );
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
        "This chat answer will use retrieved tenant context with OpenAI. The answer prompt leaves this device.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("What leaves this device")).toBeInTheDocument();
    expect(bridge.streamIntuneChatMessage).not.toHaveBeenCalled();

    const modalSendButton = screen.getAllByRole("button", { name: "Send" }).at(-1);
    expect(modalSendButton).toBeDefined();
    await user.click(modalSendButton!);

    await waitFor(() => {
      expect(bridge.streamIntuneChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "Which Windows devices are stale?",
          hostedProviderConsent: expect.objectContaining({
            tenantId: "tenant-1",
            providerId: "openai",
            remember: true,
          }),
        }),
        expect.any(Function),
      );
    });
  });

  it("uses the mocked hosted provider state", () => {
    expect(mockProviders.find((provider) => provider.id === "openai")?.isLocal).toBe(false);
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
      path: "/chat",
      route: "/chat",
      bridge,
    });

    const composer = await screen.findByPlaceholderText(
      "Ask about devices, users, policies, sign-ins, or an installed agent workflow.",
    );
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
