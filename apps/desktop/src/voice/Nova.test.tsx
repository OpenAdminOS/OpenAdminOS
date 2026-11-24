import { useLocation } from "react-router";
import { NOVA_DOCUMENTATION_SETTINGS } from "../shared/nova-session";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { Nova } from "./Nova";
import { createMockAppState, makeMockBridge, mockProviders, renderRoute, renderWithAppState } from "../test/test-utils";
import { openNovaPanel, openNovaShortcut } from "../shared/nova-panel";

async function openNovaForTest() {
  act(openNovaPanel);
  await screen.findByText(/Contoso IT/);
}

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
  await openNovaForTest();
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
  await openNovaForTest();
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
  await openNovaForTest();
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
  await openNovaForTest();
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
  expect(dc.send.mock.calls.map(([raw]) => JSON.parse(raw).content).join(' ')).not.toContain('Reading cached device inventory');
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
  // Repeat the actual help question with different transcript/delegation arrival orders.
  // None may enter the backend or replace the already running inventory question.
  vi.useFakeTimers({toFake:["setTimeout", "clearTimeout", "Date"]});
  try {
    for (const delay of [25, 75, 125]) {
      for (const order of ["early", "fallback", "late", "answered"]) {
        const chunksBefore = dc.send.mock.calls.filter(([event]) => String(event).includes("I'm Nova, the voice assistant")).length;
        await act(async () => {
          const parts = order === "early" ? ["What can", " you do and", " what can you", " help me with"] : ["What can you do and what can you help me with"];
          emit({type:"session.input_transcript.delta",delta:parts[0]});
          if (order === "early") emit({type:"session.delegation.created",delegation:{id:`intro-${delay}-${order}`,target:"client"}});
          for (const part of parts.slice(1)) {await vi.advanceTimersByTimeAsync(delay);emit({type:"session.input_transcript.delta",delta:part});}
          emit({type:"session.output_transcript.delta",delta:order === "answered" ? "I'm Nova. I can help you explore your tenant and prepare reports." : "Sure, I'm checking that."});
          await vi.advanceTimersByTimeAsync(1100);
          if (order === "late") {emit({type:"session.delegation.created",delegation:{id:`intro-${delay}-${order}`,target:"client"}});await vi.advanceTimersByTimeAsync(400);}
        });
        expect(vi.mocked(bridge.nova).mock.calls.filter(([request]) => request.action === "answer")).toHaveLength(1);
        const chunksAfter=dc.send.mock.calls.filter(([event]) => String(event).includes("I'm Nova, the voice assistant")).length;
        expect(chunksAfter-chunksBefore).toBe(order === "answered" ? 0 : 1);
      }
    }
  } finally {vi.useRealTimers();}
  const oldFinish = finish;
  act(() => {
    emit({ type: "session.input_transcript.delta", delta: "Can you tell me a joke while we wait" });
    emit({ type: "session.delegation.created", delegation: { id: "small-talk", target: "client" } });
    emit({ type: "session.output_transcript.delta", delta: "Sure. Here is a joke." });
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
  expect(dc.send.mock.calls.some(([event]) => String(event).includes('session.thinking.append'))).toBe(false);
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
  // Hosted action text is spoken once, and only its audio transcript becomes a chat bubble.
  await user.click(screen.getByRole("button", { name: "Confirm send" }));
  await act(async () => finishAction({ text: "Outlook accepted the email for sending." }));
  expect(screen.queryByText("Outlook accepted the email for sending.")).not.toBeInTheDocument();
  act(() => emit({type:"session.output_transcript.delta",delta:"Outlook accepted the email for sending."}));
  expect(screen.getAllByText(/Outlook accepted the email for sending/)).toHaveLength(1);
  act(() => emit({ type: "session.delegation.created", delegation: { id: "late-email", target: "client" } }));
  await new Promise(resolve => setTimeout(resolve, 350));
  expect(vi.mocked(bridge.nova).mock.calls.filter(([request]) => request.action === "answer")).toHaveLength(beforeFallback + 1);
  act(() => emit({ type: "session.input_transcript.delta", delta: "How are you doing?" }));
  await new Promise(resolve => setTimeout(resolve, 1100));
  expect(vi.mocked(bridge.nova).mock.calls.filter(([request]) => request.action === "answer")).toHaveLength(beforeFallback + 1);
  const waitingUpdates = dc.send.mock.calls.filter(([event]) => String(event).includes("Do not say you are still checking")).length;
  act(() => emit({type:"session.input_transcript.delta",delta:"Are you still working?"}));
  await waitFor(() => expect(dc.send.mock.calls.filter(([event]) => String(event).includes("Do not say you are still checking")).length).toBe(waitingUpdates + 1), {timeout:2000});
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
}, 20000);

it('preserves paused qualifiers and stage greetings through microphone activity and early delegation', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  let micSample = 128;
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); // no visual frames are delivered
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const track = { stop: vi.fn(), addEventListener: vi.fn() };
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: vi.fn(async () => ({ getTracks: () => [track], getAudioTracks: () => [track] })),
  }});
  vi.stubGlobal('AudioContext', class {
    resume = async () => {}; close = async () => {};
    createAnalyser = () => ({ fftSize: 512, getByteTimeDomainData: (v: Uint8Array) => v.fill(micSample) });
    createMediaStreamSource = () => ({ connect: vi.fn() });
  });
  const dc = { readyState: 'open', send: vi.fn(), close: vi.fn(), addEventListener: vi.fn(),
    onmessage: undefined as undefined | ((event: {data: string}) => void) };
  vi.stubGlobal('RTCPeerConnection', class {
    iceGatheringState = 'complete'; localDescription = { sdp: 'v=0' };
    addTrack = vi.fn(); createDataChannel = () => dc;
    createOffer = async () => ({ sdp: 'v=0' }); setLocalDescription = async () => {};
    setRemoteDescription = async () => {}; close = vi.fn();
  });
  const bridge = makeMockBridge({ nova: vi.fn(async (input, onActivity) => {
    if (input.action === 'status') return { hasKey: true };
    if (input.action === 'start') return { sessionId: 'audio-regression', sdp: 'v=0' };
    if (input.action === 'answer') {
      onActivity?.({kind:'action',status:'running',message:'Understanding your request.'});
      return { text: 'Three Windows devices report not encrypted.' };
    }
    return {};
  }) });
  renderRoute(<Nova />, { bridge, route: '/cache', path: '/cache' });
  const user = userEvent.setup();
  await openNovaForTest();
  await user.click(screen.getByRole('checkbox'));
  const emit = (event: object) => dc.onmessage!({data: JSON.stringify(event)});
  const input = (delta: string, start_ms: number, end_ms: number) => emit({type:'session.input_transcript.delta', delta, start_ms, end_ms});
  const answers = () => vi.mocked(bridge.nova).mock.calls.flatMap(([r]) => r.action === 'answer' ? [r.text] : []);
  vi.useFakeTimers({toFake:['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
  try {
    await act(async () => { screen.getByRole('button', {name:'Start Nova'}).click(); });
    expect(dc.onmessage).toBeTypeOf('function');
    await act(async () => {
      emit({type:'session.started'});
      input('Which Windows devices are', 0, 900);
      emit({type:'session.delegation.created',offset_ms:900,delegation:{id:'prefix'}});
      await vi.advanceTimersByTimeAsync(1400);
    });
    expect(answers()).toEqual([]);
    await act(async () => {
      emit({type:'session.output_transcript.delta',delta:'Checking tenant',start_ms:1000,end_ms:1400});
      input(' not encrypted', 2300, 2800);
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(answers()).toEqual(['Which Windows devices are not encrypted']);
    expect(dc.send).toHaveBeenCalledWith(JSON.stringify({type:'session.commentary.append',delegation_id:'prefix',content:'Three Windows devices report not encrypted.'}));

    await act(async () => {
      micSample = 145;
      await vi.advanceTimersByTimeAsync(50); // activity sampling works without animation frames
      input('Which devices are not encrypted', 5000, 5900);
      emit({type:'session.delegation.created',offset_ms:5900,delegation:{id:'platform'}});
      micSample = 128;
      await vi.advanceTimersByTimeAsync(800);
      micSample = 145; // qualifier starts before the transcript reaches us
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(answers()).toHaveLength(1);
    await act(async () => {
      input(' on Windows', 6700, 7100);
      micSample = 128;
      await vi.advanceTimersByTimeAsync(1100);
      emit({type:'session.delegation.created',offset_ms:5900,delegation:{id:'late-platform'}});
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(answers()).toEqual(['Which Windows devices are not encrypted', 'Which devices are not encrypted on Windows']);

    await act(async () => {
      input('So- Okay, so we are right now on the stage in front of an audience', 9000, 11000);
      emit({type:'session.delegation.created',offset_ms:11000,delegation:{id:'audience'}});
      emit({type:'session.output_transcript.delta',delta:'Mm-hmm.',start_ms:11050,end_ms:11200});
      await vi.advanceTimersByTimeAsync(500);
      input('. And I want you to say hello to them', 11300, 12000);
      emit({type:'session.output_transcript.delta',delta:'Okay.',start_ms:12100,end_ms:12300});
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(answers()).toHaveLength(2);
    expect(dc.send.mock.calls.some(([raw]) => JSON.parse(raw).type === 'session.commentary.append' && JSON.parse(raw).content.startsWith('Hello everyone'))).toBe(true);

    await act(async () => {
      input('Alright, so you are now in front of an audience, can you say hi', 12310, 12350);
      emit({type:'session.output_transcript.delta',delta:'Hi everyone!',start_ms:12360,end_ms:12380});
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(answers()).toHaveLength(2);
    const sent = dc.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(sent.some(event => event.type === 'session.thinking.append')).toBe(false);
    expect(sent.map(event => event.content).join(' ')).not.toMatch(/Understanding your request|Result retrieved|Current app page|No action is approved/);


    const greetingCount = () => dc.send.mock.calls.filter(([raw]) => JSON.parse(raw).type === 'session.commentary.append' && JSON.parse(raw).content.startsWith('Hello everyone')).length;
    const greetingsBefore = greetingCount();
    await act(async () => {
      input('And I want you to say hello', 12400, 12600);
      emit({type:'session.delegation.created',offset_ms:12600,delegation:{id:'interleaved-greeting'}});
      emit({type:'session.output_transcript.delta',delta:'Of course. Hi, folks!',start_ms:12700,end_ms:12900});
      await vi.advanceTimersByTimeAsync(400);
      input(' to them', 13000, 13200);
      emit({type:'session.output_transcript.delta',delta:" I'm Nova, the voice assistant in OpenAdminOS.",start_ms:13200,end_ms:13250});
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(answers()).toHaveLength(2);
    expect(greetingCount()).toBe(greetingsBefore);

    await act(async () => {
      input('Which Windows devices are not encrypted?', 13300, 13500);
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(answers()).toEqual(['Which Windows devices are not encrypted', 'Which devices are not encrypted on Windows', 'Which Windows devices are not encrypted?']);

    await act(async () => {
      input('Stop', 14000, 14500);
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(bridge.nova).toHaveBeenCalledWith({action:'interrupt',sessionId:'audio-regression'});
    await act(async () => {
      input('Which devices are', 15000, 16000);
      emit({type:'session.delegation.created',offset_ms:900,delegation:{id:'stale'}});
      await vi.advanceTimersByTimeAsync(1400);
    });
    expect(answers()).toHaveLength(3);
    act(() => screen.getByRole('button', {name:'Stop'}).click());
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(answers()).toHaveLength(3);
    expect(track.stop).toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

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
  await openNovaForTest();
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
  await openNovaForTest();
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

it.each(["nova-bubble-hidden", "nova-bubble-toggle"])("keeps the live panel until consent and releases a delayed microphone on %s", async (stopReason) => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const stopTrack = vi.fn();
  let grant!: (stream: MediaStream) => void;
  const getUserMedia = vi.fn(() => new Promise<MediaStream>(resolve => { grant = resolve; }));
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  let liveSurface: "panel" | "bubble" = "panel";
  const bridge = makeMockBridge({
    nova: vi.fn(async () => ({ hasKey: true })),
    novaWindow: vi.fn(async (action) => {
      if (action === "claim") liveSurface = "bubble";
      return undefined;
    }),
  }, createMockAppState({
    tenants: [], organizations: [], activeTenantId: undefined,
  }));
  renderRoute(<Nova bubble />, { bridge, route: "/cache", path: "/cache" });
  const user = userEvent.setup();
  const checkbox = await screen.findByRole("checkbox", { name: /Allow hosted processing/ });
  expect(checkbox).toHaveAccessibleDescription(/No organization data is shared/);
  expect(screen.getByText("No organization")).toBeVisible();
  expect(screen.getByRole("button", { name: "Talk" })).toHaveFocus();
  const listeners = vi.mocked(bridge.onAppStateChanged!).mock.calls.map(([listener]) => listener);
  act(() => listeners.forEach(listener => listener({ reason: "nova-bubble-toggle" })));
  expect(await screen.findByRole("alert")).toHaveTextContent("Confirm hosted sharing");
  expect(checkbox).toHaveFocus();
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(bridge.novaWindow).not.toHaveBeenCalledWith("claim");
  expect(liveSurface).toBe("panel");
  await user.click(checkbox);
  await user.click(screen.getByRole("button", { name: "Talk" }));
  expect(screen.getByRole("button", { name: "Stop" })).toBeVisible();
  await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
  expect(vi.mocked(bridge.novaWindow).mock.invocationCallOrder.at(-1)!).toBeLessThan(getUserMedia.mock.invocationCallOrder[0]!);
  expect(liveSurface).toBe("bubble");
  act(() => listeners.forEach(listener => listener({ reason: stopReason })));
  expect(screen.getByRole("button", { name: "Talk" })).toBeVisible();
  grant({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);
  await waitFor(() => expect(stopTrack).toHaveBeenCalledOnce());
  expect(bridge.nova).not.toHaveBeenCalledWith(expect.objectContaining({ action: "start" }));
});

it("starts hosted voice without an organization and opens the documentation install block", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const track = { stop: vi.fn(), addEventListener: vi.fn() };
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track], getAudioTracks: () => [track] })) },
    configurable: true,
  });
  vi.stubGlobal("AudioContext", class {
    resume = async () => {};
    close = async () => {};
    createAnalyser = () => ({ getByteTimeDomainData: (values: Uint8Array) => values.fill(128) });
    createMediaStreamSource = () => ({ connect: vi.fn() });
  });
  const dc = {
    readyState: "open",
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    onmessage: undefined as undefined | ((event: { data: string }) => void),
  };
  vi.stubGlobal("RTCPeerConnection", class {
    iceGatheringState = "complete";
    localDescription = { sdp: "v=0" };
    addTrack = vi.fn();
    createDataChannel = () => dc;
    createOffer = async () => ({ sdp: "v=0" });
    setLocalDescription = async () => {};
    setRemoteDescription = async () => {};
    close = vi.fn();
  });
  const getGraphCacheStatus = vi.fn();
  const bridge = makeMockBridge({
    nova: vi.fn(async input => {
      if (input.action === "status") return { hasKey: true };
      if (input.action === "start") return { sessionId: "public", sdp: "v=0" };
      if (input.action === "answer") return {
        text: "No documentation was consulted.",
        links: [{ label: "Install the documentation index", route: NOVA_DOCUMENTATION_SETTINGS }],
      };
      return {};
    }),
    getGraphCacheStatus,
  }, createMockAppState({
    tenants: [], organizations: [], activeTenantId: undefined, activeProviderId: "openai",
    providers: mockProviders.map(provider => provider.id === "openai" ? { ...provider, status: "connected" } : provider),
  }));
  function CurrentRoute() {
    const { pathname, search } = useLocation();
    return <output>{pathname + search}</output>;
  }
  renderWithAppState(<><Nova /><CurrentRoute /></>, { bridge, route: "/chat" });
  act(() => openNovaShortcut("Autopatch"));
  const user = userEvent.setup();
  expect(await screen.findByText(/No organization ·/)).toBeVisible();
  const consent = await screen.findByRole("checkbox", { name: /No organization data is shared/ });
  expect(consent).toHaveAccessibleName(/Audio and Nova’s instructions go to OpenAI.*documentation passages go to Codex/);
  await user.click(consent);
  await user.click(screen.getByRole("button", { name: "Start Nova" }));
  await waitFor(() => expect(bridge.nova).toHaveBeenCalledWith(expect.objectContaining({ action: "start", tenantId: undefined })));
  act(() => dc.onmessage!({ data: JSON.stringify({ type: "session.started" }) }));
  const link = await screen.findByRole("button", { name: "Install the documentation index" });
  expect(screen.getByText("The local documentation index is missing.")).toBeVisible();
  await user.click(link);
  expect(screen.getByText(NOVA_DOCUMENTATION_SETTINGS)).toBeVisible();
  expect(getGraphCacheStatus).not.toHaveBeenCalled();
});

it("offers macOS microphone privacy settings when the floating window is denied access", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const getUserMedia = vi.fn(async () => { throw new DOMException("Denied", "NotAllowedError"); });
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  const bridge = makeMockBridge({ platform: "macos", nova: vi.fn(async () => ({ hasKey: true })) });
  renderRoute(<Nova bubble />, { bridge, route: "/cache", path: "/cache" });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Talk" }));
  expect(await screen.findByText("Microphone denied")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Open Microphone Settings" }));
  expect(bridge.novaWindow).toHaveBeenCalledWith("microphone-settings");
});

it("claims typed Nova without opening the microphone", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const getUserMedia = vi.fn();
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  const makeEmptyStream = vi.fn();
  vi.stubGlobal("MediaStream", class {
    constructor() { makeEmptyStream(); }
    getTracks = () => [];
  });
  // Stop the fixture after the typed stream is built.
  vi.stubGlobal("AudioContext", class { constructor() { throw new Error("Fixture audio context"); } });
  const bridge = makeMockBridge({ nova: vi.fn(async () => ({ hasKey: true })) });
  renderRoute(<Nova bubble />, { bridge, route: "/cache", path: "/cache" });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("checkbox"));
  await user.type(screen.getByRole("textbox", { name: "Ask Nova" }), "What is Autopilot?");
  await user.click(screen.getByRole("button", { name: "Ask" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Fixture audio context");
  expect(bridge.novaWindow).toHaveBeenCalledWith("claim-typed");
  expect(makeEmptyStream).toHaveBeenCalledOnce();
  expect(getUserMedia).not.toHaveBeenCalled();
});

it("releases the bubble microphone when the organization changes", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const track = { stop: vi.fn(), addEventListener: vi.fn() };
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }));
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  vi.stubGlobal("AudioContext", class {
    resume = async () => {};
    close = async () => {};
    createAnalyser = () => ({ getByteTimeDomainData: (values: Uint8Array) => values.fill(128) });
    createMediaStreamSource = () => ({ connect: vi.fn() });
  });
  const dc = {
    readyState: "open", send: vi.fn(), close: vi.fn(), addEventListener: vi.fn(),
    onmessage: undefined as undefined | ((event: { data: string }) => void),
  };
  vi.stubGlobal("RTCPeerConnection", class {
    iceGatheringState = "complete";
    localDescription = { sdp: "v=0" };
    addTrack = vi.fn();
    createDataChannel = () => dc;
    createOffer = async () => ({ sdp: "v=0" });
    setLocalDescription = async () => {};
    setRemoteDescription = async () => {};
    close = vi.fn();
  });
  const bridge = makeMockBridge({
    nova: vi.fn(async (input) => input.action === "status" ? { hasKey: true } :
      input.action === "start" ? { sessionId: "bubble", sdp: "v=0" } : {}),
  });
  renderRoute(<Nova bubble />, { bridge, route: "/cache", path: "/cache" });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Talk" }));
  await waitFor(() => expect(bridge.nova).toHaveBeenCalledWith(expect.objectContaining({ action: "start" })));
  act(() => dc.onmessage!({ data: JSON.stringify({ type: "session.started" }) }));
  expect(await screen.findByText("Listening")).toBeVisible();
  vi.mocked(bridge.getAppState).mockResolvedValue(createMockAppState({
    activeTenantId: undefined, activeOrganizationId: undefined, tenants: [], organizations: [],
  }));
  act(() => vi.mocked(bridge.onAppStateChanged!).mock.calls.forEach(([listener]) => listener({ reason: "nova-context-changed" })));
  expect(await screen.findByText("No organization")).toBeVisible();
  expect(track.stop).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Talk" })).toBeVisible();
});

it("keeps a typed fallback local when the selected voice provider is hosted", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const onHostedChange = vi.fn();
  const bridge = makeMockBridge({
    nova: vi.fn(async request => {
      if (request.action === "start") return { sessionId: "typed-local" };
      if (request.action === "answer") return { text: "The sample device is ready." };
      if (request.action === "speak") throw new Error("Set up local voice to use Kokoro.");
      return {};
    }),
  });
  renderRoute(<Nova onHostedChange={onHostedChange} />, { bridge, route: "/cache", path: "/cache" });
  const user = userEvent.setup();
  await openNovaForTest();
  const question = screen.getByLabelText("Type a question");
  await user.type(question, "What needs attention?");
  await user.click(screen.getByRole("button", { name: "Ask Nova" }));
  expect((await screen.findAllByText("The sample device is ready."))[0]).toBeVisible();
  expect(bridge.nova).toHaveBeenCalledWith(expect.objectContaining({ action: "start", mode: "local" }));
  expect(onHostedChange).not.toHaveBeenCalledWith(true);
});

it("plays a local speech chunk before synthesis finishes and ignores chunks after Stop", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.stubGlobal("URL", { revokeObjectURL: vi.fn(), createObjectURL: vi.fn(() => "blob:sample") });
  let receiveAudio: ((audio: Uint8Array) => void) | undefined;
  let resolveSpeech: (() => void) | undefined;
  const bridge = makeMockBridge({
    nova: vi.fn(async (request, _activity, onAudio) => {
      if (request.action === "start") return { sessionId: "local-stream" };
      if (request.action === "answer") return { text: "The sample device is ready." };
      if (request.action === "speak") {
        receiveAudio = onAudio;
        await new Promise<void>(resolve => { resolveSpeech = resolve; });
      }
      return {};
    }),
  });
  renderRoute(<Nova />, { bridge, route: "/cache", path: "/cache" });
  const user = userEvent.setup();
  await openNovaForTest();
  await user.type(screen.getByLabelText("Type a question"), "What needs attention?");
  await user.click(screen.getByRole("button", { name: "Ask Nova" }));
  await waitFor(() => expect(receiveAudio).toBeDefined());
  act(() => receiveAudio?.(new Uint8Array([1, 2, 3])));
  expect(play).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Stop" }));
  act(() => {
    receiveAudio?.(new Uint8Array([4, 5, 6]));
    resolveSpeech?.();
  });
  expect(play).toHaveBeenCalledTimes(1);
  expect(bridge.nova).toHaveBeenCalledWith({ action: "stop" });
});

it("waits for system voices, selects German locally and reports an utterance error", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const voices = new EventTarget();
  const getVoices = vi.fn((): Array<{ localService: boolean; lang: string }> => []);
  const speak = vi.fn<(utterance: SpeechSynthesisUtterance) => void>();
  vi.stubGlobal("speechSynthesis", Object.assign(voices, { getVoices, speak, cancel: vi.fn() }));
  vi.stubGlobal("SpeechSynthesisUtterance", class { constructor(readonly text: string) {} });
  const bridge = makeMockBridge({
    nova: vi.fn(async request => {
      if (request.action === "start") return { sessionId: "typed-local" };
      if (request.action === "answer") return { text: "Zwei Geräte brauchen einen Neustart." };
      if (request.action === "speak") return { speechLanguage: "de" };
      return {};
    }),
  });
  renderRoute(<Nova />, { bridge, route: "/cache", path: "/cache" });
  const user = userEvent.setup();
  await openNovaForTest();
  await user.type(screen.getByLabelText("Type a question"), "Welche Geräte?");
  await user.click(screen.getByRole("button", { name: "Ask Nova" }));
  await waitFor(() => expect(getVoices).toHaveBeenCalled());
  expect(speak).not.toHaveBeenCalled();
  act(() => {
    getVoices.mockReturnValue([{ lang: "de-DE", localService: false }, { lang: "de-AT", localService: true }]);
    voices.dispatchEvent(new Event("voiceschanged"));
  });
  expect(await screen.findByText("Speaking with the system voice for German")).toBeVisible();
  const utterance = speak.mock.calls[0]![0];
  expect(utterance).toMatchObject({ lang: "de-AT", text: "Zwei Geräte brauchen einen Neustart." });
  act(() => utterance.onerror?.(new Event("error") as SpeechSynthesisErrorEvent));
  expect(await screen.findByText("Device voice could not play. Read Nova's answer in the conversation.")).toBeVisible();

});

it("plays queued audio before handing just the unsynthesized remainder to the system voice", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.stubGlobal("URL", { revokeObjectURL: vi.fn(), createObjectURL: vi.fn(() => "blob:sample") });
  const speak = vi.fn();
  vi.stubGlobal("speechSynthesis", { speak, cancel: vi.fn(), getVoices: () => [{ localService: true, lang: "en-US" }] });
  vi.stubGlobal("SpeechSynthesisUtterance", class { constructor(readonly text: string) {} });
  const bridge = makeMockBridge({
    nova: vi.fn(async (request, _activity, onAudio) => {
      if (request.action === "start") return { sessionId: "typed-local" };
      if (request.action === "answer") return { text: "Intune is ready. Try another check." };
      if (request.action === "speak") {
        onAudio?.(new Uint8Array([1, 2, 3]), "Try another check.");
        throw new Error("Built-in Kokoro could not speak.");
      }
      return {};
    }),
  });
  renderRoute(<Nova />, { bridge, route: "/cache", path: "/cache" });
  const user = userEvent.setup();
  await openNovaForTest();
  await user.type(screen.getByLabelText("Type a question"), "Check devices");
  await user.click(screen.getByRole("button", { name: "Ask Nova" }));
  expect(await screen.findByText("Built-in Kokoro could not speak.")).toBeVisible();
  expect(speak).not.toHaveBeenCalled();
  act(() => document.querySelector("audio")!.dispatchEvent(new Event("ended")));
  await waitFor(() => expect(speak).toHaveBeenCalledWith(expect.objectContaining({ text: "Try another check." })));
});

async function startHandsFreeFixture() {
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.stubGlobal("URL", { revokeObjectURL: vi.fn(), createObjectURL: vi.fn(() => "blob:nova-hands-free") });
  const track = { stop: vi.fn(), addEventListener: vi.fn() };
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }));
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  vi.stubGlobal("AudioContext", class {
    resume = async () => {};
    close = async () => {};
    audioWorklet = { addModule: vi.fn(async () => {}) };
    createAnalyser = () => ({ getByteTimeDomainData: (values: Uint8Array) => values.fill(128) });
    createMediaStreamSource = () => ({ connect: vi.fn() });
  });
  const port: { onmessage?: (event: { data: Float32Array }) => void } = {};
  vi.stubGlobal("AudioWorkletNode", class { port = port; });
  const bridge = makeMockBridge({
    nova: vi.fn(async (request, _activity, onAudio) => {
      if (request.action === "speech-status") return { speech: {
        source: "builtin", model: "small", selectedModel: "small", gpuAccelerated: false,
        available: true, ready: true, totalBytes: 0,
        preferences: { interaction: "hands-free", silenceMs: 800, idleSeconds: 120, showTimings: false },
      } as const };
      if (request.action === "vad") return { speechProbability: request.frame[0] ?? 0 };
      if (request.action === "start") return { sessionId: "hands-free" };
      if (request.action === "transcribe") return { text: "What can you do?" };
      if (request.action === "answer") return { text: "I can help." };
      if (request.action === "speak") {
        onAudio?.(new Uint8Array([1, 2, 3]));
        return {};
      }
      return {};
    }),
  });
  renderRoute(<Nova />, { bridge, route: "/cache", path: "/cache" });
  const user = userEvent.setup();
  await openNovaForTest();
  await user.selectOptions(screen.getByLabelText("Voice provider"), "local");
  await screen.findByText("Models are installed on this device.");
  return { bridge, track, getUserMedia, port, play, pause };
}

it("releases the hands-free microphone after two minutes without speech", async () => {
  const { track } = await startHandsFreeFixture();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await act(async () => screen.getByRole("button", { name: "Start Nova" }).click());
    expect(screen.getByText("Microphone live")).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(120000));
    expect(track.stop).toHaveBeenCalledOnce();
    expect(screen.queryByText("Microphone live")).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it("interrupts streamed playback and keeps the hands-free microphone open", async () => {
  const { bridge, track, port, play, pause, getUserMedia } = await startHandsFreeFixture();
  await act(async () => screen.getByRole("button", { name: "Start Nova" }).click());
  expect(getUserMedia).toHaveBeenCalledWith({ audio: {
    echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1,
  }, video: false });
  play.mockClear();
  const send = (score: number) => port.onmessage?.({ data: new Float32Array(512).fill(score) });
  await act(async () => {
    send(0.95);
    for (let index = 0; index < 25; index++) send(0);
  });
  await waitFor(() => expect(play).toHaveBeenCalledOnce());
  pause.mockClear();
  await act(async () => send(0.95));
  await waitFor(() => expect(pause).toHaveBeenCalledOnce());
  expect(bridge.nova).toHaveBeenCalledWith({ action: "interrupt", sessionId: "hands-free" });
  expect(track.stop).not.toHaveBeenCalled();
  expect(screen.getByText("Microphone live")).toBeVisible();
});
