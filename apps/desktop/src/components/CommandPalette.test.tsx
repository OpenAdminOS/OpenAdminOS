import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
import { makeMockBridge, renderRoute } from "../test/test-utils";

describe("Command Palette", () => {
  it("uses complete combobox semantics and opens catalog-backed Settings results", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderRoute(<CommandPalette open onClose={onClose} />, {
      path: "/",
      route: "/",
      bridge: makeMockBridge(),
    });

    expect(screen.getByRole("dialog", { name: "Command Palette" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
    const combobox = screen.getByRole("combobox", {
      name: "Search commands, agents, or pages",
    });
    expect(combobox).toHaveAttribute("aria-controls", "command-palette-results");
    await waitFor(() => expect(combobox).toHaveFocus());

    await user.tab();
    expect(combobox).toHaveFocus();
    await user.tab({ shift: true });
    expect(combobox).toHaveFocus();

    await user.type(combobox, "tenant cache");
    const option = screen.getByRole("option", { name: /Tenant cache/ });
    expect(option).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
