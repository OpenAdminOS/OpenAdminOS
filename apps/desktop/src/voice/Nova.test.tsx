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
  await user.click(screen.getByRole("button", { name: "Expand view" }));
  expect(
    screen.getByRole("region", { name: "Nova voice assistant" }),
  ).toHaveClass("nova-panel-expanded");
  await user.click(screen.getByRole("button", { name: "Captions on" }));
  expect(
    screen.queryByLabelText("Conversation captions"),
  ).not.toBeInTheDocument();
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
  let finish!: (value: { text: string }) => void;
  const bridge = makeMockBridge({
    nova: vi.fn(async (input) => {
      if (input.action === "status") return { hasKey: true };
      if (input.action === "start")
        return { sessionId: "voice-session", sdp: "v=0" };
      if (input.action === "answer")
        return new Promise<{ text: string }>((resolve) => {
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
  const emit = (event: object) =>
    dc.onmessage!({ data: JSON.stringify(event) });
  act(() => {
    emit({ type: "session.started" });
    emit({ type: "session.input_transcript.delta", delta: "Do you see" });
    emit({ type: "session.input_transcript.delta", delta: " any devices?" });
    emit({
      type: "session.delegation.created",
      delegation: { id: "task-1", target: "client" },
    });
    emit({ type: "session.output_transcript.delta", delta: "Let me check." });
  });
  expect(screen.getByLabelText("Conversation captions")).toHaveTextContent(
    "User: Do you see any devices? Nova: Let me check.",
  );
  await waitFor(() =>
    expect(bridge.nova).toHaveBeenCalledWith({
      action: "answer",
      sessionId: "voice-session",
      text: "Do you see any devices?",
    }),
  );
  expect(screen.getByRole("button", { name: "Stop Nova" })).toHaveAttribute(
    "data-phase",
    "thinking",
  );
  await act(async () => {
    finish({ text: "The tenant has 9 Intune devices." });
  });
  expect(dc.send).toHaveBeenCalledWith(
    JSON.stringify({
      type: "session.commentary.append",
      delegation_id: "task-1",
      content: "The tenant has 9 Intune devices.",
    }),
  );
  act(() =>
    emit({
      type: "session.output_transcript.delta",
      delta: "Yes, nine Intune devices.",
    }),
  );
  expect(screen.getByLabelText("Conversation captions")).toHaveTextContent(
    "Backend: The tenant has 9 Intune devices. Nova: Yes, nine Intune devices.",
  );
  await user.click(screen.getByRole("button", { name: "Stop" }));
});
