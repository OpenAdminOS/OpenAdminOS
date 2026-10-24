import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation, useNavigate } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type { IntuneChatConversation } from "../shared/openAdminOS";
import { makeMockBridge, renderWithAppState } from "../test/test-utils";
import {
  ConversationWorkspaceProvider,
  useConversations,
} from "./conversations";

const conversation: IntuneChatConversation = {
  id: "conversation-1",
  title: "Review stale devices",
  tenantId: "tenant-1",
  scopeKind: "single-tenant",
  createdAt: "2026-10-10T08:00:00.000Z",
  updatedAt: "2026-10-10T09:00:00.000Z",
};

describe("ConversationWorkspaceProvider", () => {
  it("reloads for tenant and search changes, not route changes", async () => {
    const user = userEvent.setup();
    const listIntuneChatConversations = vi.fn(async () => [conversation]);
    const searchIntuneChatConversations = vi.fn(async () => [conversation]);
    const bridge = makeMockBridge({
      listIntuneChatConversations,
      searchIntuneChatConversations,
    });

    renderConversationHarness("/chat", bridge);

    await screen.findByText("loaded");
    await waitFor(() =>
      expect(listIntuneChatConversations).toHaveBeenCalledTimes(2),
    );
    const tenantLoadCount = listIntuneChatConversations.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Open Runs" }));
    expect(screen.getByTestId("conversation-location")).toHaveTextContent("/runs");
    expect(listIntuneChatConversations).toHaveBeenCalledTimes(tenantLoadCount);

    await user.click(screen.getByRole("button", { name: "Search conversations" }));
    await waitFor(() =>
      expect(searchIntuneChatConversations).toHaveBeenCalledTimes(1),
    );
    expect(searchIntuneChatConversations).toHaveBeenCalledWith("stale");

    await user.click(screen.getByRole("button", { name: "Open conversation route" }));
    expect(screen.getByTestId("conversation-location")).toHaveTextContent(
      "/chat/conversation-1",
    );
    expect(listIntuneChatConversations).toHaveBeenCalledTimes(tenantLoadCount);
    expect(searchIntuneChatConversations).toHaveBeenCalledTimes(1);
  });

  it("refreshes pin, rename, and non-active deletion in place", async () => {
    const user = userEvent.setup();
    const listIntuneChatConversations = vi.fn(async () => [conversation]);
    const bridge = makeMockBridge({ listIntuneChatConversations });

    renderConversationHarness("/runs", bridge);
    await screen.findByText("loaded");

    await user.click(screen.getByRole("button", { name: "Pin first conversation" }));
    await waitFor(() =>
      expect(bridge.setIntuneChatConversationPinned).toHaveBeenCalledWith(
        conversation.id,
        true,
      ),
    );
    expect(screen.getByTestId("conversation-location")).toHaveTextContent("/runs");

    await user.click(screen.getByRole("button", { name: "Rename first conversation" }));
    const title = screen.getByRole("textbox", { name: "Conversation title" });
    await user.clear(title);
    await user.type(title, "Renamed conversation");
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() =>
      expect(bridge.renameIntuneChatConversation).toHaveBeenCalledWith(
        conversation.id,
        "Renamed conversation",
      ),
    );
    expect(screen.getByTestId("conversation-location")).toHaveTextContent("/runs");

    await user.click(screen.getByRole("button", { name: "Delete first conversation" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(bridge.deleteIntuneChatConversation).toHaveBeenCalledWith(conversation.id),
    );
    expect(screen.getByTestId("conversation-location")).toHaveTextContent("/runs");
  });

  it("returns to Chat only when deleting the open conversation", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge({
      listIntuneChatConversations: vi.fn(async () => [conversation]),
    });

    renderConversationHarness(`/chat/${conversation.id}`, bridge);
    await screen.findByText("loaded");
    await user.click(screen.getByRole("button", { name: "Delete first conversation" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(screen.getByTestId("conversation-location")).toHaveTextContent(/^\/chat$/),
    );
  });
});

function renderConversationHarness(
  route: string,
  bridge: ReturnType<typeof makeMockBridge>,
) {
  return renderWithAppState(
    <ConversationWorkspaceProvider>
      <ConversationHarness />
    </ConversationWorkspaceProvider>,
    { route, bridge },
  );
}

function ConversationHarness() {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    conversations,
    shellLoaded,
    setConversationSearch,
    togglePinned,
    requestRename,
    requestDelete,
  } = useConversations();
  const first = conversations[0];
  return (
    <>
      <output data-testid="conversation-location">{location.pathname}</output>
      <output>{shellLoaded ? "loaded" : "loading"}</output>
      <button type="button" onClick={() => navigate("/runs")}>Open Runs</button>
      <button type="button" onClick={() => setConversationSearch("stale")}>Search conversations</button>
      <button type="button" onClick={() => navigate(`/chat/${conversation.id}`)}>Open conversation route</button>
      <button type="button" disabled={!first} onClick={() => first && void togglePinned(first)}>Pin first conversation</button>
      <button type="button" disabled={!first} onClick={() => first && requestRename(first)}>Rename first conversation</button>
      <button type="button" disabled={!first} onClick={() => first && requestDelete(first)}>Delete first conversation</button>
    </>
  );
}
