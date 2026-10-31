import { screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import MenuBarCompanion from "./MenuBarCompanion";
import { makeMockBridge, renderRoute } from "../test/test-utils";

it("labels a planned result in companion activity without treating it as failed or pending", async () => {
  const bridge = makeMockBridge();
  const snapshot = await bridge.getCompanionSnapshot();
  snapshot.recentActivity = [{ id: "dry", label: "Dry run test", status: "planned", route: "/runs/dry", queuedAt: "2026-10-31T12:00:00Z" }];
  bridge.getCompanionSnapshot = vi.fn(async () => snapshot);
  renderRoute(<MenuBarCompanion />, { path: "/companion", route: "/companion", bridge });
  expect(await screen.findByText("Dry run: not applied")).toBeInTheDocument();
  expect(screen.queryByText("Awaiting confirmation")).not.toBeInTheDocument();
});
