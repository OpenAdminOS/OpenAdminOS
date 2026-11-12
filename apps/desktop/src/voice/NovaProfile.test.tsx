import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { Nova } from "./Nova";
import { createMockAppState, makeMockBridge, renderRoute } from "../test/test-utils";
import { openNovaPanel, openNovaShortcut } from "../shared/nova-panel";
import type { EffectiveNovaProfile, NovaResponse } from "../shared/openAdminOS";

function effective(overrides: Partial<EffectiveNovaProfile> = {}): EffectiveNovaProfile {
  return {
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
    ...overrides,
  };
}

function stubHostedSession() {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const track = { stop: vi.fn(), addEventListener: vi.fn() };
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track], getAudioTracks: () => [track] })) },
    configurable: true,
  });
  vi.stubGlobal("AudioContext", class {
    resume = async () => {};
    close = async () => {};
    createAnalyser = () => ({ fftSize: 512, getByteTimeDomainData: (values: Uint8Array) => values.fill(128) });
    createMediaStreamSource = () => ({ connect: vi.fn() });
  });
  const dc = { readyState: "open", send: vi.fn(), close: vi.fn(), addEventListener: vi.fn(), onmessage: undefined as undefined | ((event: { data: string }) => void) };
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
  return dc;
}

it("moves the voice mode and greeting name out of local storage once", async () => {
  localStorage.setItem("nova.voice-mode", "local");
  localStorage.setItem("nova.greeting-name", "Sam");
  const bridge = makeMockBridge();
  renderRoute(<Nova />, { bridge, route: "/cache", path: "/cache" });
  await waitFor(() => expect(bridge.novaProfile).toHaveBeenCalledWith({ action: "migrate", voiceMode: "local", greetingName: "Sam" }));
  await waitFor(() => expect(localStorage.getItem("nova.voice-mode")).toBeNull());
  expect(localStorage.getItem("nova.greeting-name")).toBeNull();
});

it("offers only the voice modes the IT policy allows, and none when voice is off", async () => {
  const bridge = makeMockBridge({}, createMockAppState({ novaProfile: effective({ voiceMode: "local", allowedVoiceModes: ["local"], locked: { ...effective().locked, voiceMode: true } }) }));
  const view = renderRoute(<Nova />, { bridge, route: "/cache", path: "/cache" });
  act(openNovaPanel);
  const select = await screen.findByRole("combobox");
  expect(select).toBeDisabled();
  expect(screen.queryByRole("option", { name: /OpenAI/ })).not.toBeInTheDocument();
  view.unmount();
  const off = makeMockBridge({}, createMockAppState({ novaProfile: effective({ voiceMode: undefined, allowedVoiceModes: [] }) }));
  renderRoute(<Nova />, { bridge: off, route: "/cache", path: "/cache" });
  act(openNovaPanel);
  expect(await screen.findByText(/Nova voice is turned off by your IT department/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start Nova" })).toBeDisabled();
});

it("saves a voice mode change in Nova settings", async () => {
  const bridge = makeMockBridge({}, createMockAppState({ novaProfile: effective() }));
  renderRoute(<Nova />, { bridge, route: "/cache", path: "/cache" });
  act(openNovaPanel);
  await userEvent.setup().selectOptions(await screen.findByRole("combobox"), "local");
  await waitFor(() => expect(bridge.novaProfile).toHaveBeenCalledWith({ action: "save", patch: { voiceMode: "local" } }));
});

it("runs a shortcut picked before the session once it starts, shows links, and reviews a settings change on a card", async () => {
  const dc = stubHostedSession();
  let finish!: (value: NovaResponse) => void;
  const bridge = makeMockBridge({
    nova: vi.fn(async (input) => {
      if (input.action === "status") return { hasKey: true };
      if (input.action === "start") return { sessionId: "voice-session", sdp: "v=0" };
      if (input.action === "answer") return new Promise<NovaResponse>((resolve) => { finish = resolve; });
      return {};
    }),
  }, createMockAppState({ novaProfile: effective({ shortcuts: [{ id: "s1", name: "Morning check", prompt: "How many devices?", createdAt: "2026-11-12T08:00:00.000Z" }] }) }));
  renderRoute(<Nova />, { bridge, route: "/cache", path: "/cache" });
  const user = userEvent.setup();
  act(() => openNovaShortcut("Morning check"));
  expect(await screen.findByText(/Start Nova to run Morning check/)).toBeInTheDocument();
  expect(bridge.nova).not.toHaveBeenCalledWith(expect.objectContaining({ action: "answer" }), expect.anything());
  expect(screen.getByText(/confirmed notes, when set, go to OpenAI too/)).toBeInTheDocument();
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Start Nova" }));
  await waitFor(() => expect(dc.onmessage).toBeTypeOf("function"));
  act(() => dc.onmessage!({ data: JSON.stringify({ type: "session.started" }) }));
  await waitFor(() => expect(bridge.nova).toHaveBeenCalledWith({ action: "answer", sessionId: "voice-session", text: "Run shortcut Morning check" }, expect.any(Function)));
  await act(async () => finish({ text: "In Contoso, 1 run waits.", links: [{ label: "Review Retire devices", route: "/runs/run-1" }] }));
  expect(await screen.findByRole("button", { name: "Review Retire devices" })).toBeInTheDocument();
  expect(dc.send.mock.calls.some(([event]) => String(event).includes("In Contoso, 1 run waits."))).toBe(true);

  act(() => openNovaShortcut("Morning check"));
  await waitFor(() => expect(vi.mocked(bridge.nova).mock.calls.filter(([request]) => request.action === "answer")).toHaveLength(2));
  await act(async () => finish({ text: "Review the change.", pendingAction: { id: "a1", kind: "profile", title: "Add to Nova standing instructions", target: "Settings, Nova, standing instructions", body: "Answer briefly.\nName counts first.", previousBody: "Answer briefly." } }));
  const card = screen.getByRole("region", { name: "Review Nova action" });
  expect(card).toHaveTextContent("Nothing changes until you confirm.");
  expect(screen.getByLabelText("Current value")).toHaveTextContent("Answer briefly.");
  expect(screen.getByLabelText("New value")).toHaveTextContent("Name counts first.");
  await user.click(screen.getByRole("button", { name: "Confirm change" }));
  await waitFor(() => expect(bridge.nova).toHaveBeenCalledWith({ action: "decide-action", sessionId: "voice-session", actionId: "a1", approved: true }, expect.any(Function)));
});

it("reviews a note on its own card and shows pending follow-ups", async () => {
  const dc = stubHostedSession();
  let finish!: (value: NovaResponse) => void;
  const bridge = makeMockBridge({
    nova: vi.fn(async (input) => {
      if (input.action === "status") return { hasKey: true };
      if (input.action === "start") return { sessionId: "voice-session", sdp: "v=0" };
      if (input.action === "answer") return new Promise<NovaResponse>((resolve) => { finish = resolve; });
      return {};
    }),
  }, createMockAppState({ novaFollowUpsPending: 2, novaProfile: effective({ shortcuts: [{ id: "s1", name: "Morning check", prompt: "How many devices?", createdAt: "2026-11-12T08:00:00.000Z" }] }) }));
  renderRoute(<Nova />, { bridge, route: "/cache", path: "/cache" });
  const user = userEvent.setup();
  act(() => openNovaShortcut("Morning check"));
  expect(await screen.findByRole("button", { name: "2 follow-ups pending" })).toBeInTheDocument();
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Start Nova" }));
  await waitFor(() => expect(dc.onmessage).toBeTypeOf("function"));
  act(() => dc.onmessage!({ data: JSON.stringify({ type: "session.started" }) }));
  await waitFor(() => expect(bridge.nova).toHaveBeenCalledWith(expect.objectContaining({ action: "answer" }), expect.any(Function)));
  await act(async () => finish({ text: "Review the note.", pendingAction: { id: "n1", kind: "remember", title: "Remember for Nova", target: "Northwind", body: "Kiosks are in Berlin", deliveryNote: "You asked for this note in Nova." } }));
  const card = screen.getByRole("region", { name: "Review Nova action" });
  expect(card).toHaveTextContent("Organization: Northwind");
  expect(card).toHaveTextContent("Until you confirm, it waits for review in Settings, Nova.");
  expect(screen.getByLabelText("Note")).toHaveTextContent("Kiosks are in Berlin");
  await user.click(screen.getByRole("button", { name: "Confirm note" }));
  await waitFor(() => expect(bridge.nova).toHaveBeenCalledWith({ action: "decide-action", sessionId: "voice-session", actionId: "n1", approved: true }, expect.any(Function)));
});

it("closes the hosted audio when the main process ends the session after a settings change, without another question", async () => {
  const dc = stubHostedSession();
  const listeners: Array<(info: { reason: string }) => void> = [];
  const bridge = makeMockBridge({
    nova: vi.fn(async (input) => {
      if (input.action === "status") return { hasKey: true };
      if (input.action === "start") return { sessionId: "voice-session", sdp: "v=0" };
      return {};
    }),
    onAppStateChanged: vi.fn((next: (info: { reason: string }) => void) => { listeners.push(next); return () => undefined; }),
  });
  renderRoute(<Nova />, { bridge, route: "/cache", path: "/cache" });
  const user = userEvent.setup();
  act(openNovaPanel);
  await user.click(await screen.findByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Start Nova" }));
  await waitFor(() => expect(dc.onmessage).toBeTypeOf("function"));
  act(() => dc.onmessage!({ data: JSON.stringify({ type: "session.started" }) }));
  // A note OpenAI received is forgotten in Settings; the main process ends the session.
  act(() => { for (const listener of listeners) listener({ reason: "nova-session-ended" }); });
  expect(await screen.findByText(/Nova settings or notes changed after this voice session started/)).toBeInTheDocument();
  expect(dc.send.mock.calls.some(([event]) => String(event).includes("session.close"))).toBe(true);
  expect(bridge.nova).toHaveBeenCalledWith({ action: "stop" });
});

it("closes the hosted audio and says why when the main process ends the session after a provider or organization change", async () => {
  const dc = stubHostedSession();
  const listeners: Array<(info: { reason: string }) => void> = [];
  const bridge = makeMockBridge({
    nova: vi.fn(async (input) => {
      if (input.action === "status") return { hasKey: true };
      if (input.action === "start") return { sessionId: "voice-session", sdp: "v=0" };
      return {};
    }),
    onAppStateChanged: vi.fn((next: (info: { reason: string }) => void) => { listeners.push(next); return () => undefined; }),
  });
  renderRoute(<Nova />, { bridge, route: "/cache", path: "/cache" });
  const user = userEvent.setup();
  act(openNovaPanel);
  await user.click(await screen.findByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Start Nova" }));
  await waitFor(() => expect(dc.onmessage).toBeTypeOf("function"));
  act(() => dc.onmessage!({ data: JSON.stringify({ type: "session.started" }) }));
  act(() => { for (const listener of listeners) listener({ reason: "nova-session-context-ended" }); });
  expect(await screen.findByText(/the reasoning provider changed after this voice session started/)).toBeInTheDocument();
  expect(dc.send.mock.calls.some(([event]) => String(event).includes("session.close"))).toBe(true);
  expect(bridge.nova).toHaveBeenCalledWith({ action: "stop" });
});

it("says when the voice settings on this device could not be moved, keeps them, and tries again", async () => {
  localStorage.setItem("nova.voice-mode", "local");
  const migrate = vi.fn()
    .mockRejectedValueOnce(new Error("Error invoking remote method 'openadminos:nova-profile': Error: state.json is locked."))
    .mockResolvedValue({});
  const bridge = makeMockBridge({ novaProfile: migrate });
  renderRoute(<Nova />, { bridge, route: "/cache", path: "/cache" });
  act(openNovaPanel);
  expect(await screen.findByText(/could not move the voice mode and greeting name/)).toBeInTheDocument();
  expect(localStorage.getItem("nova.voice-mode")).toBe("local");
  await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(localStorage.getItem("nova.voice-mode")).toBeNull());
  expect(migrate).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(/could not move the voice mode/)).toBeNull();
});

it("keeps the links of a local answer after its speech ends, until the next answer", async () => {
  stubHostedSession();
  vi.stubGlobal("MediaRecorder", class {
    state = "inactive";
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void;
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; this.onstop?.(); }
  });
  const createObjectURL = vi.fn(() => "blob:speech");
  Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
  const bridge = makeMockBridge({
    nova: vi.fn(async (input) => {
      if (input.action === "status") return { hasKey: true };
      if (input.action === "start") return { sessionId: "local-session" };
      if (input.action === "answer") return { text: "In Contoso, 1 run waits.", links: [{ label: "Review Retire devices", route: "/runs/run-1" }] };
      if (input.action === "speak") return { audio: [0, 1, 2] };
      return {};
    }),
  }, createMockAppState({ novaProfile: effective({ voiceMode: "local", shortcuts: [{ id: "s1", name: "Morning check", prompt: "What needs me?", createdAt: "2026-11-12T08:00:00.000Z" }] }) }));
  renderRoute(<Nova />, { bridge, route: "/cache", path: "/cache" });
  const user = userEvent.setup();
  act(() => openNovaShortcut("Morning check"));
  await user.click(await screen.findByRole("button", { name: "Start Nova" }));
  await waitFor(() => expect(bridge.nova).toHaveBeenCalledWith(expect.objectContaining({ action: "speak", sessionId: "local-session" })));
  expect(await screen.findByRole("button", { name: "Review Retire devices" })).toBeInTheDocument();
  const audio = document.querySelector("audio")!;
  await waitFor(() => expect(audio.onended).toBeTypeOf("function"));
  await act(async () => { audio.onended!(new Event("ended")); });
  // The session ended with the speech; the review link is still there.
  expect(bridge.nova).toHaveBeenCalledWith({ action: "stop" });
  expect(screen.getByRole("button", { name: "Review Retire devices" })).toBeInTheDocument();
  // A new session clears it.
  await user.click(screen.getByRole("button", { name: "Start Nova" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Review Retire devices" })).not.toBeInTheDocument());
});
