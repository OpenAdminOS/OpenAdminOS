import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Route, Routes, useLocation } from "react-router";

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

    await user.click(screen.getByRole("button", { name: "New agent" }));
    expect(screen.getByRole("menuitem", { name: "Browse the Marketplace" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Build your own agent" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Add teammate" })).not.toBeInTheDocument();
  });

  it("sends old hub links to the Marketplace and lists installed agents only", async () => {
    renderRoute(
      <Routes>
        <Route path="/agents" element={<Agents />} />
        <Route path="/marketplace" element={<LocationProbe />} />
      </Routes>,
      { path: "*", route: "/agents?source=hub", bridge: makeMockBridge() },
    );
    expect(await screen.findByTestId("location")).toHaveTextContent("/marketplace?kind=agents");
  });

  it("shows no hub tab or hub rows", async () => {
    renderRoute(<Agents />, { path: "/agents", route: "/agents", bridge: makeMockBridge() });
    expect(await screen.findByRole("tab", { name: "Installed" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Browse" })).not.toBeInTheDocument();
    expect(screen.getByText("1 of 1 installed agents")).toBeInTheDocument();
  });
});

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}
