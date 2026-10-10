import { screen } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import {
  ActivityRedirect,
  LegacyConnectorRedirect,
  LegacySettingsRedirect,
} from "./App";
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

describe("legacy Settings routes", () => {
  it("redirects Cache to Data and preserves the query string and hash", async () => {
    renderWithAppState(
      <Routes>
        <Route path="/cache" element={<LegacySettingsRedirect section="data" />} />
        <Route path="/settings/data" element={<LocationProbe />} />
      </Routes>,
      { route: "/cache?resource=users#coverage" },
    );

    expect(await screen.findByTestId("location")).toHaveTextContent(
      "/settings/data?resource=users#coverage",
    );
  });

  it("redirects connector deep links to the matching Settings drawer", async () => {
    renderWithAppState(
      <Routes>
        <Route path="/connectors/:connectorId" element={<LegacyConnectorRedirect />} />
        <Route path="/settings/connectors" element={<LocationProbe />} />
      </Routes>,
      { route: "/connectors/slack?from=agent#permissions" },
    );

    expect(await screen.findByTestId("location")).toHaveTextContent(
      "/settings/connectors?from=agent&connector=slack#permissions",
    );
  });
});

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search + location.hash}</div>;
}
