import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Sidebar } from "./Sidebar";
import { makeMockBridge, renderRoute } from "../test/test-utils";

describe("Sidebar", () => {
  it("keeps one compact primary navigation group", () => {
    renderRoute(<Sidebar />, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge(),
    });

    const primary = screen.getByRole("navigation", { name: "Primary" });
    expect(
      within(primary)
        .getAllByRole("link")
        .map((link) => link.querySelector(".flex-1")?.textContent?.trim()),
    ).toEqual(["Chat", "Agents", "Changes", "Settings"]);
    expect(screen.queryByRole("link", { name: "Home" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Report issue/ })).not.toBeInTheDocument();
  });
});
