import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DeviceTile } from "./DeviceTile";

describe("DeviceTile", () => {
  it("renders the three sizes and is decorative unless labelled", () => {
    const { container } = render(
      <>
        <DeviceTile size="xl" />
        <DeviceTile size="lg" />
        <DeviceTile size="sm" label="This device" />
      </>,
    );
    const tiles = container.querySelectorAll(".device-tile");
    expect([...tiles].map((tile) => tile.getAttribute("data-size"))).toEqual(["xl", "lg", "sm"]);
    expect(tiles[0]).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("img", { name: "This device" })).toBe(tiles[2]);
  });
});
