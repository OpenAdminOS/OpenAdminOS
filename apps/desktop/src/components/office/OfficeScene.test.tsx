import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfficeScene } from "./OfficeScene";
import type { OfficePersona } from "../../shared/openAdminOS";

const personas: OfficePersona[] = Array.from({ length: 8 }, (_, i) => ({
  id: `persona-${i}`,
  name: `Teammate ${i}`,
  responsibility: "Review settings",
  avatar: "robot",
  color: "sage",
  tenantId: "tenant-1",
  providerId: "ollama",
  agentSlugs: ["compliance-overview"],
  intervalMinutes: null,
  maxMinutes: 30,
  enabled: true,
  createdAt: "2026-09-10T10:00:00Z",
  updatedAt: "2026-09-10T10:00:00Z",
}));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Office scene", () => {
  it("moves idle personas, respects pause, and interrupts downtime for real work and approval", () => {
    vi.useFakeTimers();
    const props = {
      personas: personas.slice(0, 1),
      selectedId: "persona-0",
      onSelect: vi.fn(),
    };
    const { container, rerender } = render(
      <OfficeScene {...props} statuses={{ "persona-0": "Ready" }} />,
    );
    const position = () =>
      (container.querySelector(".scene-persona-position") as HTMLElement).style
        .transform;
    const lounge = position();
    act(() => vi.advanceTimersByTime(18000));
    expect(position()).not.toBe(lounge);
    fireEvent.click(screen.getByRole("button", { name: "Pause motion" }));
    const paused = position();
    act(() => vi.advanceTimersByTime(36000));
    expect(position()).toBe(paused);
    expect(container.querySelector(".team-office")).toHaveAttribute(
      "data-motion",
      "off",
    );
    rerender(<OfficeScene {...props} statuses={{ "persona-0": "Working" }} />);
    const desk = position();
    expect(desk).not.toBe(paused);
    expect(container.querySelectorAll(".scene-desk-active")).toHaveLength(1);
    rerender(
      <OfficeScene {...props} statuses={{ "persona-0": "Needs approval" }} />,
    );
    expect(position()).not.toBe(desk);
    expect(container.querySelectorAll(".scene-desk-active")).toHaveLength(0);
    expect(
      screen.getByRole("button", { name: "Teammate 0, Needs approval" }),
    ).toBeInTheDocument();
  });
  it("opens the selected persona's floor and keeps every persona reachable", () => {
    const select = vi.fn();
    render(
      <OfficeScene
        personas={personas}
        statuses={{}}
        selectedId="persona-7"
        onSelect={select}
      />,
    );
    expect(screen.getByRole("button", { name: "Floor 2" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Teammate 7, Ready" }));
    expect(select).toHaveBeenCalledWith("persona-7");
    fireEvent.click(screen.getByRole("button", { name: "Floor 1" }));
    expect(
      screen.getByRole("button", { name: "Teammate 0, Ready" }),
    ).toBeInTheDocument();
  });
  it("honors reduced motion without hiding live status", () => {
    const original = window.matchMedia;
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      ...original(query),
      matches: true,
    }));
    const { container } = render(
      <OfficeScene
        personas={personas.slice(0, 1)}
        statuses={{ "persona-0": "Working" }}
        onSelect={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Reduced motion" }),
    ).toBeDisabled();
    expect(container.querySelector(".team-office")).toHaveAttribute(
      "data-motion",
      "off",
    );
    expect(
      screen.getByRole("button", { name: "Teammate 0, Working" }),
    ).toBeInTheDocument();
  });
});
