import { screen } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import {
  ActivityRedirect,
  AgentsQueryRedirect,
  FleetRedirect,
  LegacyConnectorRedirect,
  LegacySettingsRedirect,
  OfficeRedirect,
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

describe("legacy Agents routes", () => {
  it("redirects Hub and Schedules into Agents filters while preserving state", async () => {
    const { unmount } = renderWithAppState(
      <Routes>
        <Route path="/agents/hub" element={<AgentsQueryRedirect source="hub" />} />
        <Route path="/agents" element={<LocationProbe />} />
      </Routes>,
      { route: "/agents/hub?category=devices#catalog" },
    );

    expect(await screen.findByTestId("location")).toHaveTextContent(
      "/agents?category=devices&source=hub#catalog",
    );
    unmount();

    renderWithAppState(
      <Routes>
        <Route path="/agents/schedules" element={<AgentsQueryRedirect filter="scheduled" />} />
        <Route path="/agents" element={<LocationProbe />} />
      </Routes>,
      { route: "/agents/schedules?mode=read" },
    );
    expect(await screen.findByTestId("location")).toHaveTextContent(
      "/agents?mode=read&filter=scheduled",
    );
  });

  it("redirects the root Hub alias to the Hub library source", async () => {
    renderWithAppState(
      <Routes>
        <Route path="/hub" element={<AgentsQueryRedirect source="hub" />} />
        <Route path="/agents" element={<LocationProbe />} />
      </Routes>,
      { route: "/hub?category=identity" },
    );

    expect(await screen.findByTestId("location")).toHaveTextContent(
      "/agents?category=identity&source=hub",
    );
  });

  it("redirects Office landing and persona links to their consolidated locations", async () => {
    const { unmount } = renderWithAppState(
      <Routes>
        <Route path="/office" element={<OfficeRedirect />} />
        <Route path="/agents" element={<LocationProbe />} />
      </Routes>,
      { route: "/office" },
    );
    expect(await screen.findByTestId("location")).toHaveTextContent("/agents");
    unmount();

    renderWithAppState(
      <Routes>
        <Route path="/office" element={<OfficeRedirect />} />
        <Route path="/agents/team/:personaId" element={<LocationProbe />} />
      </Routes>,
      { route: "/office?persona=policy-watcher&view=list#assignment" },
    );
    expect(await screen.findByTestId("location")).toHaveTextContent(
      "/agents/team/policy-watcher?view=list#assignment",
    );
  });

  it("keeps assignment Office links in the full office view", async () => {
    renderWithAppState(
      <Routes>
        <Route path="/office" element={<OfficeRedirect />} />
        <Route path="/agents/office" element={<LocationProbe />} />
      </Routes>,
      { route: "/office?assignment=mission-42&inbox=1" },
    );

    expect(await screen.findByTestId("location")).toHaveTextContent(
      "/agents/office?assignment=mission-42&inbox=1",
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

describe("legacy fleet route", () => {
  it("redirects to the all-tenant Changes scope and preserves query and hash", async () => {
    renderWithAppState(
      <Routes>
        <Route path="/fleet" element={<FleetRedirect />} />
        <Route path="/changes" element={<LocationProbe />} />
      </Routes>,
      { route: "/fleet?group=eu&view=compare#recent" },
    );

    const location = await screen.findByTestId("location");
    expect(location).toHaveTextContent("/changes?");
    expect(location).toHaveTextContent("group=eu");
    expect(location).toHaveTextContent("view=compare");
    expect(location).toHaveTextContent("scope=all");
    expect(location).toHaveTextContent("#recent");
  });
});

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search + location.hash}</div>;
}
