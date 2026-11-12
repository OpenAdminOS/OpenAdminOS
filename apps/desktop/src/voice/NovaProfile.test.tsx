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
