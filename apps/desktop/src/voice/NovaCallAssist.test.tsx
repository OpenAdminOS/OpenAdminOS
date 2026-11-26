import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NovaCallRequest, NovaCallUpdate } from "@openadminos/agent-sdk";
import { expect, it, vi } from "vitest";
import { makeMockBridge } from "../test/test-utils";
import { NovaCallAssist } from "./NovaCallAssist";

it("requires fresh consent, reconciles capture state, and discards late events after Stop", async () => {
  let notify: (view: NovaCallUpdate) => void = () => {};
  const bridge = makeMockBridge({
    onNovaCallChanged: listener => {
      notify = listener;
      return () => {};
    },
    novaCall: vi.fn(async ({ action }: NovaCallRequest): Promise<NovaCallUpdate | undefined> => {
      if (action === "status") return { state: "idle", canSuggest: false, suggesting: false, revision: 0 };
      if (action === "start") return { state: "capturing", canSuggest: true, suggesting: false, answer: "A private suggestion.", revision: 1 };
      if (action === "stop") return { state: "stopped", canSuggest: false, suggesting: false, revision: 3 };
    }),
  });
  vi.stubGlobal("openAdminOS", bridge);
  render(<NovaCallAssist close={vi.fn()} />);
  const user = userEvent.setup();
  const start = screen.getByRole("button", { name: "Start capture" });
  expect(bridge.novaCall).toHaveBeenCalledWith({ action: "status" });
  expect(start).toBeDisabled();
  expect(screen.getByText(/other apps and browser tabs/)).toBeVisible();
  await user.click(screen.getByRole("checkbox"));
  await user.click(start);
  expect(bridge.novaCall).toHaveBeenCalledWith({ action: "start", confirmed: true });

  expect(screen.getByText("Capturing Mac playback")).toBeVisible();
  expect(screen.getByText("A private suggestion.")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Suggest answer" }));
  expect(bridge.novaCall).toHaveBeenCalledWith({ action: "suggest" });

  act(() => notify({ state: "reconnecting", canSuggest: false, suggesting: false, revision: 2 }));
  expect(screen.getByText("Reconnecting audio")).toBeVisible();
  expect(screen.getByRole("button", { name: "Suggest answer" })).toBeDisabled();
  expect(screen.queryByText("A private suggestion.")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Stop" }));
  expect(bridge.novaCall).toHaveBeenCalledWith({ action: "stop" });
  act(() => notify({ state: "capturing", canSuggest: true, suggesting: false, answer: "A private suggestion.", revision: 1 }));
  expect(screen.queryByText("A private suggestion.")).toBeNull();
  expect(screen.queryByRole("button", { name: "Suggest answer" })).toBeNull();

  act(() => notify({ state: "permission", canSuggest: false, suggesting: false, revision: 4 }));
  await user.click(screen.getByRole("button", { name: "Open Privacy & Security" }));
  expect(bridge.novaCall).toHaveBeenCalledWith({ action: "settings" });
  await user.click(screen.getByRole("button", { name: "Start again" }));
  expect(screen.getByRole("button", { name: "Start capture" })).toBeDisabled();
});

it("resyncs a cleared session after wake even if the stop event was missed", async () => {
  let wake = () => {};
  let view: NovaCallUpdate = { state: "idle", canSuggest: false, suggesting: false, revision: 0 };
  const bridge = makeMockBridge({
    onAppStateChanged: listener => {
      wake = () => listener({ reason: "nova-call-resumed" });
      return () => {};
    },
    novaCall: vi.fn(async ({ action }: NovaCallRequest) => {
      if (action === "start") view = { state: "capturing", canSuggest: true, suggesting: false, answer: "Private text", revision: 1 };
      return view;
    }),
  });
  vi.stubGlobal("openAdminOS", bridge);
  render(<NovaCallAssist close={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Start capture" }));
  expect(screen.getByText("Private text")).toBeVisible();

  view = { state: "stopped", canSuggest: false, suggesting: false, revision: 2 };
  act(wake);
  expect(await screen.findByRole("button", { name: "Start again" })).toBeVisible();
  expect(screen.queryByText("Private text")).toBeNull();
});
