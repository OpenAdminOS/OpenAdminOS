import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfficeScene } from "./OfficeScene";
import type { OfficePersona } from "../../shared/openAdminOS";

const personas: OfficePersona[] = Array.from({ length: 24 }, (_, i) => ({
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
beforeEach(() => {
  vi.stubGlobal(
    "DOMMatrixReadOnly",
    class {
      m41 = 0;
      m42 = 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "animate").mockImplementation(
    () => ({ cancel: () => {}, onfinish: null }) as unknown as Animation,
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
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
    expect(position()).toBe(desk); // Review retains the reserved desk, with work stopped.
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

it("keeps 24 personas searchable and leaves no idle timers after prolonged use", () => {
  vi.useFakeTimers();
  const select = vi.fn();
  const { unmount, container } = render(
    <OfficeScene
      personas={personas}
      statuses={{ "persona-23": "Needs approval" }}
      onSelect={select}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Floor 4 · Needs attention" }),
  ).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Find a teammate"), {
    target: { value: "Teammate 23" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Teammate 23 · Needs approval" }),
  );
  expect(select).toHaveBeenCalledWith("persona-23");
  act(() => vi.advanceTimersByTime(3600000));
  expect(container.querySelectorAll(".scene-persona")).toHaveLength(6);
  expect(vi.getTimerCount()).toBeLessThan(50);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("visits the shared table only for a recent recorded handoff, then returns to work", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-11T10:00:00Z"));
  const { container } = render(
    <OfficeScene
      personas={personas.slice(0, 1)}
      statuses={{ "persona-0": "Working" }}
      selectedId="persona-0"
      onSelect={vi.fn()}
      events={{
        "persona-0": {
          text: "Evidence received",
          at: new Date().toISOString(),
          handoffAt: new Date().toISOString(),
          handoff: true,
          runId: "source-run",
        },
      }}
    />,
  );
  expect(container.querySelector(".scene-persona-position")).toHaveAttribute(
    "data-seat",
    "meeting-0",
  );
  expect(screen.getByRole("link", { name: /Open evidence/ })).toHaveAttribute(
    "href",
    "#/runs/source-run",
  );
  act(() => vi.advanceTimersByTime(5001));
  expect(container.querySelector(".scene-persona-position")).toHaveAttribute(
    "data-seat",
    "desk-0",
  );
});

it("keeps complete teammate names available in the roster and evidence stationary", () => {
  const name = "Long responsibility name for the conference demonstration";
  const { container } = render(
    <OfficeScene
      personas={[{ ...personas[0], name }]}
      statuses={{ "persona-0": "Needs attention" }}
      selectedId="persona-0"
      onSelect={vi.fn()}
      events={{
        "persona-0": {
          text: "Evidence ready",
          at: new Date().toISOString(),
          runId: "source-run",
        },
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Team roster" }));
  expect(
    screen.getByRole("button", { name: `Select ${name}` }),
  ).toBeInTheDocument();
  expect(container.querySelector(".office-stage .scene-event")).toBeNull();
  expect(screen.getByRole("link", { name: "Open evidence →" })).toHaveAttribute(
    "href",
    "#/runs/source-run",
  );
});
