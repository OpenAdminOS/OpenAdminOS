import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import Runs from "./Runs";
import {
  createAwaitingConfirmationRun,
  createMockAgent,
  createMockAppState,
  makeMockBridge,
  mockTenant,
  renderRoute,
  renderWithAppState,
} from "../test/test-utils";

const secondTenant = {
  ...mockTenant,
  id: "tenant-2",
  displayName: "Fabrikam",
  homeAccountId: "home-account-2",
};

describe("Runs", () => {
  it("renders review and running sections only when populated, with addressable anchors", async () => {
    const reviewManual = createAwaitingConfirmationRun({ id: "review-manual" });
    const reviewGateway = createAwaitingConfirmationRun({
      id: "review-gateway",
      agentSlug: "external-proposal",
      origin: "external-proposal",
      external: { clientName: "Gateway client", requiredScopes: [] },
    });
    const running = createAwaitingConfirmationRun({
      id: "run-live",
      status: "running",
      plan: undefined,
      steps: [
        {
          id: "step-1",
          runId: "run-live",
          label: "Read inventory",
          status: "completed",
        },
        {
          id: "step-2",
          runId: "run-live",
          label: "Build report",
          status: "running",
        },
      ],
    });
    const bridge = makeMockBridge(
      {},
      createMockAppState({ runs: [reviewManual, reviewGateway, running] }),
    );

    renderRoute(<Runs />, { path: "/runs", route: "/runs", bridge });

    expect((await screen.findByRole("heading", { name: "Needs review" })).closest("section"))
      .toHaveAttribute("id", "needs-review");
    expect(screen.getByRole("heading", { name: "Running" }).closest("section"))
      .toHaveAttribute("id", "running");
    expect(screen.getByRole("heading", { name: "History" }).closest("section"))
      .toHaveAttribute("id", "history");

    const reviewButtons = screen.getAllByRole("button", { name: "Review" });
    expect(reviewButtons).toHaveLength(2);
    expect(reviewButtons[0]).toHaveClass("bg-[var(--color-accent)]");
    expect(reviewButtons[1]).toHaveClass("bg-[var(--color-surface)]");
    expect(screen.getByText("1 of 2 steps")).toBeInTheDocument();
  });

  it("supports agent, status, and tenant query filters", async () => {
    const failed = createAwaitingConfirmationRun({
      id: "run-failed-fabrikam",
      agentSlug: "agent-b",
      tenantId: secondTenant.id,
      status: "failed",
      plan: undefined,
      finishedAt: "2026-10-10T10:01:00.000Z",
      error: "Provider request failed.",
    });
    const completed = createAwaitingConfirmationRun({
      id: "run-completed-contoso",
      agentSlug: "agent-a",
      status: "completed",
      plan: undefined,
      finishedAt: "2026-10-10T10:02:00.000Z",
    });
    const bridge = makeMockBridge(
      {},
      createMockAppState({
        tenants: [mockTenant, secondTenant],
        installedAgents: [
          createMockAgent({ id: "agent-a", slug: "agent-a", name: "Agent A" }),
          createMockAgent({ id: "agent-b", slug: "agent-b", name: "Agent B" }),
        ],
        runs: [completed, failed],
      }),
    );

    renderRoute(<Runs />, {
      path: "/runs",
      route: "/runs?agent=agent-b&status=failed&tenant=tenant-2",
      bridge,
    });

    const table = await screen.findByRole("table", { name: "Run history" });
    expect(within(table).getByText("Agent B")).toBeInTheDocument();
    expect(within(table).getByText("Fabrikam")).toBeInTheDocument();
    expect(within(table).queryByText("Agent A")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Failed" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("button", { name: "Filter (2)" })).toBeInTheDocument();
  });

  it("scrolls an addressable section into view after its runs load", async () => {
    const original = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollTo",
    );
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    const run = createAwaitingConfirmationRun({ id: "review-anchor" });
    const bridge = makeMockBridge({}, createMockAppState({ runs: [run] }));

    try {
      renderRoute(<Runs />, {
        path: "/runs",
        route: "/runs?status=review#needs-review",
        bridge,
      });

      await waitFor(() =>
        expect(scrollTo).toHaveBeenCalledWith(
          expect.objectContaining({ behavior: "auto" }),
        ),
      );
    } finally {
      if (original) {
        Object.defineProperty(HTMLElement.prototype, "scrollTo", original);
      } else {
        delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
      }
    }
  });

  it("distinguishes an empty finished history from active filters", async () => {
    const review = createAwaitingConfirmationRun({ id: "review-only" });
    const bridge = makeMockBridge({}, createMockAppState({ runs: [review] }));

    const view = renderRoute(<Runs />, { path: "/runs", route: "/runs", bridge });
    expect(await screen.findByText("No finished runs yet")).toBeInTheDocument();
    expect(screen.queryByText(/Change the search or filters/)).not.toBeInTheDocument();

    view.unmount();
    renderRoute(<Runs />, {
      path: "/runs",
      route: "/runs?status=failed",
      bridge,
    });
    expect(await screen.findByText("No runs found")).toBeInTheDocument();
    expect(screen.getByText(/Change the search or filters/)).toBeInTheDocument();
  });

  it("opens running rows and completed history rows at their run routes", async () => {
    const user = userEvent.setup();
    const running = createAwaitingConfirmationRun({
      id: "run-live",
      status: "running",
      plan: undefined,
    });
    const completed = createAwaitingConfirmationRun({
      id: "run-done",
      status: "completed",
      plan: undefined,
      finishedAt: "2026-10-10T10:01:00.000Z",
    });
    const bridge = makeMockBridge(
      {},
      createMockAppState({ runs: [running, completed] }),
    );

    const view = renderWithAppState(
      <Routes>
        <Route path="/runs" element={<Runs />} />
        <Route path="/runs/:id" element={<LocationProbe />} />
      </Routes>,
      { route: "/runs?tenant=tenant-1", bridge },
    );

    await user.click(await screen.findByRole("button", { name: /Device Offboard.*Running/i }));
    expect(await screen.findByTestId("location")).toHaveTextContent(
      "/runs/run-live?tenant=tenant-1",
    );

    view.unmount();
    renderWithAppState(
      <Routes>
        <Route path="/runs" element={<Runs />} />
        <Route path="/runs/:id" element={<LocationProbe />} />
      </Routes>,
      { route: "/runs", bridge },
    );
    const history = await screen.findByRole("table", { name: "Run history" });
    await user.click(within(history).getByText("run-done"));
    expect(await screen.findByTestId("location")).toHaveTextContent("/runs/run-done");
  });
});

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {location.pathname + location.search + location.hash}
    </div>
  );
}
