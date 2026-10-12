import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useState } from "react";
import { render } from "@testing-library/react";
import { Tabs } from "./Tabs";

describe("Tabs", () => {
  it("uses tablist semantics and changes tabs with arrow keys", async () => {
    const user = userEvent.setup();
    render(<TabsHarness />);

    const tablist = screen.getByRole("tablist", { name: "Agent views" });
    expect(tablist).toBeInTheDocument();
    const installed = screen.getByRole("tab", { name: "Installed" });
    installed.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Hub" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Hub" })).toHaveFocus();
  });
});

function TabsHarness() {
  const [value, setValue] = useState("installed");
  return (
    <Tabs
      ariaLabel="Agent views"
      value={value}
      onValueChange={setValue}
      tabs={[
        { id: "installed", label: "Installed", panelId: "installed-panel" },
        { id: "hub", label: "Hub", panelId: "hub-panel" },
      ]}
    />
  );
}
