import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { Nova } from "./Nova";
import { makeMockBridge, renderRoute } from "../test/test-utils";
it("does not activate the microphone until consent and releases a late permission grant after Stop", async () => {
  vi.stubGlobal("URL", { revokeObjectURL: vi.fn(), createObjectURL: vi.fn() });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  let resolve!: (stream: MediaStream) => void;
  const getUserMedia = vi.fn(
    () =>
      new Promise<MediaStream>((r) => {
        resolve = r;
      }),
  );
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia },
    configurable: true,
  });
  const stop = vi.fn();
  const bridge = makeMockBridge({
    nova: vi.fn(async (input) =>
      input.action === "status" ? { hasKey: true } : {},
    ),
  });
  renderRoute(<Nova />, { bridge, route: "/cache", path: "/cache" });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Talk to Nova/ }));
  expect(screen.getByRole("button", { name: "Start Nova" })).toBeDisabled();
  expect(getUserMedia).not.toHaveBeenCalled();
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Start Nova" }));
  expect(getUserMedia).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", { name: "Stop" }));
  resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
  await waitFor(() => expect(stop).toHaveBeenCalledOnce());
  expect(bridge.nova).not.toHaveBeenCalledWith(
    expect.objectContaining({ action: "start" }),
  );
  expect(screen.getByRole("checkbox")).not.toBeChecked();
});

it("expands the voice view and hides captions without requesting the microphone", async () => {
  const getUserMedia = vi.fn();
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia },
    configurable: true,
  });
  const bridge = makeMockBridge({
    nova: vi.fn(async () => ({ hasKey: true })),
  });
  renderRoute(<Nova />, { bridge, route: "/cache", path: "/cache" });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Talk to Nova/ }));
  await user.click(screen.getByRole("button", { name: "Full screen" }));
  expect(
    screen.getByRole("dialog", { name: "Nova voice assistant" }),
  ).toHaveClass("nova-panel-expanded");
  expect(
    screen.queryByLabelText("Conversation"),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  await user.click(screen.getByRole("button", { name: "Show conversation panel" }));
  expect(screen.getByLabelText("Conversation")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Exit full screen" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Full screen" })).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Voice settings" }));
  expect(screen.getByLabelText("Voice provider")).toBeVisible();
  expect(getUserMedia).not.toHaveBeenCalled();
});

it("keeps the microphone off when setup fails and explains the reasoning dependency", async () => {
  const getUserMedia = vi.fn();
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia },
    configurable: true,
  });
  const bridge = makeMockBridge({
    nova: vi.fn(async (input) => {
      if (input.action === "status") return { hasKey: true };
      if (input.action === "check")
        throw new Error(
          "Nova needs a connected reasoning provider. Open Settings.",
        );
      return {};
    }),
  });
  renderRoute(<Nova />, { bridge, route: "/cache", path: "/cache" });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Talk to Nova/ }));
  expect(screen.getByText(/The voice key powers speech/)).toBeVisible();
  expect(screen.getByText(/Preloading is optional/)).toBeInTheDocument();
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Start Nova" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "reasoning provider",
  );
  expect(getUserMedia).not.toHaveBeenCalled();
});

it("keeps transcript speakers distinct and returns a delegated answer to the live session", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const track = { stop: vi.fn(), addEventListener: vi.fn() };
  Object.defineProperty(navigator, "mediaDevices", {
    value: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [track],
        getAudioTracks: () => [track],
      })),
    },
    configurable: true,
  });
  vi.stubGlobal(
    "AudioContext",
    class {
      resume = async () => {};
      close = async () => {};
      createAnalyser = () => ({
        fftSize: 512,
        getByteTimeDomainData: (values: Uint8Array) => values.fill(128),
      });
      createMediaStreamSource = () => ({ connect: vi.fn() });
    },
  );
  const dc = {
    readyState: "open",
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    onmessage: undefined as undefined | ((event: { data: string }) => void),
  };
  vi.stubGlobal(
    "RTCPeerConnection",
    class {
      iceGatheringState = "complete";
      localDescription = { sdp: "v=0" };
      addTrack = vi.fn();
      createDataChannel = () => dc;
      createOffer = async () => ({ sdp: "v=0" });
      setLocalDescription = async () => {};
      setRemoteDescription = async () => {};
      close = vi.fn();
    },
  );
  let finishAction!: (value: { text: string }) => void;
  let finish!: (value: { text: string; answerError?: string; pendingAction?: import("@openadminos/agent-sdk").NovaActionPreview }) => void;
  const bridge = makeMockBridge({
    nova: vi.fn(async (input) => {
      if (input.action === "status") return { hasKey: true };
      if (input.action === "start")
        return { sessionId: "voice-session", sdp: "v=0" };
      if (input.action === "decide-action") return new Promise<{ text: string }>(resolve => { finishAction = resolve; });
      if (input.action === "answer")
        return new Promise<{ text: string; answerError?: string }>((resolve) => {
          finish = resolve;
        });
      return {};
    }),
  });
  renderRoute(<Nova />, { bridge, route: "/cache", path: "/cache" });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Talk to Nova/ }));
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Start Nova" }));
  await waitFor(() => expect(dc.onmessage).toBeTypeOf("function"));
  await user.click(screen.getByRole("button", { name: "Show conversation panel" }));
  const emit = (event: object) =>
    dc.onmessage!({ data: JSON.stringify(event) });
  act(() => {
    emit({ type: "session.started" });
    emit({ type: "session.input_transcript.delta", delta: "Hello Nova.", start_ms: 0, end_ms: 200 });
    emit({ type: "session.output_transcript.delta", delta: "Hi!", start_ms: 100, end_ms: 300 });
    emit({ type: "session.input_transcript.delta", delta: " Who are you?", start_ms: 400, end_ms: 700 });
    emit({ type: "session.output_transcript.delta", delta: " I'm Nova.", start_ms: 800, end_ms: 1000 });
    emit({ type: "session.input_transcript.delta", delta: "Do you see" });
    emit({ type: "session.input_transcript.delta", delta: " any devices?" });
    emit({
      type: "session.delegation.created",
      delegation: { id: "task-1", target: "client" },
    });
    emit({ type: "session.output_transcript.delta", delta: "Let me check." });
  });
  expect(screen.getByText("Hello Nova. Who are you?")).toBeVisible();
  expect(screen.getByText("Hi! I'm Nova.")).toBeVisible();
  expect(screen.getByLabelText("Conversation")).toHaveTextContent(
    "YouDo you see any devices?NovaLet me check.",
  );
  await waitFor(() =>
    expect(bridge.nova).toHaveBeenCalledWith(expect.objectContaining({
      action: "answer",
      sessionId: "voice-session",
      text: "Do you see any devices?",
    }), expect.any(Function)),
  );
  const firstActivity = vi.mocked(bridge.nova).mock.calls.find(([request]) => request.action === "answer")![1]!;
  act(() => firstActivity({ kind: "cache", status: "running", message: "Reading cached device inventory" }));
  expect(screen.getByLabelText("Conversation")).toHaveTextContent("Reading cached device inventory");
  expect(screen.getByRole("button", { name: "Stop Nova" })).toHaveAttribute(
    "data-phase",
    "thinking",
  );
  await user.click(screen.getByRole("button", { name: "Full screen" }));
  expect(screen.getByRole("dialog")).toHaveAttribute("data-active", "true");
  expect(screen.getByLabelText("Conversation")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Hide conversation panel" }));
  expect(screen.queryByLabelText("Conversation")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Show conversation panel" }));
  await user.click(screen.getByRole("button", { name: "Exit full screen" }));
  expect(track.stop).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Stop Nova" })).toHaveAttribute(
    "data-phase",
    "thinking",
  );
  const oldFinish = finish;
  act(() => {
    emit({ type: "session.input_transcript.delta", delta: "Can you tell me a joke while we wait" });
    emit({ type: "session.delegation.created", delegation: { id: "small-talk", target: "client" } });
    emit({ type: "session.output_transcript.delta", delta: "Sure. Here is a joke." });
  });
  await waitFor(() => expect(dc.send.mock.calls.some(([event]) => String(event).includes("did not replace it"))).toBe(true));
  expect(vi.mocked(bridge.nova).mock.calls.filter(([request]) => request.action === "answer")).toHaveLength(1);

  act(() => {
    emit({
      type: "session.input_transcript.delta",
      delta: "How many Intune devices?",
    });
    emit({
      type: "session.delegation.created",
      delegation: { id: "task-2", target: "client" },
    });
  });
  await waitFor(() =>
    expect(bridge.nova).toHaveBeenCalledWith(expect.objectContaining({
      action: "answer",
      sessionId: "voice-session",
      text: "How many Intune devices?",
    }), expect.any(Function)),
  );
  expect(screen.getByLabelText("Conversation")).toHaveTextContent("Question replaced");
  act(() => firstActivity({ kind: "cache", status: "completed", message: "Old activity must stay hidden" }));
  expect(screen.getByLabelText("Conversation")).not.toHaveTextContent("Old activity must stay hidden");
  await act(async () => {
    oldFinish({ text: "Outdated result" });
    finish({ text: "The tenant has 9 Intune devices." });
  });
  expect(
    dc.send.mock.calls.some(([event]) =>
      String(event).includes("Outdated result"),
    ),
  ).toBe(false);
  expect(dc.send).toHaveBeenCalledWith(
    JSON.stringify({
      type: "session.commentary.append",
      delegation_id: "task-2",
      content: "The tenant has 9 Intune devices.",
    }),
  );
  act(() =>
    emit({
      type: "session.output_transcript.delta",
      delta: "Yes, nine Intune devices.",
    }),
  );
  expect(screen.getByLabelText("Conversation")).toHaveTextContent(
    "NovaYes, nine Intune devices.",
  );
  act(() => {
    emit({ type: "session.input_transcript.delta", delta: "Research macOS" });
    emit({ type: "session.delegation.created", delegation: { id: "task-3", target: "client" } });
  });
  await waitFor(() => expect(bridge.nova).toHaveBeenCalledWith(expect.objectContaining({ text: "Research macOS" }), expect.any(Function)));
  await act(async () => finish({ text: "Search failed. You can ask another question.", answerError: "Search failed. Retry later." }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Search failed. Retry later.");
  expect(track.stop).not.toHaveBeenCalled();
  expect(dc.close).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Stop Nova" })).toHaveAttribute("data-phase", "error");
  expect(dc.send).toHaveBeenCalledWith(JSON.stringify({ type: "session.commentary.append", delegation_id: "task-3", content: "Search failed. You can ask another question." }));
  act(() => {
    emit({ type: "session.input_transcript.delta", delta: "How many devices?" });
    emit({ type: "session.delegation.created", delegation: { id: "task-4", target: "client" } });
  });
  await waitFor(() => expect(bridge.nova).toHaveBeenCalledWith(expect.objectContaining({ text: "How many devices?" }), expect.any(Function)));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await act(async () => finish({ text: "9 devices." }));
  expect(dc.send).toHaveBeenCalledWith(JSON.stringify({ type: "session.commentary.append", delegation_id: "task-4", content: "9 devices." }));
  act(() => {
    emit({ type: "session.input_transcript.delta", delta: "Stop" });
  });
  await waitFor(() => expect(bridge.nova).toHaveBeenCalledWith({ action: "interrupt", sessionId: "voice-session" }));
  expect(track.stop).not.toHaveBeenCalled();
  expect(dc.close).not.toHaveBeenCalled();
  expect(dc.send.mock.calls.some(([event]) => String(event).includes("session.instructions.append"))).toBe(true);
  act(() => {
    emit({ type: "session.input_transcript.delta", delta: "Send this to my WhatsApp" });
    emit({ type: "session.delegation.created", delegation: { id: "send-1", target: "client" } });
  });
  await waitFor(() => expect(bridge.nova).toHaveBeenCalledWith(expect.objectContaining({ text: "Send this to my WhatsApp" }), expect.any(Function)));
  await act(async () => finish({ text: "Review the message.", pendingAction: { id: "action-1", kind: "send", title: "Send via WhatsApp", target: "My WhatsApp", body: "Verified nine-device report." } }));
  expect(screen.getByRole("region", { name: "Review Nova action" })).toHaveTextContent("Verified nine-device report.");
  expect(bridge.nova).not.toHaveBeenCalledWith(expect.objectContaining({ action: "decide-action" }), expect.any(Function));
  await user.click(screen.getByRole("button", { name: "Confirm send" }));
  await waitFor(() => expect(bridge.nova).toHaveBeenCalledWith({ action: "decide-action", sessionId: "voice-session", actionId: "action-1", approved: true }, expect.any(Function)));
  await user.click(screen.getByRole("button", { name: "Stop answer" }));
  await act(async () => finishAction({ text: "Late delivery message" }));
  expect(dc.send.mock.calls.some(([event]) => String(event).includes("Late delivery message"))).toBe(false);
  expect(screen.queryByText("Late delivery message")).not.toBeInTheDocument();
  const beforeFallback = vi.mocked(bridge.nova).mock.calls.filter(([request]) => request.action === "answer").length;
  act(() => {
    emit({ type: "session.input_transcript.delta", delta: "Can you send me an email with the list of non-compliant devices" });
    emit({ type: "session.output_transcript.delta", delta: "I cannot send emails." });
  });
  await waitFor(() => expect(bridge.nova).toHaveBeenCalledWith(expect.objectContaining({ text: "Can you send me an email with the list of non-compliant devices" }), expect.any(Function)), { timeout: 2000 });
  await act(async () => finish({ text: "Review the email.", pendingAction: { id: "email-1", kind: "send", title: "Send via Outlook", target: "admin@example.test", body: "Verified device list.", deliveryNote: "This report will be sent as 2 numbered messages." } }));
  expect(screen.getByRole("region", { name: "Review Nova action" })).toHaveTextContent("admin@example.test");
  expect(screen.getByRole("region", { name: "Review Nova action" })).toHaveTextContent("2 numbered messages");
  expect(dc.send).toHaveBeenCalledWith(JSON.stringify({ type: "session.commentary.append", delegation_id: null, content: "Review the email." }));
  act(() => emit({ type: "session.delegation.created", delegation: { id: "late-email", target: "client" } }));
  await new Promise(resolve => setTimeout(resolve, 350));
  expect(vi.mocked(bridge.nova).mock.calls.filter(([request]) => request.action === "answer")).toHaveLength(beforeFallback + 1);
  act(() => emit({ type: "session.input_transcript.delta", delta: "How are you doing?" }));
  await new Promise(resolve => setTimeout(resolve, 1100));
  expect(vi.mocked(bridge.nova).mock.calls.filter(([request]) => request.action === "answer")).toHaveLength(beforeFallback + 1);
  for (const text of ["Pop those findings into my inbox", "Actually use Teams instead", "Outlook", "Could you bring up settings"]) {
    act(() => emit({ type: "session.input_transcript.delta", delta: text }));
    await waitFor(() => expect(bridge.nova).toHaveBeenCalledWith(expect.objectContaining({ action: "answer", text }), expect.any(Function)), { timeout: 2000 });
    await act(async () => finish({ text: "Request understood. Review in the app." }));
  }
  act(() => emit({ type: "session.input_transcript.delta", delta: "Send this via Slack" }));
  await user.click(screen.getByRole("button", { name: "Stop" }));
  await new Promise(resolve => setTimeout(resolve, 1100));
  expect(vi.mocked(bridge.nova).mock.calls.filter(([request]) => request.action === "answer")).toHaveLength(beforeFallback + 5);
  expect(track.stop).toHaveBeenCalled();
}, 15000);

it("explains microphone permission recovery without starting a hosted session", async () => {
  Object.defineProperty(navigator, "mediaDevices", {
    value: {
      getUserMedia: vi.fn(async () => {
        throw new DOMException("Denied", "NotAllowedError");
      }),
    },
    configurable: true,
  });
  const bridge = makeMockBridge({
    nova: vi.fn(async () => ({ hasKey: true })),
  });
  renderRoute(<Nova />, { bridge, route: "/cache", path: "/cache" });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Talk to Nova/ }));
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Start Nova" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "system microphone privacy settings",
  );
  expect(bridge.nova).not.toHaveBeenCalledWith(
    expect.objectContaining({ action: "start" }),
  );
  expect(screen.getByRole("checkbox")).not.toBeChecked();
});

it("does not let a delayed key-status result undo a successful key save", async () => {
  let status!: (value: { hasKey: boolean }) => void;
  const bridge = makeMockBridge({
    nova: vi.fn(async (input) => {
      if (input.action === "status")
        return new Promise<{ hasKey: boolean }>((resolve) => {
          status = resolve;
        });
      if (input.action === "configure") return { hasKey: true };
      return {};
    }),
  });
  renderRoute(<Nova />, { bridge, route: "/cache", path: "/cache" });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Talk to Nova/ }));
  await user.type(screen.getByLabelText("OpenAI API key"), "test-only-key");
  await user.click(screen.getByRole("button", { name: "Save key" }));
  await act(async () => {
    status({ hasKey: false });
  });
  await user.click(screen.getByRole("button", { name: "Voice settings" }));
  expect(screen.getByLabelText(/OpenAI API key.*saved securely/)).toHaveValue(
    "",
  );
  expect(screen.getByRole("button", { name: "Remove key" })).toBeVisible();
});
