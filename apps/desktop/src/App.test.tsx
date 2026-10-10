import { screen } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { ActivityRedirect } from "./App";
import { renderWithAppState } from "./test/test-utils";

describe("legacy activity route", () => {
  it("redirects to Runs and preserves the query string", async () => {
    renderWithAppState(
      <Routes>
        <Route path="/activity" element={<ActivityRedirect />} />
        <Route path="/runs" element={<LocationProbe />} />
      </Routes>,
      { route: "/activity?filter=needs-review&tenant=contoso" },
    );

    expect(await screen.findByTestId("location")).toHaveTextContent(
      "/runs?filter=needs-review&tenant=contoso",
    );
  });
});

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}
