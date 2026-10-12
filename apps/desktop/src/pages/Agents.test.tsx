import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { makeMockBridge, renderRoute } from "../test/test-utils";
import Agents from "./Agents";

describe("Agents", () => {
  it("keeps the page focused on the Library and agent installation actions", async () => {
    const user = userEvent.setup();
    renderRoute(<Agents />, {
      path: "/agents",
      route: "/agents",
      bridge: makeMockBridge(),
    });

    expect(await screen.findByRole("heading", { name: "Agents" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Library" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Team" })).not.toBeInTheDocument();
    expect(screen.queryByText("Open office")).not.toBeInTheDocument();
    expect(screen.queryByText("No teammates")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("menuitem", { name: "Install from hub" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Build your own agent" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Add teammate" })).not.toBeInTheDocument();
  });
});
