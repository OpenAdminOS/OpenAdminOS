import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { UpdateBanner } from "./UpdateBanner";
import { makeMockBridge, renderRoute } from "../test/test-utils";

describe("UpdateBanner", () => {
  it("surfaces update errors and lets the admin retry", async () => {
    const user = userEvent.setup();
    const checkForUpdatesNow = vi.fn(async () => ({
      status: "checking" as const,
    }));
    renderRoute(<UpdateBanner />, {
      path: "/",
      route: "/",
      bridge: makeMockBridge({
        getUpdateState: vi.fn(async () => ({
          status: "error" as const,
          message: "Update check failed. Network unavailable.",
        })),
        checkForUpdatesNow,
      }),
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Network unavailable",
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(checkForUpdatesNow).toHaveBeenCalledTimes(1);
  });
});
