import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import IntuneChat from "./IntuneChat";
import { createMockAppState, makeMockBridge, mockProviders, renderRoute, renderWithAppState } from "../test/test-utils";
import { useAppState } from "../state";
import type {
  GraphCacheStatus,
  IntuneChatConversation,
  IntuneChatMessage,
  OpenAdminOSApi,
  SendIntuneChatMessageInput,
  SendIntuneChatMessageResult,
} from "../shared/openAdminOS";
import { CHAT_COPY } from "../copy";
import { readChatDraft } from "../shared/chat-drafts";

const QUESTION = "List every device with its compliance policies, profiles and last sign-in, grouped by owner.";
const tenantId = createMockAppState().activeTenantId!;
const conversation: IntuneChatConversation = {
  id: "conversation-fit",
  title: QUESTION,
  createdAt: "2026-11-19T09:00:00.000Z",
  updatedAt: "2026-11-19T09:00:01.000Z",
  tenantId,
  scopeKind: "single-tenant",
};

/** The first send fails for its size on the local model; a send with an override answers on the chosen provider. */
function fitBridge(state = createMockAppState(), failedModel = "llama3.1") {
  let saved: IntuneChatMessage[] = [];
  let count = 0;
  return makeMockBridge(
    {
      listIntuneChatConversations: vi.fn(async () => (saved.length ? [conversation] : [])),
      getIntuneChatMessages: vi.fn(async () => saved),
      streamIntuneChatMessage: vi.fn<OpenAdminOSApi["streamIntuneChatMessage"]>(async (input: SendIntuneChatMessageInput, onEvent) => {
        count += 1;
        const userMessage: IntuneChatMessage = { id: `user-${count}`, conversationId: conversation.id, role: "user", content: input.content, status: "completed", createdAt: conversation.createdAt };
        const override = input.modelOverride;
        const assistantMessage: IntuneChatMessage = override
          ? {
              id: `assistant-${count}`, conversationId: conversation.id, role: "assistant", status: "completed", createdAt: "2026-11-19T09:00:02.000Z",
              content: "Contoso has 412 managed devices across 187 owners.",
              providerId: override.providerId, model: override.model,
              switchedFrom: { providerId: "ollama", model: "llama3.1", reason: "context-too-small" },
            }
          : {
              id: `assistant-${count}`, conversationId: conversation.id, role: "assistant", status: "failed", createdAt: "2026-11-19T09:00:01.000Z",
              content: "The selected LLM provider failed while answering this chat message.",
              providerId: "ollama", model: failedModel,
              error: "Ollama context size too small",
              modelFit: { reason: "context-too-small", providerId: "ollama", model: failedModel, neededTokens: 40652, limitTokens: 16384, offerId: `fit_${count}` },
            };
        saved = [...saved, userMessage, assistantMessage];
        const cacheStatus: GraphCacheStatus = { tenantId, resources: [] };
        const result: SendIntuneChatMessageResult = { conversation, userMessage, assistantMessage, cacheStatus };
        if (override) onEvent({ type: "completed", result });
        else onEvent({ type: "failed", result, error: assistantMessage.error! });
        return result;
      }),
    },
    state,
  );
}

async function sendTooLarge(bridge: ReturnType<typeof fitBridge>) {
  const user = userEvent.setup();
  renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: "/chat", bridge });
  await user.click(await screen.findByRole("combobox", { name: CHAT_COPY.composerLabel }));
  await user.paste(QUESTION);
  await user.click(screen.getByRole("button", { name: "Send" }));
  const notice = await screen.findByRole("region", { name: "llama3.1 cannot fit this request" });
  return { user, notice };
}

afterEach(() => window.localStorage.clear());

describe("IntuneChat model fit (mockup 36)", () => {
  it("shows the notice with the numbers and each hosted provider's location label, with nothing preselected", async () => {
    const bridge = fitBridge();
    const { notice } = await sendTooLarge(bridge);
    expect(within(notice).getByText("This request needs about 40,652 tokens. llama3.1 is set to 16,384.")).toBeInTheDocument();
    expect(within(notice).getByText("Nothing goes to another provider unless you choose one.")).toBeInTheDocument();
    expect(within(notice).getByText("Codex · location set by your account")).toBeInTheDocument();
    expect(within(notice).getByText("Uses your Codex sign-in. The request counts toward that account's usage or bill.")).toBeInTheDocument();
    // Claude Code is not installed in this state, so it is not offered.
    expect(within(notice).queryByRole("button", { name: "Run with Claude Code" })).toBeNull();
    // Every choice is a plain button, none focused or marked.
    const runWithCodex = within(notice).getByRole("button", { name: "Run with Codex" });
    expect(notice.contains(document.activeElement)).toBe(false);
    expect(runWithCodex).not.toHaveAttribute("aria-pressed");
    expect(within(notice).queryByRole("radio")).toBeNull();
    // The generic error is replaced by the notice.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(bridge.streamIntuneChatMessage).toHaveBeenCalledOnce();
  });

  it("sends nothing to the hosted provider until the per-request accept, then answers with it and says where data went", async () => {
    const bridge = fitBridge();
    const { user, notice } = await sendTooLarge(bridge);
    await user.click(within(notice).getByRole("button", { name: "Run with Codex" }));
    const accept = await screen.findByRole("dialog", { name: "Run this request with Codex?" });
    expect(within(accept).getByText("llama3.1 cannot fit it. Codex answers this one request. Your next message goes to llama3.1 again.")).toBeInTheDocument();
    expect(within(accept).getByText("Codex · location set by your account", { exact: false }).tagName).toBe("DD");
    expect(within(accept).getByText("Counts toward your Codex account's usage or bill")).toBeInTheDocument();
    expect(within(accept).getByText("Asked for every request. Nothing is remembered.")).toBeInTheDocument();
    expect(within(accept).queryByRole("checkbox")).toBeNull();
    // Choosing the provider did not send, and Enter in the accept step does not either.
    expect(within(accept).getByRole("button", { name: "Send through Codex" })).not.toHaveFocus();
    await user.keyboard("{Enter}");
    expect(bridge.streamIntuneChatMessage).toHaveBeenCalledOnce();

    await user.click(within(accept).getByRole("button", { name: "Send through Codex" }));
    await waitFor(() => expect(bridge.streamIntuneChatMessage).toHaveBeenCalledTimes(2));
    const input = vi.mocked(bridge.streamIntuneChatMessage).mock.calls[1]![0];
    expect(input.content).toBe(QUESTION);
    expect(input.modelOverride).toEqual({ offerId: "fit_1", providerId: "openai", model: "gpt-5", destination: "dest-openai" });
    expect(input.hostedProviderConsent).toMatchObject({ tenantId, providerId: "openai", model: "gpt-5" });
    expect(input.hostedProviderConsent).not.toHaveProperty("remember");

    const answeredBy = (await screen.findByText("Answered by")).parentElement!;
    expect(answeredBy).toHaveTextContent("Answered by Codex · location set by your account for this request only. Chat is back on llama3.1.");
  });

  it("shows the exact question in the accept step and closes it unsent when the composer changes", async () => {
    const bridge = fitBridge();
    const { user, notice } = await sendTooLarge(bridge);
    await user.click(within(notice).getByRole("button", { name: "Run with Codex" }));
    const accept = await screen.findByRole("dialog", { name: "Run this request with Codex?" });
    expect(accept.querySelector("[data-model-fit-question]")).toHaveTextContent(QUESTION);
    // The admin removes part of the question while the accept step is open.
    const composer = screen.getByRole("combobox", { name: CHAT_COPY.composerLabel });
    await user.clear(composer);
    await user.click(composer);
    await user.paste("List devices grouped by owner.");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Run this request with Codex?" })).toBeNull());
    expect(screen.getByText(/^Your question or attachments changed, so nothing was sent\./)).toBeInTheDocument();
    expect(bridge.streamIntuneChatMessage).toHaveBeenCalledOnce();
  });

  it("says where the accepted request is going while it runs", async () => {
    const bridge = fitBridge();
    let release: () => void = () => undefined;
    const stream = bridge.streamIntuneChatMessage;
    // The accepted request stays in progress until released.
    bridge.streamIntuneChatMessage = vi.fn<OpenAdminOSApi["streamIntuneChatMessage"]>(async (input, onEvent, options) => {
      if (input.modelOverride) await new Promise<void>((resolve) => { release = resolve; });
      return stream(input, onEvent, options);
    });
    const { user, notice } = await sendTooLarge(bridge);
    await user.click(within(notice).getByRole("button", { name: "Run with Codex" }));
    const accept = await screen.findByRole("dialog", { name: "Run this request with Codex?" });
    await user.click(within(accept).getByRole("button", { name: "Send through Codex" }));
    const line = (await screen.findByText("Sending to")).parentElement!;
    expect(line).toHaveTextContent("Sending to Codex · location set by your account for this request only.");
    release();
    expect(await screen.findByText("Answered by")).toBeInTheDocument();
  });

  it("keeps a narrower draft the admin typed when the original question is retried", async () => {
    const bridge = fitBridge();
    const { user } = await sendTooLarge(bridge);
    await screen.findByDisplayValue(QUESTION);
    fireEvent.change(screen.getByRole("combobox", { name: CHAT_COPY.composerLabel }), { target: { value: "List devices by owner." } });
    await user.click(within(await screen.findByRole("region", { name: "llama3.1 cannot fit this request" })).getByRole("button", { name: "Run with Codex" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Run this request with Codex?" })).getByRole("button", { name: "Send through Codex" }));
    await waitFor(() => expect(bridge.streamIntuneChatMessage).toHaveBeenCalledTimes(2));
    expect(vi.mocked(bridge.streamIntuneChatMessage).mock.calls[1]![0].content).toBe(QUESTION);
    await screen.findByText("Answered by");
    expect(screen.getByRole("combobox", { name: CHAT_COPY.composerLabel })).toHaveValue("List devices by owner.");
  });

  it("does not say the request went anywhere when the host refuses the retry", async () => {
    const bridge = fitBridge();
    const stream = bridge.streamIntuneChatMessage;
    bridge.streamIntuneChatMessage = vi.fn<OpenAdminOSApi["streamIntuneChatMessage"]>(async (input, onEvent, options) => {
      if (input.modelOverride) throw new Error("Codex's settings changed after you chose it, so nothing was sent. Choose it again to review where the request goes.");
      return stream(input, onEvent, options);
    });
    const { user, notice } = await sendTooLarge(bridge);
    await user.click(within(notice).getByRole("button", { name: "Run with Codex" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Run this request with Codex?" })).getByRole("button", { name: "Send through Codex" }));
    await waitFor(() => expect(bridge.streamIntuneChatMessage).toHaveBeenCalledTimes(2));
    await screen.findByText(/settings changed after you chose it, so nothing was sent/);
    expect(screen.queryByText("Sent to")).toBeNull();
    expect(screen.queryByText("Sending to")).toBeNull();
  });

  it("keeps the admin's narrower draft stored when a larger local model fails too", async () => {
    const providers = mockProviders.map((provider) => (provider.id === "ollama" ? { ...provider, models: ["llama3.1:8b", "gpt-oss:20b"], defaultModel: "llama3.1:8b" } : provider));
    // The failed model is 8B by name, so gpt-oss:20b is offered as a larger local model.
    const bridge = fitBridge(createMockAppState({ providers, activeModelByProviderId: { ollama: "llama3.1:8b" } }), "llama3.1:8b");
    const stream = bridge.streamIntuneChatMessage;
    bridge.streamIntuneChatMessage = vi.fn<OpenAdminOSApi["streamIntuneChatMessage"]>(async (input, onEvent, options) => {
      // The larger local model fails for its size as well.
      if (input.modelOverride?.providerId === "ollama") return stream({ ...input, modelOverride: undefined }, onEvent, options);
      return stream(input, onEvent, options);
    });
    const user = userEvent.setup();
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: "/chat", bridge });
    await user.click(await screen.findByRole("combobox", { name: CHAT_COPY.composerLabel }));
    await user.paste(QUESTION);
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByDisplayValue(QUESTION);
    fireEvent.change(screen.getByRole("combobox", { name: CHAT_COPY.composerLabel }), { target: { value: "List devices by owner." } });
    await user.click(within(await screen.findByRole("region", { name: "llama3.1:8b cannot fit this request" })).getByRole("button", { name: "Use gpt-oss:20b" }));
    await waitFor(() => expect(bridge.streamIntuneChatMessage).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(readChatDraft(conversation.id)).toBe("List devices by owner."));
    expect(screen.getByRole("combobox", { name: CHAT_COPY.composerLabel })).toHaveValue("List devices by owner.");
  });

  it("keeps a cleared draft cleared when a larger local model fails too", async () => {
    const providers = mockProviders.map((provider) => (provider.id === "ollama" ? { ...provider, models: ["llama3.1:8b", "gpt-oss:20b"], defaultModel: "llama3.1:8b" } : provider));
    const bridge = fitBridge(createMockAppState({ providers, activeModelByProviderId: { ollama: "llama3.1:8b" } }), "llama3.1:8b");
    const stream = bridge.streamIntuneChatMessage;
    bridge.streamIntuneChatMessage = vi.fn<OpenAdminOSApi["streamIntuneChatMessage"]>(async (input, onEvent, options) =>
      input.modelOverride?.providerId === "ollama" ? stream({ ...input, modelOverride: undefined }, onEvent, options) : stream(input, onEvent, options));
    const user = userEvent.setup();
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: "/chat", bridge });
    await user.click(await screen.findByRole("combobox", { name: CHAT_COPY.composerLabel }));
    await user.paste(QUESTION);
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByDisplayValue(QUESTION);
    fireEvent.change(screen.getByRole("combobox", { name: CHAT_COPY.composerLabel }), { target: { value: "" } });
    await user.click(within(await screen.findByRole("region", { name: "llama3.1:8b cannot fit this request" })).getByRole("button", { name: "Use gpt-oss:20b" }));
    await waitFor(() => expect(bridge.streamIntuneChatMessage).toHaveBeenCalledTimes(2));
    await screen.findByRole("region", { name: "llama3.1:8b cannot fit this request" });
    expect(screen.getByRole("combobox", { name: CHAT_COPY.composerLabel })).toHaveValue("");
    expect(readChatDraft(conversation.id)).toBe("");
  });

  it("asks for the accept even when hosted sends to Codex were remembered for this tenant", async () => {
    window.localStorage.setItem(`openadminos:intune-chat-hosted-consent:v1:${tenantId}:openai`, "true");
    const bridge = fitBridge();
    const { user, notice } = await sendTooLarge(bridge);
    await user.click(within(notice).getByRole("button", { name: "Run with Codex" }));
    expect(await screen.findByRole("dialog", { name: "Run this request with Codex?" })).toBeInTheDocument();
    expect(bridge.streamIntuneChatMessage).toHaveBeenCalledOnce();
  });

  it("keeps the local model when declined, with the question back and a plain next step", async () => {
    const bridge = fitBridge();
    const { user, notice } = await sendTooLarge(bridge);
    await user.click(within(notice).getByRole("button", { name: "Keep on llama3.1" }));
    expect(screen.queryByRole("region", { name: "llama3.1 cannot fit this request" })).toBeNull();
    expect(await screen.findByText(/^Kept on llama3\.1\. Nothing was sent\. Narrow the question/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: CHAT_COPY.composerLabel })).toHaveValue(QUESTION);
    expect(bridge.streamIntuneChatMessage).toHaveBeenCalledOnce();
  });

  it("keeps a draft the admin cleared when declining", async () => {
    const bridge = fitBridge();
    const { user } = await sendTooLarge(bridge);
    // The question is back in the composer once the conversation opens; the admin clears it.
    await screen.findByDisplayValue(QUESTION);
    fireEvent.change(screen.getByRole("combobox", { name: CHAT_COPY.composerLabel }), { target: { value: "" } });
    await user.click(within(await screen.findByRole("region", { name: "llama3.1 cannot fit this request" })).getByRole("button", { name: "Keep on llama3.1" }));
    expect(screen.getByRole("combobox", { name: CHAT_COPY.composerLabel })).toHaveValue("");
  });

  it("puts the question back when Split is chosen with an empty composer", async () => {
    const bridge = fitBridge();
    const { user } = await sendTooLarge(bridge);
    await screen.findByDisplayValue(QUESTION);
    fireEvent.change(screen.getByRole("combobox", { name: CHAT_COPY.composerLabel }), { target: { value: "" } });
    await user.click(within(await screen.findByRole("region", { name: "llama3.1 cannot fit this request" })).getByRole("button", { name: "Split the question" }));
    expect(screen.getByRole("combobox", { name: CHAT_COPY.composerLabel })).toHaveValue(QUESTION);
  });

  it("offers no hosted provider when the managed policy allows only local ones", async () => {
    const state = createMockAppState({
      // The main process leaves out what the policy does not allow.
      providers: mockProviders.filter((provider) => provider.isLocal),
      managedPolicy: { files: [], values: { allowedProviders: ["ollama", "apple-foundation", "lm-studio"] }, sources: {}, locked: [], issues: [] },
    });
    const { notice } = await sendTooLarge(fitBridge(state));
    expect(within(notice).queryByRole("button", { name: /^Run with/ })).toBeNull();
    expect(within(notice).getByText("Your organization's policy allows only providers on this device, so no hosted provider is offered.")).toBeInTheDocument();
  });
  it("still says where the request went when the switched answer fails", async () => {
    const failedSwitch: IntuneChatMessage = {
      id: "assistant-switch", conversationId: conversation.id, role: "assistant", status: "failed", createdAt: "2026-11-19T09:00:02.000Z",
      content: "The selected LLM provider failed while answering this chat message.", error: "Codex stopped sending output.",
      providerId: "openai", model: "gpt-5", switchedFrom: { providerId: "ollama", model: "llama3.1", reason: "context-too-small" },
    };
    const bridge = makeMockBridge({
      listIntuneChatConversations: vi.fn(async () => [conversation]),
      getIntuneChatMessages: vi.fn(async (): Promise<IntuneChatMessage[]> => [
        { id: "user-switch", conversationId: conversation.id, role: "user", content: QUESTION, status: "completed", createdAt: conversation.createdAt },
        failedSwitch,
      ]),
    });
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: `/chat/${conversation.id}`, bridge });
    const line = (await screen.findByText("Sent to")).parentElement!;
    expect(line).toHaveTextContent("Sent to Codex · location set by your account for this request only. Chat is back on llama3.1.");
  });

  it("keeps the reason on a stored failed answer after a reload, without the choices", async () => {
    const stored: IntuneChatMessage = {
      id: "assistant-stored", conversationId: conversation.id, role: "assistant", status: "failed", createdAt: "2026-11-19T09:00:01.000Z",
      content: "The selected LLM provider failed while answering this chat message.", error: "Ollama context size too small",
      providerId: "ollama", model: "llama3.1",
      modelFit: { reason: "context-too-small", providerId: "ollama", model: "llama3.1", neededTokens: 40652, limitTokens: 16384 },
    };
    const bridge = makeMockBridge({
      listIntuneChatConversations: vi.fn(async () => [conversation]),
      getIntuneChatMessages: vi.fn(async (): Promise<IntuneChatMessage[]> => [
        { id: "user-stored", conversationId: conversation.id, role: "user", content: QUESTION, status: "completed", createdAt: conversation.createdAt },
        stored,
      ]),
    });
    renderRoute(<IntuneChat />, { path: "/chat/:conversationId?", route: `/chat/${conversation.id}`, bridge });
    const reason = await screen.findByText("This request needs about 40,652 tokens. llama3.1 is set to 16,384.");
    expect(reason.closest("[data-model-fit-reason]")).toHaveTextContent("llama3.1 cannot fit this request.");
    expect(screen.queryByRole("button", { name: /^Run with/ })).toBeNull();
  });

  it("withdraws the offer when the active model changes", async () => {
    const user = userEvent.setup();
    const providers = mockProviders.map((provider) => (provider.id === "ollama" ? { ...provider, models: ["llama3.1", "qwen3:8b"] } : provider));
    const bridge = fitBridge(createMockAppState({ providers }));
    function SwitchModel() {
      const { setActiveModel } = useAppState();
      return <button type="button" onClick={() => void setActiveModel("ollama", "qwen3:8b")}>Switch model</button>;
    }
    renderWithAppState(
      <Routes><Route path="/chat/:conversationId?" element={<><IntuneChat /><SwitchModel /></>} /></Routes>,
      { route: "/chat", bridge },
    );
    await user.click(await screen.findByRole("combobox", { name: CHAT_COPY.composerLabel }));
  await user.paste(QUESTION);
    await user.click(screen.getByRole("button", { name: "Send" }));
    const notice = await screen.findByRole("region", { name: "llama3.1 cannot fit this request" });
    await user.click(within(notice).getByRole("button", { name: "Run with Codex" }));
    expect(await screen.findByRole("dialog", { name: "Run this request with Codex?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Switch model" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Run this request with Codex?" })).toBeNull());
    expect(screen.queryByRole("region", { name: "llama3.1 cannot fit this request" })).toBeNull();
    expect(bridge.streamIntuneChatMessage).toHaveBeenCalledOnce();
  });
});
