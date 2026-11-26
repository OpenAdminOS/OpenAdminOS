import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { NovaRequest, NovaSpeechStatus } from "@openadminos/agent-sdk";
import { makeMockBridge, renderRoute } from "../test/test-utils";
import { LocalSpeechSetup } from "./LocalSpeechSetup";

it("offers a cancellable download and shows readiness on successful retry", async () => {
  let status: NovaSpeechStatus = {
    source: "builtin", model: "auto", selectedModel: "small", gpuAccelerated: false, available: true, ready: false, totalBytes: 289000000,
  };
  let resolveInstall: (() => void) | undefined;
  const nova = vi.fn(async (request: NovaRequest) => {
    if (request.action === "speech-install") {
      if (resolveInstall) status = { ...status, ready: true };
      else {
        status = { ...status, receivedBytes: 5000000 };
        await new Promise<void>(resolve => { resolveInstall = resolve; });
      }
    }
    if (request.action === "speech-cancel") {
      status = { ...status, receivedBytes: undefined };
      resolveInstall?.();
    }
    return { speech: status };
  });
  renderRoute(<LocalSpeechSetup showModel />, { route: "/settings", path: "/settings", bridge: makeMockBridge({ nova }) });
  const user = userEvent.setup();
  expect(await screen.findByText("Set up local voice")).toBeVisible();
  expect(screen.getByRole("option", { name: "Large v3 Turbo · slow on this device" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Download models" }));
  expect(await screen.findByRole("progressbar")).toHaveAttribute("aria-valuenow", "5000000");
  await user.click(screen.getByRole("button", { name: "Cancel download" }));
  await waitFor(() => expect(screen.queryByRole("progressbar")).not.toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: "Download models" }));
  expect(await screen.findByText("Ready")).toBeVisible();
});

it("offers Download again for a failed model and shows the unused set size", async () => {
  const speech: NovaSpeechStatus = {
    source: "builtin", model: "auto", selectedModel: "small", gpuAccelerated: false,
    available: true, ready: false, repairNeeded: true, unusedBytes: 743913015, totalBytes: 359957307,
    error: "Local voice models failed verification. Choose Download again to repair them.",
  };
  const nova = vi.fn(async () => ({ speech }));
  renderRoute(<LocalSpeechSetup showModel />, { route: "/settings", path: "/settings", bridge: makeMockBridge({ nova }) });
  const user = userEvent.setup();
  expect(await screen.findByText(/Speech models come from Hugging Face/)).toBeVisible();
  expect(screen.getByText(/unused model set takes 744 MB/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Download again" }));
  expect(nova).toHaveBeenCalledWith({ action: "speech-install" });
});

it("saves a silence preset and an inactivity preset for the next conversation", async () => {
  const speech: NovaSpeechStatus = {
    source: "builtin", model: "auto", selectedModel: "small", gpuAccelerated: false,
    available: true, ready: true, totalBytes: 0,
    preferences: { interaction: "hands-free", silenceMs: 800, idleSeconds: 120, showTimings: false },
  };
  const nova = vi.fn(async (request: NovaRequest) => {
    if (request.action === "speech-preferences") speech.preferences = request.preferences;
    return { speech: { ...speech } };
  });
  renderRoute(<LocalSpeechSetup showModel />, { route: "/settings", path: "/settings", bridge: makeMockBridge({ nova }) });
  const user = userEvent.setup();
  const silence = await screen.findByLabelText("End-of-speech wait");
  expect(silence).toHaveValue("800");
  expect(screen.getByText("Applies to the next conversation.")).toBeVisible();
  await user.selectOptions(silence, "1400");
  await user.selectOptions(screen.getByLabelText("Microphone inactivity timeout"), "300");
  expect(nova).toHaveBeenLastCalledWith({
    action: "speech-preferences",
    preferences: { interaction: "hands-free", silenceMs: 1400, idleSeconds: 300, showTimings: false },
  });
});
