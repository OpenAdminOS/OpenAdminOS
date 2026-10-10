import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { SegmentedControl } from "./SegmentedControl";

describe("SegmentedControl", () => {
  it("uses radiogroup semantics and supports arrow-key selection", async () => {
    const user = userEvent.setup();
    render(<SegmentedHarness />);

    expect(screen.getByRole("radiogroup", { name: "Run filter" })).toBeInTheDocument();
    const all = screen.getByRole("radio", { name: "All" });
    all.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Needs review" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});

function SegmentedHarness() {
  const [value, setValue] = useState("all");
  return (
    <SegmentedControl
      ariaLabel="Run filter"
      value={value}
      onValueChange={setValue}
      options={[
        { id: "all", label: "All" },
        { id: "review", label: "Needs review" },
      ]}
    />
  );
}
