import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import IntuneChat from "./IntuneChat";
import {
  createMockAppState,
  makeMockBridge,
  mockProviders,
  renderRoute,
} from "../test/test-utils";

describe("IntuneChat hosted-provider consent", () => {
  it("shows consent copy and waits for explicit confirmation before sending tenant context", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge(
      {},
      createMockAppState({
        activeProviderId: "openai",
        activeModelByProviderId: { openai: "gpt-5" },
      }),
    );

    renderRoute(<IntuneChat />, {
      path: "/chat",
      route: "/chat",
      bridge,
    });

    const composer = await screen.findByPlaceholderText(
      "Ask about devices, users, policies, sign-ins, or an installed agent workflow.",
    );
    await screen.findByText("Retrieved tenant context is sent to the selected hosted provider.");

    await user.type(composer, "Which Windows devices are stale?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(
      await screen.findByRole("heading", {
        name: "Send tenant context to hosted provider",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This chat answer will use retrieved tenant context with OpenAI. The answer prompt leaves this device.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("What leaves this device")).toBeInTheDocument();
    expect(bridge.streamIntuneChatMessage).not.toHaveBeenCalled();

    const modalSendButton = screen.getAllByRole("button", { name: "Send" }).at(-1);
    expect(modalSendButton).toBeDefined();
    await user.click(modalSendButton!);

    await waitFor(() => {
      expect(bridge.streamIntuneChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "Which Windows devices are stale?",
          hostedProviderConsent: expect.objectContaining({
            tenantId: "tenant-1",
            providerId: "openai",
            remember: true,
          }),
        }),
        expect.any(Function),
      );
    });
  });

  it("uses the mocked hosted provider state", () => {
    expect(mockProviders.find((provider) => provider.id === "openai")?.isLocal).toBe(false);
  });
});
