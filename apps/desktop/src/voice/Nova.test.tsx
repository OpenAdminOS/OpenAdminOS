import { screen, waitFor } from "@testing-library/react";
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
